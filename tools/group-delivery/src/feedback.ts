// Post-purchase feedback ("נשמח לשמוע איך היה"), sent by the Fankee app's Thank you page checkout UI extension
// (tools/shopify-app/extensions/post-purchase-feedback).
//
// - Authentication: the extension's Shopify session token (shopify.sessionToken.get()), a JWT signed by Shopify with
//   the app's client secret (HS256). The signature, the audience (SHOPIFY_CLIENT_ID), the shop (dest ==
//   SHOPIFY_STORE_DOMAIN) and the time claims are checked. The request Origin is never trusted: the extension runs in a
//   Web Worker whose origin Shopify does not guarantee, so CORS is open (no cookies or credentials) and the token is
//   the only proof.
// - Storage: one row per Shopify order (unique), the answers and the order identifiers only. Nothing from the token is
//   stored (its optional `sub` is a customer id). No customer name, email, phone, address, ID, payment or cart data.
// - Idempotency: a repeated submission for the same order changes nothing and gets the same generic answer, so the
//   response never tells whether an order already answered.
import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {ApiError} from './domain.js';
import {INVISIBLE,CONTROL} from './cancellations.js';
import {israelMidnight,type Page} from './admin-data.js';
import type {Database} from './db.js';

export const FEEDBACK_SUCCESS_MESSAGE='תודה! המשוב שלכם התקבל ועוזר לנו להשתפר 💚';
export const FEEDBACK_VERSION=1;
export const FEEDBACK_LIMITS={missingProductsDetails:500,problemDetails:1000,improvementFeedback:1000} as const;
export const RATING_LABELS:Record<number,string>={1:'לא נוח בכלל',2:'לא כל כך נוח',3:'בסדר',4:'נוח',5:'מצוין'};

// ---- Configuration (names variables only, never values) ----
export interface FeedbackConfig {
 state:'ENABLED'|'DISABLED'|'MISCONFIGURED';problems:string[];
 clientId:string|null;clientSecret:string|null;
 /** Exact myshopify.com hostnames whose session tokens are accepted (feedback only). */
 shops:string[];
}
/** One exact myshopify.com hostname: lowercase letters, digits and hyphens, then .myshopify.com. No wildcard, scheme, port or path. */
const SHOP_HOST=/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;
/**
 * The shops allowed to submit feedback. SHOPIFY_FEEDBACK_ALLOWED_SHOPS (comma separated, exact hostnames) replaces the
 * default; unset or blank, only the store's own SHOPIFY_STORE_DOMAIN is allowed. Entries are trimmed and lowercased; empty
 * entries (a trailing comma) are skipped. Any malformed entry refuses the whole list (null), like the other feedback
 * settings: feedback is then refused, nothing else is affected.
 */
export function feedbackAllowedShops(value:string|undefined,storeDomain:string):string[]|null{
 const text=value?.trim()||'';
 if(!text)return [storeDomain];
 const entries=text.split(',').map(entry=>entry.trim().toLowerCase()).filter(Boolean);
 if(!entries.length||entries.length>20||entries.some(entry=>!SHOP_HOST.test(entry)))return null;
 return [...new Set(entries)];
}
export function feedbackConfig(env:NodeJS.ProcessEnv,storeDomain:string):FeedbackConfig{
 const clientId=env.SHOPIFY_CLIENT_ID?.trim()||'',clientSecret=env.SHOPIFY_CLIENT_SECRET?.trim()||'';
 const allowed=feedbackAllowedShops(env.SHOPIFY_FEEDBACK_ALLOWED_SHOPS,storeDomain);
 const base={shops:allowed??[]};
 if(!clientId&&!clientSecret)return {...base,state:'DISABLED',clientId:null,clientSecret:null,
  problems:['SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (the Fankee app that owns the Thank you page extension) are not configured.']};
 const problems:string[]=[];
 if(!/^[A-Za-z0-9_-]{8,100}$/.test(clientId))problems.push('SHOPIFY_CLIENT_ID is missing or invalid.');
 if(clientSecret.length<16||clientSecret.length>200||/\s/.test(clientSecret))problems.push('SHOPIFY_CLIENT_SECRET is missing or invalid.');
 if(!allowed)problems.push('SHOPIFY_FEEDBACK_ALLOWED_SHOPS must be a comma-separated list of exact *.myshopify.com hostnames (no wildcards, schemes, ports or paths).');
 if(problems.length)return {...base,state:'MISCONFIGURED',clientId:null,clientSecret:null,problems};
 return {...base,state:'ENABLED',clientId,clientSecret,problems:[]};
}

// ---- Session token (checkout UI extension) ----
const b64url=(text:string)=>/^[A-Za-z0-9_-]+$/.test(text)?Buffer.from(text,'base64url'):null;
const json=(buffer:Buffer|null)=>{if(!buffer)return null;try{const value=JSON.parse(buffer.toString('utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}};
const hostOf=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase().replace(/^https:\/\//,'').replace(/\/.*$/,''):'';
/**
 * True only for a session token Shopify issued to this app's extension on one of the allowed shops (exact hostname
 * match on `dest`), valid now (5 s clock leeway).
 * Never throws and never reports why a token was refused.
 */
export function verifySessionToken(token:unknown,settings:{clientId:string;clientSecret:string;shops:readonly string[]},nowSeconds=Math.floor(Date.now()/1000)):boolean{
 if(typeof token!=='string'||token.length<20||token.length>4096)return false;
 const parts=token.split('.');if(parts.length!==3)return false;
 const header=json(b64url(parts[0])),payload=json(b64url(parts[1])),signature=b64url(parts[2]);
 if(!header||!payload||!signature||header.alg!=='HS256'||(header.typ!==undefined&&header.typ!=='JWT'))return false;
 const expected=createHmac('sha256',settings.clientSecret).update(parts[0]+'.'+parts[1]).digest();
 if(signature.length!==expected.length||!timingSafeEqual(signature,expected))return false;
 const audience=Array.isArray(payload.aud)?payload.aud:[payload.aud];
 if(!audience.includes(settings.clientId))return false;
 if(!settings.shops.includes(hostOf(payload.dest)))return false;
 const leeway=5,num=(value:unknown)=>typeof value==='number'&&Number.isFinite(value);
 if(!num(payload.exp)||payload.exp<=nowSeconds-leeway||payload.exp>nowSeconds+3600)return false;
 if(payload.nbf!==undefined&&(!num(payload.nbf)||payload.nbf>nowSeconds+leeway))return false;
 if(payload.iat!==undefined&&(!num(payload.iat)||payload.iat>nowSeconds+leeway))return false;
 return true;
}
/** The bearer token of an Authorization header, or null. */
export const bearerToken=(header:string|undefined)=>{const match=/^Bearer ([A-Za-z0-9_.-]{20,4096})$/.exec(header||'');return match?match[1]:null;};

// ---- Input ----
export type FeedbackField='orderId'|'confirmationNumber'|'rating'|'missingProducts'|'missingProductsDetails'|'encounteredProblem'|'problemDetails'|'improvementFeedback'|'version';
const FIELDS:readonly FeedbackField[]=['orderId','confirmationNumber','rating','missingProducts','missingProductsDetails','encounteredProblem','problemDetails','improvementFeedback','version'];
export class FeedbackInputError extends ApiError {
 constructor(public fields:Partial<Record<FeedbackField,'REQUIRED'|'INVALID'>>){super(400,'INVALID_FEEDBACK','לא ניתן לשלוח את המשוב. יש לבדוק את התשובות ולנסות שוב.');this.name='FeedbackInputError';}
}
export interface FeedbackInput {
 orderId:string;confirmationNumber:string|null;rating:number;
 missingProducts:boolean;missingProductsDetails:string|null;
 encounteredProblem:boolean;problemDetails:string|null;
 improvementFeedback:string|null;version:number;
}
// Markup is refused (a tag, comment, doctype or processing instruction); "<3" or "מחיר > 50" are plain text.
const MARKUP=/<\s*[A-Za-z!/?]/;
/** A Luhn-valid 13-19 digit run (spaces or dashes allowed) anywhere in the text: a card number never belongs in feedback. */
export function hasCardNumber(text:string){
 for(const match of text.matchAll(/\d(?:[ -]?\d){12,18}/g)){
  const digits=match[0].replace(/[ -]/g,'');let sum=0;
  for(let i=0;i<digits.length;i++){let d=Number(digits[digits.length-1-i]);if(i%2){d*=2;if(d>9)d-=9;}sum+=d;}
  if(sum%10===0)return true;
 }
 return false;
}
/** Trimmed, NFC, invisible formatting removed, runs of spaces collapsed, at most one blank line in a row. */
export function feedbackText(value:string){
 return value.normalize('NFC').replace(INVISIBLE,'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[^\S\n]+/g,' ').trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function parseFeedback(body:unknown):FeedbackInput{
 if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'INVALID_INPUT');
 const raw=body as Record<string,unknown>;
 if(Object.keys(raw).some(key=>!(FIELDS as readonly string[]).includes(key)))throw new ApiError(400,'INVALID_INPUT');
 const fields:FeedbackInputError['fields']={};
const order =
  typeof raw.orderId === 'string'
    ? /^gid:\/\/shopify\/(?:Order|OrderIdentity)\/([1-9][0-9]{0,19})$/.exec(raw.orderId.trim())
    : null; if(raw.orderId===undefined||raw.orderId===null||raw.orderId==='')fields.orderId='REQUIRED';else if(!order)fields.orderId='INVALID';
 let confirmationNumber:string|null=null;
 if(raw.confirmationNumber!==undefined&&raw.confirmationNumber!==null&&raw.confirmationNumber!==''){
  const text=typeof raw.confirmationNumber==='string'?raw.confirmationNumber.trim().toUpperCase():'';
  if(/^[A-Z0-9]{4,20}$/.test(text))confirmationNumber=text;else fields.confirmationNumber='INVALID';
 }
 if(raw.rating===undefined||raw.rating===null)fields.rating='REQUIRED';
 else if(typeof raw.rating!=='number'||!Number.isInteger(raw.rating)||raw.rating<1||raw.rating>5)fields.rating='INVALID';
 const flag=(key:'missingProducts'|'encounteredProblem')=>{
  if(raw[key]===undefined||raw[key]===null){fields[key]='REQUIRED';return false;}
  if(typeof raw[key]!=='boolean'){fields[key]='INVALID';return false;}
  return raw[key] as boolean;
 };
 const missingProducts=flag('missingProducts'),encounteredProblem=flag('encounteredProblem');
 const text=(key:'missingProductsDetails'|'problemDetails'|'improvementFeedback',allowed:boolean)=>{
  const value=raw[key];if(value===undefined||value===null)return null;
  if(typeof value!=='string'){fields[key]='INVALID';return null;}
  const normalized=feedbackText(value);if(!normalized)return null;
  // Details belong to a "yes" answer only: a "no" with details is a malformed submission, not something to keep.
  if(!allowed||CONTROL.test(normalized)||MARKUP.test(normalized)||hasCardNumber(normalized)||normalized.length>FEEDBACK_LIMITS[key]){fields[key]='INVALID';return null;}
  return normalized;
 };
 const missingProductsDetails=text('missingProductsDetails',missingProducts||fields.missingProducts!==undefined);
 const problemDetails=text('problemDetails',encounteredProblem||fields.encounteredProblem!==undefined);
 const improvementFeedback=text('improvementFeedback',true);
 let version=FEEDBACK_VERSION;
 if(raw.version!==undefined){if(typeof raw.version==='number'&&Number.isInteger(raw.version)&&raw.version>=1&&raw.version<=99)version=raw.version;else fields.version='INVALID';}
 if(Object.keys(fields).length)throw new FeedbackInputError(fields);
 return {orderId:order![1],confirmationNumber,rating:raw.rating as number,missingProducts,missingProductsDetails,encounteredProblem,problemDetails,improvementFeedback,version};
}

// ---- Admin dashboard ----
export interface FeedbackFilters {rating:string;missing:''|'yes'|'no';problem:''|'yes'|'no';from:string;to:string;page:number}
export interface FeedbackRow {createdAt:string;orderId:string;confirmationNumber:string|null;rating:number;missingProducts:boolean;missingProductsDetails:string|null;encounteredProblem:boolean;problemDetails:string|null;improvementFeedback:string|null}
export interface FeedbackSummary {responses:number;averageRating:number|null;missingPercent:number|null;problemPercent:number|null;ratingCounts:Record<1|2|3|4|5,number>}
export interface MissingProduct {text:string;count:number;lastAt:string}
export const FEEDBACK_PAGE_SIZE=50;
const DATE=/^(\d{4})-(\d{2})-(\d{2})$/;
const validDate=(value:unknown)=>{
 if(typeof value!=='string')return '';const m=DATE.exec(value);if(!m)return '';
 const d=new Date(Date.UTC(+m[1],+m[2]-1,+m[3]));return d.getUTCFullYear()===+m[1]&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[3]&&+m[1]>=2020&&+m[1]<=2100?value:'';
};
export function feedbackFilters(query:any):FeedbackFilters{
 const pick=(value:unknown)=>value==='yes'||value==='no'?value:'';
 const rating=typeof query?.rating==='string'&&/^[1-5]$/.test(query.rating)?query.rating:'';
 const page=Number.parseInt(String(query?.page??'1'),10);
 return {rating,missing:pick(query?.missing),problem:pick(query?.problem),from:validDate(query?.from),to:validDate(query?.to),page:Number.isSafeInteger(page)&&page>=1&&page<=100000?page:1};
}
/** Splits free text into separate product mentions and groups equal ones (case, spacing and edge punctuation ignored). */
export function aggregateMissingProducts(entries:{text:string;at:string}[],limit=50):MissingProduct[]{
 const groups=new Map<string,MissingProduct>();
 for(const entry of entries){
  const seen=new Set<string>();
  for(const part of entry.text.split(/[\n,،;•|]+|\s+\/\s+|\s+-\s+/)){
   const item=part.replace(/^[\s\-–—.:!?"'״׳()[\]*]+|[\s\-–—.:!?"'״׳()[\]*]+$/g,'').replace(/\s+/g,' ');
   if(item.length<2||item.length>80)continue;
   const key=item.toLocaleLowerCase('he');if(seen.has(key))continue;seen.add(key);
   const group=groups.get(key);
   if(group){group.count++;if(entry.at>group.lastAt)group.lastAt=entry.at;}
   else groups.set(key,{text:item,count:1,lastAt:entry.at});
  }
 }
 return [...groups.values()].sort((a,b)=>b.count-a.count||(a.lastAt<b.lastAt?1:a.lastAt>b.lastAt?-1:0)).slice(0,limit);
}
const iso=(value:unknown)=>value instanceof Date?value.toISOString():new Date(String(value)).toISOString();

export class Feedback {
 constructor(private db:Database,private cfg:FeedbackConfig){}
 get enabled(){return this.cfg.state==='ENABLED';}
 /** Whether a request carries a valid session token from this app's extension on this shop. */
 authenticated(authorization:string|undefined,nowSeconds?:number){
  if(!this.enabled)return false;
  return verifySessionToken(bearerToken(authorization),{clientId:this.cfg.clientId!,clientSecret:this.cfg.clientSecret!,shops:this.cfg.shops},nowSeconds);
 }
 /** Stores the first response for an order; later ones change nothing. created tells tests apart, never the client. */
 async submit(body:unknown):Promise<{created:boolean}>{
  const input=parseFeedback(body);
  const rows=(await this.db.query(`INSERT INTO post_purchase_feedback(id,shopify_order_id,confirmation_number,rating,missing_products,missing_products_details,encountered_problem,problem_details,improvement_feedback,source,version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'thank-you',$10) ON CONFLICT (shopify_order_id) DO NOTHING RETURNING id`,
   [randomUUID(),input.orderId,input.confirmationNumber,input.rating,input.missingProducts,input.missingProductsDetails,input.encounteredProblem,input.problemDetails,input.improvementFeedback,input.version])).rows;
  return {created:rows.length===1};
 }
 /** Notes for the admin pages (names variables only). */
 warnings():string[]{
  const out:string[]=[];
  const badShops=this.cfg.problems.some(problem=>problem.startsWith('SHOPIFY_FEEDBACK_ALLOWED_SHOPS'));
  if(this.cfg.state!=='ENABLED'&&(!badShops||this.cfg.problems.length>1))out.push('המשוב מעמוד התודה לא נקלט עד שיוגדרו SHOPIFY_CLIENT_ID ו־SHOPIFY_CLIENT_SECRET של אפליקציית פאנקי (האפליקציה שמכילה את התוסף).');
  if(badShops)out.push('המשוב מעמוד התודה לא נקלט: SHOPIFY_FEEDBACK_ALLOWED_SHOPS צריך להיות רשימה מופרדת בפסיקים של כתובות myshopify.com מדויקות (בלי כוכביות, https או נתיב).');
  return out;
 }
 private where(f:FeedbackFilters){
  const clauses:string[]=[],values:unknown[]=[];
  const add=(sql:string,value:unknown)=>{values.push(value);clauses.push(sql.replace('?','$'+values.length));};
  if(f.rating)add('rating=?',Number(f.rating));
  if(f.missing)add('missing_products=?',f.missing==='yes');
  if(f.problem)add('encountered_problem=?',f.problem==='yes');
  const bound=(date:string,next:boolean)=>{const [y,m,d]=date.split('-').map(Number);return israelMidnight(y,m,d+(next?1:0)).toISOString();};
  if(f.from)add('created_at>=?::timestamptz',bound(f.from,false));
  if(f.to)add('created_at<?::timestamptz',bound(f.to,true));
  return {sql:clauses.length?' WHERE '+clauses.join(' AND '):'',values};
 }
 async dashboard(query:unknown):Promise<{filters:FeedbackFilters;summary:FeedbackSummary;responses:FeedbackRow[];pagination:Page;missingProducts:MissingProduct[]}>{
  const filters=feedbackFilters(query),{sql,values}=this.where(filters);
  const s=(await this.db.query(`SELECT COUNT(*)::int AS n,COALESCE(SUM(rating),0)::int AS total,
   COUNT(*) FILTER (WHERE missing_products)::int AS missing,COUNT(*) FILTER (WHERE encountered_problem)::int AS problem,
   COUNT(*) FILTER (WHERE rating=1)::int AS r1,COUNT(*) FILTER (WHERE rating=2)::int AS r2,COUNT(*) FILTER (WHERE rating=3)::int AS r3,
   COUNT(*) FILTER (WHERE rating=4)::int AS r4,COUNT(*) FILTER (WHERE rating=5)::int AS r5 FROM post_purchase_feedback`+sql,values)).rows[0];
  const n=Number(s.n),percent=(count:number)=>n?Math.round(count/n*1000)/10:null;
  const summary:FeedbackSummary={responses:n,averageRating:n?Math.round(Number(s.total)/n*10)/10:null,missingPercent:percent(Number(s.missing)),problemPercent:percent(Number(s.problem)),
   ratingCounts:{1:Number(s.r1),2:Number(s.r2),3:Number(s.r3),4:Number(s.r4),5:Number(s.r5)}};
  const pageCount=Math.max(1,Math.ceil(n/FEEDBACK_PAGE_SIZE)),page=Math.min(filters.page,pageCount);
  const rows=(await this.db.query(`SELECT created_at,shopify_order_id,confirmation_number,rating,missing_products,missing_products_details,encountered_problem,problem_details,improvement_feedback
   FROM post_purchase_feedback`+sql+` ORDER BY created_at DESC,id DESC LIMIT ${FEEDBACK_PAGE_SIZE} OFFSET ${(page-1)*FEEDBACK_PAGE_SIZE}`,values)).rows;
  const responses=rows.map((r:any):FeedbackRow=>({createdAt:iso(r.created_at),orderId:String(r.shopify_order_id),confirmationNumber:r.confirmation_number,rating:Number(r.rating),
   missingProducts:r.missing_products,missingProductsDetails:r.missing_products_details,encounteredProblem:r.encountered_problem,problemDetails:r.problem_details,improvementFeedback:r.improvement_feedback}));
  const details=(await this.db.query(`SELECT missing_products_details,created_at FROM post_purchase_feedback`+(sql?sql+' AND ':' WHERE ')+`missing_products_details IS NOT NULL ORDER BY created_at DESC LIMIT 5000`,values)).rows;
  return {filters:{...filters,page},summary,responses,pagination:{page,pageSize:FEEDBACK_PAGE_SIZE,total:n,pageCount},
   missingProducts:aggregateMissingProducts(details.map((r:any)=>({text:String(r.missing_products_details),at:iso(r.created_at)})))};
 }
}
