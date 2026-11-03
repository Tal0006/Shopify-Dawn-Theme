import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {AppError,safeImage} from './validation.js';
import type {ValidatedImage,ImageUrlValidator} from './image-types.js';
type Address = {address:string; family:number};
type HeadersResult = {status:number; contentType?:string; location?:string;contentLength?:number;sample?:Buffer};
type Resolver = (hostname:string) => Promise<Address[]>;
type Probe = (url:URL, address:Address) => Promise<HeadersResult>;
const blocked = new BlockList();
for (const [network,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]
] as const) blocked.addSubnet(network,prefix,'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::',3,'ipv6');
blocked.addSubnet('2001::',23,'ipv6');
blocked.addSubnet('2001:db8::',32,'ipv6');
blocked.addSubnet('2002::',16,'ipv6');
export function isPublicAddress(address:string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address,'ipv4') :
    family === 6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
const resolvePublic:Resolver = hostname => lookup(hostname,{all:true});
const probeHeaders:Probe = (url,address) => new Promise((resolve,reject) => {
  let done=false;
  const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
    method:'GET',agent:false,family:address.family,signal:AbortSignal.timeout(7000),
    headers:{Range:'bytes=0-65535',Accept:'image/*'},
    lookup:(_hostname,_options,callback)=>callback(null,address.address,address.family)
  },response=>{
    const range=response.headers['content-range'];
    const total=range?.match(/\/(\d+)$/)?.[1]??response.headers['content-length'];
    const result:HeadersResult={status:response.statusCode??0,contentType:response.headers['content-type'],
      location:response.headers.location,contentLength:total===undefined?undefined:Number(total)};
    const finish=(sample?:Buffer)=>{if(done)return;done=true;resolve({...result,sample});response.destroy();};
    if(result.status<200||result.status>=300|| (result.contentLength??0)>20*1024*1024 ||
       (result.contentType && !result.contentType.toLowerCase().startsWith('image/'))){finish();return;}
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{
      const part=chunk.subarray(0,65536-size);chunks.push(part);size+=part.length;
      if(size>=65536)finish(Buffer.concat(chunks));
    });
    response.on('end',()=>finish(Buffer.concat(chunks)));
    response.on('error',error=>{if(!done){done=true;reject(error);}});
  });
  request.on('error',error=>{if(!done){done=true;reject(error);}});
  request.end();
});
/** Bounded header-only dimension reading; unknown/truncated formats remain unverified. */
export function imageDimensions(b:Buffer):{width:number;height:number}|undefined{
  if(b.length>=24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
      b.toString('ascii',12,16)==='IHDR')return {width:b.readUInt32BE(16),height:b.readUInt32BE(20)};
  if(b.length>=10 && /^GIF8[79]a$/.test(b.toString('ascii',0,6)))return {width:b.readUInt16LE(6),height:b.readUInt16LE(8)};
  if(b.length>=30 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP'){
    const type=b.toString('ascii',12,16);
    if(type==='VP8X')return {width:1+b.readUIntLE(24,3),height:1+b.readUIntLE(27,3)};
    if(type==='VP8 ' && b[23]===157 && b[24]===1 && b[25]===42)
      return {width:b.readUInt16LE(26)&16383,height:b.readUInt16LE(28)&16383};
    if(type==='VP8L' && b[20]===47){const bits=b.readUInt32LE(21);return {width:(bits&16383)+1,height:((bits>>>14)&16383)+1};}
  }
  if(b.length>=4 && b[0]===255 && b[1]===216){
    let offset=2;
    while(offset+4<=b.length){
      if(b[offset]!==255){offset++;continue;}
      while(offset<b.length && b[offset]===255)offset++;
      const marker=b[offset++];
      if(marker===undefined||marker===217||marker===218)break;
      if(marker===0 || marker===1 || (marker>=208&&marker<=216))continue;
      if(offset+2>b.length)break;
      const length=b.readUInt16BE(offset);
      if(length<2||offset+length>b.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)
        return {height:b.readUInt16BE(offset+3),width:b.readUInt16BE(offset+5)};
      offset+=length;
    }
  }
}
export class PublicImageUrlValidator implements ImageUrlValidator {
  constructor(private resolve:Resolver = resolvePublic, private probe:Probe = probeHeaders) {}
  async validate(value:unknown): Promise<ValidatedImage> {
    let candidate = safeImage(value);
    if (!candidate) throw new AppError(400, 'כתובת התמונה אינה תקינה. יש להזין כתובת HTTP או HTTPS ציבורית');
    for (let redirects = 0; redirects <= 3; redirects++) {
      const url = new URL(candidate);
      if(/\/(?:pixel|beacon|tracking|spacer)(?:[./?]|$)|1x1\.(?:gif|png)/i.test(url.pathname))
        throw new AppError(400,'כתובת התמונה נראית כמו פיקסל מעקב');
      let addresses:Address[];
      try { addresses = await this.resolve(url.hostname); }
      catch { throw new AppError(400, 'לא ניתן לאתר את כתובת התמונה'); }
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address)))
        throw new AppError(400, 'כתובת התמונה חייבת להיות ציבורית');
      let response:HeadersResult;
      try { response = await this.probe(url,addresses[0]); }
      catch { return {imageUrl:candidate,warning:'לא ניתן לאמת את תוכן התמונה כעת. יש לבדוק את המדיה בטיוטה לפני פרסום'}; }
      if ([301,302,303,307,308].includes(response.status)) {
        if (!response.location || redirects === 3) throw new AppError(400, 'הפניית כתובת התמונה אינה תקינה');
        try { candidate = safeImage(new URL(response.location,url).href); } catch { candidate = undefined; }
        if (!candidate) throw new AppError(400, 'הפניית כתובת התמונה אינה תקינה');
        continue;
      }
      // Some hosts block a bounded probe; Shopify validates the full file on import.
      if ([401,403,405,429,501].includes(response.status) || response.status >= 500)
        return {imageUrl:candidate,warning:'שרת התמונה אינו מאפשר אימות מקדים. יש לבדוק את המדיה בטיוטה לפני פרסום'};
      if (response.status < 200 || response.status >= 300)
        throw new AppError(400, 'התמונה לא נמצאה בכתובת שהוזנה');
      if (response.contentType && !/^image\/(jpeg|png|webp|gif|avif|heic|heif|bmp|tiff)(?:;|$)/i.test(response.contentType))
        throw new AppError(400, 'הכתובת אינה מפנה לקובץ תמונה נתמך');
      if(response.contentLength!==undefined && (!Number.isFinite(response.contentLength) ||
         response.contentLength<128 || response.contentLength>20*1024*1024))
        throw new AppError(400,'גודל קובץ התמונה אינו מתאים');
      if(response.sample && /^\s*(?:<!doctype\s+html|<html|<head|<body|<script)/i.test(response.sample.toString('utf8',0,512)))
        throw new AppError(400,'הכתובת מחזירה HTML ולא תמונה');
      const dimensions=response.sample?imageDimensions(response.sample):undefined;
      if(dimensions && (dimensions.width<64 || dimensions.height<64 ||
         dimensions.width>20000 || dimensions.height>20000 || dimensions.width*dimensions.height>100_000_000))
        throw new AppError(400,'התמונה קטנה מדי או גדולה מדי');
      return {imageUrl:candidate,warning:!response.contentType?'לא התקבל סוג קובץ. יש לבדוק את המדיה בטיוטה לפני פרסום':
        !dimensions?'ממדי התמונה לא אומתו. יש לבדוק את המדיה בטיוטה לפני פרסום':undefined};

    }
    throw new AppError(400, 'כתובת התמונה אינה תקינה');
  }
}
