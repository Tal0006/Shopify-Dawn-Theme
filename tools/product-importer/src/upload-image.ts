import {createHash,randomUUID} from 'node:crypto';
import {availableParallelism} from 'node:os';
import sharp,{type Metadata} from 'sharp';
import {AppError} from './validation.js';

/**
 * Admin-uploaded product images. Processing is deterministic pixel work only: orientation,
 * background removal, trimming, proportional scaling and transparent padding. No generative model
 * redraws, recolours or completes the product.
 */
sharp.cache(false); // No decoded-image cache between requests.
sharp.concurrency(Math.max(1,Math.min(2,availableParallelism())));

export const UPLOAD_LIMITS=Object.freeze({
  maxBytes:10*1024*1024, maxSide:8000, maxPixels:50_000_000,
  canvas:1200, workMax:1600, originalMax:4096, smallSide:500
});
export type UploadFormat='jpeg'|'png'|'webp';
const FORMATS:Record<UploadFormat,{mimeType:string;extension:string}>={
  jpeg:{mimeType:'image/jpeg',extension:'jpg'},png:{mimeType:'image/png',extension:'png'},webp:{mimeType:'image/webp',extension:'webp'}
};
export const BACKGROUND_REMOVAL_FAILED='לא הצלחנו להסיר את הרקע אוטומטית.';
export const BACKGROUND_REMOVAL_UNCERTAIN='ייתכן שהסרת הרקע חלקית. השוו לתמונה המקורית לפני הבחירה.';
export const SMALL_IMAGE='התמונה קטנה. ייתכן שאיכות התצוגה באתר תהיה נמוכה.';

/** RGBA, 8 bits per channel. */
export interface RawImage{data:Buffer;width:number;height:number}
export interface BackgroundRemovalResult{image:RawImage;method:string;confidence:'high'|'low'}
/** Replaceable segmentation step; implementations must only change alpha, never product pixels. */
export interface BackgroundRemovalService{removeBackground(image:RawImage):Promise<BackgroundRemovalResult>}
export class BackgroundRemovalError extends Error{}
export interface UploadVariant{
  data:Buffer;mimeType:string;format:UploadFormat;extension:string;
  width:number;height:number;bytes:number;sha256:string;transparent:boolean;
}
export interface ProcessedUpload{
  id:string;original:UploadVariant;processed?:UploadVariant;backgroundRemoved:boolean;
  method?:string;warnings:string[];timings:{totalMs:number;removalMs:number};
}

/** Content sniffing; filenames and browser MIME types are never trusted. */
export function sniffImageFormat(b:Buffer):UploadFormat|undefined{
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'jpeg';
  if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))return 'png';
  if(b.length>=12&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP')return 'webp';
}
export const sha256=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

/**
 * Deterministic background remover for product photos on a plain, light or uniform backdrop.
 * Only background connected to the image border is removed, so enclosed areas (a handle's inner
 * gap) are kept rather than risking product loss. A colour-distance test plus an edge barrier
 * stops the fill at product outlines, including white bottles on white. Pixels are never
 * recoloured; only alpha changes, with a narrow anti-aliasing ramp at the outline (no erosion).
 */
export class EdgeBackgroundRemover implements BackgroundRemovalService{
  constructor(private options:{tolerance?:number;edgeThreshold?:number;minUniformBorder?:number}={}){}
  async removeBackground(input:RawImage):Promise<BackgroundRemovalResult>{
    const {width:w,height:h}=input,src=input.data,n=w*h;
    if(w<8||h<8||src.length!==n*4)throw new BackgroundRemovalError('invalid-image');
    const tolerance=this.options.tolerance??34,edgeThreshold=this.options.edgeThreshold??40;
    const border:number[]=[];
    for(let x=0;x<w;x++)border.push(x,(h-1)*w+x);
    for(let y=1;y<h-1;y++)border.push(y*w,y*w+w-1);
    // Already-cut-out images (transparent PNG/WebP) keep their own alpha.
    if(border.filter(i=>src[i*4+3]<250).length>=border.length*0.5){
      if(!src.some((v,i)=>i%4===3&&v>8))throw new BackgroundRemovalError('empty-image');
      return {image:{data:Buffer.from(src),width:w,height:h},method:'existing-alpha',confidence:'high'};
    }
    const median=(c:number)=>{const v=border.map(i=>src[i*4+c]).sort((a,b)=>a-b);return v[v.length>>1];};
    const bg=[median(0),median(1),median(2)];
    const dist=new Uint16Array(n);
    for(let i=0;i<n;i++){
      const r=src[i*4]-bg[0],g=src[i*4+1]-bg[1],b=src[i*4+2]-bg[2];
      dist[i]=Math.round(Math.sqrt(r*r+g*g+b*b));
    }
    const uniform=border.filter(i=>dist[i]<=tolerance).length/border.length;
    if(uniform<(this.options.minUniformBorder??0.6))throw new BackgroundRemovalError('background-not-uniform');
    // Local edge strength (max channel central difference); outlines block the fill.
    const edge=new Uint16Array(n);
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=y*w+x;let m=0;
      for(let c=0;c<3;c++){
        const d=Math.abs(src[(i+1)*4+c]-src[(i-1)*4+c])+Math.abs(src[(i+w)*4+c]-src[(i-w)*4+c]);
        if(d>m)m=d;
      }
      edge[i]=m;
    }
    const background=new Uint8Array(n),queue=new Int32Array(n);let head=0,tail=0;
    const visit=(i:number)=>{if(!background[i]&&dist[i]<=tolerance&&edge[i]<=edgeThreshold){background[i]=1;queue[tail++]=i;}};
    for(const i of border)visit(i);
    while(head<tail){
      const i=queue[head++],x=i%w;
      if(x>0)visit(i-1);if(x<w-1)visit(i+1);if(i>=w)visit(i-w);if(i<n-w)visit(i+w);
    }
    let removed=0;for(let i=0;i<n;i++)removed+=background[i];
    if(removed<n*0.02)throw new BackgroundRemovalError('nothing-removed');
    if(n-removed<n*0.01)throw new BackgroundRemovalError('no-product');
    const out=Buffer.from(src);
    for(let i=0;i<n;i++)if(background[i])out[i*4+3]=0;
    // Anti-aliasing ring: only background-coloured outline pixels lose alpha; distinct product pixels stay opaque.
    const low=tolerance*0.4,high=tolerance*1.2;
    const touches=(i:number,mask:Uint8Array)=>{const x=i%w;return (x>0&&mask[i-1])||(x<w-1&&mask[i+1])||(i>=w&&mask[i-w])||(i<n-w&&mask[i+w]);};
    const ring=new Uint8Array(n);
    for(let i=0;i<n;i++)if(!background[i]&&touches(i,background)){
      ring[i]=1;
      const a=dist[i]<=low?0:dist[i]>=high?255:Math.round((dist[i]-low)/(high-low)*255);
      out[i*4+3]=Math.min(out[i*4+3],a);
    }
    for(let i=0;i<n;i++)if(!background[i]&&!ring[i]&&dist[i]<=low&&touches(i,ring))out[i*4+3]=0;
    // Drop isolated dust specks (tiny components far smaller than the product).
    const label=new Int32Array(n),areas:number[]=[0];
    for(let s=0;s<n;s++){
      if(label[s]||out[s*4+3]===0)continue;
      const id=areas.length;let area=0;head=0;tail=0;queue[tail++]=s;label[s]=id;
      const add=(j:number)=>{if(!label[j]&&out[j*4+3]!==0){label[j]=id;queue[tail++]=j;}};
      while(head<tail){
        const i=queue[head++],x=i%w;area++;
        if(x>0)add(i-1);if(x<w-1)add(i+1);if(i>=w)add(i-w);if(i<n-w)add(i+w);
      }
      areas.push(area);
    }
    let largest=0;for(const area of areas)if(area>largest)largest=area;
    const minimum=Math.max(25,largest*0.005);
    for(let i=0;i<n;i++)if(label[i]&&areas[label[i]]<minimum)out[i*4+3]=0;
    return {image:{data:out,width:w,height:h},method:'edge-flood-fill',confidence:uniform>=0.85?'high':'low'};
  }
}

/**
 * Trim to the alpha bounds, scale proportionally (fit: inside, never cover/stretch/crop) and centre on
 * a transparent square canvas. Product occupancy is 80% for square items up to 88% for tall/wide ones.
 */
export async function normalizeToCanvas(image:RawImage,canvas=UPLOAD_LIMITS.canvas){
  const {data,width:w,height:h}=image;
  let left=w,top=h,right=-1,bottom=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]>=4){
    if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;
  }
  if(right<0)throw new BackgroundRemovalError('empty-result');
  const bw=right-left+1,bh=bottom-top+1,ratio=Math.max(bw/bh,bh/bw);
  const inner=Math.round(canvas*(0.80+0.08*Math.min(1,ratio-1)));
  const product=await sharp(data,{raw:{width:w,height:h,channels:4}})
    .extract({left,top,width:bw,height:bh})
    .resize({width:inner,height:inner,fit:'inside',withoutEnlargement:false})
    .raw().toBuffer({resolveWithObject:true});
  const pw=product.info.width,ph=product.info.height;
  const png=await sharp({create:{width:canvas,height:canvas,channels:4,background:{r:0,g:0,b:0,alpha:0}}})
    .composite([{input:product.data,raw:{width:pw,height:ph,channels:4},left:Math.floor((canvas-pw)/2),top:Math.floor((canvas-ph)/2)}])
    .png({compressionLevel:9,adaptiveFiltering:true}).toBuffer();
  return {data:png,width:canvas,height:canvas,product:{width:pw,height:ph,sourceWidth:bw,sourceHeight:bh}};
}

function variant(data:Buffer,format:UploadFormat,width:number,height:number,transparent:boolean):UploadVariant{
  return {data,format,...FORMATS[format],width,height,bytes:data.length,sha256:sha256(data),transparent};
}

export class ProductImageProcessor{
  private active=0;
  private waiting:(()=>void)[]=[];
  constructor(private remover:BackgroundRemovalService=new EdgeBackgroundRemover(),
    private options:{maxConcurrent?:number;maxQueue?:number}={}){}
  private async acquire(){
    if(this.active<(this.options.maxConcurrent??1)){this.active++;return;}
    if(this.waiting.length>=(this.options.maxQueue??2))throw new AppError(429,'מעבדים תמונה אחרת כעת. יש לנסות שוב בעוד רגע');
    await new Promise<void>(resolve=>this.waiting.push(resolve)); // The slot is handed over by release().
  }
  private release(){const next=this.waiting.shift();if(next)next();else this.active--;}
  async process(input:unknown):Promise<ProcessedUpload>{
    if(!Buffer.isBuffer(input)||input.length===0)throw new AppError(400,'לא התקבל קובץ תמונה');
    if(input.length>UPLOAD_LIMITS.maxBytes)throw new AppError(413,'קובץ התמונה גדול מדי. הגודל המרבי הוא 10MB');
    const format=sniffImageFormat(input);
    if(!format)throw new AppError(415,'יש לצרף תמונה בפורמט JPEG, PNG או WebP');
    await this.acquire();
    try{return await this.run(input,format);}finally{this.release();}
  }
  private async run(input:Buffer,format:UploadFormat):Promise<ProcessedUpload>{
    const started=performance.now();
    const options={limitInputPixels:UPLOAD_LIMITS.maxPixels,failOn:'error' as const,sequentialRead:true};
    let meta:Metadata;
    // Header-only read (no pixel decode), so our own size checks run before any limit-bound decode.
    try{meta=await sharp(input,{limitInputPixels:false,failOn:'error'}).metadata();}catch{throw new AppError(400,'לא ניתן לקרוא את קובץ התמונה');}
    if(meta.format!==format)throw new AppError(415,'תוכן הקובץ אינו תמונת JPEG, PNG או WebP תקינה');
    if((meta.pages??1)>1)throw new AppError(415,'תמונות מונפשות אינן נתמכות');
    if(!meta.width||!meta.height||meta.width>UPLOAD_LIMITS.maxSide||meta.height>UPLOAD_LIMITS.maxSide||
       meta.width*meta.height>UPLOAD_LIMITS.maxPixels)
      throw new AppError(413,'ממדי התמונה גדולים מדי. עד 8000 פיקסלים בכל צד ועד 50 מגה-פיקסל');
    // Decode → apply EXIF orientation → (metadata is not copied to any output) → process.
    const oriented=()=>sharp(input,options).rotate();
    let original:UploadVariant,work:RawImage;
    try{
      let encoder=oriented().resize({width:UPLOAD_LIMITS.originalMax,height:UPLOAD_LIMITS.originalMax,fit:'inside',withoutEnlargement:true})
        .toColourspace('srgb');
      encoder=format==='jpeg'?encoder.jpeg({quality:92,chromaSubsampling:'4:4:4'}):
        format==='png'?encoder.png({compressionLevel:9,adaptiveFiltering:true}):encoder.webp({quality:92,alphaQuality:100});
      const encoded=await encoder.toBuffer({resolveWithObject:true});
      const raw=await oriented().resize({width:UPLOAD_LIMITS.workMax,height:UPLOAD_LIMITS.workMax,fit:'inside',withoutEnlargement:true})
        .toColourspace('srgb').ensureAlpha().raw().toBuffer({resolveWithObject:true});
      work={data:raw.data,width:raw.info.width,height:raw.info.height};
      let transparent=false;
      if(format!=='jpeg')for(let i=3;i<work.data.length;i+=4)if(work.data[i]<255){transparent=true;break;}
      original=variant(encoded.data,format,encoded.info.width,encoded.info.height,transparent);
    }catch(error){
      if(error instanceof AppError)throw error;
      throw new AppError(400,'קובץ התמונה פגום או שאינו נתמך');
    }
    const warnings:string[]=[];
    if(Math.max(original.width,original.height)<UPLOAD_LIMITS.smallSide)warnings.push(SMALL_IMAGE);
    let processed:UploadVariant|undefined,method:string|undefined;
    const removalStarted=performance.now();
    try{
      const removed=await this.remover.removeBackground(work);
      const normalized=await normalizeToCanvas(removed.image);
      processed=variant(normalized.data,'png',normalized.width,normalized.height,true);
      method=removed.method;
      if(removed.confidence==='low')warnings.push(BACKGROUND_REMOVAL_UNCERTAIN);
    }catch{
      // Never block the import and never invent an image: the original stays available.
      warnings.push(BACKGROUND_REMOVAL_FAILED);
    }
    const removalMs=performance.now()-removalStarted;
    work.data=Buffer.alloc(0);
    return {id:randomUUID(),original,processed,backgroundRemoved:!!processed,method,warnings,
      timings:{totalMs:Math.round(performance.now()-started),removalMs:Math.round(removalMs)}};
  }
}
