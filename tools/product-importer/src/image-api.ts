import {MemoryCatalogCache} from './catalog.js';
interface ApiOptions{redirectHosts?:string[];minimumIntervalMs?:number}
/** Isolated per provider: paid request caching, coalescing, throttling and Retry-After. */
export class CachedImageApi{
  private cache=new MemoryCatalogCache<any>();
  private errors=new MemoryCatalogCache<null>(60_000);
  private pending=new Map<string,Promise<any>>();
  private cooldownUntil=0;
  private nextRequestAt=0;
  constructor(private http:typeof fetch=fetch,private options:ApiOptions={}){}
  async get(url:string,headers:Record<string,string>={}):Promise<any>{
    const cached=this.cache.get(url);
    if(cached)return structuredClone(cached.product);
    if(this.errors.get(url)||Date.now()<this.cooldownUntil)return null;
    let request=this.pending.get(url);
    if(!request){
      if(Date.now()<this.nextRequestAt)return null;
      this.nextRequestAt=Date.now()+(this.options.minimumIntervalMs??0);
      request=this.load(url,headers);this.pending.set(url,request);
    }
    try{return structuredClone(await request);}finally{this.pending.delete(url);}
  }
  private async request(url:string,headers:Record<string,string>){
    let current=url;
    const allowed=this.options.redirectHosts??[];
    for(let redirects=0;redirects<=3;redirects++){
      const response=await this.http(current,{headers:{Accept:'application/json',...headers},
        redirect:allowed.length?'manual':'error',signal:AbortSignal.timeout(10000)});
      if(![301,302,303,307,308].includes(response.status))return response;
      const location=response.headers.get('location');
      if(!location||redirects===3)throw Error();
      const next=new URL(location,current);
      if(next.protocol!=='https:'||next.username||next.password||next.port||!allowed.includes(next.hostname)||
         !next.pathname.startsWith('/api/v3/product/'))throw Error();
      await response.body?.cancel();
      current=next.href;
    }
    throw Error();
  }
  private async load(url:string,headers:Record<string,string>){
    try{
      const response=await this.request(url,headers);
      if(response.status===429){
        const value=response.headers.get('retry-after');
        const delay=value&&/^\d+$/.test(value)?Number(value)*1000:value?Date.parse(value)-Date.now():60_000;
        this.cooldownUntil=Date.now()+Math.max(60_000,Number.isFinite(delay)?delay:60_000);throw Error();
      }
      if(response.status===401||response.status===403){this.cooldownUntil=Date.now()+60_000;throw Error();}
      if(!response.ok&&response.status!==404)throw Error();
      const product=response.status===404?null:await response.json();
      this.cache.set(url,{product,lookedUpAt:Date.now()});return product;
    }catch{
      // Do not log upstream URLs: some documented APIs require query-string keys.
      this.errors.set(url,{product:null,lookedUpAt:Date.now()});return null;
    }
  }
}
