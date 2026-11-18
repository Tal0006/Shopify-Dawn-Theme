
import {randomBytes,randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,hash,contact,lines,publicId,distance,center,areaReference,type AreaPlace} from './domain.js';
import type {CartValidator,ValidatedCart,InspectedLine} from './shopify.js';
import {Areas,type AreaRow} from './areas.js';
import {auditStrict} from './audit.js';
// Payment mode of new groups: NONE (no card, the Phase 1 behaviour) or CARDCOM (a verified Cardcom card reservation
// is required before a membership exists). Existing groups keep the mode they were created with.
export type PaymentMode='NONE'|'CARDCOM';
// Card states in which a member is active and chargeable only after approval (see migrations/007).
export const RESERVED_PAYMENT_STATUSES=['CARD_RESERVED','CONSENT_REQUIRED'];
// Hooks the payments module provides; Groups never calls Cardcom itself.
export interface PaymentHooks {
 /** True when Cardcom is fully configured (charging possible). */
 readonly available:boolean;
 /** Inside the approval transaction: create one charge per active card member; returns the number created. */
 prepareCharges(db:Queryable,group:any):Promise<number>;
 /** After the approval commits: start charging in the background (never blocks the response). */
 afterApprove(groupId:string):void;
 /** Inside retire(): cancel the member's card reservation and delete its sealed token. */
 cancelMember(db:Queryable,memberId:string):Promise<void>;
}
export interface AdmitOptions {
 /** Hash of the receipt the browser already holds (card reservations); a fresh token is issued otherwise. */
 tokenHash?:string;
 /** Card membership: the amount the member explicitly approved and when. */
 card?:{approvedAgorot:bigint;consentAt:Date};
}
// The domain's active-member definition and the per-group limit on active members. Withdrawn rows are kept as history
// and never count toward capacity, participant counts or totals.
export const ACTIVE_MEMBER_STATUS='PLEDGED';
export const GROUP_CAPACITY=100;
// Admin delivery workflow, a separate layer over the business status. Only COMPLETED has public effect: the group is
// closed history (no matching, joins, pledge changes, withdrawals, approval or expiry rewrite) and the area's next
// first join creates a brand-new group. Order matters: forward one step at a time, backward any number of steps,
// COMPLETED only from OUT_FOR_DELIVERY and terminal.
export const OPERATIONAL_STATUSES=['NEW','IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY','COMPLETED'] as const;
export type OperationalStatus=typeof OPERATIONAL_STATUSES[number];
export const operationalTargets=(from:string):OperationalStatus[]=>{
 const i=OPERATIONAL_STATUSES.indexOf(from as OperationalStatus);
 if(i<0||from==='COMPLETED')return [];
 return OPERATIONAL_STATUSES.filter((_,j)=>j===i+1||j<i);
};
// Accepting pledges: business status OPEN/THRESHOLD_REACHED and the delivery not completed.
export const acceptsPledges=(group:{status:string;operational_status?:string})=>['OPEN','THRESHOLD_REACHED'].includes(group.status)&&group.operational_status!=='COMPLETED';
// Stores one device receipt for a membership (hash only). Shared by join and OTP recovery; never revokes another.
export async function issueToken(db:Queryable,memberId:string,source:'JOIN'|'RECOVERY',token=randomBytes(32).toString('hex')){
 await db.query('INSERT INTO member_tokens(id,member_id,token_hash,source) VALUES($1,$2,$3,$4)',[randomUUID(),memberId,hash(token),source]);
 return token;
}
export class Groups {
 payments?:PaymentHooks;
 constructor(private db:Database,private config:Pick<Config,'threshold'|'expiryDays'|'standardRadius'|'storeLocation'|'areaSuggestionRadius'>,private shopify:CartValidator,readonly areas:Areas=new Areas(db,config),private options:{paymentMode?:()=>PaymentMode}={}){}
 /** Mode required for new memberships right now. */
 paymentMode():PaymentMode{return this.options.paymentMode?.()??'NONE';}
 attachPayments(hooks:PaymentHooks){this.payments=hooks;}
 /** Coordination-locked transaction (expiry first). Shared with the payments module. */
 async locked<T>(fn:(db:Queryable)=>Promise<T>):Promise<T>{
  return transaction(this.db,async db=>{
   await db.query('SELECT id FROM group_coordination WHERE id=1 FOR UPDATE');
   await this.expire(db);
   return fn(db);
  });
 }
 // Automatic expiry ends only the customer-pledging phase (OPEN/THRESHOLD_REACHED). APPROVED groups continue through the
 // delivery workflow without a deadline; completed deliveries and already-closed groups are never rewritten.
 async expire(db:Queryable=this.db){
  await db.query("UPDATE delivery_groups SET status='EXPIRED',updated_at=NOW() WHERE expires_at<=NOW() AND status IN ('OPEN','THRESHOLD_REACHED') AND operational_status<>'COMPLETED'");
  // Abandoned card reservations (closed window, declined card, Cardcom never answered) end here: never members, never
  // counted, and their contact and cart are erased, so the same details can reserve again.
  await db.query("UPDATE group_payment_reservations SET status='EXPIRED',failure_code=COALESCE(failure_code,'ABANDONED'),email=NULL,phone=NULL,cart_snapshot=NULL,updated_at=NOW() WHERE status='PENDING_RESERVATION' AND expires_at<=NOW()");
  // An expired group will never be charged: its card reservations are canceled and the sealed tokens deleted.
  await db.query(`UPDATE group_payment_reservations r SET status='CANCELED',token_ciphertext=NULL,failure_code='GROUP_EXPIRED',updated_at=NOW()
   FROM delivery_groups g WHERE r.group_id=g.id AND g.status='EXPIRED' AND r.status='CARD_RESERVED'`);
  await db.query(`UPDATE group_members m SET payment_status='CANCELED',pending_cart_snapshot=NULL,pending_amount_agorot=NULL,updated_at=NOW()
   FROM delivery_groups g WHERE m.group_id=g.id AND g.status='EXPIRED' AND m.payment_status IN ('CARD_RESERVED','CONSENT_REQUIRED')`);
 }
 async group(db:Queryable,id:string){
  const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND');return group;
 }
 async aggregate(db:Queryable,group:any){
  const count=(await db.query("SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND status=$2",[group.id,ACTIVE_MEMBER_STATUS])).rows[0].count;
  const total=BigInt(group.pledged_total_agorot),threshold=BigInt(group.threshold_agorot);
  return {publicId:group.public_id,areaName:group.area_name,status:group.operational_status==='COMPLETED'?'COMPLETED':group.status,participantCount:Number(count),currency:'ILS',thresholdAgorot:Number(threshold),pledgedTotalAgorot:Number(total),remainingAmountAgorot:Number(total<threshold?threshold-total:0n),progressPercent:Number(total>=threshold?100n:total*100n/threshold),expiresAt:new Date(group.expires_at).toISOString(),
   // Card groups only (the public shape of groups without cards is unchanged): joining needs a Cardcom card
   // reservation, and nothing is charged until the group is approved.
   ...(group.payment_mode==='CARDCOM'?{cardReservation:true}:{})};
 }
 // The delivery area is the whole boundary. Groups without an area (pre-areas history) accept no new members.
 private fits(group:any,place:AreaPlace):boolean{return group.area_id===place.areaId;}
 async create(db:Queryable,place:AreaPlace,mode:PaymentMode=this.paymentMode()){
  // area_name/locality_key keep the area name and slug for display and admin; area groups store no coordinates.
  const group=(await db.query(`INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,expires_at,area_id,payment_mode)
   VALUES($1,$2,$3,$4,$5,NOW()+($6::int * INTERVAL '1 day'),$7,$8) RETURNING *`,
   [randomUUID(),randomUUID(),place.areaName,place.key,this.config.threshold.toString(),this.config.expiryDays,place.areaId,mode])).rows[0];
  return group;
 }
 // The area's oldest OPEN, unexpired, not completed group with active capacity. Read-only. Callers that create on a miss must run this
 // inside locked() so the check and the insert are one serialized step.
 // Only groups of the current payment mode match: while Cardcom is required, a group created without cards accepts no
 // new members (its members keep updating, withdrawing and approval as before) and the area's next join opens a card group.
 async match(db:Queryable,place:AreaPlace,mode:PaymentMode=this.paymentMode()):Promise<any|undefined>{
  return (await db.query("SELECT g.* FROM delivery_groups g WHERE area_id=$1 AND status='OPEN' AND operational_status<>'COMPLETED' AND expires_at>NOW() AND payment_mode=$4 AND (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id AND m.status=$2)<$3 ORDER BY created_at LIMIT 1",[place.areaId,ACTIVE_MEMBER_STATUS,GROUP_CAPACITY,mode])).rows[0];
 }
 // Advisory only: whether the area center lies within the store's standard delivery radius.
 private standard(area:AreaRow){return this.config.storeLocation?distance({lat:area.latitude,lng:area.longitude},this.config.storeLocation)<=this.config.standardRadius:null;}
 // Search never writes: no group creation, no expiry update, no lock. Requires a server-resolved active area.
 // A miss is reported as group:null and the first join for the area creates the group (see joinArea).
 async find(body:any){
  const area=await this.areas.resolve(this.db,body?.areaPublicId);
  const cart=body?.lines===undefined?undefined:await this.shopify.validate(lines(body.lines));
  const group=await this.match(this.db,this.areas.place(area));
  return {group:group?await this.aggregate(this.db,group):null,canCreateOnJoin:!group,withinStandardRadius:this.standard(area),...(cart?{validatedPledgeAgorot:Number(cart.total)}:{}),
   // Present only while joining (or starting) this area's group needs a card reservation.
   ...(this.paymentMode()==='CARDCOM'?{cardReservationRequired:true}:{})};
 }
 async get(id:string){return this.locked(async db=>this.aggregate(db,await this.group(db,id)));}
 async recalculate(db:Queryable,group:any){
  const rows=(await db.query("SELECT pledged_total_agorot,approx_lat,approx_lng FROM group_members WHERE group_id=$1 AND status=$2",[group.id,ACTIVE_MEMBER_STATUS])).rows;
  const total=rows.reduce((sum:bigint,row:any)=>sum+BigInt(row.pledged_total_agorot),0n);
  if(total>1000000000n)throw new ApiError(422,'GROUP_LIMIT');
  // Pre-areas coordinate groups keep their anchor/center bookkeeping while existing members update or withdraw.
  let next={lat:group.anchor_lat,lng:group.anchor_lng};
  const located=rows.filter((row:any)=>row.approx_lat!==null&&row.approx_lng!==null);
  if(group.anchor_lat!==null&&located.length)next=center(located.map((row:any)=>({lat:row.approx_lat,lng:row.approx_lng})));
  const updated=(await db.query('UPDATE delivery_groups SET pledged_total_agorot=$1,center_lat=$2,center_lng=$3,status=$4,updated_at=NOW() WHERE id=$5 RETURNING *',
   [total.toString(),next.lat,next.lng,total>=BigInt(group.threshold_agorot)?'THRESHOLD_REACHED':'OPEN',group.id])).rows[0];
  return this.aggregate(db,updated);
 }
 // Every admission rule except the insert; must run inside locked(). Shared by free joins, card reservations (checked
 // up front so a shopper is not sent to Cardcom for a join that cannot happen) and card activation (checked again).
 async admissible(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},mode:PaymentMode){
  if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
  // A group only takes members of its own payment mode (no free joins into a card group, no card joins into an old one).
  if(group.payment_mode!==mode)throw new ApiError(409,'GROUP_CLOSED');
  if(!this.fits(group,place))throw new ApiError(409,'LOCATION_OUTSIDE_GROUP','המיקום אינו מתאים לקבוצה הזאת. חפשו קבוצה באזור שלכם.');
  const members=(await db.query('SELECT email,phone,status FROM group_members WHERE group_id=$1',[group.id])).rows;
  // Capacity counts active (PLEDGED) members only; withdrawn rows are history and hold no slot.
  if(members.filter(member=>member.status===ACTIVE_MEMBER_STATUS).length>=GROUP_CAPACITY)throw new ApiError(409,'GROUP_FULL');
  // Any existing row with this email or phone, withdrawn or not, refuses a new join. A withdrawn member returns only
  // through their receipt (update-pledge); email + phone alone never reactivate a row or issue a token (no OTP yet).
  if(members.some(member=>member.email===person.email||member.phone===person.phone))throw new ApiError(409,'ALREADY_JOINED','לא ניתן להצטרף שוב עם אותם פרטים. לעדכון הסל השתמשו באישור ההצטרפות הקיים.');
 }
 // Shared membership insert; must run inside locked(). Every rule applies to new and existing groups alike.
 // Members store no coordinates. A card membership (options.card) is created only from a verified Cardcom reservation.
 async admit(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},cart:ValidatedCart,options:AdmitOptions={}){
  await this.admissible(db,group,place,person,options.card?'CARDCOM':'NONE');
  const token=options.tokenHash?null:randomBytes(32).toString('hex'),tokenHash=options.tokenHash??hash(token!),memberId=randomUUID();
  const card=options.card;
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash,payment_status,approved_amount_agorot,consent_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
   [memberId,group.id,person.email,person.phone,place.key,JSON.stringify(cart.snapshot),cart.total.toString(),tokenHash,card?'CARD_RESERVED':null,card?card.approvedAgorot.toString():null,card?card.consentAt:null]);
  // The join receipt is this membership's first device receipt (member_tokens); a recovery adds another one.
  await db.query('INSERT INTO member_tokens(id,member_id,token_hash,source) VALUES($1,$2,$3,$4)',[randomUUID(),memberId,tokenHash,'JOIN']);
  return {memberId,group:await this.recalculate(db,group),memberToken:token,validatedPledgeAgorot:Number(cart.total)};
 }
 private async enroll(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},cart:ValidatedCart){
  const {group:aggregate,memberToken,validatedPledgeAgorot}=await this.admit(db,group,place,person,cart);
  return {group:aggregate,memberToken:memberToken!,validatedPledgeAgorot};
 }
 // While Cardcom is required, a membership starts only through a card reservation (POST .../reserve).
 private freeJoinAllowed(){if(this.paymentMode()==='CARDCOM')throw new ApiError(409,'CARD_RESERVATION_REQUIRED','כדי לשריין מקום במשלוח הקבוצתי יש להזין כרטיס אשראי. לא יתבצע חיוב כעת.');}
 // Join a specific group the shopper was shown in their selected area.
 async join(id:string,body:any){
  publicId(id);this.freeJoinAllowed();
  const areaId=areaReference(body?.areaPublicId),person=contact(body),cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const place=this.areas.place(await this.areas.resolve(db,areaId));
   return this.enroll(db,await this.group(db,id),place,person,cart);
  });
 }
 // Join the area's group, creating it only now. Under the coordination lock: expire, resolve the area (it must still
 // be active), re-match (another shopper may have created the group since the search), create on a miss, insert the
 // first member. A failure at any step rolls back the transaction, so a group never exists without its first member.
 async joinArea(body:any){
  this.freeJoinAllowed();
  const areaId=areaReference(body?.areaPublicId),person=contact(body),cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const place=this.areas.place(await this.areas.resolve(db,areaId));
   const existing=await this.match(db,place);
   const group=existing||await this.create(db,place);
   return {...await this.enroll(db,group,place,person,cart),created:!existing};
  });
 }
 // The member behind a receipt (group public id + bearer token). Runs before any Shopify request or lock. A member can
 // hold several device receipts (member_tokens: the join receipt plus one per recovery); any unrevoked one is accepted.
 // The join receipt is also matched on group_members.token_hash, so a join written by the previous release during a
 // rolling deploy (before member_tokens existed) still authenticates; a revoked member_tokens row always wins.
 async member(id:string,token:string){
  publicId(id);if(!/^[a-f0-9]{64}$/.test(token))throw new ApiError(401,'MEMBER_AUTH_REQUIRED');
  const row=(await this.db.query(`SELECT m.id,m.status,m.pledged_total_agorot,m.cart_snapshot,m.payment_status,m.approved_amount_agorot,m.pending_amount_agorot,g.payment_mode,
   (SELECT r.card_last4 FROM group_payment_reservations r WHERE r.member_id=m.id AND r.status='CARD_RESERVED' ORDER BY r.verified_at DESC LIMIT 1) AS card_last4,
   (SELECT r.card_brand FROM group_payment_reservations r WHERE r.member_id=m.id AND r.status='CARD_RESERVED' ORDER BY r.verified_at DESC LIMIT 1) AS card_brand
   FROM group_members m JOIN delivery_groups g ON m.group_id=g.id
   WHERE g.public_id=$1 AND (m.token_hash=$2 OR EXISTS(SELECT 1 FROM member_tokens t WHERE t.member_id=m.id AND t.token_hash=$2))
   AND NOT EXISTS(SELECT 1 FROM member_tokens r WHERE r.token_hash=$2 AND r.revoked_at IS NOT NULL)`,[id,hash(token)])).rows[0];
  if(!row)throw new ApiError(401,'MEMBER_AUTH_REQUIRED');
  return row;
 }
 // Replaces the pledge with a validated, non-empty cart. An empty cart is never a withdrawal: an expired or cleared
 // Shopify cart reads as empty, so it is rejected and the pledge stays as it was (see withdraw()).
 async update(id:string,token:string,body:any){
  const proof=await this.member(id,token);
  if(Array.isArray(body?.lines)&&body.lines.length===0)throw new ApiError(422,'EMPTY_CART_CANNOT_UPDATE_PLEDGE','הסל ריק, ולכן ההתחייבות לא שונתה.');
  const cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const group=await this.group(db,id);
   if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
   if(group.payment_mode==='CARDCOM')return this.updateCard(db,group,proof.id,cart);
   await db.query("UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,status='PLEDGED',withdrawn_at=NULL,withdrawn_by=NULL,updated_at=NOW() WHERE id=$3 AND group_id=$4",[JSON.stringify(cart.snapshot),cart.total.toString(),proof.id,group.id]);
   return {group:await this.recalculate(db,group),validatedPledgeAgorot:Number(cart.total)};
  });
 }
 // Card member cart update. The chargeable amount never changes silently: a cart at or below the last explicitly
 // approved amount replaces the pledge (charging less than approved is within the consent); a higher cart is only
 // stored as a pending change (CONSENT_REQUIRED) and the member keeps counting with the approved cart and amount until
 // POST /confirm-pledge. A withdrawn card member has no card any more and must reserve again (new consent + card).
 private async updateCard(db:Queryable,group:any,memberId:string,cart:ValidatedCart){
  const member=(await db.query('SELECT status,payment_status,approved_amount_agorot,pledged_total_agorot FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
  if(!member||member.status!==ACTIVE_MEMBER_STATUS||!RESERVED_PAYMENT_STATUSES.includes(member.payment_status))
   throw new ApiError(409,'CARD_RESERVATION_REQUIRED','כדי לשריין מקום במשלוח הקבוצתי יש להזין כרטיס אשראי. לא יתבצע חיוב כעת.');
  const approved=BigInt(member.approved_amount_agorot);
  if(cart.total>approved){
   await db.query("UPDATE group_members SET pending_cart_snapshot=$1::jsonb,pending_amount_agorot=$2,payment_status='CONSENT_REQUIRED',updated_at=NOW() WHERE id=$3",[JSON.stringify(cart.snapshot),cart.total.toString(),memberId]);
   return {group:await this.aggregate(db,group),validatedPledgeAgorot:Number(member.pledged_total_agorot),
    consentRequired:{approvedAmountAgorot:Number(approved),newAmountAgorot:Number(cart.total)}};
  }
  await db.query("UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,pending_cart_snapshot=NULL,pending_amount_agorot=NULL,payment_status='CARD_RESERVED',updated_at=NOW() WHERE id=$3",[JSON.stringify(cart.snapshot),cart.total.toString(),memberId]);
  return {group:await this.recalculate(db,group),validatedPledgeAgorot:Number(cart.total)};
 }
 // Explicit consent to a pending higher amount: {confirm:true, amountAgorot} must equal the pending amount, and the
 // pending cart is re-validated with Shopify first (prices can change). No new card entry while the token is valid.
 async confirmPledge(id:string,token:string,body:any){
  const proof=await this.member(id,token);
  if(body?.confirm!==true)throw new ApiError(400,'CONSENT_REQUIRED','יש לאשר את סכום ההתחייבות לפני ההמשך.');
  const amount=body?.amountAgorot;
  if(!Number.isSafeInteger(amount)||amount<=0)throw new ApiError(400,'INVALID_INPUT');
  const pending=(await this.db.query('SELECT pending_cart_snapshot FROM group_members WHERE id=$1',[proof.id])).rows[0]?.pending_cart_snapshot;
  if(proof.payment_mode!=='CARDCOM'||proof.payment_status!=='CONSENT_REQUIRED'||!Array.isArray(pending))throw new ApiError(409,'PLEDGE_AMOUNT_CHANGED','אין שינוי בסכום ההתחייבות שממתין לאישור.');
  const cart=await this.shopify.validate(lines(pending.map((line:any)=>({variantId:line.variantId,quantity:line.quantity}))));
  const outcome=await this.locked(async db=>{
   const group=await this.group(db,id);
   if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
   const member=(await db.query('SELECT status,payment_status,pending_amount_agorot FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[proof.id,group.id])).rows[0];
   if(!member||member.status!==ACTIVE_MEMBER_STATUS||member.payment_status!=='CONSENT_REQUIRED'||member.pending_amount_agorot===null)throw new ApiError(409,'PLEDGE_AMOUNT_CHANGED','אין שינוי בסכום ההתחייבות שממתין לאישור.');
   const card=(await db.query("SELECT token_expires_on FROM group_payment_reservations WHERE member_id=$1 AND status='CARD_RESERVED' ORDER BY verified_at DESC LIMIT 1",[proof.id])).rows[0];
   if(!card||(card.token_expires_on!==null&&new Date(card.token_expires_on)<new Date(new Date().toDateString())))
    throw new ApiError(409,'CARD_RESERVATION_REQUIRED','כדי לשריין מקום במשלוח הקבוצתי יש להזין כרטיס אשראי. לא יתבצע חיוב כעת.');
   // The shown amount must be exactly what is approved now; a re-priced cart needs the shopper to see the new amount.
   if(cart.total!==BigInt(member.pending_amount_agorot)||BigInt(amount)!==cart.total){
    // Committed first (the refusal below must not roll it back), so the next confirmation sees the new amount.
    await db.query('UPDATE group_members SET pending_cart_snapshot=$1::jsonb,pending_amount_agorot=$2,updated_at=NOW() WHERE id=$3',[JSON.stringify(cart.snapshot),cart.total.toString(),proof.id]);
    return {changed:Number(cart.total)};
   }
   await db.query("UPDATE group_members SET cart_snapshot=pending_cart_snapshot,pledged_total_agorot=pending_amount_agorot,approved_amount_agorot=pending_amount_agorot,consent_at=NOW(),pending_cart_snapshot=NULL,pending_amount_agorot=NULL,payment_status='CARD_RESERVED',updated_at=NOW() WHERE id=$1",[proof.id]);
   return {group:await this.recalculate(db,group),validatedPledgeAgorot:Number(cart.total)};
  });
  if('changed' in outcome&&outcome.changed!==undefined)throw new ApiError(409,'PLEDGE_AMOUNT_CHANGED','סכום ההתחייבות השתנה. יש לאשר את הסכום החדש לפני שנוכל להמשיך.',{newAmountAgorot:outcome.changed});
  return outcome;
 }
 // The one withdrawal implementation (customer receipt and store-owner removal). Must run inside locked(). Only an
 // active group (OPEN/THRESHOLD_REACHED) changes: an approved group is never reopened by a removal. The row is kept
 // (status WITHDRAWN, pledge 0, who/when recorded) and never deleted. The last cart_snapshot is kept as history only:
 // it never counts (recalculate sums PLEDGED rows), is never returned to the receipt (memberState) and is replaced by
 // the next explicit pledge. The group total, count and
 // threshold status come from recalculate(). Already withdrawn: no write, same result (idempotent).
 private async retire(db:Queryable,group:any,memberId:string,by:'MEMBER'|'ADMIN'){
  if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
  const before=(await db.query('SELECT status,pledged_total_agorot,payment_status FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
  if(!before)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
  const previous={status:before.status as 'PLEDGED'|'WITHDRAWN',pledgedTotalAgorot:Number(before.pledged_total_agorot)};
  if(previous.status==='WITHDRAWN')return {group:await this.aggregate(db,group),member:{status:'WITHDRAWN' as const,pledgedTotalAgorot:0},previous,changed:false};
  // A charge that started or happened is never undone by a self-service withdrawal (refunds are the business's process).
  if(['CHARGE_PENDING','CHARGED','PAYMENT_FAILED'].includes(before.payment_status))throw new ApiError(409,'CHARGE_IN_PROGRESS','החיוב כבר התחיל או בוצע. לביטול או לזיכוי יש לפנות לשירות הלקוחות.');
  await db.query("UPDATE group_members SET pledged_total_agorot=0,status='WITHDRAWN',withdrawn_at=NOW(),withdrawn_by=$3,updated_at=NOW() WHERE id=$1 AND group_id=$2 AND status='PLEDGED'",[memberId,group.id,by]);
  // Card member: no charge will ever be made. The reservation is canceled and its sealed token deleted.
  if(before.payment_status!==null){
   await db.query("UPDATE group_members SET payment_status='CANCELED',approved_amount_agorot=0,pending_cart_snapshot=NULL,pending_amount_agorot=NULL WHERE id=$1",[memberId]);
   if(this.payments)await this.payments.cancelMember(db,memberId);
   else await db.query("UPDATE group_payment_reservations SET status='CANCELED',token_ciphertext=NULL,failure_code='MEMBER_WITHDREW',updated_at=NOW() WHERE member_id=$1 AND status='CARD_RESERVED'",[memberId]);
  }
  return {group:await this.recalculate(db,group),member:{status:'WITHDRAWN' as const,pledgedTotalAgorot:0},previous,changed:true};
 }
 // Explicit withdrawal: member token plus {confirm:true} from the confirmation step. Idempotent for a withdrawn member.
 async withdraw(id:string,token:string,body:any){
  const proof=await this.member(id,token);
  if(body?.confirm!==true)throw new ApiError(400,'WITHDRAW_CONFIRMATION_REQUIRED');
  return this.locked(async db=>{
   const {group,member}=await this.retire(db,await this.group(db,id),proof.id,'MEMBER');
   return {group,member};
  });
 }
 // Store-owner removal from /admin (session, Origin and CSRF are checked by the admin middleware). Same domain path as
 // the customer's own withdrawal; the receipt is left as it is (it then reads WITHDRAWN and restores nothing).
 async adminWithdraw(id:string,memberId:string,body:any){
  publicId(id);
  if(typeof memberId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(memberId))throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
  if(body?.confirm!==true)throw new ApiError(400,'WITHDRAW_CONFIRMATION_REQUIRED','נדרש אישור מפורש להסרת הלקוח.');
  return this.locked(async db=>this.retire(db,await this.group(db,id),memberId,'ADMIN'));
 }
 // The member's own pledge and stored cart, re-checked against Shopify now. Never returns contact details, the token,
 // its hash or database ids. If Shopify cannot be reached the membership is still returned with cartCheck UNAVAILABLE.
 async memberState(id:string,token:string){
  const row=await this.member(id,token);
  // A withdrawn member's kept snapshot is history, not a pledge: it is never returned here, so nothing restores it.
  const snapshot=row.status===ACTIVE_MEMBER_STATUS&&Array.isArray(row.cart_snapshot)?row.cart_snapshot:[];
  let cart:InspectedLine[]|null=[],cartCheck:'OK'|'UNAVAILABLE'='OK';
  if(snapshot.length){
   if(!this.shopify.inspect){cart=null;cartCheck='UNAVAILABLE';}
   else try{cart=await this.shopify.inspect(snapshot);}
   catch(error){if((error as any)?.code!=='SHOPIFY_UNAVAILABLE')throw error;cart=null;cartCheck='UNAVAILABLE';}
  }
  return {member:{status:row.status as 'PLEDGED'|'WITHDRAWN',pledgedTotalAgorot:Number(row.pledged_total_agorot),cartCheck,cart,
   // Card groups only (the member read of groups without cards is unchanged). Never the token, its expiry or any Cardcom id.
   ...(row.payment_mode==='CARDCOM'&&row.payment_status?{payment:{status:row.payment_status as string,
    approvedAmountAgorot:Number(row.approved_amount_agorot??0),pendingAmountAgorot:row.pending_amount_agorot===null?null:Number(row.pending_amount_agorot),
    card:row.card_last4||row.card_brand?{last4:row.card_last4??null,brand:row.card_brand??null}:null}}:{})}};
 }
 async list(){
  return this.locked(async db=>{
   const groups=(await db.query("SELECT * FROM delivery_groups ORDER BY CASE status WHEN 'THRESHOLD_REACHED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'APPROVED' THEN 2 ELSE 3 END,created_at DESC LIMIT 200")).rows,result=[];
   for(const group of groups)result.push({...await this.aggregate(db,group),createdAt:new Date(group.created_at).toISOString(),legacy:group.area_id===null});
   return result;
  });
 }
 // Admin operational transition (session, Origin and CSRF are checked by the admin middleware). Under the coordination
 // lock, so it serializes with joins and with itself: completing twice, or completing while a first join runs, can
 // never leave two current groups. Same status again is a no-op (changed:false). The transition is recorded in the
 // audit log inside the same transaction (the timeline cannot miss it). Completion only stamps the existing row:
 // members, carts, pledges, totals and ids are never changed, deleted or copied.
 async setOperationalStatus(id:string,body:any,actor:string){
  publicId(id);
  const target=body?.status;
  if(typeof target!=='string'||!(OPERATIONAL_STATUSES as readonly string[]).includes(target))throw new ApiError(400,'INVALID_OPERATIONAL_STATUS','סטטוס המשלוח אינו תקין.');
  if(target==='COMPLETED'&&body?.confirm!==true)throw new ApiError(400,'COMPLETION_CONFIRMATION_REQUIRED','נדרש אישור מפורש להשלמת המשלוח.');
  return this.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1 FOR UPDATE',[id])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
   const previous=group.operational_status as OperationalStatus;
   if(previous===target)return {previous,status:previous,changed:false,group:await this.aggregate(db,group)};
   if(!operationalTargets(previous).includes(target as OperationalStatus))
    throw new ApiError(409,'OPERATIONAL_TRANSITION_NOT_ALLOWED',previous==='COMPLETED'?'המשלוח הושלם ואינו ניתן לפתיחה מחדש.':'מעבר הסטטוס הזה אינו אפשרי.');
   const completing=target==='COMPLETED';
   const updated=(await db.query(`UPDATE delivery_groups SET operational_status=$1,completed_at=CASE WHEN $2::boolean THEN NOW() ELSE NULL END,completed_by=CASE WHEN $2::boolean THEN $3::text ELSE NULL END,updated_at=NOW()
    WHERE id=$4 AND operational_status=$5 RETURNING *`,[target,completing,actor,group.id,previous])).rows[0];
   await auditStrict(db,{action:completing?'group.complete':'group.operational_status_change',actor,target:id,result:'OK',previousStatus:previous,newStatus:target,
    amountAgorot:completing?Number(updated.pledged_total_agorot):null});
   return {previous,status:target as OperationalStatus,changed:true,group:await this.aggregate(db,updated)};
  });
 }
 async approve(id:string){
  return this.locked(async db=>{
   const group=await this.group(db,id);
   if(group.status!=='THRESHOLD_REACHED'||group.operational_status==='COMPLETED'||BigInt(group.pledged_total_agorot)<BigInt(group.threshold_agorot))throw new ApiError(409,'APPROVAL_NOT_ALLOWED','ניתן לאשר רק קבוצה פעילה שהגיעה לסף.');
   const card=group.payment_mode==='CARDCOM';
   // A card group is approved only when it can actually be charged; nothing changes otherwise.
   if(card&&!this.payments?.available)throw new ApiError(409,'PAYMENT_UNAVAILABLE','חיוב בכרטיסי אשראי אינו זמין כרגע. הקבוצה לא אושרה.');
   const updated=(await db.query("UPDATE delivery_groups SET status='APPROVED',payment_state=$2,updated_at=NOW() WHERE id=$1 AND status='THRESHOLD_REACHED' RETURNING *",[group.id,card?'CHARGING':null])).rows[0];
   if(!updated)throw new ApiError(409,'APPROVAL_NOT_ALLOWED','ניתן לאשר רק קבוצה פעילה שהגיעה לסף.');
   // Same transaction: the charges exist exactly when the approval does (a crash cannot leave one without the other).
   if(card)await this.payments!.prepareCharges(db,updated);
   return {group:updated,card};
  }).then(async({group,card})=>{
   if(card)this.payments!.afterApprove(group.id);
   return this.aggregate(this.db,group);
  });
 }
}
