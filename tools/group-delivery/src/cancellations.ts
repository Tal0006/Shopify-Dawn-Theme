import {createHash,createHmac,hkdfSync,randomInt,randomUUID} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError} from './domain.js';
import {TokenVault,parseEncryptionKey} from './vault.js';
import {audit,auditStrict} from './audit.js';
import {sender,type EmailProvider} from './email.js';

// Transaction cancellation requests ("ביטול עסקה"), submitted from the storefront form.
//  - The Israeli ID number is sealed with AES-256-GCM under a key derived (HKDF) from CANCELLATION_ENCRYPTION_KEY, a
//    dedicated secret, and bound to the row id. A second derived key makes the HMAC fingerprint used to recognise an
//    accidental double submission. The plaintext exists only while a request is validated and sealed, and when an
//    authenticated admin explicitly reveals it (audited, without the value).
//  - The ID number, name, email, phone, reason and order number are never logged, emailed, audited or returned to the
//    storefront. The public answer is a generic message plus a random, non-personal reference.
//  - Statuses are operational only (NEW -> IN_REVIEW -> COMPLETED); they never record a legal decision.
//  - Retention: with CANCELLATION_RETENTION_DAYS set, a request completed more than that many days ago has every
//    personal column cleared (purged_at). Without it nothing is ever deleted and the admin pages warn.
export const CANCELLATION_STATUSES=['NEW','IN_REVIEW','COMPLETED'] as const;
export type CancellationStatus=typeof CANCELLATION_STATUSES[number];
export const CANCELLATION_STATUS_LABELS:Record<CancellationStatus,string>={NEW:'חדשה',IN_REVIEW:'בטיפול',COMPLETED:'הטיפול הסתיים'};
// COMPLETED -> IN_REVIEW reopens a request closed by mistake (its retention clock starts again on the next completion).
const TRANSITIONS:Record<CancellationStatus,CancellationStatus[]>={NEW:['IN_REVIEW','COMPLETED'],IN_REVIEW:['COMPLETED'],COMPLETED:['IN_REVIEW']};
export const CANCELLATION_SUCCESS_MESSAGE='הבקשה התקבלה ונשלחה לטיפול.';
// A second identical submission (same ID number, email and order number) within this window returns the first
// request's reference instead of creating another request.
export const DUPLICATE_WINDOW_SECONDS=600;
export const REFERENCE=/^CR-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;
const ALPHABET='23456789ABCDEFGHJKMNPQRSTVWXYZ';
const newReference=()=>{let s='';for(let i=0;i<8;i++)s+=ALPHABET[randomInt(ALPHABET.length)];return 'CR-'+s.slice(0,4)+'-'+s.slice(4);};

export interface CancellationConfig {
 // ENABLED: the form accepts requests. DISABLED: no key configured. MISCONFIGURED: the key is invalid or not
 // dedicated. Both refuse submissions (503) while the admin pages, and retention, keep working.
 state:'ENABLED'|'DISABLED'|'MISCONFIGURED';
 problems:string[];
 key?:Buffer;
 retentionDays:number|null;
 retentionProblem:string|null;
 notifyTo:string|null;
 notifyProblem:string|null;
}
// Secrets the cancellation key must never equal (by text, or as the same 32 bytes).
const OTHER_SECRETS=['GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY','SESSION_SECRET','ADMIN_PASSWORD','SHOPIFY_STOREFRONT_PRIVATE_TOKEN','SHOPIFY_CLIENT_SECRET','SHOPIFY_ADMIN_ACCESS_TOKEN','RESEND_API_KEY','CARDCOM_API_NAME'];
// Problems name variables, never values.
export function cancellationConfig(env:NodeJS.ProcessEnv):CancellationConfig{
 const retentionText=env.CANCELLATION_RETENTION_DAYS?.trim()||'';
 let retentionDays:number|null=null,retentionProblem:string|null=null;
 if(retentionText){
  if(/^\d{1,4}$/.test(retentionText)&&Number(retentionText)>=1&&Number(retentionText)<=3650)retentionDays=Number(retentionText);
  else retentionProblem='CANCELLATION_RETENTION_DAYS must be a whole number of days between 1 and 3650. Nothing is deleted until it is fixed.';
 }
 const notifyText=env.CANCELLATION_NOTIFY_EMAIL?.trim()||'';
 let notifyTo:string|null=null,notifyProblem:string|null=null;
 if(notifyText){const parsed=/[<>]/.test(notifyText)?null:sender(notifyText);if(parsed)notifyTo=parsed.address;else notifyProblem='CANCELLATION_NOTIFY_EMAIL is not a valid email address; no notification is sent.';}
 const base={retentionDays,retentionProblem,notifyTo,notifyProblem};
 const raw=env.CANCELLATION_ENCRYPTION_KEY?.trim()||'';
 if(!raw)return {state:'DISABLED',problems:['CANCELLATION_ENCRYPTION_KEY is not set; the cancellation form refuses requests (503) until it is configured.'],...base};
 const key=parseEncryptionKey(raw),problems:string[]=[];
 if(!key)problems.push('CANCELLATION_ENCRYPTION_KEY is not 32 bytes (64 hex characters or base64).');
 for(const name of OTHER_SECRETS){
  const other=env[name]?.trim();if(!other)continue;
  const otherKey=parseEncryptionKey(other);
  if(other===raw||(key&&otherKey&&otherKey.equals(key)))problems.push('CANCELLATION_ENCRYPTION_KEY must be a dedicated key; it must not equal '+name+'.');
 }
 if(problems.length)return {state:'MISCONFIGURED',problems,...base};
 return {state:'ENABLED',problems:[],key:key!,...base};
}

// Hebrew warnings for the admin pages (names of variables only).
export function cancellationWarnings(cfg:CancellationConfig,emailAvailable:boolean):string[]{
 const warnings:string[]=[];
 if(cfg.state==='DISABLED')warnings.push('טופס ביטול העסקה באתר אינו מקבל בקשות: לא הוגדר המפתח CANCELLATION_ENCRYPTION_KEY. לקוחות מופנים לדרכי הפנייה האחרות (טלפון, דוא״ל, וואטסאפ).');
 if(cfg.state==='MISCONFIGURED')warnings.push('טופס ביטול העסקה באתר אינו מקבל בקשות: המפתח CANCELLATION_ENCRYPTION_KEY אינו תקין או שאינו מפתח ייעודי.');
 if(cfg.retentionProblem)warnings.push('תקופת השמירה של בקשות ביטול אינה תקינה (CANCELLATION_RETENTION_DAYS). בקשות אינן נמחקות עד לתיקון.');
 else if(cfg.retentionDays===null)warnings.push('לא הוגדרה תקופת שמירה לבקשות ביטול (CANCELLATION_RETENTION_DAYS). בקשות אינן נמחקות אוטומטית. יש לקבוע תקופה לאחר ייעוץ משפטי וחשבונאי.');
 if(cfg.notifyProblem)warnings.push('כתובת ההתראה על בקשות ביטול אינה תקינה (CANCELLATION_NOTIFY_EMAIL); לא נשלחות התראות.');
 else if(cfg.notifyTo&&!emailAvailable)warnings.push('הוגדרה כתובת התראה לבקשות ביטול (CANCELLATION_NOTIFY_EMAIL), אך שליחת דוא״ל אינה מוגדרת (RECOVERY_EMAIL_PROVIDER); לא נשלחות התראות.');
 return warnings;
}

class CancellationCrypto {
 private vault:TokenVault;private fingerprintKey:Buffer;
 constructor(key:Buffer){
  // Separate keys per purpose, derived from the dedicated secret.
  const derive=(purpose:string)=>Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'fankee-cancellation:'+purpose+':v1',32));
  this.vault=new TokenVault(derive('id-number-encryption'));this.fingerprintKey=derive('id-number-fingerprint');
 }
 private aad(rowId:string){return 'cancellation-request:'+rowId+':id-number';}
 seal(idNumber:string,rowId:string){return this.vault.seal(idNumber,this.aad(rowId));}
 open(sealed:string,rowId:string){return this.vault.open(sealed,this.aad(rowId));}
 fingerprint(idNumber:string){return createHmac('sha256',this.fingerprintKey).update('id-number\n'+idNumber).digest('hex');}
}

// Israeli ID number: 5-9 digits (left-padded to 9) with a valid check digit; all zeros is refused.
export function israeliId(value:string):string|null{
 if(!/^\d{5,9}$/.test(value))return null;
 const id=value.padStart(9,'0');if(/^0+$/.test(id))return null;
 let sum=0;
 for(let i=0;i<9;i++){let digit=Number(id[i])*(i%2+1);if(digit>9)digit-=9;sum+=digit;}
 return sum%10===0?id:null;
}

export type FieldProblem='REQUIRED'|'INVALID';
// Field names and problem kinds only; never the submitted values.
export class CancellationInputError extends ApiError {
 constructor(public fields:Record<string,FieldProblem>){super(400,'INVALID_CANCELLATION','לא ניתן לשלוח את הבקשה. יש לתקן את השדות המסומנים ולנסות שוב.');}
}
const FIELDS=['name','idNumber','orderNumber','email','phone','reason','submissionKey'];
// Invisible formatting characters (bidirectional controls, zero-width characters, BOM) are removed; any other control
// character, and < or >, is refused: the form accepts plain text only.
const INVISIBLE=/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]/g;
const CONTROL=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
export interface CancellationInput {name:string;idNumber:string;orderNumber:string|null;email:string;phone:string|null;reason:string|null;submissionKey:string|null}
export function parseCancellation(body:unknown):CancellationInput{
 if(!body||typeof body!=='object'||Array.isArray(body))throw new ApiError(400,'INVALID_INPUT');
 const record=body as Record<string,unknown>;
 if(Object.keys(record).some(key=>!FIELDS.includes(key)))throw new ApiError(400,'INVALID_INPUT');
 const fields:Record<string,FieldProblem>={};
 const read=(key:string,options:{required:boolean;max:number;multiline?:boolean}):string|null=>{
  const raw=record[key];
  if(raw===undefined||raw===null||raw===''){if(options.required)fields[key]='REQUIRED';return null;}
  if(typeof raw!=='string'||raw.length>options.max*2+200){fields[key]='INVALID';return null;}
  let value=raw.normalize('NFC').replace(INVISIBLE,'');
  value=options.multiline?value.replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[\t ]+/g,' ').trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim():value.replace(/\s+/g,' ').trim();
  if(!value){if(options.required)fields[key]='REQUIRED';return null;}
  if(CONTROL.test(value)||/[<>]/.test(value)||value.length>options.max){fields[key]='INVALID';return null;}
  return value;
 };
 const name=read('name',{required:true,max:120});
 if(name&&(name.length<2||!/\p{L}/u.test(name)))fields.name='INVALID';
 const idText=read('idNumber',{required:true,max:20});
 const idNumber=idText?israeliId(idText.replace(/[\s-]/g,'')):null;
 if(idText&&!idNumber)fields.idNumber='INVALID';
 const orderText=read('orderNumber',{required:false,max:32});
 const order=orderText?/^#?\s*([A-Za-z0-9-]{1,30})$/.exec(orderText)?.[1]?.toUpperCase()??null:null;
 if(orderText&&!order)fields.orderNumber='INVALID';
 const emailText=read('email',{required:true,max:254});
 const email=emailText?emailText.toLowerCase():null;
 if(email&&(email.length<3||!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)))fields.email='INVALID';
 const phoneText=read('phone',{required:false,max:30});
 const phoneDigits=phoneText?phoneText.replace(/[\s().-]/g,''):null;
 if(phoneDigits&&!/^\+?\d{8,15}$/.test(phoneDigits))fields.phone='INVALID';
 // Israeli local and international formats get the same stored form (as for Group Delivery members).
 const phone=phoneDigits&&!fields.phone?(/^0\d{8,9}$/.test(phoneDigits)?'+972'+phoneDigits.slice(1):phoneDigits.replace(/^(?:00)?972(?=\d{8,9}$)/,'+972')):null;
 const reason=read('reason',{required:false,max:2000,multiline:true});
 const key=record.submissionKey;
 if(key!==undefined&&key!==null&&(typeof key!=='string'||!/^[A-Za-z0-9-]{16,64}$/.test(key)))throw new ApiError(400,'INVALID_INPUT');
 if(Object.keys(fields).length)throw new CancellationInputError(fields);
 return {name:name!,idNumber:idNumber!,orderNumber:order,email:email!,phone,reason,submissionKey:typeof key==='string'?key:null};
}

// Admin display helpers: a minimal identifier for lists, the last two digits for the masked ID.
export const maskEmail=(email:string|null)=>{if(!email)return '';const at=email.lastIndexOf('@');return at<1?'•••':email[0]+'•••'+email.slice(at);};
export const maskId=(id:string)=>'•••••••'+id.slice(-2);
const notFound=()=>new ApiError(404,'CANCELLATION_REQUEST_NOT_FOUND','בקשת הביטול לא נמצאה.');
const unavailable=()=>new ApiError(503,'CANCELLATION_UNAVAILABLE','לא ניתן לשלוח בקשת ביטול דרך האתר כרגע.');
const iso=(value:unknown)=>value?new Date(value as string).toISOString():null;
export interface CancellationSummary {reference:string;status:CancellationStatus;createdAt:string;orderNumber:string|null;customer:string;purged:boolean}
export interface CancellationDetail extends CancellationSummary {id:string;updatedAt:string;inReviewAt:string|null;completedAt:string|null;handledBy:string|null;purgedAt:string|null;
 fullName:string|null;email:string|null;phone:string|null;reason:string|null;adminNote:string|null;maskedId:string|null;idReadable:boolean;transitions:CancellationStatus[]}

export class Cancellations {
 private crypto:CancellationCrypto|null;private pending=new Set<Promise<void>>();
 constructor(private db:Database,private cfg:CancellationConfig,private options:{email?:EmailProvider|null;adminOrigin:()=>string;log?:(line:string)=>void}){
  this.crypto=cfg.state==='ENABLED'&&cfg.key?new CancellationCrypto(cfg.key):null;
 }
 get enabled(){return this.crypto!==null;}
 get retentionDays(){return this.cfg.retentionDays;}
 get emailAvailable(){return !!this.options.email?.sendCancellationNotice;}
 warnings(){return cancellationWarnings(this.cfg,this.emailAvailable);}
 private log(line:string){(this.options.log??console.error)(line);}

 // Public submission. Idempotent: the same submission key, or the same ID number + email + order number within
 // DUPLICATE_WINDOW_SECONDS, returns the first request's reference. Nothing about other requests is revealed.
 async submit(body:unknown):Promise<{reference:string;created:boolean}>{
  const crypto=this.crypto;if(!crypto)throw unavailable();
  const input=parseCancellation(body);
  const fingerprint=crypto.fingerprint(input.idNumber);
  const keyHash=input.submissionKey?createHash('sha256').update('cancellation-submission\n'+input.submissionKey).digest('hex'):null;
  const result=await transaction(this.db,async db=>{
   // One submission at a time, so two simultaneous copies of a request cannot both pass the duplicate check.
   await db.query('SELECT pg_advisory_xact_lock(4330003)');
   if(keyHash){
    const same=(await db.query('SELECT reference,id_fingerprint FROM cancellation_requests WHERE submission_key_hash=$1',[keyHash])).rows[0];
    if(same){if(same.id_fingerprint!==fingerprint)throw new ApiError(400,'INVALID_INPUT');return {reference:same.reference as string,created:false};}
   }
   const duplicate=(await db.query("SELECT reference FROM cancellation_requests WHERE id_fingerprint=$1 AND email=$2 AND order_number IS NOT DISTINCT FROM $3 AND purged_at IS NULL AND created_at>NOW()-($4::int * INTERVAL '1 second') ORDER BY created_at DESC LIMIT 1",
    [fingerprint,input.email,input.orderNumber,DUPLICATE_WINDOW_SECONDS])).rows[0];
   if(duplicate)return {reference:duplicate.reference as string,created:false};
   const id=randomUUID();
   for(let attempt=0;attempt<8;attempt++){
    const reference=newReference();
    if((await db.query('SELECT 1 FROM cancellation_requests WHERE reference=$1',[reference])).rows.length)continue;
    await db.query('INSERT INTO cancellation_requests(id,reference,full_name,order_number,email,phone,reason,id_number_sealed,id_fingerprint,submission_key_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
     [id,reference,input.name,input.orderNumber,input.email,input.phone,input.reason,crypto.seal(input.idNumber,id),fingerprint,keyHash]);
    return {reference,created:true};
   }
   throw Error('No free cancellation reference');
  });
  if(result.created)this.notify(result.reference,new Date());
  return result;
 }
 // Sent after the answer is built; a failure is reported without any detail and never affects the request.
 private notify(reference:string,receivedAt:Date){
  const to=this.cfg.notifyTo,provider=this.options.email;
  if(!to||!provider?.sendCancellationNotice)return;
  const task:Promise<void>=provider.sendCancellationNotice({to,reference,receivedAt,adminUrl:this.options.adminOrigin()+'/admin/cancellations/'+reference,idempotencyKey:'cancellation-notice-'+reference})
   .catch(()=>this.log('Cancellation request notification email could not be delivered.'))
   .finally(()=>{this.pending.delete(task);});
  this.pending.add(task);
 }
 async idle(){await Promise.all([...this.pending]);}

 // ---- Admin (authenticated pages only).
 async list(query:any){
  const status=typeof query?.status==='string'&&(CANCELLATION_STATUSES as readonly string[]).includes(query.status)?query.status as CancellationStatus:'';
  const q=typeof query?.q==='string'?query.q.trim().slice(0,254):'';
  const pageNumber=Number.parseInt(String(query?.page??'1'),10),page=Number.isSafeInteger(pageNumber)&&pageNumber>0&&pageNumber<=100000?pageNumber:1,size=50;
  const where:string[]=[],values:any[]=[];
  if(status){values.push(status);where.push('status=$'+values.length);}
  if(q){
   // Exact matches only: a reference, an order number or an email address.
   values.push(q.toUpperCase());const ref='$'+values.length;
   values.push(q.replace(/^#\s*/,'').toUpperCase());const order='$'+values.length;
   values.push(q.toLowerCase());const email='$'+values.length;
   where.push('(reference='+ref+' OR order_number='+order+' OR email='+email+')');
  }
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const total=(await this.db.query('SELECT COUNT(*)::int AS n FROM cancellation_requests'+clause,values)).rows[0].n as number;
  const rows=(await this.db.query('SELECT reference,status,created_at,order_number,email,purged_at FROM cancellation_requests'+clause+' ORDER BY created_at DESC,reference LIMIT '+size+' OFFSET '+((page-1)*size),values)).rows;
  const counts=Object.fromEntries(CANCELLATION_STATUSES.map(s=>[s,0])) as Record<CancellationStatus,number>;
  for(const row of (await this.db.query('SELECT status,COUNT(*)::int AS n FROM cancellation_requests WHERE purged_at IS NULL GROUP BY status')).rows)counts[row.status as CancellationStatus]=row.n;
  return {requests:rows.map((row:any):CancellationSummary=>({reference:row.reference,status:row.status,createdAt:iso(row.created_at)!,orderNumber:row.order_number,customer:maskEmail(row.email),purged:!!row.purged_at})),
   counts,filters:{status,q,page},pagination:{page,pageSize:size,total,pageCount:Math.max(1,Math.ceil(total/size))}};
 }
 private async row(db:Queryable,reference:string,lock=false){
  if(typeof reference!=='string'||!REFERENCE.test(reference))throw notFound();
  const row=(await db.query('SELECT * FROM cancellation_requests WHERE reference=$1'+(lock?' FOR UPDATE':''),[reference])).rows[0];
  if(!row)throw notFound();
  return row;
 }
 // The detail never carries the full ID number: only the masked form (last two digits), when it can be opened.
 async detail(reference:string):Promise<CancellationDetail>{
  const row=await this.row(this.db,reference);
  let maskedId:string|null=null,idReadable=false;
  if(row.id_number_sealed&&this.crypto){try{maskedId=maskId(this.crypto.open(row.id_number_sealed,row.id));idReadable=true;}catch{this.log('A cancellation request ID number could not be decrypted.');}}
  const status=row.status as CancellationStatus;
  return {id:row.id,reference:row.reference,status,createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,inReviewAt:iso(row.in_review_at),completedAt:iso(row.completed_at),
   handledBy:row.handled_by,purgedAt:iso(row.purged_at),purged:!!row.purged_at,orderNumber:row.order_number,customer:maskEmail(row.email),fullName:row.full_name,email:row.email,phone:row.phone,
   reason:row.reason,adminNote:row.admin_note,maskedId,idReadable,transitions:row.purged_at?[]:TRANSITIONS[status]};
 }
 // Explicit, audited reveal (the audit row has the request id only). The caller renders it once, in a POST response.
 async revealId(reference:string,actor:string):Promise<string>{
  const row=await this.row(this.db,reference);
  const base={action:'cancellation.reveal_id' as const,actor,target:row.id as string};
  if(row.purged_at){await audit(this.db,{...base,result:'DENIED',detail:'CANCELLATION_PURGED'});throw new ApiError(409,'CANCELLATION_PURGED','הפרטים האישיים של הבקשה כבר נמחקו.');}
  if(!this.crypto||!row.id_number_sealed){await audit(this.db,{...base,result:'FAILED',detail:'CANCELLATION_UNAVAILABLE'});throw unavailable();}
  let value:string;
  try{value=this.crypto.open(row.id_number_sealed,row.id);}
  catch{await audit(this.db,{...base,result:'FAILED',detail:'DECRYPT_FAILED'});this.log('A cancellation request ID number could not be decrypted.');throw unavailable();}
  await audit(this.db,{...base,result:'OK'});
  return value;
 }
 // Status change and its audit row commit together.
 async setStatus(reference:string,next:unknown,actor:string){
  return transaction(this.db,async db=>{
   const row=await this.row(db,reference,true);
   const previous=row.status as CancellationStatus,base={action:'cancellation.status_change' as const,actor,target:row.id as string,previousStatus:previous};
   if(row.purged_at)throw new ApiError(409,'CANCELLATION_PURGED','הפרטים האישיים של הבקשה כבר נמחקו; לא ניתן לשנות אותה.');
   if(typeof next!=='string'||!(CANCELLATION_STATUSES as readonly string[]).includes(next)||!TRANSITIONS[previous].includes(next as CancellationStatus))
    throw new ApiError(409,'CANCELLATION_TRANSITION_NOT_ALLOWED','לא ניתן להעביר את הבקשה לשלב הזה.');
   const status=next as CancellationStatus;
   await db.query(`UPDATE cancellation_requests SET status=$2,updated_at=NOW(),handled_by=$3,
    in_review_at=CASE WHEN $2='IN_REVIEW' THEN COALESCE(in_review_at,NOW()) ELSE in_review_at END,
    completed_at=CASE WHEN $2='COMPLETED' THEN NOW() ELSE NULL END WHERE id=$1`,[row.id,status,actor]);
   await auditStrict(db,{...base,newStatus:status,result:'OK'});
   return {previous,status};
  });
 }
 async setNote(reference:string,note:unknown,actor:string){
  if(note!==undefined&&note!==null&&typeof note!=='string')throw new ApiError(400,'INVALID_INPUT');
  const text=typeof note==='string'?note.normalize('NFC').replace(INVISIBLE,'').replace(/\r\n?/g,'\n').trim():'';
  if(text.length>1000||CONTROL.test(text))throw new ApiError(400,'INVALID_INPUT','ההערה ארוכה מדי או מכילה תווים לא תקינים (עד 1000 תווים).');
  return transaction(this.db,async db=>{
   const row=await this.row(db,reference,true);
   if(row.purged_at)throw new ApiError(409,'CANCELLATION_PURGED','הפרטים האישיים של הבקשה כבר נמחקו; לא ניתן לשנות אותה.');
   await db.query('UPDATE cancellation_requests SET admin_note=$2,updated_at=NOW() WHERE id=$1',[row.id,text||null]);
   // The note text itself is never audited.
   await auditStrict(db,{action:'cancellation.note_update',actor,target:row.id,result:'OK',detail:text?'NOTE_SAVED':'NOTE_CLEARED'});
  });
 }
 // Retention: clears every personal column of requests completed more than retentionDays ago, in one transaction
 // with one audit row per request (id only). A no-op when no retention period is configured.
 async purgeExpired(actor='system:retention'){
  const days=this.cfg.retentionDays;
  if(days===null)return {configured:false,purged:0};
  const purged=await transaction(this.db,async db=>{
   const rows=(await db.query(`UPDATE cancellation_requests SET full_name=NULL,order_number=NULL,email=NULL,phone=NULL,reason=NULL,id_number_sealed=NULL,id_fingerprint=NULL,
    submission_key_hash=NULL,admin_note=NULL,purged_at=NOW(),updated_at=NOW()
    WHERE status='COMPLETED' AND purged_at IS NULL AND completed_at<NOW()-($1::int * INTERVAL '1 day') RETURNING id`,[days])).rows;
   for(const row of rows)await auditStrict(db,{action:'cancellation.retention_purge',actor,target:row.id,result:'OK',previousStatus:'COMPLETED',detail:'RETENTION_DAYS:'+days});
   return rows.length;
  });
  return {configured:true,purged};
 }
}
