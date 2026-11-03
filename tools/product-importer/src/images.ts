import { UpcItemDbImageProvider } from './upcitemdb.js';
import { BarcodeLookupImageProvider,GoUpcImageProvider,OpenProductsFactsImageProvider,SerpApiProductImageProvider } from './image-providers.js';
import { CachedImageApi } from './image-api.js';
import { MemoryCatalogCache,type ProductCatalogProduct } from './catalog.js';
import { AppError,barcode,safeImage } from './validation.js';
import { PublicImageUrlValidator } from './image-validation.js';
import type { ProductImageProvider,ProductImageResult,ProductImageCandidate,ProductImageDiscovery,ImageUrlValidator } from './image-types.js';
export * from './image-types.js';
export { PublicImageUrlValidator,isPublicAddress,imageDimensions } from './image-validation.js';
export { BarcodeLookupImageProvider,GoUpcImageProvider,OpenProductsFactsImageProvider,SerpApiProductImageProvider } from './image-providers.js';

export class NoProductImageProvider implements ProductImageProvider {
  async findByBarcode():Promise<null>{return null;}
}
export class AuthorizedApiProductImageProvider implements ProductImageProvider {
  private api:CachedImageApi;
  constructor(private endpoint:string,private key:string,http:typeof fetch=fetch){
    if(!endpoint.includes('{barcode}') || !safeImage(endpoint.replace('{barcode}','123')) || !endpoint.startsWith('https://') || !key)
      throw new AppError(503,'הגדרת ספק התמונות חסרה או אינה תקינה');
    this.api=new CachedImageApi(http);
  }
  async findByBarcode(code:string,_product:ProductCatalogProduct):Promise<ProductImageResult|null>{
    const body=await this.api.get(this.endpoint.replaceAll('{barcode}',encodeURIComponent(barcode(code))),{'X-API-Key':this.key});
    if(!body || body.imageUrl===null)return null;
    const imageUrl=safeImage(body.imageUrl);
    if(!imageUrl)throw new AppError(502,'ספק התמונות אינו זמין כרגע');
    return {imageUrl,source:'authorized-api',confidence:0.90};
  }
}
const confidence:Record<string,number>={'barcodelookup':0.95,'go-upc':0.95,'open-products-facts':0.90,'upcitemdb':0.90,'authorized-api':0.90};
/** Search candidates are collected, never promoted to automatic image results. */
export class CompositeProductImageProvider implements ProductImageProvider {
  private cache=new MemoryCatalogCache<ProductImageDiscovery>();
  private emptyCache=new MemoryCatalogCache<ProductImageDiscovery>(60_000);
  private pending=new Map<string,Promise<ProductImageDiscovery>>();
  constructor(private providers:ProductImageProvider[],private validator:ImageUrlValidator=new PublicImageUrlValidator()){}
  async findByBarcode(code:string,product:ProductCatalogProduct){return (await this.discoverByBarcode(code,product)).image;}
  async discoverByBarcode(input:string,product:ProductCatalogProduct):Promise<ProductImageDiscovery>{
    const code=barcode(input);
    const cached=this.cache.get(code)??this.emptyCache.get(code);
    if(cached)return structuredClone(cached.product);
    let request=this.pending.get(code);
    if(!request){request=this.load(code,product);this.pending.set(code,request);}
    try{return structuredClone(await request);}finally{this.pending.delete(code);}
  }
  private async validCandidate(value:ProductImageCandidate):Promise<ProductImageCandidate|null>{
    try{
      const checked=await this.validator.validate(value.imageUrl);
      const sourcePageUrl=safeImage(value.sourcePageUrl);
      return {...value,imageUrl:checked.imageUrl,thumbnailUrl:safeImage(value.thumbnailUrl)??checked.imageUrl,sourcePageUrl,
        sourceDomain:new URL(sourcePageUrl??checked.imageUrl).hostname,warning:checked.warning??value.warning};
    }catch{return null;}
  }
  private async load(code:string,product:ProductCatalogProduct):Promise<ProductImageDiscovery>{
    const candidates:ProductImageCandidate[]=[];
    const add=(candidate:ProductImageCandidate)=>{if(!candidates.some(c=>c.imageUrl===candidate.imageUrl))candidates.push(candidate);};
    for(const provider of this.providers){
      try{
        if(provider.findCandidatesByBarcode){
          const suggestions=await provider.findCandidatesByBarcode(code,{...product});
          for(const suggestion of suggestions.slice(0,10)){
            const checked=await this.validCandidate(suggestion);
            if(checked)add({...checked,confidence:Math.min(0.50,checked.confidence??0.50)});
          }
          continue;
        }
        const result=await provider.findByBarcode(code,{...product});
        if(!result)continue;
        const checked=await this.validCandidate(result);
        if(!checked)continue;
        const score=result.confidence??confidence[result.source]??0;
        if(result.source==='serpapi' || score<0.85 || !confidence[result.source]){
          add({...checked,confidence:Math.min(score,0.50)});continue;
        }
        const trusted:ProductImageCandidate[]=[{...checked,confidence:score}];
        for(const candidate of (result.candidates??[]).slice(0,10)){
          if(trusted.some(c=>c.imageUrl===candidate.imageUrl))continue;
          const valid=await this.validCandidate({...candidate,source:result.source,confidence:score});
          if(valid)trusted.push(valid);
          if(trusted.length===5)break;
        }
        const discovery={image:{...result,imageUrl:checked.imageUrl,sourcePageUrl:checked.sourcePageUrl,confidence:score,
          warning:checked.warning},candidates:[...trusted,...candidates].slice(0,5)};
        this.cache.set(code,{product:discovery,lookedUpAt:Date.now()});
        return discovery;
      }catch{/* One provider failure cannot stop fallback. */}
    }
    const discovery={image:null,candidates:candidates.slice(0,5)};
    (candidates.length?this.cache:this.emptyCache).set(code,{product:discovery,lookedUpAt:Date.now()});
    return discovery;
  }
}
export class FallbackProductImageProvider extends CompositeProductImageProvider {}
export const DEFAULT_IMAGE_PROVIDER_ORDER=['barcodelookup','go-upc','open-products-facts','upcitemdb','serpapi','authorized-api'];
export function createProductImageProvider(env:NodeJS.ProcessEnv,http:typeof fetch=fetch,
  validator:ImageUrlValidator=new PublicImageUrlValidator()):ProductImageProvider{
  const mode=env.PRODUCT_IMAGE_PROVIDER?.trim()??'auto';
  if(mode==='none')return new NoProductImageProvider();
  if(!['','auto','upcitemdb','authorized-api'].includes(mode))throw new AppError(503,'ספק התמונות שהוגדר אינו נתמך');
  const order=env.PRODUCT_IMAGE_PROVIDER_ORDER?.trim()?env.PRODUCT_IMAGE_PROVIDER_ORDER.split(',').map(s=>s.trim()).filter(Boolean):
    mode==='authorized-api'?['authorized-api']:DEFAULT_IMAGE_PROVIDER_ORDER;
  if(order.some(name=>!DEFAULT_IMAGE_PROVIDER_ORDER.includes(name)))throw new AppError(503,'סדר ספקי התמונות אינו תקין');
  if(env.GOOGLE_IMAGE_PROVIDER && env.GOOGLE_IMAGE_PROVIDER!=='serpapi')throw new AppError(503,'ספק חיפוש התמונות אינו נתמך');
  const providers:ProductImageProvider[]=[];
  for(const name of [...new Set(order)]){
    switch(name){
      case 'barcodelookup':if(env.BARCODE_LOOKUP_API_KEY)providers.push(new BarcodeLookupImageProvider(env.BARCODE_LOOKUP_API_KEY,http,validator));break;
      case 'go-upc':if(env.GO_UPC_API_KEY)providers.push(new GoUpcImageProvider(env.GO_UPC_API_KEY,http,validator));break;
      case 'open-products-facts':providers.push(new OpenProductsFactsImageProvider(http,validator));break;
      case 'upcitemdb':providers.push(new UpcItemDbImageProvider(http,validator));break;
      case 'serpapi':if(env.GOOGLE_IMAGE_PROVIDER==='serpapi' && env.SERPAPI_API_KEY)providers.push(
        new SerpApiProductImageProvider(env.SERPAPI_API_KEY,http,validator,
          (env.PRODUCT_IMAGE_PREFERRED_DOMAINS??'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean),
          {gl:env.SERPAPI_GL,hl:env.SERPAPI_HL,location:env.SERPAPI_LOCATION,development:env.NODE_ENV==='development'}));break;
      case 'authorized-api':
        if(env.PRODUCT_IMAGE_API_URL && env.PRODUCT_IMAGE_API_KEY)providers.push(
          new AuthorizedApiProductImageProvider(env.PRODUCT_IMAGE_API_URL,env.PRODUCT_IMAGE_API_KEY,http));
        else if(mode==='authorized-api')throw new AppError(503,'הגדרת ספק התמונות חסרה או אינה תקינה');
        break;
    }
  }
  return new CompositeProductImageProvider(providers,validator);
}

export type {SerpApiLocaleOptions,SerpApiDiagnostic} from './image-providers.js';
