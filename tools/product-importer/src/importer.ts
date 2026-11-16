import {randomUUID} from 'node:crypto';
import {AppError,barcode,price} from './validation.js';
import {MemoryCatalogCache,type ProductCatalogProduct,type ProductCatalogProvider} from './catalog.js';
import type {ShopifyGateway,ImportedProduct} from './shopify.js';
import {NoProductImageProvider,PublicImageUrlValidator,DEFAULT_IMAGE_SOURCE_POLICY,logDomain,urlHostname,
  type ImageSourcePolicy,type ProductImageProvider,type ImageUrlValidator,
  type ProductImageResult,type ProductImageCandidate} from './images.js';
import {ProductImageProcessor,sha256,type ProcessedUpload,type UploadVariant} from './upload-image.js';
type Outcome={duplicate:boolean;product:ImportedProduct};
type UploadChoice='processed'|'original';
interface Preview{
  product:ProductCatalogProduct;price:string;currency:string;expires:number;
  candidates:ProductImageCandidate[];selectedImage?:ProductImageResult;imageWarning?:string;
  manuallySelected:boolean;outcome?:Outcome;blocked?:boolean;editing?:boolean;
  /** Exact image URL the admin confirmed usage rights for, held server-side for this preview only. */
  usageApproval?:string;
  /** Admin-uploaded image, held in memory for this preview only (never written to disk). */
  upload?:ProcessedUpload;
  /** Permission confirmed for this exact upload: its id and the hashes of the variants it produced. */
  uploadApproval?:{uploadId:string;hashes:Partial<Record<UploadChoice,string>>};
  uploadChoice?:UploadChoice;
  /** Provider lookup skipped because an upload was announced; resumed if the upload is removed. */
  providersDeferred?:boolean;
}
export interface ImporterOptions{
  /** Defaults to the image provider chain's policy, then the built-in conservative policy. */
  policy?:ImageSourcePolicy;
  /** Receives one sanitized line per image decision: provider, domain, policy, autoAttach. */
  log?:(line:string)=>void;
  /** Deterministic upload processing (background removal + normalization). */
  uploads?:ProductImageProcessor;
  /** Maximum previews holding an uploaded image at once. */
  maxUploads?:number;
  now?:()=>number;
}
const PREVIEW_TTL=30*60*1000;
const NO_IMAGE='לא נמצאה תמונה אוטומטית ממקור מאושר. אפשר לבדוק תמונה מוצעת, להזין תמונה חלופית או ליצור ללא תמונה';
const APPROVAL_REQUIRED='יש לאשר שיש הרשאה להשתמש בתמונה לפני שמוסיפים אותה למוצר';
const NOT_ATTACHABLE='התמונה שנבחרה אינה מאושרת לשימוש. יש לבחור תמונה מחדש או ליצור את המוצר ללא תמונה';
const safeToken=(value:unknown)=>typeof value==='string'&&/^[a-z0-9-]{1,40}$/.test(value)?value:'unknown';
export class Importer{
  private previews=new Map<string,Preview>();
  private selectedImages=new MemoryCatalogCache<ProductImageCandidate|null>();
  private busy=false;
  private policy:ImageSourcePolicy;
  private log:(line:string)=>void;
  private uploads:ProductImageProcessor;
  private maxUploads:number;
  private now:()=>number;
  constructor(private catalog:ProductCatalogProvider,private shop:ShopifyGateway,
    private images:ProductImageProvider=new NoProductImageProvider(),
    private imageValidator:ImageUrlValidator=new PublicImageUrlValidator(),options:ImporterOptions={}){
    this.policy=options.policy??images.policy??DEFAULT_IMAGE_SOURCE_POLICY;
    this.log=options.log??(()=>{});
    this.uploads=options.uploads??new ProductImageProcessor();
    this.maxUploads=options.maxUploads??10;
    this.now=options.now??Date.now;
    // Expired previews and their in-memory images are released even when the tool sits idle.
    setInterval(()=>this.sweep(),60_000).unref();
  }
  private uploadUrl(id:string,upload:ProcessedUpload,variant:UploadChoice){
    return '/api/image-upload/'+encodeURIComponent(id)+'/'+upload.id+'/'+variant;
  }
  private response(id:string,p:Preview){
    const info=(upload:ProcessedUpload,name:UploadChoice,v:UploadVariant)=>({width:v.width,height:v.height,bytes:v.bytes,
      format:v.format,transparent:v.transparent,url:this.uploadUrl(id,upload,name)});
    const u=p.upload;
    // Buffers never leave the server in JSON; the browser previews them through the authenticated image route.
    return structuredClone({id,product:p.product,price:p.price,currency:p.currency,candidates:p.candidates,
      selectedImage:p.selectedImage,manuallySelected:p.manuallySelected,imageWarning:p.imageWarning,
      uploadPending:!!p.providersDeferred&&!u,
      upload:u?{id:u.id,backgroundRemoved:u.backgroundRemoved,warnings:u.warnings,choice:p.uploadChoice??null,
        original:info(u,'original',u.original),processed:u.processed?info(u,'processed',u.processed):null}:null});
  }
  /** Releases expired previews and the uploaded images they hold. */
  sweep(){
    for(const [key,entry] of this.previews)if(entry.expires<this.now()){this.dropUpload(entry);this.previews.delete(key);}
  }
  /** Diagnostics for tests and capacity checks; contains no image data. */
  stats(){
    let uploads=0,uploadBytes=0;
    for(const p of this.previews.values())if(p.upload){
      uploads++;uploadBytes+=p.upload.original.bytes+(p.upload.processed?.bytes??0);
    }
    return {previews:this.previews.size,uploads,uploadBytes};
  }
  private dropUpload(p:Preview){
    if(p.uploadChoice){p.selectedImage=undefined;p.product.imageSource=undefined;}
    p.upload=undefined;p.uploadApproval=undefined;p.uploadChoice=undefined;
  }
  private chooseVariant(p:Preview,id:string,choice:UploadChoice|undefined){
    p.uploadChoice=choice;p.usageApproval=undefined;p.product.imageUrl=undefined;
    p.manuallySelected=true;
    if(!choice||!p.upload){p.selectedImage=undefined;p.product.imageSource=undefined;return;}
    // Display-only URL: Shopify receives the verified bytes through a staged upload, never this URL.
    p.selectedImage={imageUrl:this.uploadUrl(id,p.upload,choice),source:'manual-upload',
      usagePolicy:'MANUAL_APPROVED',autoAttachAllowed:true,reason:'admin-confirmed-upload'};
    p.product.imageSource='manual-upload';
    p.imageWarning=p.upload.warnings.join(' ')||undefined;
  }
  /** Provenance and policy are always recomputed server-side; provider/client fields are never trusted. */
  private classified<T extends ProductImageCandidate>(image:T):T{
    const sourcePageHost=urlHostname(image.sourcePageUrl);
    return {...image,sourceDomain:sourcePageHost??image.sourceDomain??urlHostname(image.imageUrl),...this.policy.classify(image)};
  }
  /** Automatic selection: approved source, and either an approved domain or a confident exact-barcode match. */
  private automatic(image:ProductImageCandidate){
    const usage=this.policy.classify(image);
    return usage.autoAttachAllowed&&(usage.reason==='approved-domain'||(image.confidence??0.90)>=0.85);
  }
  private confirmed<T extends ProductImageCandidate>(image:T):T{
    return {...image,usagePolicy:'MANUAL_APPROVED',autoAttachAllowed:false,reason:'admin-confirmed'};
  }
  private record(action:string,image:ProductImageCandidate|undefined,attached:boolean){
    // Hostname only: never full image URLs (signed CDN tokens), query strings or API keys.
    this.log(image?'[image] action='+action+' provider='+safeToken(image.source)+' domain='+
      logDomain(image.sourceDomain??image.imageUrl)+' policy='+(image.usagePolicy??'UNKNOWN')+
      ' autoAttach='+(image.autoAttachAllowed===true)+' attached='+attached:
      '[image] action='+action+' provider=none attached=false');
  }
  private apply(p:Preview,image:ProductImageResult|undefined,manuallySelected=false){
    p.uploadChoice=undefined; // Choosing a provider image or "no image" deselects an upload.
    p.selectedImage=image;p.manuallySelected=manuallySelected;
    p.product.imageUrl=image?.imageUrl;p.product.imageSource=image?.source;
    p.imageWarning=image?.warning;
  }
  /**
   * options.uploadPending: the admin attached a file that will be sent next. An approved upload takes
   * priority, so the paid provider chain is not called unless the upload is later removed.
   */
  async preview(input:unknown,sellingPrice:unknown,manualImage?:unknown,manualImageApproved?:unknown,
    options:{uploadPending?:unknown}={}){
    const code=barcode(input),amount=price(sellingPrice);
    const uploadPending=options.uploadPending===true;
    if(manualImage!==undefined && typeof manualImage!=='string')throw new AppError(400,'כתובת התמונה אינה תקינה');
    const manual=uploadPending?'':typeof manualImage==='string'?manualImage.trim():'';
    // A manual image needs the admin's explicit, per-request usage confirmation.
    if(manual && manualImageApproved!==true)throw new AppError(400,APPROVAL_REQUIRED);
    const product={...await this.catalog.lookupByBarcode(code)};
    delete product.imageUrl;delete product.imageSource;
    const p:Preview={product,price:amount,currency:'',expires:this.now()+PREVIEW_TTL,candidates:[],manuallySelected:false};
    if(uploadPending){p.providersDeferred=true;p.imageWarning='התמונה שצורפה בעיבוד';}
    else await this.discover(p);
    if(!uploadPending && !p.product.imageUrl && manual){
      const checked=await this.imageValidator.validate(manual);
      const selected=this.confirmed(this.classified({imageUrl:checked.imageUrl,source:'manual',warning:checked.warning}));
      this.apply(p,selected,true);p.usageApproval=selected.imageUrl;
      this.record('manual',selected,true);
    }
    if(!uploadPending && !p.product.imageUrl)p.imageWarning=NO_IMAGE;
    p.currency=await this.shop.currency();
    this.sweep();
    if(this.previews.size>=200)throw new AppError(429,'יש יותר מדי תצוגות מקדימות פתוחות');
    const id=randomUUID();this.previews.set(id,p);return this.response(id,p);
  }
  /** Existing provider pipeline: approved → automatic, discovery-only → candidates, else none. */
  private async discover(p:Preview){
    const code=p.product.barcode,product=p.product;
    let image:ProductImageResult|null=null;
    try{
      if(this.images.discoverByBarcode){
        const discovery=await this.images.discoverByBarcode(code,{...product});
        image=discovery.image;p.candidates=discovery.candidates.slice(0,5);
      }else image=await this.images.findByBarcode(code,{...product});
      p.candidates=p.candidates.map(candidate=>this.classified(candidate));
      if(image)image=this.classified(image);
      if(image && !this.automatic(image)){
        p.candidates=[image,...p.candidates.filter(c=>c.imageUrl!==image!.imageUrl)].slice(0,5);
        this.record('discover',image,false);image=null;
      }
      if(image){
        const checked=await this.imageValidator.validate(image.imageUrl);
        // A redirect can change the host: classify the URL that will actually be used.
        const final=this.classified({...image,imageUrl:checked.imageUrl,warning:checked.warning??image.warning});
        if(this.automatic(final)){this.apply(p,final);this.record('auto-select',final,true);}
        else{p.candidates=[final,...p.candidates].slice(0,5);this.record('discover',final,false);}
      }
      const remembered=this.selectedImages.get(code);
      if(remembered){
        if(remembered.product){
          const candidate=p.candidates.find(c=>c.imageUrl===remembered.product!.imageUrl);
          // Earlier admin confirmations are never carried into a new preview; only approved picks are restored.
          if(candidate?.autoAttachAllowed){
            const checked=await this.imageValidator.validate(candidate.imageUrl);
            const restored=this.classified({...candidate,imageUrl:checked.imageUrl,warning:checked.warning??candidate.warning});
            if(restored.autoAttachAllowed)this.apply(p,restored,true);
          }
        }else this.apply(p,undefined,true);
      }
    }catch{/* Automatic lookup failures must not block manual/no-image imports. */}
  }
  private getPreview(id:unknown):Preview{
    const p=typeof id==='string'?this.previews.get(id):undefined;
    if(!p||p.expires<this.now())throw new AppError(400,'התצוגה המקדימה פגה. יש לחפש שוב');
    return p;
  }
  private assertEditable(p:Preview){
    if(p.blocked||p.outcome||p.editing||this.busy)throw new AppError(409,'לא ניתן לשנות תמונה בזמן ייבוא או לאחר יצירת המוצר');
  }
  /**
   * Accepts an uploaded file for this preview. confirmUsage is the admin's permission confirmation for
   * this exact file; any new upload first discards the previous upload and its approval.
   */
  async attachUpload(id:unknown,bytes:unknown,confirmUsage:unknown){
    const p=this.getPreview(id);
    this.assertEditable(p);
    const hadUpload=!!p.upload;
    this.dropUpload(p);
    if(hadUpload)p.imageWarning='התמונה הקודמת הוסרה';
    if(confirmUsage!==true)throw new AppError(400,APPROVAL_REQUIRED);
    this.sweep();
    if(this.stats().uploads>=this.maxUploads)throw new AppError(429,'יש יותר מדי תמונות פתוחות. יש לסיים או לבטל ייבוא קודם');
    p.editing=true;
    try{
      const upload=await this.uploads.process(bytes);
      if(this.previews.get(id as string)!==p||p.expires<this.now())throw new AppError(400,'התצוגה המקדימה פגה. יש לחפש שוב');
      p.upload=upload;
      p.uploadApproval={uploadId:upload.id,hashes:{original:upload.original.sha256,
        ...(upload.processed?{processed:upload.processed.sha256}:{})}};
      // Background-removal failure: nothing is selected until the admin picks the original or no image.
      this.chooseVariant(p,id as string,upload.processed?'processed':undefined);
      if(!upload.processed)p.imageWarning=upload.warnings.join(' ');
      this.log('[image] action=upload provider=manual-upload policy=MANUAL_APPROVED autoAttach=true backgroundRemoved='+
        upload.backgroundRemoved+' ms='+upload.timings.totalMs);
      return this.response(id as string,p);
    }finally{p.editing=false;}
  }
  /** processed/original select a variant of the current upload; none = no image; remove resumes providers. */
  async chooseUpload(id:unknown,choice:unknown,uploadId?:unknown){
    const p=this.getPreview(id);
    this.assertEditable(p);
    if(choice==='remove'){
      this.dropUpload(p);this.apply(p,undefined,false);
      if(p.providersDeferred){
        p.editing=true;
        try{p.providersDeferred=false;p.candidates=[];await this.discover(p);}finally{p.editing=false;}
      }
      if(!p.product.imageUrl)p.imageWarning=NO_IMAGE;
      return this.response(id as string,p);
    }
    if(choice==='none'){
      this.apply(p,undefined,true);p.imageWarning='המוצר ייווצר ללא תמונה';
      this.log('[image] action=select provider=none attached=false');
      return this.response(id as string,p);
    }
    if(choice!=='processed'&&choice!=='original')throw new AppError(400,'בחירת התמונה אינה תקינה');
    if(!p.upload||p.upload.id!==uploadId)throw new AppError(409,'התמונה שהועלתה השתנתה. יש לרענן את התצוגה');
    if(!p.uploadApproval||p.uploadApproval.uploadId!==p.upload.id||!p.uploadApproval.hashes[choice])
      throw new AppError(400,choice==='processed'?'אין תמונה מותאמת זמינה':APPROVAL_REQUIRED);
    this.chooseVariant(p,id as string,choice);
    return this.response(id as string,p);
  }
  /** Authenticated preview bytes for the admin UI (re-encoded output only, never the raw upload). */
  uploadImage(id:unknown,uploadId:unknown,variant:unknown){
    const p=typeof id==='string'?this.previews.get(id):undefined;
    const u=p&&p.expires>=this.now()?p.upload:undefined;
    const v=u&&u.id===uploadId?variant==='processed'?u.processed:variant==='original'?u.original:undefined:undefined;
    if(!v)throw new AppError(404,'התמונה אינה זמינה');
    return {data:v.data,mimeType:v.mimeType};
  }
  /** Final upload guard: same preview, same upload, confirmed permission and unchanged bytes. */
  private uploadFile(p:Preview){
    const choice=p.uploadChoice!,u=p.upload,approval=p.uploadApproval,v=u?.[choice];
    if(!u||!v||!approval||approval.uploadId!==u.id||approval.hashes[choice]!==v.sha256||sha256(v.data)!==v.sha256){
      this.log('[image] action=blocked provider=manual-upload attached=false');
      throw new AppError(409,NOT_ATTACHABLE);
    }
    return {data:v.data,mimeType:v.mimeType,filename:'fanakee-'+p.product.barcode+'-'+choice+'.'+v.extension};
  }
  /** confirmUsage is the admin's per-image confirmation; it only applies to this preview's candidate. */
  async selectImage(id:unknown,index:unknown,confirmUsage?:unknown){
    const p=this.getPreview(id);
    this.assertEditable(p);
    if(index!==null && (typeof index!=='number'||!Number.isInteger(index)||index<0||index>=p.candidates.length))
      throw new AppError(400,'בחירת התמונה אינה תקינה');
    const candidate=index===null?undefined:this.classified(p.candidates[index as number]);
    if(candidate && !candidate.autoAttachAllowed && confirmUsage!==true)throw new AppError(400,APPROVAL_REQUIRED);
    p.editing=true;
    try{
      if(!candidate){
        this.apply(p,undefined,true);p.usageApproval=undefined;p.imageWarning='המוצר ייווצר ללא תמונה';
        this.selectedImages.set(p.product.barcode,{product:null,lookedUpAt:Date.now()});
        this.record('select',undefined,false);
      }else{
        const checked=await this.imageValidator.validate(candidate.imageUrl);
        let selected=this.classified({...candidate,imageUrl:checked.imageUrl,warning:checked.warning??candidate.warning});
        if(selected.autoAttachAllowed)p.usageApproval=undefined;
        else{
          if(confirmUsage!==true)throw new AppError(400,APPROVAL_REQUIRED);
          selected=this.confirmed(selected);p.usageApproval=selected.imageUrl;
        }
        this.apply(p,selected,true);
        this.selectedImages.set(p.product.barcode,{product:selected,lookedUpAt:Date.now()});
        this.record('select',selected,true);
      }
      return this.response(id as string,p);
    }finally{p.editing=false;}
  }
  /** Final server-side guard: only approved or explicitly confirmed images reach Shopify. */
  private assertAttachable(p:Preview,finalUrl:string){
    const selected=p.selectedImage;
    if(!selected||selected.imageUrl!==p.product.imageUrl){this.record('blocked',selected,false);throw new AppError(409,NOT_ATTACHABLE);}
    const usage=this.policy.classify({...selected,imageUrl:finalUrl});
    const confirmed=p.usageApproval!==undefined&&p.usageApproval===selected.imageUrl&&finalUrl===selected.imageUrl;
    if(!usage.autoAttachAllowed&&!confirmed){this.record('blocked',selected,false);throw new AppError(409,NOT_ATTACHABLE);}
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
      let product=preview.product;
      if(preview.uploadChoice){
        const file=this.uploadFile(preview);
        if(!this.shop.uploadImage)throw new AppError(503,'העלאת תמונות ל-Shopify אינה זמינה');
        // Staged before the mutation: a failed upload leaves no product and can be retried.
        product={...preview.product,imageUrl:await this.shop.uploadImage(file)};
      }else if(preview.product.imageUrl){
        const checked=await this.imageValidator.validate(preview.product.imageUrl);
        this.assertAttachable(preview,checked.imageUrl);
        preview.product.imageUrl=checked.imageUrl;
      }
      preview.blocked=true;
      const created=await this.shop.create(product,preview.price);
      if(preview.uploadChoice)this.log('[image] action=import provider=manual-upload policy=MANUAL_APPROVED autoAttach=true attached=true variant='+preview.uploadChoice);
      else this.record('import',preview.product.imageUrl?preview.selectedImage:undefined,!!preview.product.imageUrl);
      return preview.outcome={duplicate:false,product:created};
    }finally{
      this.busy=false;
      // The workflow is finished (or uncertain): uploaded bytes and their approval are released.
      if(preview.outcome||preview.blocked){
        const choice=preview.uploadChoice;
        this.dropUpload(preview);
        if(choice&&preview.outcome)preview.product.imageSource='manual-upload';
      }
    }
  }
}
