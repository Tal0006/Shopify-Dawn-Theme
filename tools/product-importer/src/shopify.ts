import { AppError, escapeHtml } from './validation.js';
import type { ProductCatalogProduct } from './catalog.js';
export interface ImportedProduct { id: string; title: string; barcode: string; adminUrl: string }
export interface ShopifyGateway {
  currency(): Promise<string>;
  findBarcode(code: string): Promise<ImportedProduct | undefined>;
  create(product: ProductCatalogProduct, price: string): Promise<ImportedProduct>;
}
export class ShopifyAdmin implements ShopifyGateway {
  private token = '';
  private expiresAt = 0;
  constructor(private config: {domain:string; token?:string; clientId?:string; clientSecret?:string; trackInventory?:boolean},
    private http: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(config.domain))
      throw new AppError(503, 'יש להגדיר דומיין Shopify תקין');
  }
  private async accessToken() {
    if (this.config.token) return this.config.token;
    if (this.token && Date.now() < this.expiresAt) return this.token;
    if (!this.config.clientId || !this.config.clientSecret) throw new AppError(503, 'חסרים פרטי גישה ל-Shopify');
    try {
      const response = await this.http('https://' + this.config.domain + '/admin/oauth/access_token', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials', client_id:this.config.clientId, client_secret:this.config.clientSecret})});
      const data = await response.json();
      if (!response.ok || !data.access_token || !data.expires_in) throw new Error();
      this.token = data.access_token;
      this.expiresAt = Date.now() + Math.max(0, data.expires_in - 120) * 1000;
      return this.token;
    } catch { throw new AppError(502, 'לא ניתן להתחבר ל-Shopify. יש לבדוק את פרטי הגישה'); }
  }
  private async graphql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
    const token = await this.accessToken();
    try {
      const response = await this.http('https://' + this.config.domain + '/admin/api/2026-10/graphql.json', {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
        headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
        body:JSON.stringify({query,variables})});
      const body = await response.json();
      if (!response.ok || body.errors?.length || !body.data) throw new Error();
      return body.data;
    } catch { throw new AppError(502, 'לא ניתן להשלים את הבקשה ב-Shopify. יש לבדוק הרשאות וחיבור'); }
  }
  private result(p: {id:string; title:string}, code:string): ImportedProduct {
    return {...p, barcode:code, adminUrl:'https://' + this.config.domain + '/admin/products/' + p.id.split('/').pop()};
  }
  async currency(): Promise<string> {
    return (await this.graphql('query StoreCurrency { shop { currencyCode } }')).shop.currencyCode;
  }
  async findBarcode(code: string): Promise<ImportedProduct | undefined> {
    // Exhaustive scan avoids search-index delays immediately after creation.
    // Multiple instances/external writers still require an external distributed lock.
    let after: string | null = null;
    do {
      const data = await this.graphql(`query ExistingBarcode($after:String) {
        productVariants(first:25, after:$after) {
          nodes { barcodes(first:20) { nodes { value } } product { id title } }
          pageInfo { hasNextPage endCursor }
        }
      }`, {after});
      const page = data.productVariants;
      const match = page.nodes.find((v:any) => v.barcodes.nodes.some((b:any) => b.value === code));
      if (match) return this.result(match.product, code);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      if (page.pageInfo.hasNextPage && !after) throw new AppError(502, 'בדיקת הכפילויות לא הושלמה');
    } while (after);
    return undefined;
  }
  private async metafields(p: ProductCatalogProduct) {
    const data = await this.graphql(`query CatalogDefinitions {
      metafieldDefinitions(first:250, ownerType:PRODUCT, namespace:"custom") {
        nodes { key type { name } validations { name value } }
        pageInfo { hasNextPage }
      }
    }`);
    if (data.metafieldDefinitions.pageInfo.hasNextPage)
      throw new AppError(409, 'יש לבדוק את הגדרות המטא-שדות בחנות לפני הייבוא');
    const definitions = new Map<string, any>(data.metafieldDefinitions.nodes.map((d:any) => [d.key,d]));
    const fields = [
      ['catalog_source','single_line_text_field',p.source],
      ['external_barcode','single_line_text_field',p.barcode],
      ['catalog_category','single_line_text_field',p.category],
      ['catalog_last_sync','date_time',new Date().toISOString()]
    ];
    return fields.filter(([, , value]) => value).map(([key,type,value]) => {
      const def = definitions.get(key!);
      // Preserve existing definitions; don't bypass merchant validations.
      if (def && (def.type.name !== type || def.validations.length))
        throw new AppError(409, 'הגדרת מטא-שדה קיימת דורשת התאמה ידנית: custom.' + key);
      return {namespace:'custom', key, type, value};
    });
  }
  async create(p: ProductCatalogProduct, sellingPrice: string): Promise<ImportedProduct> {
    const input = {title:p.title, vendor:p.manufacturer, status:'DRAFT',
      descriptionHtml:p.description ? '<p>' + escapeHtml(p.description).replace(/\n/g,'<br>') + '</p>' : undefined,
      metafields:await this.metafields(p),
      productOptions:[{name:'Title', values:[{name:'Default Title'}]}],
      variants:[{optionValues:[{optionName:'Title',name:'Default Title'}],
        barcodes:[{value:p.barcode}], price:sellingPrice,
        inventoryItem:{tracked:this.config.trackInventory === true}}],
      files:p.imageUrl ? [{originalSource:p.imageUrl,contentType:'IMAGE',alt:p.title}] : undefined};
    const data = await this.graphql(`mutation CreateCatalogProduct($input:ProductSetInput!) {
      productSet(input:$input, synchronous:true) {
        product { id title }
        userErrors { field message }
      }
    }`, {input});
    const result = data.productSet;
    if (result.userErrors?.length || !result.product) throw new AppError(502,
      'Shopify לא אישר את יצירת המוצר. יש לבדוק את הגדרות המטא-שדות וכתובת התמונה');
    return this.result(result.product,p.barcode);
  }
}
