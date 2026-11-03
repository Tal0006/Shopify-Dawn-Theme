import { pathToFileURL } from 'node:url';
import { AppError, barcode } from './validation.js';
export interface ProductCatalogProduct {
  barcode: string; title: string; imageUrl?: string; imageSource?: string; manufacturer?: string;
  category?: string; description?: string; unitQuantity?: string; source: string;
}
export interface ProductCatalogProvider {
  lookupByBarcode(barcode: string): Promise<ProductCatalogProduct>;
}
export interface CacheEntry<T = ProductCatalogProduct> { product: T; lookedUpAt: number }
export interface CatalogCache<T = ProductCatalogProduct> { get(key: string): CacheEntry<T> | undefined; set(key: string, value: CacheEntry<T>): void }
export class MemoryCatalogCache<T = ProductCatalogProduct> implements CatalogCache<T> {
  private entries = new Map<string, CacheEntry<T>>();
  constructor(private ttlMs = 60 * 60 * 1000, private limit = 500) {}
  get(key: string) {
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.lookedUpAt < this.ttlMs) return entry;
    this.entries.delete(key);
  }
  set(key: string, entry: CacheEntry<T>) {
    if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
  }
}
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
export class CheapersalProductCatalogProvider implements ProductCatalogProvider {
  private inFlight = new Map<string, Promise<ProductCatalogProduct>>();
  constructor(private key: string, private cache: CatalogCache = new MemoryCatalogCache(),
    private http: typeof fetch = fetch) {}
  async lookupByBarcode(input: string): Promise<ProductCatalogProduct> {
    const code = barcode(input);
    const cached = this.cache.get(code);
    if (cached) return { ...cached.product };
    let request = this.inFlight.get(code);
    if (!request) {
      request = this.load(code);
      this.inFlight.set(code, request);
    }
    try { return { ...await request }; } finally { this.inFlight.delete(code); }
  }
  private async load(code: string): Promise<ProductCatalogProduct> {
    const body = await this.request(code);
    const d = body.data;
    if (!d || typeof d !== 'object' || !str(d.name) || (d.barcode && String(d.barcode) !== code))
      throw new AppError(502, 'לא ניתן כרגע לקבל מידע על המוצר');
    const product: ProductCatalogProduct = {barcode:code, title:str(d.name)!,
      manufacturer:str(d.manufacturer) ?? str(d.brand), category:str(d.category),
      description:str(d.description), unitQuantity:str(d.unitQty), source:'cheapersal'};
    this.cache.set(code, {product, lookedUpAt:Date.now()});
    return product;
  }
  async request(code: string): Promise<any> {
    if (!this.key) throw new AppError(503, 'מפתח ספק המידע חסר או אינו תקין');
    let response: Response;
    try {
      response = await this.http('https://api.cheapersal.co.il/api/v1/products/' + barcode(code),
        {headers:{'X-API-Key':this.key}, signal:AbortSignal.timeout(15000), redirect:'error'});
    } catch { throw new AppError(502, 'לא ניתן כרגע לקבל מידע על המוצר'); }
    if (response.status === 401 || response.status === 403) throw new AppError(502, 'מפתח ספק המידע חסר או אינו תקין');
    if (response.status === 404) throw new AppError(404, 'המוצר לא נמצא לפי הברקוד שהוזן');
    if (response.status === 429) throw new AppError(429, 'חרגת ממכסת הבקשות של ספק המידע');
    if (!response.ok) throw new AppError(502, 'לא ניתן כרגע לקבל מידע על המוצר');
    let body;
    try { body = await response.json(); } catch { throw new AppError(502, 'לא ניתן כרגע לקבל מידע על המוצר'); }
    if (body?.success !== true) throw new AppError(502, 'לא ניתן כרגע לקבל מידע על המוצר');
    return body;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const code = barcode(process.argv[2]);
    const provider = new CheapersalProductCatalogProvider(process.env.CHEAPERSAL_API_KEY ?? '');
    const body = await provider.request(code);
    console.log('Product field names and types (no credentials or field values):');
    console.log(Object.fromEntries(Object.entries(body.data ?? {}).map(([k,v]) => [k, typeof v])));
    console.log('Cheapersal supplies metadata only; image lookup uses ProductImageProvider.');
  } catch (error) { console.error(error instanceof AppError ? error.message : 'Catalog inspection failed'); process.exitCode = 1; }
}
