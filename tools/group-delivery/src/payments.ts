import {randomBytes,randomUUID} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,areaReference,contact,hash,lines,publicId} from './domain.js';
import {ACTIVE_MEMBER_STATUS,GROUP_CAPACITY,acceptsPledges,type Groups,type PaymentHooks} from './groups.js';
import type {CartValidator} from './shopify.js';
import type {PaymentsConfig} from './payments-config.js';
import {CardcomError,cardExpiry,type CardcomGateway,type LowProfileOutcome} from './cardcom.js';
import {ShopifyOrderError,type OrderGateway,type OrderCreateOutcome,type CreatedOrder} from './shopify-orders.js';
import {TokenVault} from './vault.js';

// Card reservation and charging for Group Delivery (Cardcom).
//
// Reservation (no charge): the shopper approves the shown amount, the service stores a PENDING_RESERVATION (not a
// member, never counted) and sends the shopper to Cardcom's hosted page (CreateTokenOnly, J2). Only a server-to-server
// GetLpResult that confirms success, CreateTokenOnly, our terminal, our LowProfileId and our ReturnValue activates it:
// then, under the coordination lock and in one transaction, the membership is created (or a withdrawn one renewed),
// the token is sealed (AES-256-GCM) and the group is recalculated. The webhook and the browser's return are only
// triggers for that check; neither is trusted. Repeated triggers are no-ops once the reservation left PENDING.
//
// Charging (after admin approval): approval creates one charge row per active card member in the same transaction
// (UNIQUE per member and group). Each row is claimed (PENDING -> IN_FLIGHT) before Cardcom is called, sent once with
// ExternalUniqTranId = charge id, and finalized from Cardcom's answer. A lost or ambiguous answer is UNKNOWN and is
// never re-sent automatically; reconciliation asks Cardcom by ExternalUniqTranId.
export const CONSENT_VERSION='cardcom-reservation-v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN=/^[a-f0-9]{64}$/;
const PRODUCT_NAME='שריון מקום במשלוח קבוצתי - ללא חיוב בשלב זה';
const unavailable=()=>new ApiError(503,'PAYMENT_UNAVAILABLE','שריון באשראי אינו זמין כרגע. נסו שוב מאוחר יותר.');
const notFound=()=>new ApiError(404,'RESERVATION_NOT_FOUND','השריון לא נמצא.');
export type ChargeSummary={state:string|null;members:number;succeeded:number;failed:number;unknown:number;pending:number;paidAgorot:number;failedAgorot:number;unknownAgorot:number;pendingAgorot:number;
 ordersCreated:number;orderFailed:number;orderUnknown:number;syncRequired:number;cancelRequired:number;ordersCanceled:number};
// The webhook payload is only a pointer: the LowProfileId (any casing, body or query). Nothing else is read from it.
export function webhookLowProfileId(...sources:unknown[]):string|null{
 for(const source of sources){
  if(!source||typeof source!=='object')continue;
  for(const [key,value] of Object.entries(source)){
   if(!/^(lowprofileid|lowprofilecode)$/i.test(key))continue;
   const text=Array.isArray(value)?value[0]:value;
   if(typeof text==='string'&&UUID.test(text.trim().toLowerCase()))return text.trim().toLowerCase();
  }
 }
 return null;
}
const withResult=(url:string,result:'success'|'failed')=>{const u=new URL(url);u.searchParams.set('gd_result',result);return u.href;};
export class Payments implements PaymentHooks {
 private vault:TokenVault|null;
 private running=new Map<string,Promise<void>>();
 private tasks=new Set<Promise<unknown>>();
 constructor(private db:Database,private groups:Groups,private shopify:CartValidator,private config:PaymentsConfig,private cardcom:CardcomGateway|null,
  private log:(line:string)=>void=line=>console.error(line),private orders:OrderGateway|null=null){
  this.vault=config.state==='ENABLED'&&config.encryptionKey?new TokenVault(config.encryptionKey):null;
 }
 /** New memberships need a card reservation (Cardcom enabled, even if misconfigured: fail closed). */
 get required(){return this.config.state!=='DISABLED';}
 /** Card reservations can actually run (Cardcom configured). */
 get reservable(){return this.config.state==='ENABLED'&&!!this.cardcom&&!!this.vault;}
 /** Charging can run: Cardcom and Shopify orders configured (no charge is ever made without its Shopify order). */
 get available(){return this.reservable&&!!this.orders;}
 private track<T>(task:Promise<T>){this.tasks.add(task);void task.finally(()=>this.tasks.delete(task)).catch(()=>undefined);return task;}
 /** Tests and graceful shutdown: wait for background charging. */
 async idle(){while(this.tasks.size)await Promise.allSettled([...this.tasks]);}

 // ---- Reservation -------------------------------------------------------------------------------------------------
 // POST /groups/reserve (groupPublicId null: the area's group, created on activation if none) or
 // POST /groups/:id/reserve. A withdrawn card member renews with their own receipt (bearer) instead of contacts.
 async reserve(groupPublicId:string|null,body:any,bearer=''){
  if(groupPublicId!==null)publicId(groupPublicId);
  if(!this.required)throw new ApiError(409,'PAYMENT_UNAVAILABLE','שריון באשראי אינו פעיל.');
  if(!this.reservable)throw unavailable();
  if(body?.consent?.accepted!==true)throw new ApiError(400,'CONSENT_REQUIRED','יש לאשר את סכום ההתחייבות לפני ההמשך.');
  const amount=body.consent.amountAgorot;
  if(!Number.isSafeInteger(amount)||amount<=0)throw new ApiError(400,'INVALID_INPUT');
  const renewing=groupPublicId!==null&&bearer!=='';
  const proof=renewing?await this.groups.member(groupPublicId!,bearer):null;
  if(proof&&proof.status===ACTIVE_MEMBER_STATUS)throw new ApiError(409,'ALREADY_JOINED','ההצטרפות שלך כבר פעילה.');
  const person=proof?null:contact(body),areaId=proof?null:areaReference(body?.areaPublicId);
  const cart=await this.shopify.validate(lines(body?.lines));
  // The approved amount must be exactly the server-validated pledge; a changed cart needs the shopper to see it first.
  if(cart.total!==BigInt(amount))throw new ApiError(409,'PLEDGE_AMOUNT_CHANGED','סכום ההתחייבות השתנה. יש לאשר את הסכום החדש לפני שנוכל להמשיך.',{newAmountAgorot:Number(cart.total)});
  const id=randomUUID(),token=proof?bearer:randomBytes(32).toString('hex');
  const expiresAt=await this.groups.locked(async db=>{
   let groupId:string|null=null;
   if(proof){
    const group=await this.groups.group(db,groupPublicId!);
    if(!acceptsPledges(group)||group.payment_mode!=='CARDCOM')throw new ApiError(409,'GROUP_CLOSED');
    const active=(await db.query('SELECT COUNT(*)::int AS n FROM group_members WHERE group_id=$1 AND status=$2',[group.id,ACTIVE_MEMBER_STATUS])).rows[0].n;
    if(active>=GROUP_CAPACITY)throw new ApiError(409,'GROUP_FULL');
    groupId=group.id;
    await db.query("UPDATE group_payment_reservations SET status='CANCELED',failure_code='SUPERSEDED',email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW() WHERE status='PENDING_RESERVATION' AND member_id=$1",[proof.id]);
   }else{
    const place=this.groups.areas.place(await this.groups.areas.resolve(db,areaId));
    // Checked now so nobody enters a card for a join that cannot happen; checked again on activation.
    const group=groupPublicId?await this.groups.group(db,groupPublicId):await this.groups.match(db,place,'CARDCOM');
    if(group)await this.groups.admissible(db,group,place,person!,'CARDCOM');
    if(groupPublicId)groupId=group.id;
    // A newer reservation for the same details replaces older pending ones, so abandoned attempts never block anybody.
    await db.query(`UPDATE group_payment_reservations SET status='CANCELED',failure_code='SUPERSEDED',email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW()
     WHERE status='PENDING_RESERVATION' AND member_id IS NULL AND (email=$1 OR phone=$2) AND (area_id=$3 OR group_id=$4)`,[person!.email,person!.phone,place.areaId,groupId]);
    await db.query(`INSERT INTO group_payment_reservations(id,status,area_id,group_id,email,phone,cart_snapshot,member_token_hash,amount_agorot,consent_at,consent_version,expires_at)
     VALUES($1,'PENDING_RESERVATION',$2,$3,$4,$5,$6::jsonb,$7,$8,NOW(),$9,NOW()+($10::int * INTERVAL '1 minute'))`,
     [id,place.areaId,groupId,person!.email,person!.phone,JSON.stringify(cart.snapshot),hash(token),cart.total.toString(),CONSENT_VERSION,this.config.reservationTtlMinutes]);
    return (await db.query('SELECT expires_at FROM group_payment_reservations WHERE id=$1',[id])).rows[0].expires_at;
   }
   await db.query(`INSERT INTO group_payment_reservations(id,status,group_id,member_id,cart_snapshot,member_token_hash,amount_agorot,consent_at,consent_version,expires_at)
    VALUES($1,'PENDING_RESERVATION',$2,$3,$4::jsonb,$5,$6,NOW(),$7,NOW()+($8::int * INTERVAL '1 minute'))`,
    [id,groupId,proof!.id,JSON.stringify(cart.snapshot),hash(token),cart.total.toString(),CONSENT_VERSION,this.config.reservationTtlMinutes]);
   return (await db.query('SELECT expires_at FROM group_payment_reservations WHERE id=$1',[id])).rows[0].expires_at;
  });
  // Cardcom is called outside the coordination lock. A failure leaves nothing behind but a failed reservation.
  let page;
  try{
   page=await this.cardcom!.createTokenReservation({reservationId:id,amountAgorot:cart.total,successUrl:withResult(this.config.successUrl!,'success'),
    failedUrl:withResult(this.config.failedUrl!,'failed'),webhookUrl:this.config.webhookUrl!,productName:PRODUCT_NAME,language:'he'});
  }catch(error){
   this.log('Group delivery card reservation page could not be created ('+(error instanceof CardcomError?error.kind:'ERROR')+').');
   await this.finishFailure(this.db,id,'PROVIDER_UNAVAILABLE',error instanceof CardcomError?error.responseCode:null);
   throw unavailable();
  }
  await this.db.query("UPDATE group_payment_reservations SET low_profile_id=$2,updated_at=NOW() WHERE id=$1 AND status='PENDING_RESERVATION'",[id,page.lowProfileId]);
  return {reservation:{id,status:'PENDING_RESERVATION',expiresAt:new Date(expiresAt).toISOString()},redirectUrl:page.url,
   ...(proof?{}:{memberToken:token}),validatedPledgeAgorot:Number(cart.total)};
 }
 private async finishFailure(db:Queryable,id:string,code:string,responseCode:number|null){
  await db.query(`UPDATE group_payment_reservations SET status='RESERVATION_FAILED',failure_code=$2,provider_response_code=$3,email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW()
   WHERE id=$1 AND status='PENDING_RESERVATION'`,[id,code,responseCode]);
 }
 private async row(id:string,token:string){
  if(typeof id!=='string'||!UUID.test(id)||!TOKEN.test(token))throw notFound();
  const row=(await this.db.query(`SELECT r.*,g.public_id AS group_public_id FROM group_payment_reservations r LEFT JOIN delivery_groups g ON g.id=r.group_id WHERE r.id=$1 AND r.member_token_hash=$2`,[id,hash(token)])).rows[0];
  if(!row)throw notFound();
  return row;
 }
 // The browser's status read after returning from Cardcom (bearer = the receipt it received from reserve). A pending
 // reservation is checked with Cardcom now (at most every 2 s), so a delayed webhook never strands the shopper.
 // returned:'failed' (the shopper came back through the failure page) ends a reservation Cardcom does not confirm.
 async status(id:string,token:string,body:any){
  let row=await this.row(id,token);
  if(row.status==='PENDING_RESERVATION'&&new Date(row.expires_at)<=new Date()){await this.groups.expire();row=await this.row(id,token);}
  if(row.status==='PENDING_RESERVATION'&&row.low_profile_id&&this.reservable&&(!row.last_checked_at||Date.now()-new Date(row.last_checked_at).getTime()>=2000)){
   try{await this.verify(row,{failedReturn:body?.returned==='failed'});}
   catch(error){if(!(error instanceof CardcomError))throw error;}
   row=await this.row(id,token);
  }
  return this.view(row);
 }
 async cancel(id:string,token:string){
  const row=await this.row(id,token);
  if(row.status==='PENDING_RESERVATION')await this.db.query(`UPDATE group_payment_reservations SET status='CANCELED',failure_code='SHOPPER_CANCELED',email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW() WHERE id=$1 AND status='PENDING_RESERVATION'`,[row.id]);
  return this.view(await this.row(id,token));
 }
 private async view(row:any){
  const reserved=['CARD_RESERVED','CONSUMED'].includes(row.status);
  return {reservation:{id:row.id,status:row.status==='CONSUMED'?'CARD_RESERVED':row.status as string,reason:row.failure_code??null,
   groupPublicId:reserved?row.group_public_id:null,expiresAt:new Date(row.expires_at).toISOString()},
   ...(reserved&&row.group_public_id?{group:await this.groups.get(row.group_public_id)}:{})};
 }
 // Cardcom webhook. Only the LowProfileId is taken from the request; everything else comes from GetLpResult.
 // Returns false for an unknown page (nothing to do). Ambiguous Cardcom failures throw, so the route answers 503 and
 // Cardcom retries.
 async webhook(lowProfileId:string|null){
  if(!lowProfileId)throw new ApiError(400,'INVALID_INPUT');
  const row=(await this.db.query('SELECT * FROM group_payment_reservations WHERE low_profile_id=$1',[lowProfileId])).rows[0];
  if(!row)return false;
  if(row.status!=='PENDING_RESERVATION')return true;
  if(!this.reservable)throw unavailable();
  await this.verify(row,{});
  return true;
 }
 private async verify(row:any,options:{failedReturn?:boolean}){
  await this.db.query('UPDATE group_payment_reservations SET last_checked_at=NOW() WHERE id=$1',[row.id]);
  let outcome:LowProfileOutcome;
  try{outcome=await this.cardcom!.getLowProfileResult(row.low_profile_id);}
  catch(error){
   this.log('Group delivery card reservation check failed ('+(error instanceof CardcomError?error.kind:'ERROR')+').');
   // INVALID_RESPONSE from GetLpResult (a mismatching terminal, operation or page) can never become a valid result.
   if(error instanceof CardcomError&&error.kind==='INVALID_RESPONSE'){await this.finishFailure(this.db,row.id,'VERIFICATION_FAILED',null);return;}
   throw error;
  }
  if(outcome.state==='PENDING'){
   if(options.failedReturn)await this.finishFailure(this.db,row.id,'NOT_COMPLETED',outcome.responseCode);
   return;
  }
  // DECLINED, or J5_NOT_ALLOWED / NOT_J2: a result that is not the J2 card check we asked for never activates.
  if(outcome.state==='FAILED'){if(outcome.reason!=='DECLINED')this.log('Group delivery card reservation refused: not a J2 card check.');await this.finishFailure(this.db,row.id,outcome.reason,outcome.responseCode);return;}
  // Our own correlation: the page must be the one we created for this reservation.
  if(outcome.returnValue!==row.id||outcome.lowProfileId!==String(row.low_profile_id).toLowerCase()){
   this.log('Group delivery card reservation result did not match its reservation.');
   await this.finishFailure(this.db,row.id,'VERIFICATION_FAILED',0);return;
  }
  // Only the token is sealed; the card expiry (not a secret) is stored as CardMonth/CardYear columns.
  const sealed=this.vault!.seal(JSON.stringify({token:outcome.token}),row.id);
  await this.activate(row.id,outcome,sealed);
 }
 private async activate(id:string,outcome:Extract<LowProfileOutcome,{state:'SUCCESS'}>,sealed:string){
  await this.groups.locked(async db=>{
   const r=(await db.query('SELECT * FROM group_payment_reservations WHERE id=$1 FOR UPDATE',[id])).rows[0];
   // Idempotent: a duplicate webhook, a concurrent status read or an expired reservation changes nothing.
   if(!r||r.status!=='PENDING_RESERVATION')return;
   const cart={total:BigInt(r.amount_agorot),snapshot:r.cart_snapshot};
   await db.query('SAVEPOINT reservation_activation');
   let group:any;
   try{
    if(r.member_id){
     // Withdrawn card member renewing: the same row and receipt, new cart, new consent, new card.
     const member=(await db.query('SELECT * FROM group_members WHERE id=$1 FOR UPDATE',[r.member_id])).rows[0];
     group=(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[member.group_id])).rows[0];
     if(!acceptsPledges(group)||group.payment_mode!=='CARDCOM')throw new ApiError(409,'GROUP_CLOSED');
     if(member.status===ACTIVE_MEMBER_STATUS)throw new ApiError(409,'ALREADY_JOINED');
     const active=(await db.query('SELECT COUNT(*)::int AS n FROM group_members WHERE group_id=$1 AND status=$2',[group.id,ACTIVE_MEMBER_STATUS])).rows[0].n;
     if(active>=GROUP_CAPACITY)throw new ApiError(409,'GROUP_FULL');
     await db.query(`UPDATE group_members SET status='PLEDGED',cart_snapshot=$2::jsonb,pledged_total_agorot=$3,approved_amount_agorot=$3,consent_at=$4,payment_status='CARD_RESERVED',
      pending_cart_snapshot=NULL,pending_amount_agorot=NULL,withdrawn_at=NULL,withdrawn_by=NULL,updated_at=NOW() WHERE id=$1`,[member.id,JSON.stringify(cart.snapshot),cart.total.toString(),r.consent_at]);
     await this.groups.recalculate(db,group);
    }else{
     const area=(await db.query('SELECT * FROM delivery_areas WHERE id=$1 AND active',[r.area_id])).rows[0];
     if(!area)throw new ApiError(400,'INVALID_AREA');
     const place=this.groups.areas.place(area);
     group=r.group_id?(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[r.group_id])).rows[0]:await this.groups.match(db,place,'CARDCOM')||await this.groups.create(db,place,'CARDCOM');
     const admitted=await this.groups.admit(db,group,place,{email:r.email,phone:r.phone},cart,{tokenHash:r.member_token_hash,card:{approvedAgorot:cart.total,consentAt:r.consent_at}});
     r.member_id=admitted.memberId;
    }
   }catch(error){
    // The join cannot happen any more (group closed, full, details already joined, area inactive): no member, no
    // group, no token kept; the card was only checked (J2), never charged.
    if(!(error instanceof ApiError)||error.status>=500)throw error;
    await db.query('ROLLBACK TO SAVEPOINT reservation_activation');
    await this.finishFailure(db,id,error.code,0);
    return;
   }
   await db.query(`UPDATE group_payment_reservations SET status='CARD_RESERVED',member_id=$2,group_id=$3,token_ciphertext=$4,token_expires_on=$5,card_last4=$6,card_brand=$7,card_exp_month=$8,card_exp_year=$9,
    provider_response_code=$10,verified_at=NOW(),email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW() WHERE id=$1`,
    [id,r.member_id,group.id,sealed,outcome.tokenExpiresOn,outcome.last4,outcome.brand,outcome.cardMonth,outcome.cardYear,outcome.responseCode]);
  });
 }
 // PaymentHooks.cancelMember: inside the withdrawal transaction.
 async cancelMember(db:Queryable,memberId:string){
  await db.query("UPDATE group_payment_reservations SET status='CANCELED',token_ciphertext=NULL,failure_code='MEMBER_WITHDREW',updated_at=NOW() WHERE member_id=$1 AND status='CARD_RESERVED'",[memberId]);
  await db.query("UPDATE group_payment_reservations SET status='CANCELED',failure_code='MEMBER_WITHDREW',email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW() WHERE member_id=$1 AND status='PENDING_RESERVATION'",[memberId]);
 }

 // ---- Charging ----------------------------------------------------------------------------------------------------
 // Approval creates one charge row per active card member (inside the approval transaction). Each row then advances
 // through persisted stages, each claimed in the database before its external call:
 //   PENDING -> ORDER_CREATING -> ORDER_CREATED     (Shopify orderCreate; ORDER_FAILED: nothing charged)
 //   ORDER_CREATED -> IN_FLIGHT -> SUCCEEDED        (Cardcom token charge; FAILED: the order stays unpaid)
 //   SUCCEEDED: shopify_payment_state NOT_STARTED -> SYNCED (orderCreateManualPayment + reference tag) or SYNC_REQUIRED
 // A lost answer is never read as a failure: ORDER_CREATING/IN_FLIGHT left behind become ORDER_UNKNOWN/UNKNOWN and are
 // resolved only by reconciliation (Shopify order search by our reference tag; Cardcom lookup by ExternalUniqTranId).
 // No stage ever runs twice for a row: an order is created only from PENDING, a charge only from ORDER_CREATED.
 //
 // PaymentHooks.prepareCharges: one row per active card member, for the amount the member counts with (never above
 // the last explicit approval: group_members constraint), with the exact approved cart copied for the order. A pending
 // unapproved cart change is discarded; it was never approved, so it is never ordered or charged.
 async prepareCharges(db:Queryable,group:any){
  const created=(await db.query(`INSERT INTO group_payment_charges(id,external_uniq_tran_id,group_id,member_id,reservation_id,amount_agorot,order_lines)
   SELECT x.id,'G'||substr(replace(x.id::text,'-',''),1,24),x.group_id,x.member_id,x.reservation_id,x.amount,x.lines FROM (
    SELECT gen_random_uuid() AS id,m.group_id,m.id AS member_id,r.id AS reservation_id,m.pledged_total_agorot AS amount,m.cart_snapshot AS lines FROM group_members m
    JOIN LATERAL (SELECT id FROM group_payment_reservations y WHERE y.member_id=m.id AND y.status='CARD_RESERVED' ORDER BY y.verified_at DESC LIMIT 1) r ON true
    WHERE m.group_id=$1 AND m.status='PLEDGED' AND m.payment_status IN ('CARD_RESERVED','CONSENT_REQUIRED') AND m.pledged_total_agorot>0) x
   ON CONFLICT (group_id,member_id) DO NOTHING RETURNING member_id`,[group.id])).rows;
  await db.query(`UPDATE group_members SET payment_status='CHARGE_PENDING',pending_cart_snapshot=NULL,pending_amount_agorot=NULL,updated_at=NOW()
   WHERE id IN (SELECT member_id FROM group_payment_charges WHERE group_id=$1 AND status='PENDING')`,[group.id]);
  return created.length;
 }
 afterApprove(groupId:string){void this.runCharges(groupId);}
 // Rows left mid-stage by a crash or restart may or may not have reached Shopify/Cardcom: never re-sent, only reconciled.
 private async recoverStale(groupId:string){
  await this.db.query("UPDATE group_payment_charges SET status='ORDER_UNKNOWN',failure_code='INTERRUPTED',updated_at=NOW() WHERE group_id=$1 AND status='ORDER_CREATING' AND started_at<NOW()-INTERVAL '2 minutes'",[groupId]);
  await this.db.query("UPDATE group_payment_charges SET status='UNKNOWN',failure_code='INTERRUPTED',updated_at=NOW() WHERE group_id=$1 AND status='IN_FLIGHT' AND started_at<NOW()-INTERVAL '2 minutes'",[groupId]);
 }
 // One processor per group per instance; across instances the per-row stage claims keep every order and charge single.
 private runCharges(groupId:string){
  const current=this.running.get(groupId);if(current)return current;
  const task=this.track((async()=>{
   try{
    if(!this.available)return;
    await this.recoverStale(groupId);
    // Each row is visited at most once per run (a row sent back to PENDING by a transient error waits for the next run).
    const ids=(await this.db.query("SELECT id FROM group_payment_charges WHERE group_id=$1 AND (status IN ('PENDING','ORDER_CREATED') OR (status='SUCCEEDED' AND shopify_payment_state<>'SYNCED') OR (status IN ('FAILED','ORDER_FAILED') AND shopify_cancel_state IN ('ORDER_CANCEL_REQUIRED','ORDER_CANCEL_REQUESTED'))) ORDER BY created_at,id",[groupId])).rows.map((r:any)=>r.id as string);
    for(const id of ids)await this.advance(id);
   }catch{this.log('Group delivery charge processing stopped unexpectedly.');}
   finally{this.running.delete(groupId);await this.refreshState(groupId).catch(()=>undefined);}
  })());
  this.running.set(groupId,task);
  return task;
 }
 private async load(id:string){return (await this.db.query('SELECT * FROM group_payment_charges WHERE id=$1',[id])).rows[0];}
 private async advance(id:string){
  let row=await this.load(id);
  if(row?.status==='PENDING'){await this.createOrder(row);row=await this.load(id);}
  if(row?.status==='ORDER_CREATED'){await this.chargeOne(row);row=await this.load(id);}
  if(row?.status==='SUCCEEDED'&&row.shopify_payment_state!=='SYNCED')await this.syncPayment(row);
  if(['FAILED','ORDER_FAILED'].includes(row?.status)&&['ORDER_CANCEL_REQUIRED','ORDER_CANCEL_REQUESTED'].includes(row.shopify_cancel_state))await this.cancelOrder(row.id);
 }
 // Stage 1: the Shopify order for the exact approved cart. Nothing is charged unless this stage reaches ORDER_CREATED.
 private async createOrder(row:any){
  const claimed=(await this.db.query("UPDATE group_payment_charges SET status='ORDER_CREATING',started_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='PENDING' RETURNING *",[row.id])).rows[0];
  if(!claimed)return;
  const back=(code:string)=>this.db.query("UPDATE group_payment_charges SET status='PENDING',failure_code=$2,updated_at=NOW() WHERE id=$1 AND status='ORDER_CREATING'",[row.id,code]);
  const snapshot=Array.isArray(claimed.order_lines)?claimed.order_lines:[];
  const orderLines=snapshot.map((line:any)=>({variantId:String(line.variantId),quantity:Number(line.quantity),unitAgorot:/^\d{1,12}$/.test(String(line.unitAgorot))?BigInt(line.unitAgorot):-1n}));
  // The order must be exactly the approved pledge: stored unit prices x quantities = the charge amount.
  if(!orderLines.length||orderLines.some((line:any)=>line.unitAgorot<=0n)||orderLines.reduce((sum:bigint,line:any)=>sum+line.unitAgorot*BigInt(line.quantity),0n)!==BigInt(claimed.amount_agorot))
   return this.orderFailed(claimed,'AMOUNT_MISMATCH');
  // Revalidated with Shopify now (availability, quantity rules, currency). Prices stay the approved ones: the
  // customer is never charged more than approved, and the order shows what was approved.
  try{await this.shopify.validate(lines(orderLines.map((line:any)=>({variantId:line.variantId,quantity:line.quantity}))));}
  catch(error){
   if(error instanceof ApiError&&error.code==='SHOPIFY_UNAVAILABLE')return back('SHOPIFY_UNAVAILABLE');
   return this.orderFailed(claimed,error instanceof ApiError?error.code:'CART_UNAVAILABLE');
  }
  const info=(await this.db.query('SELECT g.public_id,g.area_name FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE m.id=$1',[claimed.member_id])).rows[0];
  let outcome:OrderCreateOutcome;
  try{
   outcome=await this.orders!.createOrder({reference:claimed.external_uniq_tran_id,groupPublicId:info.public_id,areaName:info.area_name,
    lines:orderLines,totalAgorot:BigInt(claimed.amount_agorot)});
  }catch(error){
   // Authentication failure (bad credentials, missing write_orders, token endpoint down): no order, no charge.
   if(error instanceof ShopifyOrderError&&error.kind==='AUTH'){this.log('Group delivery Shopify Admin authentication failed; no order created, nothing charged.');return back('SHOPIFY_AUTH_FAILED');}
   if(error instanceof ShopifyOrderError&&!error.ambiguous)return back('SHOPIFY_NOT_EXECUTED');
   this.log('Group delivery Shopify order outcome unknown ('+(error instanceof ShopifyOrderError?error.kind:'ERROR')+'); reconciliation required.');
   await this.db.query("UPDATE group_payment_charges SET status='ORDER_UNKNOWN',failure_code=$2,updated_at=NOW() WHERE id=$1 AND status='ORDER_CREATING'",[row.id,error instanceof ShopifyOrderError?error.kind:'ERROR']);
   return;
  }
  if(outcome.state==='REJECTED')return this.orderFailed(claimed,outcome.code);
  await this.orderCreated(claimed,outcome.order,'ORDER_CREATING');
 }
 // Records the order. A total that differs from the approved amount is a definitive failure before any charge: never
 // charged, and the unpaid order is canceled and restocked through the same path as a FAILED charge (cancelOrder).
 private async orderCreated(row:any,order:CreatedOrder,from:'ORDER_CREATING'|'ORDER_UNKNOWN'){
  const matches=order.currency==='ILS'&&order.totalAgorot===BigInt(row.amount_agorot);
  await transaction(this.db,async db=>{
   const done=(await db.query(`UPDATE group_payment_charges SET status=$3,shopify_order_id=$4,shopify_order_name=$5,shopify_order_created_at=$6,failure_code=$7,updated_at=NOW()${matches?'':",completed_at=NOW(),shopify_cancel_state='ORDER_CANCEL_REQUIRED'"}
    WHERE id=$1 AND status=$2 RETURNING member_id`,[row.id,from,matches?'ORDER_CREATED':'ORDER_FAILED',order.id,order.name.slice(0,40),order.createdAt,matches?null:'ORDER_TOTAL_MISMATCH'])).rows[0];
   if(done&&!matches)await db.query("UPDATE group_members SET payment_status='PAYMENT_FAILED',updated_at=NOW() WHERE id=$1",[done.member_id]);
  });
  if(!matches){this.log('Group delivery Shopify order total did not match the approved amount; not charged.');await this.cancelOrder(row.id);}
 }
 private async orderFailed(row:any,code:string){
  await transaction(this.db,async db=>{
   const done=(await db.query("UPDATE group_payment_charges SET status='ORDER_FAILED',failure_code=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('ORDER_CREATING','ORDER_UNKNOWN') RETURNING member_id",[row.id,code.replace(/[^A-Z0-9_]/g,'_').slice(0,40)])).rows[0];
   // Not charged; the customer sees "the charge did not go through" and the admin sees why.
   if(done)await db.query("UPDATE group_members SET payment_status='PAYMENT_FAILED',updated_at=NOW() WHERE id=$1",[done.member_id]);
  });
 }
 // Stage 2: the Cardcom token charge, only for a row that has its Shopify order (DB constraint) and was never sent.
 private async chargeOne(row:any){
  const charge=(await this.db.query("UPDATE group_payment_charges SET status='IN_FLIGHT',attempts=attempts+1,started_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='ORDER_CREATED' AND shopify_order_id IS NOT NULL RETURNING *",[row.id])).rows[0];
  if(!charge)return;
  const reservation=(await this.db.query('SELECT id,token_ciphertext,token_expires_on,card_exp_month,card_exp_year FROM group_payment_reservations WHERE id=$1',[charge.reservation_id])).rows[0];
  if(!reservation?.token_ciphertext)return this.chargeFailed(charge,'TOKEN_UNAVAILABLE',null);
  const today=new Date(new Date().toDateString());
  if(reservation.token_expires_on!==null&&new Date(reservation.token_expires_on)<today)return this.chargeFailed(charge,'TOKEN_EXPIRED',null);
  let secret:{token:string;exp?:string};
  try{secret=JSON.parse(this.vault!.open(reservation.token_ciphertext,reservation.id));}
  catch{return this.chargeFailed(charge,'TOKEN_UNAVAILABLE',null);}
  // CardExpirationMMYY from the persisted CardMonth/CardYear (rows sealed before migration 008 carry it sealed).
  const expiry=reservation.card_exp_month!==null?cardExpiry(Number(reservation.card_exp_month),Number(reservation.card_exp_year)):null;
  const mmyy=expiry?.mmyy??(typeof secret.exp==='string'&&/^(0[1-9]|1[0-2])\d{2}$/.test(secret.exp)?secret.exp:null);
  if(!mmyy)return this.chargeFailed(charge,'CARD_EXPIRY_UNKNOWN',null);
  // A card past its expiry month is not sent (it would be declined): the order stays unpaid.
  const year=2000+Number(mmyy.slice(2)),month=Number(mmyy.slice(0,2));
  if(new Date(year,month,1)<=today)return this.chargeFailed(charge,'CARD_EXPIRED',null);
  let outcome;
  try{outcome=await this.cardcom!.chargeToken({token:secret.token,cardExpirationMMYY:mmyy,amountAgorot:BigInt(charge.amount_agorot),externalUniqTranId:charge.external_uniq_tran_id});}
  catch(error){
   this.log('Group delivery charge outcome unknown ('+(error instanceof CardcomError?error.kind:'ERROR')+'); reconciliation required.');
   return this.chargeUnknown(charge,error instanceof CardcomError?error.kind:'ERROR');
  }
  if(outcome.state==='SUCCEEDED')return this.chargeSucceeded(charge,outcome.transactionId);
  if(outcome.state==='FAILED')return this.chargeFailed(charge,'DECLINED',outcome.responseCode);
  // 608: Cardcom already has a transaction for this ExternalUniqTranId. Only a confirmed lookup counts as paid.
  try{
   const found=await this.cardcom!.findChargeByExternalId(charge.external_uniq_tran_id);
   if(found.state==='SUCCEEDED')return this.chargeSucceeded(charge,found.transactionId);
  }catch{/* stays unknown */}
  return this.chargeUnknown(charge,'DUPLICATE_UNCONFIRMED');
 }
 private async chargeSucceeded(charge:any,transactionId:number){
  await transaction(this.db,async db=>{
   const done=(await db.query(`UPDATE group_payment_charges SET status='SUCCEEDED',cardcom_transaction_id=$2,provider_response_code=0,failure_code=NULL,completed_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND status IN ('IN_FLIGHT','UNKNOWN') RETURNING *`,[charge.id,transactionId])).rows[0];
   if(!done)return;
   // The customer has been charged: CHARGED now, whatever happens to the Shopify payment record afterwards.
   await db.query("UPDATE group_members SET payment_status='CHARGED',updated_at=NOW() WHERE id=$1",[done.member_id]);
   await db.query('UPDATE delivery_groups SET paid_total_agorot=paid_total_agorot+$2,updated_at=NOW() WHERE id=$1',[done.group_id,done.amount_agorot]);
   // The token has done its job: deleted.
   await db.query("UPDATE group_payment_reservations SET status='CONSUMED',token_ciphertext=NULL,updated_at=NOW() WHERE id=$1 AND status='CARD_RESERVED'",[done.reservation_id]);
  });
 }
 private async chargeFailed(charge:any,code:string,responseCode:number|null){
  await transaction(this.db,async db=>{
   // The unpaid Shopify order is to be canceled (stock released) in the same step; no automatic resend of the charge.
   const done=(await db.query(`UPDATE group_payment_charges SET status='FAILED',failure_code=$2,provider_response_code=$3,completed_at=NOW(),updated_at=NOW(),
    shopify_cancel_state=CASE WHEN shopify_order_id IS NOT NULL THEN 'ORDER_CANCEL_REQUIRED' END WHERE id=$1 AND status='IN_FLIGHT' RETURNING member_id`,[charge.id,code,responseCode])).rows[0];
   if(done)await db.query("UPDATE group_members SET payment_status='PAYMENT_FAILED',updated_at=NOW() WHERE id=$1",[done.member_id]);
  });
  await this.cancelOrder(charge.id);
 }
 // Cancels the unpaid Shopify order of a FAILED charge and restocks it (orderCancel: DECLINED, restock, no refund, no
 // customer notification). Only FAILED rows qualify (DB constraint): never UNKNOWN, never SUCCEEDED. Idempotent: an
 // order Shopify already reports as canceled is only recorded; orderCancel is sent from ORDER_CANCEL_REQUIRED, or again
 // only if an accepted request has not completed after 10 minutes. A failure keeps the row ORDER_CANCEL_REQUIRED
 // (the Cardcom state is not touched). The stock counts as released only once Shopify reports cancelledAt.
 private async cancelOrder(chargeId:string){
  const row=await this.load(chargeId);
  if(!row||!['FAILED','ORDER_FAILED'].includes(row.status)||!row.shopify_order_id||!['ORDER_CANCEL_REQUIRED','ORDER_CANCEL_REQUESTED'].includes(row.shopify_cancel_state))return;
  const canceled=(at:string)=>this.db.query("UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCELED',shopify_canceled_at=$2,inventory_released_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('FAILED','ORDER_FAILED') AND shopify_cancel_state<>'ORDER_CANCELED'",[row.id,at]);
  try{
   const before=await this.orders!.orderState(row.shopify_order_id);
   if(before.cancelledAt)return void await canceled(before.cancelledAt);
   const stale=row.shopify_cancel_state==='ORDER_CANCEL_REQUESTED'&&(!row.shopify_cancel_requested_at||Date.now()-new Date(row.shopify_cancel_requested_at).getTime()>=10*60000);
   if(row.shopify_cancel_state==='ORDER_CANCEL_REQUIRED'||stale){
    await this.orders!.cancelOrder(row.shopify_order_id);
    await this.db.query("UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCEL_REQUESTED',shopify_cancel_requested_at=NOW(),updated_at=NOW() WHERE id=$1 AND status IN ('FAILED','ORDER_FAILED') AND shopify_cancel_state<>'ORDER_CANCELED'",[row.id]);
   }
   const after=await this.orders!.orderState(row.shopify_order_id);
   if(after.cancelledAt)await canceled(after.cancelledAt);
  }catch(error){
   // The row keeps its state: ORDER_CANCEL_REQUIRED if orderCancel was not accepted (retried by process/reconcile;
   // a request that did reach Shopify is then found canceled by the cancelledAt check), or ORDER_CANCEL_REQUESTED.
   this.log('Group delivery Shopify order cancellation failed ('+(error instanceof ShopifyOrderError?error.kind:'ERROR')+'); cancellation required.');
  }
 }
 private async chargeUnknown(charge:any,code:string){
  await this.db.query("UPDATE group_payment_charges SET status='UNKNOWN',failure_code=$2,updated_at=NOW() WHERE id=$1 AND status='IN_FLIGHT'",[charge.id,code.replace(/[^A-Z0-9_]/g,'_').slice(0,40)]);
 }
 // Stage 3: record the Cardcom payment on the Shopify order. Never charges. Safe to repeat: an order that already shows
 // PAID is not paid again, and adding the same tag twice changes nothing.
 private async syncPayment(row:any){
  try{
   const paid=(state:{financialStatus:string;outstandingAgorot:bigint})=>state.financialStatus==='PAID'&&state.outstandingAgorot===0n;
   if(!paid(await this.orders!.orderState(row.shopify_order_id))){
    await this.orders!.recordExternalPayment(row.shopify_order_id,new Date(row.completed_at??Date.now()));
    // Verified, not assumed: PAID with nothing outstanding, otherwise the row stays SYNC_REQUIRED.
    if(!paid(await this.orders!.orderState(row.shopify_order_id)))throw new ShopifyOrderError('INVALID_RESPONSE','order');
   }
   await this.orders!.addTags(row.shopify_order_id,['cardcom-tx-'+row.cardcom_transaction_id]);
   await this.db.query("UPDATE group_payment_charges SET shopify_payment_state='SYNCED',shopify_synced_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='SUCCEEDED'",[row.id]);
  }catch(error){
   this.log('Group delivery Shopify payment record failed ('+(error instanceof ShopifyOrderError?error.kind:'ERROR')+'); Shopify sync required.');
   await this.db.query("UPDATE group_payment_charges SET shopify_payment_state='SYNC_REQUIRED',updated_at=NOW() WHERE id=$1 AND status='SUCCEEDED' AND shopify_payment_state<>'SYNCED'",[row.id]);
  }
 }
 private async refreshState(groupId:string){
  const row=(await this.db.query(`SELECT COUNT(*)::int AS n,COUNT(*) FILTER (WHERE status IN ('PENDING','ORDER_CREATING','ORDER_CREATED','IN_FLIGHT'))::int AS open,
   COUNT(*) FILTER (WHERE status='SUCCEEDED' AND shopify_payment_state='SYNCED')::int AS ok FROM group_payment_charges WHERE group_id=$1`,[groupId])).rows[0];
  const state=row.open>0?'CHARGING':row.ok===row.n?'PAID':'PAYMENT_REVIEW_REQUIRED';
  await this.db.query("UPDATE delivery_groups SET payment_state=$2,updated_at=NOW() WHERE id=$1 AND payment_mode='CARDCOM' AND status='APPROVED'",[groupId,state]);
 }
 private async approvedCardGroup(groupPublicId:string){
  const group=(await this.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(groupPublicId)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  if(group.payment_mode!=='CARDCOM'||group.status!=='APPROVED')throw new ApiError(409,'APPROVAL_NOT_ALLOWED','אין חיובים לקבוצה הזאת.');
  if(!this.available)throw unavailable();
  return group;
 }
 /** Admin: continue rows that are safe to continue (PENDING, ORDER_CREATED, unsynced SUCCEEDED). Idempotent. */
 async processCharges(groupPublicId:string){
  const group=await this.approvedCardGroup(groupPublicId);
  await this.runCharges(group.id);
  return this.summary(group.id);
 }
 /** Admin reconciliation. Never creates an order and never charges:
  *  - ORDER_UNKNOWN: find the order by our reference tag; found -> ORDER_CREATED (a later "process" charges it);
  *    not found 10+ minutes after the attempt -> PENDING (a later "process" may create it);
  *  - UNKNOWN: ask Cardcom by ExternalUniqTranId; only a confirmed success changes the row (SUCCEEDED);
  *  - SUCCEEDED without a Shopify payment record: retry only the Shopify synchronization. */
 async reconcile(groupPublicId:string){
  const group=await this.approvedCardGroup(groupPublicId);
  await this.recoverStale(group.id);
  let resolved=0,ordersFound=0;
  for(const row of (await this.db.query("SELECT * FROM group_payment_charges WHERE group_id=$1 AND status='ORDER_UNKNOWN' ORDER BY created_at,id",[group.id])).rows){
   try{
    const order=await this.orders!.findOrderByReference(row.external_uniq_tran_id);
    if(order){await this.orderCreated(row,order,'ORDER_UNKNOWN');ordersFound++;}
    else await this.db.query("UPDATE group_payment_charges SET status='PENDING',failure_code='ORDER_NOT_FOUND',updated_at=NOW() WHERE id=$1 AND status='ORDER_UNKNOWN' AND updated_at<NOW()-INTERVAL '10 minutes'",[row.id]);
   }catch{this.log('Group delivery order reconciliation could not reach Shopify.');}
  }
  for(const charge of (await this.db.query("SELECT * FROM group_payment_charges WHERE group_id=$1 AND status='UNKNOWN' ORDER BY created_at,id",[group.id])).rows){
   try{const found=await this.cardcom!.findChargeByExternalId(charge.external_uniq_tran_id);if(found.state==='SUCCEEDED'){await this.chargeSucceeded(charge,found.transactionId);resolved++;}}
   catch{this.log('Group delivery charge reconciliation could not reach Cardcom.');}
  }
  let canceled=0;
  for(const row of (await this.db.query("SELECT id FROM group_payment_charges WHERE group_id=$1 AND status IN ('FAILED','ORDER_FAILED') AND shopify_cancel_state IN ('ORDER_CANCEL_REQUIRED','ORDER_CANCEL_REQUESTED') ORDER BY created_at,id",[group.id])).rows){
   await this.cancelOrder(row.id);
   if((await this.load(row.id)).shopify_cancel_state==='ORDER_CANCELED')canceled++;
  }
  let synced=0;
  for(const row of (await this.db.query("SELECT * FROM group_payment_charges WHERE group_id=$1 AND status='SUCCEEDED' AND shopify_payment_state<>'SYNCED' ORDER BY created_at,id",[group.id])).rows){
   await this.syncPayment(row);
   if((await this.load(row.id)).shopify_payment_state==='SYNCED')synced++;
  }
  await this.refreshState(group.id);
  return {resolved,ordersFound,synced,canceled,summary:await this.summary(group.id)};
 }
 async summary(groupId:string):Promise<ChargeSummary>{
  const rows=(await this.db.query(`SELECT status,shopify_payment_state AS sync,(shopify_order_id IS NOT NULL) AS ordered,shopify_cancel_state AS cancel,COUNT(*)::int AS n,COALESCE(SUM(amount_agorot),0)::bigint AS total
   FROM group_payment_charges WHERE group_id=$1 GROUP BY 1,2,3,4`,[groupId])).rows;
  const pick=(test:(r:any)=>boolean)=>rows.filter(test);
  const n=(test:(r:any)=>boolean)=>pick(test).reduce((a:number,r:any)=>a+Number(r.n),0),sum=(test:(r:any)=>boolean)=>pick(test).reduce((a:number,r:any)=>a+Number(r.total),0);
  const is=(...statuses:string[])=>(r:any)=>statuses.includes(r.status);
  const state=(await this.db.query('SELECT payment_state FROM delivery_groups WHERE id=$1',[groupId])).rows[0]?.payment_state??null;
  return {state,members:n(()=>true),succeeded:n(is('SUCCEEDED')),failed:n(is('FAILED')),unknown:n(is('UNKNOWN')),pending:n(is('PENDING','ORDER_CREATING','ORDER_CREATED','IN_FLIGHT')),
   paidAgorot:sum(is('SUCCEEDED')),failedAgorot:sum(is('FAILED')),unknownAgorot:sum(is('UNKNOWN')),pendingAgorot:sum(is('PENDING','ORDER_CREATING','ORDER_CREATED','IN_FLIGHT')),
   ordersCreated:n((r:any)=>r.ordered),orderFailed:n(is('ORDER_FAILED')),orderUnknown:n(is('ORDER_UNKNOWN')),syncRequired:n((r:any)=>r.status==='SUCCEEDED'&&r.sync!=='SYNCED'),
   cancelRequired:n((r:any)=>r.cancel==='ORDER_CANCEL_REQUIRED'||r.cancel==='ORDER_CANCEL_REQUESTED'),ordersCanceled:n((r:any)=>r.cancel==='ORDER_CANCELED')};
 }
}
