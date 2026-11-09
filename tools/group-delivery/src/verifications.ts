import {randomBytes,randomUUID,createHmac,timingSafeEqual} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {ApiError,hash,contact,fail} from './domain.js';
import {MockPaymentProvider,type MockOutcome,type PaymentProvider,type VerificationNext} from './payments.js';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,TOKEN=/^[a-f0-9]{64}$/;
/** An unconsumed verification is usable for this long; joining afterwards needs a new verification. */
export const VERIFICATION_TTL_MINUTES=30;
const equalHex=(a:string,b:string)=>a.length===b.length&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
export const verificationRequired=()=>new ApiError(403,'PAYMENT_VERIFICATION_REQUIRED','יש לאמת אמצעי תשלום לפני ההצטרפות.');
export const paymentsUnavailable=()=>new ApiError(503,'PAYMENTS_UNAVAILABLE','אימות אמצעי תשלום אינו זמין כרגע. נסו שוב מאוחר יותר.');
/**
 * Payment-method verification attempts. The browser receives a public id and a one-time secret; the server keeps
 * the provider session/payment-method references, a contact digest and the secret's hash. Verification results are
 * read from the provider, never accepted from the browser.
 */
export class PaymentVerifications {
 constructor(private db:Database,readonly provider:PaymentProvider,private secret:string){}
 /** Keyed digest of the normalized contact, so a verification only works for the shopper who started it. */
 digest(person:{email:string;phone:string}){return createHmac('sha256',this.secret).update('payment-contact\n'+person.email+'\n'+person.phone).digest('hex');}
 get available(){return this.provider.name!=='none';}
 private next(next:VerificationNext):VerificationNext{
  if(next.type==='mock'&&this.provider.simulated)return {type:'mock'};
  // Real adapters must return an https URL on the provider's own host; anything else is refused, never forwarded.
  if(next.type==='redirect'){
   try{const url=new URL(next.url);if(url.protocol==='https:'&&!url.username&&!url.password&&this.provider.redirectHosts?.includes(url.hostname))return {type:'redirect',url:url.href};}catch{}
  }
  throw paymentsUnavailable();
 }
 private view(row:any){
  const expired=new Date(row.expires_at).getTime()<=Date.now();
  const status=row.consumed_at?'USED':expired&&row.status!=='FAILED'&&row.status!=='CANCELLED'?'EXPIRED':row.status;
  return {id:row.public_id as string,status:status as string,expiresAt:new Date(row.expires_at).toISOString()};
 }
 async create(body:any){
  if(!this.available)throw paymentsUnavailable();
  const person=contact(body);
  // Abandoned attempts are disposable; consumed ones stay because members reference them.
  await this.db.query("DELETE FROM payment_verifications WHERE consumed_at IS NULL AND expires_at<NOW()-INTERVAL '1 day'");
  const id=randomUUID(),publicId=randomUUID(),token=randomBytes(32).toString('hex');
  let session;
  try{session=await this.provider.createVerificationSession({reference:publicId,idempotencyKey:publicId});}
  catch(error){if(error instanceof ApiError)throw error;throw paymentsUnavailable();}
  const next=this.next(session.next);
  const row=(await this.db.query(`INSERT INTO payment_verifications(id,public_id,token_hash,contact_digest,provider,provider_session_ref,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,NOW()+($7::int * INTERVAL '1 minute')) RETURNING *`,
   [id,publicId,hash(token),this.digest(person),this.provider.name,session.sessionRef,VERIFICATION_TTL_MINUTES])).rows[0];
  return {verification:this.view(row),verificationToken:token,next};
 }
 private async authorized(db:Queryable,id:unknown,token:unknown,lock=false){
  if(typeof id!=='string'||!UUID.test(id)||typeof token!=='string'||!TOKEN.test(token))throw verificationRequired();
  const row=(await db.query('SELECT * FROM payment_verifications WHERE public_id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
  if(!row||!equalHex(hash(token),row.token_hash))throw verificationRequired();
  if(row.provider!==this.provider.name)throw paymentsUnavailable();
  return row;
 }
 /** Pulls the authoritative result from the provider for a still-pending, unexpired attempt. */
 private async sync(row:any){
  if(row.status!=='PENDING'||row.consumed_at||new Date(row.expires_at).getTime()<=Date.now())return row;
  let result;
  try{result=await this.provider.getVerificationStatus(row.provider_session_ref);}
  catch(error){if(error instanceof ApiError)throw error;throw paymentsUnavailable();}
  if(result.status==='PENDING')return row;
  const updated=result.status==='VERIFIED'
   ?(await this.db.query("UPDATE payment_verifications SET status='VERIFIED',payment_method_ref=$2,verified_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='PENDING' RETURNING *",[row.id,result.paymentMethodRef])).rows[0]
   :(await this.db.query("UPDATE payment_verifications SET status=$2,failure_code=$3,updated_at=NOW() WHERE id=$1 AND status='PENDING' RETURNING *",[row.id,result.status,result.status==='FAILED'?result.failureCode:null])).rows[0];
  return updated||(await this.db.query('SELECT * FROM payment_verifications WHERE id=$1',[row.id])).rows[0];
 }
 async status(id:unknown,token:unknown){return {verification:this.view(await this.sync(await this.authorized(this.db,id,token)))};}
 /** Development simulator only: stands in for the shopper completing the provider's hosted page. */
 async simulate(id:unknown,token:unknown,body:any){
  if(!(this.provider instanceof MockPaymentProvider)||!this.provider.simulated)throw new ApiError(404,'NOT_FOUND','העמוד לא נמצא');
  const outcome=body?.outcome as MockOutcome;
  if(!['verified','failed','cancelled'].includes(outcome))fail();
  const row=await this.authorized(this.db,id,token);
  if(row.status==='PENDING'&&!row.consumed_at&&new Date(row.expires_at).getTime()>Date.now())this.provider.simulate(row.provider_session_ref,outcome);
  return {verification:this.view(await this.sync(row))};
 }
 /**
  * Join step, inside the caller's locked transaction: the attempt must belong to this contact, be VERIFIED,
  * unexpired, unused and from the configured provider. Consumption is single-use; a rolled-back join restores it.
  */
 async consume(db:Queryable,body:any,person:{email:string;phone:string}){
  if(!this.available)throw paymentsUnavailable();
  const row=await this.authorized(db,body?.verificationId,body?.verificationToken,true);
  if(row.status!=='VERIFIED'||row.consumed_at||new Date(row.expires_at).getTime()<=Date.now()||!equalHex(this.digest(person),row.contact_digest))throw verificationRequired();
  const used=(await db.query('UPDATE payment_verifications SET consumed_at=NOW(),updated_at=NOW() WHERE id=$1 AND consumed_at IS NULL RETURNING id,verified_at',[row.id])).rows[0];
  if(!used)throw verificationRequired();
  return {id:used.id as string,verifiedAt:used.verified_at};
 }
 /** Payment-method reference for a charge; only from the provider that issued it. */
 async methodRef(db:Queryable,verificationId:string):Promise<string>{
  const row=(await db.query("SELECT provider,payment_method_ref FROM payment_verifications WHERE id=$1 AND status='VERIFIED'",[verificationId])).rows[0];
  if(!row||row.provider!==this.provider.name||!row.payment_method_ref)throw paymentsUnavailable();
  return row.payment_method_ref;
 }
}
