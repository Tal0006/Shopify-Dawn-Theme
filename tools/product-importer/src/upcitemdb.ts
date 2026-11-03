import type {ProductImageCandidate} from './image-types.js';
import { barcode, safeImage } from './validation.js';
import { MemoryCatalogCache, type CatalogCache, type ProductCatalogProduct } from './catalog.js';
import { PublicImageUrlValidator } from './image-validation.js';
import type { ImageUrlValidator, ProductImageProvider, ProductImageResult } from './image-types.js';

/** Free/trial UPCitemdb API. Catalog metadata is never taken from this response. */
export class UpcItemDbImageProvider implements ProductImageProvider {
  private pending = new Map<string,Promise<ProductImageResult | null>>();
  private failures = new MemoryCatalogCache<null>(60_000);
  private cooldownUntil = 0;
  constructor(private http:typeof fetch = fetch,
    private validator:ImageUrlValidator = new PublicImageUrlValidator(),
    private cache:CatalogCache<ProductImageResult | null> = new MemoryCatalogCache<ProductImageResult | null>()) {}
  async findByBarcode(input:string, _product:ProductCatalogProduct):Promise<ProductImageResult | null> {
    const code = barcode(input);
    const key = 'upcitemdb:' + code;
    const cached = this.cache.get(key);
    if (cached) return cached.product ? structuredClone(cached.product) : null;
    if (this.failures.get(key) || Date.now() < this.cooldownUntil) return null;
    let request = this.pending.get(key);
    if (!request) {
      request = this.load(code,key);
      this.pending.set(key,request);
    }
    try { const image = await request; return image ? structuredClone(image) : null; }
    finally { this.pending.delete(key); }
  }
  private async load(code:string,key:string):Promise<ProductImageResult | null> {
    const remember = (product:ProductImageResult | null) => {
      this.cache.set(key,{product,lookedUpAt:Date.now()}); return product;
    };
    try {
      const response = await this.http('https://api.upcitemdb.com/prod/trial/lookup?upc=' + encodeURIComponent(code),{
        headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
      if (response.status === 404) return remember(null);
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const delay = retry && /^\d+$/.test(retry) ? Number(retry)*1000 :
          retry ? Date.parse(retry)-Date.now() : 60_000;
        this.cooldownUntil = Date.now() + Math.max(60_000,Number.isFinite(delay) ? delay : 60_000);
        throw new Error();
      }
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (body?.code !== 'OK') {
        if (body?.code === 'NOT_FOUND') return remember(null);
        // Application-level errors receive a short cooldown, not an hour-long negative result.
        throw new Error();
      }
      const item=Array.isArray(body.items)?body.items[0]:undefined;
      const identifiers=[item?.ean,item?.upc].filter(v=>v!==undefined && v!==null && v!=='');
      if(identifiers.length && !identifiers.some(v=>String(v).padStart(14,'0')===code.padStart(14,'0')))return remember(null);
      const images = Array.isArray(body.items) && Array.isArray(body.items[0]?.images) ? body.items[0].images : [];
      const candidates:ProductImageCandidate[]=[];
      for (const candidate of images.slice(0,10)) {
        const imageUrl = safeImage(candidate);
        if (!imageUrl || !imageUrl.startsWith('https://')) continue;
        try {
          const checked = await this.validator.validate(imageUrl);
          if (!checked.imageUrl.startsWith('https://')) continue;
          if(candidates.some(c=>c.imageUrl===checked.imageUrl))continue;
          candidates.push({imageUrl:checked.imageUrl,thumbnailUrl:checked.imageUrl,source:'upcitemdb',confidence:0.90,
            ...(checked.warning ? {warning:checked.warning} : {})});
          if(candidates.length===5)break;
        } catch { /* Try the next image when a URL or its content is invalid. */ }
      }
      return remember(candidates.length?{...candidates[0],candidates}:null);
    } catch {
      // No retries. Cache transient failures briefly so repeated previews don't consume quota.
      this.failures.set(key,{product:null,lookedUpAt:Date.now()});
      return null;
    }
  }
}
