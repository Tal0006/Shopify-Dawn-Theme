import { barcode,safeImage } from './validation.js';
import {MemoryCatalogCache,type ProductCatalogProduct} from './catalog.js';
import type { ImageUrlValidator,ProductImageCandidate,ProductImageProvider,ProductImageResult } from './image-types.js';
import { PublicImageUrlValidator } from './image-validation.js';
import { CachedImageApi } from './image-api.js';

function matches(value:unknown,code:string){
  return (typeof value==='string'||typeof value==='number') && String(value).padStart(14,'0')===code.padStart(14,'0');
}
async function exactImages(values:unknown,source:string,confidence:number,validator:ImageUrlValidator,sourcePageUrl?:string):Promise<ProductImageResult|null>{
  if(!Array.isArray(values))return null;
  const urls=[...new Set(values.map(safeImage).filter((url):url is string=>!!url))];
  urls.sort((a,b)=>Number(b.startsWith('https:'))-Number(a.startsWith('https:')));
  const candidates:ProductImageCandidate[]=[];
  for(const url of urls.slice(0,10)){
    try{
      const checked=await validator.validate(url);
      candidates.push({imageUrl:checked.imageUrl,thumbnailUrl:checked.imageUrl,source,
        sourceDomain:new URL(sourcePageUrl??checked.imageUrl).hostname,sourcePageUrl,confidence,
        ...(checked.warning?{warning:checked.warning}:{})});
      if(candidates.length===5)break;
    }catch{/* Try the next API image, never scrape product pages. */}
  }
  if(!candidates.length)return null;
  return {...candidates[0],candidates};
}
export class BarcodeLookupImageProvider implements ProductImageProvider{
  private api:CachedImageApi;
  constructor(private key:string,http:typeof fetch=fetch,private validator:ImageUrlValidator=new PublicImageUrlValidator()){
    this.api=new CachedImageApi(http,{minimumIntervalMs:1000});
  }
  async findByBarcode(input:string,_product:ProductCatalogProduct){
    if(!this.key)return null;
    const code=barcode(input);
    const params=new URLSearchParams({barcode:code,key:this.key});
    const data=await this.api.get('https://api.barcodelookup.com/v3/products?'+params);
    const product=Array.isArray(data?.products)?data.products.find((p:any)=>matches(p?.barcode_number,code)):undefined;
    return exactImages(product?.images,'barcodelookup',0.95,this.validator);
  }
}
export class GoUpcImageProvider implements ProductImageProvider{
  private api:CachedImageApi;
  constructor(private key:string,http:typeof fetch=fetch,private validator:ImageUrlValidator=new PublicImageUrlValidator()){
    this.api=new CachedImageApi(http,{minimumIntervalMs:500});
  }
  async findByBarcode(input:string,_product:ProductCatalogProduct){
    if(!this.key)return null;
    const code=barcode(input);
    const data=await this.api.get('https://go-upc.com/api/v1/code/'+encodeURIComponent(code),{Authorization:'Bearer '+this.key});
    if(!data?.product || data.inferred===true || (data.code!==undefined && !matches(data.code,code)))return null;
    return exactImages([data.product.imageUrl],'go-upc',0.95,this.validator);
  }
}
export class OpenProductsFactsImageProvider implements ProductImageProvider{
  private api:CachedImageApi;
  constructor(http:typeof fetch=fetch,private validator:ImageUrlValidator=new PublicImageUrlValidator()){
    this.api=new CachedImageApi(http,{minimumIntervalMs:4000,redirectHosts:['world.openfoodfacts.org','world.openbeautyfacts.org','world.openpetfoodfacts.org','world.openproductsfacts.org']});
  }
  async findByBarcode(input:string,_product:ProductCatalogProduct){
    const code=barcode(input);
    const params=new URLSearchParams({product_type:'all',fields:'code,image_front_url,image_url,selected_images,url'});
    const data=await this.api.get('https://world.openfoodfacts.org/api/v3/product/'+encodeURIComponent(code)+'.json?'+params,
      {'User-Agent':'FankeeProductImporter/1.0 (local Shopify product importer)'});
    if((data?.status!==1 && data?.status!=='success') || !data.product || (data.code!==undefined && !matches(data.code,code)) ||
       (data.product.code!==undefined && !matches(data.product.code,code)))return null;
    const p=data.product;
    const front=p.selected_images?.front;
    const values=[p.image_front_url,p.image_url];
    if(typeof front==='string')values.push(front);
    else if(front && typeof front==='object'){
      for(const size of ['display','small','thumb']){
        const group=front[size];
        if(typeof group==='string')values.push(group);
        else if(group && typeof group==='object')values.push(...Object.values(group));
      }
    }
    return exactImages(values,'open-products-facts',0.90,this.validator,safeImage(p.url));
  }
}
export interface SerpApiLocaleOptions{
  gl?:string;hl?:string;location?:string;development?:boolean;
  diagnostic?:(entry:SerpApiDiagnostic)=>void;
}
export interface SerpApiDiagnostic{
  provider:'serpapi';query:string;locale:{gl:string;hl:string;location:string};
  imagesResultsReturned:number;acceptedCandidates:number;rejectedCandidates:number;
}
const searchStopwords=new Set(['מוצר','מוצרים','ניקוי','כביסה','מרוכז','ליטר','מיליליטר','מל','גרם',
  'product','products','cleaning','cleaner','laundry','concentrated','gel','the','and','for','with']);
function searchText(value:unknown):string{
  return typeof value==='string'?value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase()
    .replace(/['’״׳"]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim():'';
}
function searchTokens(value:unknown):string[]{
  return [...new Set(searchText(value).split(/\s+/).filter(t=>t.length>=2 && !/^\d+$/.test(t) && !searchStopwords.has(t)))];
}
function tokenPresent(tokens:string[],word:string){
  return tokens.some(t=>t===word || (word.length>=3 && /^[והבלמכש]/.test(t) && t.slice(1)===word));
}
/** Search images are suggestions only; Israeli localization and metadata relevance are explicit. */
export class SerpApiProductImageProvider implements ProductImageProvider{
  private api:CachedImageApi;
  private cache=new MemoryCatalogCache<ProductImageCandidate[]>();
  private emptyCache=new MemoryCatalogCache<ProductImageCandidate[]>(60_000);
  private pending=new Map<string,Promise<ProductImageCandidate[]>>();
  private locale:{gl:string;hl:string;location:string};
  constructor(private key:string,http:typeof fetch=fetch,private validator:ImageUrlValidator=new PublicImageUrlValidator(),
    private preferredDomains:string[]=[],private options:SerpApiLocaleOptions={}){
    this.api=new CachedImageApi(http);
    this.locale={gl:options.gl?.trim().toLowerCase()||'il',hl:options.hl?.trim().toLowerCase()||'he',
      location:options.location?.trim()||'Israel'};
  }
  async findByBarcode():Promise<null>{return null;}
  async findCandidatesByBarcode(input:string,product:ProductCatalogProduct):Promise<ProductImageCandidate[]>{
    if(!this.key)return [];
    const code=barcode(input);
    const cacheKey=['serpapi',code,this.locale.gl,this.locale.hl,this.locale.location,product.manufacturer??'',product.title].join(':');
    const cached=this.cache.get(cacheKey)??this.emptyCache.get(cacheKey);
    if(cached)return structuredClone(cached.product);
    let request=this.pending.get(cacheKey);
    if(!request){request=this.search(code,{...product});this.pending.set(cacheKey,request);}
    try{
      const candidates=await request;
      (candidates.length?this.cache:this.emptyCache).set(cacheKey,{product:candidates,lookedUpAt:Date.now()});
      return structuredClone(candidates);
    }finally{this.pending.delete(cacheKey);}
  }
  private relevance(result:any,code:string,product:ProductCatalogProduct):number{
    const title=searchText(result.title);
    let pagePath='';
    try{pagePath=decodeURIComponent(new URL(result.link).pathname);}catch{/* Optional page context. */}
    const words=searchTokens(title||pagePath);
    const brandWords=searchTokens(product.manufacturer);
    const productWords=searchTokens(product.title).filter(t=>!brandWords.includes(t));
    const titleHits=productWords.filter(t=>tokenPresent(words,t)).length;
    const brandMatch=brandWords.length>0 && brandWords.some(t=>tokenPresent(words,t));
    const barcodeMatch=(typeof result.title==='string'&&result.title.includes(code))||
      (typeof result.link==='string'&&result.link.includes(code));
    const overlap=productWords.length?titleHits/productWords.length:0;
    // Country, dimensions and is_product cannot rescue a semantically unrelated result.
    if(productWords.length){
      if(!titleHits || !(barcodeMatch||brandMatch||titleHits>=2||overlap>=0.5))return 0;
    }else if(!brandMatch&&!barcodeMatch)return 0;
    let host='';
    const page=safeImage(result.link);
    if(page)host=new URL(page).hostname;
    const local=host.endsWith('.il');
    const preferred=this.preferredDomains.some(d=>host===d||host.endsWith('.'+d));
    let score=overlap*0.50+(brandMatch?0.18:0)+(barcodeMatch?0.25:0)+
      (local?0.07:0)+(preferred?0.05:0)+(result.is_product?0.04:0);
    if(result.original_width>=300&&result.original_height>=300)score+=0.05;
    else if(result.original_width>=64&&result.original_height>=64)score+=0.02;
    if(!productWords.length && brandMatch)score+=0.35;
    return Math.min(1,score);
  }
  private debug(query:string,total:number,accepted:number){
    if(!this.options.development)return;
    const entry:SerpApiDiagnostic={provider:'serpapi',query:query.split(this.key).join('[REDACTED]'),
      locale:{...this.locale},imagesResultsReturned:total,acceptedCandidates:accepted,rejectedCandidates:total-accepted};
    if(this.options.diagnostic)this.options.diagnostic(entry);
    else console.debug('SerpAPI image lookup',entry);
  }
  private async search(code:string,product:ProductCatalogProduct):Promise<ProductImageCandidate[]>{
    const manufacturer=product.manufacturer?.trim()??'';
    const queries=[code,manufacturer?code+' '+manufacturer:'',[manufacturer,product.title.trim()].filter(Boolean).join(' ')];
    for(const query of [...new Set(queries)].filter(Boolean)){
      const params=new URLSearchParams({engine:'google_images',q:query,gl:this.locale.gl,hl:this.locale.hl,
        location:this.locale.location,api_key:this.key,safe:'active'});
      const data=await this.api.get('https://serpapi.com/search.json?'+params);
      // Google Images can include shopping_results too. Those are intentionally never read.
      const results=Array.isArray(data?.images_results)?data.images_results:[];
      const ranked=results.filter((r:any)=>r&&typeof r==='object'&&!r.unsafe&&
        !(Number.isFinite(r.original_width)&&r.original_width<64)&&
        !(Number.isFinite(r.original_height)&&r.original_height<64))
        .map((result:any)=>({result,score:this.relevance(result,code,product)}))
        .filter(({score}:{score:number})=>score>=0.45)
        .sort((a:{score:number},b:{score:number})=>b.score-a.score);
      const candidates:ProductImageCandidate[]=[];
      for(const {result,score} of ranked.slice(0,20)){
        const imageUrl=safeImage(result.original);
        if(!imageUrl || candidates.some(c=>c.imageUrl===imageUrl))continue;
        try{
          const checked=await this.validator.validate(imageUrl);
          const sourcePageUrl=safeImage(result.link);
          const sourceDomain=sourcePageUrl?new URL(sourcePageUrl).hostname:
            typeof result.source==='string'&&/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(result.source)?result.source.toLowerCase():
              new URL(checked.imageUrl).hostname;
          candidates.push({imageUrl:checked.imageUrl,thumbnailUrl:safeImage(result.thumbnail)??checked.imageUrl,
            title:typeof result.title==='string'?result.title:undefined,sourcePageUrl,sourceDomain,source:'serpapi',
            confidence:0.50,relevanceScore:score,
            originalWidth:Number.isFinite(result.original_width)?result.original_width:undefined,
            originalHeight:Number.isFinite(result.original_height)?result.original_height:undefined,
            isProduct:result.is_product===true,...(checked.warning?{warning:checked.warning}:{})});
          if(candidates.length===5)break;
        }catch{/* Try the next relevant original image, not a Shopping result or thumbnail. */}
      }
      this.debug(query,results.length,candidates.length);
      // Even one usable relevant barcode result is sufficient. No extra paid fallback search.
      if(candidates.length)return candidates;
    }
    return [];
  }
}
