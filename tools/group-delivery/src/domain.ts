
import {createHash} from 'node:crypto';
// Error-code contract. Every code the public /api/v1 routes can return is listed here; the storefront
// maps each one in sections/group-delivery.liquid, and tests/contract.test.ts keeps both sides aligned.
export const PUBLIC_ERROR_CODES=['INVALID_INPUT','INVALID_LOCATION','INVALID_CART','INVALID_CONTACT','INVALID_PRICE','INVALID_CART_TOTAL',
 'CART_UNAVAILABLE','SHOPIFY_UNAVAILABLE','GROUP_NOT_FOUND','GROUP_CLOSED','GROUP_FULL','GROUP_LIMIT','LOCATION_OUTSIDE_GROUP',
 'ALREADY_JOINED','MEMBER_AUTH_REQUIRED','RATE_LIMITED','INVALID_HOST','INVALID_ORIGIN','NOT_FOUND','BODY_TOO_LARGE','SERVICE_UNAVAILABLE',
 'INVALID_AREA','INVALID_COORDINATES'] as const;
// Merchant-only /admin codes; never shown on the storefront.
export const ADMIN_ERROR_CODES=['LOGIN_FAILED','ADMIN_AUTH_REQUIRED','CSRF_REQUIRED','INVALID_CONTENT_TYPE','APPROVAL_NOT_ALLOWED','AREA_EXISTS','AREA_NOT_FOUND'] as const;
export type ErrorCode=typeof PUBLIC_ERROR_CODES[number]|typeof ADMIN_ERROR_CODES[number];
export class ApiError extends Error {constructor(public status:number,public code:ErrorCode, message='לא ניתן להשלים את הבקשה. יש לבדוק את הפרטים ולנסות שוב.'){super(message)}}
export const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export const fail=(code:ErrorCode='INVALID_INPUT'):never=>{throw new ApiError(400,code)};
export function text(value:unknown,min:number,max:number):string{
 if(typeof value!=='string'||value.trim().length<min||value.trim().length>max) return fail();
 return value.trim();
}
export function agorot(value:unknown):bigint{
 if(typeof value!=='string'||!/^\d{1,7}(?:\.\d{1,2}0*)?$/.test(value))throw new ApiError(422,'INVALID_PRICE');
 const [whole,fraction='']=value.split('.');
 return BigInt(whole)*100n+BigInt(fraction.slice(0,2).padEnd(2,'0'));
}
// A server-resolved delivery area: the only grouping boundary for searches and joins.
export interface AreaPlace {areaName:string;key:string;areaId:string}
// Shared normalization for locality keys, area slugs and aliases (migrations/002 seeds use the same form).
export const localityKey=(name:string)=>name.normalize('NFKC').toLocaleLowerCase().replace(/[\s'״׳.()-]+/g,' ').trim();
export function placeName(value:unknown):string{
 const name=text(value,2,60);
 if(!/^[\p{L}\p{M}\s'״׳.()-]+$/u.test(name)||!localityKey(name))return fail('INVALID_LOCATION');
 return name;
}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function areaReference(value:unknown):string{
 if(typeof value!=='string'||!UUID.test(value))throw new ApiError(400,'INVALID_AREA','האזור שנבחר אינו זמין. בחרו אזור מהרשימה.');
 return value;
}
// Nearest-area lookups only: validated, never rounded into storage because they are never stored.
export function coordinates(body:any){
 const lat=body?.latitude,lng=body?.longitude;
 if(typeof lat!=='number'||typeof lng!=='number'||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw new ApiError(400,'INVALID_COORDINATES');
 return {lat,lng};
}
export function distance(a:{lat:number;lng:number},b:{lat:number;lng:number}):number{
 const rad=(v:number)=>v*Math.PI/180;
 const h=Math.sin(rad(b.lat-a.lat)/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(rad(b.lng-a.lng)/2)**2;
 return 6371*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
export function center(points:{lat:number;lng:number}[]){
 const xyz=points.reduce((s,p)=>{const lat=p.lat*Math.PI/180,lng=p.lng*Math.PI/180;return [s[0]+Math.cos(lat)*Math.cos(lng),s[1]+Math.cos(lat)*Math.sin(lng),s[2]+Math.sin(lat)]},[0,0,0]);
 return {lat:Math.atan2(xyz[2],Math.hypot(xyz[0],xyz[1]))*180/Math.PI,lng:Math.atan2(xyz[1],xyz[0])*180/Math.PI};
}
export interface Line {variantId:string;quantity:number}
export function lines(value:any):Line[]{
 if(!Array.isArray(value)||!value.length||value.length>30)return fail('INVALID_CART');
 const ids=new Set<string>();
 return value.map(line=>{
  const raw=String(line?.variantId||'');
  const variantId=/^[1-9]\d{0,19}$/.test(raw)?'gid://shopify/ProductVariant/'+raw:raw;
  if(!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/.test(variantId)||ids.has(variantId)||!Number.isInteger(line.quantity)||line.quantity<1||line.quantity>100)return fail('INVALID_CART');
  ids.add(variantId);return {variantId,quantity:line.quantity};
 });
}
export const publicId=(value:any)=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))return fail();return value};
export function contact(body:any){
 const email=text(body?.email,3,254).toLowerCase(),phone=text(body?.phone,8,24).replace(/[\s()-]/g,'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!/^\+?\d{8,15}$/.test(phone))return fail('INVALID_CONTACT');
 // Normalize Israeli local/international phone formats to the same duplicate key.
 return {email,phone:/^0\d{8,9}$/.test(phone)?'+972'+phone.slice(1):phone.replace(/^(?:00)?972(?=\d{8,9}$)/,'+972')};
}
