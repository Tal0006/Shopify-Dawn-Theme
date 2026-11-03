import {randomUUID} from 'node:crypto';
import {AppError,barcode,price} from './validation.js';
import {MemoryCatalogCache,type ProductCatalogProduct,type ProductCatalogProvider} from './catalog.js';
import type {ShopifyGateway,ImportedProduct} from './shopify.js';
import {NoProductImageProvider,PublicImageUrlValidator,type ProductImageProvider,type ImageUrlValidator,
  type ProductImageResult,type ProductImageCandidate} from './images.js';
type Outcome={duplicate:boolean;product:ImportedProduct};
interface Preview{
  product:ProductCatalogProduct;price:string;currency:string;expires:number;
  candidates:ProductImageCandidate[];selectedImage?:ProductImageResult;imageWarning?:string;
  manuallySelected:boolean;outcome?:Outcome;blocked?:boolean;editing?:boolean;
}
const trusted=new Set(['barcodelookup','go-upc','open-products-facts','upcitemdb','authorized-api']);
export class Importer{
  private previews=new Map<string,Preview>();
  private selectedImages=new MemoryCatalogCache<ProductImageCandidate|null>();
  private busy=false;
  constructor(private catalog:ProductCatalogProvider,private shop:ShopifyGateway,
    private images:ProductImageProvider=new NoProductImageProvider(),
    private imageValidator:ImageUrlValidator=new PublicImageUrlValidator()){}
  private response(id:string,p:Preview){
    return structuredClone({id,product:p.product,price:p.price,currency:p.currency,candidates:p.candidates,
      selectedImage:p.selectedImage,manuallySelected:p.manuallySelected,imageWarning:p.imageWarning});
  }
  private apply(p:Preview,image:ProductImageResult|undefined,manuallySelected=false){
    p.selectedImage=image;p.manuallySelected=manuallySelected;
    p.product.imageUrl=image?.imageUrl;p.product.imageSource=image?.source;
    p.imageWarning=image?.warning;
  }
  async preview(input:unknown,sellingPrice:unknown,manualImage?:unknown){
    const code=barcode(input),amount=price(sellingPrice);
    if(manualImage!==undefined && typeof manualImage!=='string')throw new AppError(400,'כתובת התמונה אינה תקינה');
    const manual=typeof manualImage==='string'?manualImage.trim():'';
    const product={...await this.catalog.lookupByBarcode(code)};
    delete product.imageUrl;delete product.imageSource;
    const p:Preview={product,price:amount,currency:'',expires:Date.now()+30*60*1000,candidates:[],manuallySelected:false};
    let image:ProductImageResult|null=null;
    try{
      if(this.images.discoverByBarcode){
        const discovery=await this.images.discoverByBarcode(code,{...product});
        image=discovery.image;p.candidates=discovery.candidates.slice(0,5);
      }else image=await this.images.findByBarcode(code,{...product});
      if(image && (image.source==='serpapi'||!trusted.has(image.source)||(image.confidence??0.90)<0.85)){
        p.candidates=[image,...p.candidates].slice(0,5);image=null;
      }
      if(image){
        const checked=await this.imageValidator.validate(image.imageUrl);
        this.apply(p,{...image,imageUrl:checked.imageUrl,warning:checked.warning??image.warning});
      }
      const remembered=this.selectedImages.get(code);
      if(remembered){
        if(remembered.product){
          const candidate=p.candidates.find(c=>c.imageUrl===remembered.product!.imageUrl);
          if(candidate){
            const checked=await this.imageValidator.validate(candidate.imageUrl);
            this.apply(p,{...candidate,imageUrl:checked.imageUrl,warning:checked.warning??candidate.warning},true);
          }
        }else this.apply(p,undefined,true);
      }
    }catch{/* Automatic lookup failures must not block manual/no-image imports. */}
    if(!p.product.imageUrl && manual){
      const checked=await this.imageValidator.validate(manual);
      this.apply(p,{imageUrl:checked.imageUrl,source:'manual',warning:checked.warning},true);
    }
    if(!p.product.imageUrl)p.imageWarning='לא נמצאה תמונה אוטומטית למוצר. אפשר לבחור תמונה, להזין תמונה חלופית או ליצור ללא תמונה';
    p.currency=await this.shop.currency();
    for(const [key,entry] of this.previews)if(entry.expires<Date.now())this.previews.delete(key);
    if(this.previews.size>=200)throw new AppError(429,'יש יותר מדי תצוגות מקדימות פתוחות');
    const id=randomUUID();this.previews.set(id,p);return this.response(id,p);
  }
  private getPreview(id:unknown):Preview{
    const p=typeof id==='string'?this.previews.get(id):undefined;
    if(!p||p.expires<Date.now())throw new AppError(400,'התצוגה המקדימה פגה. יש לחפש שוב');
    return p;
  }
  async selectImage(id:unknown,index:unknown){
    const p=this.getPreview(id);
    if(p.blocked||p.outcome||p.editing||this.busy)throw new AppError(409,'לא ניתן לשנות תמונה בזמן ייבוא או לאחר יצירת המוצר');
    if(index!==null && (typeof index!=='number'||!Number.isInteger(index)||index<0||index>=p.candidates.length))
      throw new AppError(400,'בחירת התמונה אינה תקינה');
    p.editing=true;
    try{
      if(index===null){
        this.apply(p,undefined,true);p.imageWarning='המוצר ייווצר ללא תמונה';
        this.selectedImages.set(p.product.barcode,{product:null,lookedUpAt:Date.now()});
      }else{
        const candidate=p.candidates[index as number];
        const checked=await this.imageValidator.validate(candidate.imageUrl);
        const selected={...candidate,imageUrl:checked.imageUrl,warning:checked.warning??candidate.warning};
        this.apply(p,selected,true);
        this.selectedImages.set(p.product.barcode,{product:selected,lookedUpAt:Date.now()});
      }
      return this.response(id as string,p);
    }finally{p.editing=false;}
  }
  async confirm(id:unknown):Promise<Outcome>{
    const preview=this.getPreview(id);
    if(preview.outcome)return preview.outcome;
    if(preview.blocked)throw new AppError(409,'ייתכן שהמוצר נוצר. יש לבדוק ב-Shopify ולחפש שוב לפני ניסיון נוסף');
    if(preview.editing||this.busy)throw new AppError(409,'ייבוא אחר או בחירת תמונה מתבצעים כעת. יש להמתין ולנסות שוב');
    this.busy=true;
    try{
      const existing=await this.shop.findBarcode(preview.product.barcode);
      if(existing)return preview.outcome={duplicate:true,product:existing};
      if(await this.shop.currency()!==preview.currency)throw new AppError(409,'מטבע החנות השתנה. יש לחפש שוב');
      if(preview.product.imageUrl){
        const checked=await this.imageValidator.validate(preview.product.imageUrl);
        preview.product.imageUrl=checked.imageUrl;
      }
      preview.blocked=true;
      const product=await this.shop.create(preview.product,preview.price);
      return preview.outcome={duplicate:false,product};
    }finally{this.busy=false;}
  }
}
