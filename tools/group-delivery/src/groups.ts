import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Config} from './config.js';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,hash,contact,lines,publicId,distance,center,areaReference,fail,type AreaPlace} from './domain.js';
import type {CartValidator,ValidatedCart} from './shopify.js';
import {Areas,type AreaRow} from './areas.js';
import {paymentProvider,type AuthorizationResult,type ChargeResult,type PaymentProvider} from './payments.js';
import {PaymentVerifications,paymentsUnavailable} from './verifications.js';
const MAX_CHARGE_ATTEMPTS=20;
// Groups needing manual merchant attention: money moved in a group that cannot complete, or holds still open on a
// closed group.
const ATTENTION_SQL="SELECT COUNT(*)::int AS n FROM delivery_groups g WHERE refund_required OR (status IN ('CANCELLED','EXPIRED') AND EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.charge_status IN ('AUTHORIZED','PENDING','CAPTURING')))";
/** One request at a time runs a group's execution step; a crashed holder's lease simply lapses. */
const EXECUTION_LEASE_SECONDS=120;
const memberAuth=()=>new ApiError(401,'MEMBER_AUTH_REQUIRED');
const notAvailable=()=>new ApiError(409,'PAYMENT_APPROVAL_NOT_AVAILABLE','לא ניתן לאשר תשלום לקבוצה הזאת כרגע.');
const amountChanged=()=>new ApiError(409,'PAYMENT_AMOUNT_CHANGED','סכום ההתחייבות עודכן. יש לבדוק את הסכום החדש ולאשר שוב.');
const notAllowed=(message:string)=>new ApiError(409,'APPROVAL_NOT_ALLOWED',message);
const snapshotTotal=(snapshot:any)=>(Array.isArray(snapshot)?snapshot:[]).reduce((sum:bigint,line:any)=>sum+BigInt(line.unitAgorot)*BigInt(line.quantity),0n);
const past=(value:unknown)=>value!==null&&value!==undefined&&new Date(value as string).getTime()<=Date.now();
/** Payment aggregates for one group, computed from member rows (integer agorot as bigint). */
interface Stats {count:number;verified:number;legacy:number;capableTotal:bigint;approved:number;approvedTotal:bigint;waiting:number;declined:number;expired:number;invalidated:number;queued:number;pending:number;capturing:number;authorized:number;authorizedTotal:bigint;charged:number;chargedTotal:bigint;failed:number;retryable:number;voided:number}
/**
 * Group statuses: OPEN ⇄ THRESHOLD_REACHED (pledges editable) → [merchant approval] PAYMENT_OPEN (frozen; members
 * approve exact amounts until approval_deadline) → execution (Shopify revalidation, authorize, capture) → CONFIRMED,
 * or EXPIRED (deadline missed with too little approved value) / CANCELLED (not enough could be collected).
 * APPROVED is phase-one history only: those groups stay frozen and are never charged.
 */
export class Groups {
 readonly verifications:PaymentVerifications;
 constructor(private db:Database,private config:Pick<Config,'threshold'|'expiryDays'|'standardRadius'|'storeLocation'|'areaSuggestionRadius'|'secret'|'paymentProvider'|'paymentApprovalHours'|'paymentExecutionPolicy'>,private shopify:CartValidator,private areas:Areas=new Areas(db,config),private provider:PaymentProvider=paymentProvider(config)){
  this.verifications=new PaymentVerifications(db,provider,config.secret);
 }
 // Fail closed: under require_authorization (the default) a provider without authorize/capture cannot move money.
 get executionBlocked(){return this.config.paymentExecutionPolicy!=='allow_direct_charge'&&!this.provider.supportsAuthorization;}
 private async locked<T>(fn:(db:Queryable)=>Promise<T>):Promise<T>{
  return transaction(this.db,async db=>{
   await db.query('SELECT id FROM group_coordination WHERE id=1 FOR UPDATE');
   await this.expire(db);
   return fn(db);
  });
 }
 // Time-based transitions, evaluated from PostgreSQL NOW() inside every locked step. Nothing here moves money.
 // - Pre-payment groups expire at expires_at (PAYMENT_OPEN never does: it has its own approval deadline).
 // - At the approval deadline, outstanding approval requests expire; the deadline is never extended.
 // - A group that reaches its deadline before execution started without enough approved value expires: no charge.
 async expire(db:Queryable=this.db){
  const expired=(await db.query("UPDATE delivery_groups SET status='EXPIRED',updated_at=NOW() WHERE expires_at<=NOW() AND status IN ('OPEN','THRESHOLD_REACHED','APPROVED') RETURNING id")).rows;
  for(const group of expired)await db.query("UPDATE group_members SET approval_status='EXPIRED',updated_at=NOW() WHERE group_id=$1 AND approval_status='REQUIRED'",[group.id]);
  await db.query("UPDATE group_members m SET approval_status='EXPIRED',updated_at=NOW() FROM delivery_groups g WHERE m.group_id=g.id AND g.status='PAYMENT_OPEN' AND g.approval_deadline<=NOW() AND m.approval_status='REQUIRED'");
  await db.query(`UPDATE delivery_groups g SET status='EXPIRED',closed_reason='APPROVAL_DEADLINE',closed_at=NOW(),updated_at=NOW()
   WHERE g.status='PAYMENT_OPEN' AND g.approval_deadline<=NOW() AND g.payment_execution_started_at IS NULL
    AND (SELECT COALESCE(SUM(m.approval_amount_agorot),0) FROM group_members m WHERE m.group_id=g.id AND m.status='PLEDGED' AND m.approval_status='APPROVED' AND m.charge_status NOT IN ('FAILED','VOIDED'))<g.threshold_agorot`);
 }
 private async group(db:Queryable,id:string){
  const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND');return group;
 }
 private async stats(db:Queryable,groupId:string):Promise<Stats>{
  const r=(await db.query(`SELECT
   COUNT(*) FILTER (WHERE status='PLEDGED')::int AS count,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND payment_method_status='VERIFIED')::int AS verified,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND payment_method_status<>'VERIFIED')::int AS legacy,
   COALESCE(SUM(pledged_total_agorot) FILTER (WHERE status='PLEDGED' AND payment_method_status='VERIFIED'),0)::text AS capable_total,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND approval_status='APPROVED' AND charge_status NOT IN ('FAILED','VOIDED'))::int AS approved,
   COALESCE(SUM(approval_amount_agorot) FILTER (WHERE status='PLEDGED' AND approval_status='APPROVED' AND charge_status NOT IN ('FAILED','VOIDED')),0)::text AS approved_total,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND approval_status='REQUIRED')::int AS waiting,
   COUNT(*) FILTER (WHERE approval_status='DECLINED')::int AS declined,
   COUNT(*) FILTER (WHERE approval_status='EXPIRED')::int AS expired,
   COUNT(*) FILTER (WHERE approval_status='INVALIDATED')::int AS invalidated,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND approval_status='APPROVED' AND charge_status='NOT_STARTED')::int AS queued,
   COUNT(*) FILTER (WHERE charge_status='PENDING')::int AS pending,
   COUNT(*) FILTER (WHERE charge_status='CAPTURING')::int AS capturing,
   COUNT(*) FILTER (WHERE charge_status='AUTHORIZED')::int AS authorized,
   COALESCE(SUM(approval_amount_agorot) FILTER (WHERE charge_status IN ('AUTHORIZED','CAPTURING')),0)::text AS authorized_total,
   COUNT(*) FILTER (WHERE charge_status='SUCCEEDED')::int AS charged,
   COALESCE(SUM(charged_amount_agorot) FILTER (WHERE charge_status='SUCCEEDED'),0)::text AS charged_total,
   COUNT(*) FILTER (WHERE charge_status='FAILED')::int AS failed,
   COUNT(*) FILTER (WHERE status='PLEDGED' AND approval_status='APPROVED' AND charge_status='FAILED')::int AS retryable,
   COUNT(*) FILTER (WHERE charge_status='VOIDED')::int AS voided
   FROM group_members WHERE group_id=$1`,[groupId])).rows[0];
  return {count:r.count,verified:r.verified,legacy:r.legacy,capableTotal:BigInt(r.capable_total),approved:r.approved,approvedTotal:BigInt(r.approved_total),waiting:r.waiting,declined:r.declined,expired:r.expired,invalidated:r.invalidated,queued:r.queued,pending:r.pending,capturing:r.capturing,authorized:r.authorized,authorizedTotal:BigInt(r.authorized_total),charged:r.charged,chargedTotal:BigInt(r.charged_total),failed:r.failed,retryable:r.retryable,voided:r.voided};
 }
 // Public aggregate: counts and totals only, never contact data, per-member payment state or provider references.
 private async aggregate(db:Queryable,group:any,stats?:Stats){
  const s=stats||await this.stats(db,group.id);
  const total=BigInt(group.pledged_total_agorot),threshold=BigInt(group.threshold_agorot);
  return {publicId:group.public_id,areaName:group.area_name,status:group.status,participantCount:s.count,currency:'ILS',thresholdAgorot:Number(threshold),pledgedTotalAgorot:Number(total),remainingAmountAgorot:Number(total<threshold?threshold-total:0n),progressPercent:Number(total>=threshold?100n:total*100n/threshold),expiresAt:new Date(group.expires_at).toISOString(),
   approvals:{approved:s.approved,waiting:s.waiting,approvedPledgeTotalAgorot:Number(s.approvedTotal),ready:group.status==='PAYMENT_OPEN'&&s.approvedTotal>=threshold,deadline:group.approval_deadline?new Date(group.approval_deadline).toISOString():null}};
 }
 // The member's own payment state, for receipt-authenticated responses only. No provider references.
 // `actions` is the server's statement of what this member may do now; the browser only renders it.
 private memberView(row:any,group:any){
  const approval=row.approval_status as string,charge=row.charge_status as string;
  const open=group.status==='PAYMENT_OPEN'&&!past(group.approval_deadline)&&row.status==='PLEDGED'&&row.payment_method_status==='VERIFIED';
  const canApprove=open&&(approval==='REQUIRED'||approval==='DECLINED'||(approval==='APPROVED'&&charge==='FAILED'));
  const canDecline=open&&(approval==='REQUIRED'||(approval==='APPROVED'&&(charge==='NOT_STARTED'||charge==='FAILED')));
  return {
   active:row.status==='PLEDGED',pledgedAgorot:Number(row.pledged_total_agorot),
   paymentMethod:row.payment_method_status==='VERIFIED'?'VERIFIED':'NOT_STARTED',
   approval:{status:approval,amountAgorot:row.approval_amount_agorot===null?null:Number(row.approval_amount_agorot),nonce:canApprove?row.approval_nonce:null,review:row.approval_review_reason??null,previousAmountAgorot:row.previous_approval_amount_agorot===null||row.previous_approval_amount_agorot===undefined?null:Number(row.previous_approval_amount_agorot)},
   charge:{status:charge==='CAPTURING'?'PENDING':charge,amountAgorot:row.charged_amount_agorot===null?null:Number(row.charged_amount_agorot),chargedAt:row.charged_at?new Date(row.charged_at).toISOString():null,failure:row.charge_failure_code===null?null:row.charge_failure_code==='DECLINED'?'DECLINED':'ERROR'},
   actions:{approve:canApprove,decline:canDecline}
  };
 }
 // The delivery area is the whole boundary. Groups without an area (pre-areas history) accept no new members.
 private fits(group:any,place:AreaPlace):boolean{return group.area_id===place.areaId;}
 private async create(db:Queryable,place:AreaPlace){
  // area_name/locality_key keep the area name and slug for display and admin; area groups store no coordinates.
  const group=(await db.query(`INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,expires_at,area_id)
   VALUES($1,$2,$3,$4,$5,NOW()+($6::int * INTERVAL '1 day'),$7) RETURNING *`,
   [randomUUID(),randomUUID(),place.areaName,place.key,this.config.threshold.toString(),this.config.expiryDays,place.areaId])).rows[0];
  return group;
 }
 // The area's oldest OPEN, unexpired group with capacity. Read-only. Callers that create on a miss must run this
 // inside locked() so the check and the insert are one serialized step.
 private async match(db:Queryable,place:AreaPlace):Promise<any|undefined>{
  return (await db.query("SELECT g.* FROM delivery_groups g WHERE area_id=$1 AND status='OPEN' AND expires_at>NOW() AND (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id)<100 ORDER BY created_at LIMIT 1",[place.areaId])).rows[0];
 }
 // Advisory only: whether the area center lies within the store's standard delivery radius.
 private standard(area:AreaRow){return this.config.storeLocation?distance({lat:area.latitude,lng:area.longitude},this.config.storeLocation)<=this.config.standardRadius:null;}
 // Search never writes: no group creation, no expiry update, no lock. Requires a server-resolved active area.
 // A miss is reported as group:null and the first join for the area creates the group (see joinArea).
 async find(body:any){
  const area=await this.areas.resolve(this.db,body?.areaPublicId);
  const cart=body?.lines===undefined?undefined:await this.shopify.validate(lines(body.lines));
  const group=await this.match(this.db,this.areas.place(area));
  return {group:group?await this.aggregate(this.db,group):null,canCreateOnJoin:!group,withinStandardRadius:this.standard(area),...(cart?{validatedPledgeAgorot:Number(cart.total)}:{})};
 }
 async get(id:string){return this.locked(async db=>this.aggregate(db,await this.group(db,id)));}
 // Pledge totals drive OPEN ⇄ THRESHOLD_REACHED only. Reaching the target asks nobody to pay: that waits for the
 // merchant's explicit approval (approve()).
 private async recalculate(db:Queryable,group:any){
  const rows=(await db.query("SELECT pledged_total_agorot,approx_lat,approx_lng FROM group_members WHERE group_id=$1 AND status='PLEDGED'",[group.id])).rows;
  const total=rows.reduce((sum:bigint,row:any)=>sum+BigInt(row.pledged_total_agorot),0n);
  if(total>1000000000n)throw new ApiError(422,'GROUP_LIMIT');
  // Pre-areas coordinate groups keep their anchor/center bookkeeping while existing members update or withdraw.
  let next={lat:group.anchor_lat,lng:group.anchor_lng};
  const located=rows.filter((row:any)=>row.approx_lat!==null&&row.approx_lng!==null);
  if(group.anchor_lat!==null&&located.length)next=center(located.map((row:any)=>({lat:row.approx_lat,lng:row.approx_lng})));
  const updated=(await db.query('UPDATE delivery_groups SET pledged_total_agorot=$1,center_lat=$2,center_lng=$3,status=$4,updated_at=NOW() WHERE id=$5 RETURNING *',
   [total.toString(),next.lat,next.lng,total>=BigInt(group.threshold_agorot)?'THRESHOLD_REACHED':'OPEN',group.id])).rows[0];
  return {row:updated,aggregate:await this.aggregate(db,updated)};
 }
 // Shared membership insert; must run inside locked(). Every rule applies to new and existing groups alike.
 // The payment verification is checked and consumed last, so a join rejected for any other reason never uses it up,
 // and a failure after consumption rolls it back with the rest of the transaction. Members store no coordinates.
 private async enroll(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},cart:ValidatedCart,body:any){
  if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))throw new ApiError(409,'GROUP_CLOSED');
  if(!this.fits(group,place))throw new ApiError(409,'LOCATION_OUTSIDE_GROUP','המיקום אינו מתאים לקבוצה הזאת. חפשו קבוצה באזור שלכם.');
  const members=(await db.query('SELECT email,phone FROM group_members WHERE group_id=$1',[group.id])).rows;
  if(members.length>=100)throw new ApiError(409,'GROUP_FULL');
  if(members.some(member=>member.email===person.email||member.phone===person.phone))throw new ApiError(409,'ALREADY_JOINED','לא ניתן להצטרף שוב עם אותם פרטים. לעדכון הסל השתמשו באישור ההצטרפות הקיים.');
  const verification=await this.verifications.consume(db,body,person);
  const token=randomBytes(32).toString('hex'),memberId=randomUUID();
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash,payment_verification_id,payment_method_status,payment_verified_at)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'VERIFIED',$10)`,
   [memberId,group.id,person.email,person.phone,place.key,JSON.stringify(cart.snapshot),cart.total.toString(),hash(token),verification.id,verification.verifiedAt]);
  const next=await this.recalculate(db,group);
  return {group:next.aggregate,member:this.memberView(await this.memberById(db,memberId),next.row),memberToken:token,validatedPledgeAgorot:Number(cart.total)};
 }
 // Fail closed before spending a Shopify request when no payment provider is configured.
 private requirePayments(){if(!this.verifications.available)throw paymentsUnavailable();}
 // Join a specific group the shopper was shown in their selected area.
 async join(id:string,body:any){
  publicId(id);
  const areaId=areaReference(body?.areaPublicId),person=contact(body);this.requirePayments();
  const cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const place=this.areas.place(await this.areas.resolve(db,areaId));
   return this.enroll(db,await this.group(db,id),place,person,cart,body);
  });
 }
 // Join the area's group, creating it only now. Under the coordination lock: expire, resolve the area (it must still
 // be active), re-match (another shopper may have created the group since the search), create on a miss, insert the
 // first member. A failure at any step rolls back the transaction, so a group never exists without its first member.
 async joinArea(body:any){
  const areaId=areaReference(body?.areaPublicId),person=contact(body);this.requirePayments();
  const cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const place=this.areas.place(await this.areas.resolve(db,areaId));
   const existing=await this.match(db,place);
   const group=existing||await this.create(db,place);
   return {...await this.enroll(db,group,place,person,cart,body),created:!existing};
  });
 }
 private checkToken(token:string){if(!/^[a-f0-9]{64}$/.test(token))throw memberAuth();}
 private async memberById(db:Queryable,id:string){return (await db.query('SELECT * FROM group_members WHERE id=$1',[id])).rows[0];}
 private async memberFor(db:Queryable,group:any,token:string,lock=false){
  const member=(await db.query('SELECT * FROM group_members WHERE group_id=$1 AND token_hash=$2'+(lock?' FOR UPDATE':''),[group.id,hash(token)])).rows[0];
  if(!member)throw memberAuth();return member;
 }
 async update(id:string,token:string,body:any){
  publicId(id);this.checkToken(token);
  // Authenticate before spending a Shopify request.
  const proof=(await this.db.query('SELECT m.id FROM group_members m JOIN delivery_groups g ON m.group_id=g.id WHERE g.public_id=$1 AND m.token_hash=$2',[id,hash(token)])).rows[0];
  if(!proof)throw memberAuth();
  const cart=Array.isArray(body?.lines)&&body.lines.length===0?{total:0n,snapshot:[]}:await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const group=await this.group(db,id);
   // Frozen from merchant approval (PAYMENT_OPEN) on: the amounts members approve can never change underneath them.
   if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))throw new ApiError(409,'GROUP_CLOSED');
   await db.query('UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,status=$5,updated_at=NOW() WHERE id=$3 AND group_id=$4',[JSON.stringify(cart.snapshot),cart.total.toString(),proof.id,group.id,cart.total===0n?'WITHDRAWN':'PLEDGED']);
   const next=await this.recalculate(db,group);
   return {group:next.aggregate,member:this.memberView(await this.memberById(db,proof.id),next.row),validatedPledgeAgorot:Number(cart.total)};
  });
 }
 // Receipt-authenticated member view: the group aggregate plus this member's own payment state. In the payment phase
 // it first lets the execution step make progress (lease-guarded and idempotent).
 async membership(id:string,token:string){
  publicId(id);this.checkToken(token);
  const read=()=>this.locked(async db=>{const group=await this.group(db,id),member=await this.memberFor(db,group,token);return {group,aggregate:await this.aggregate(db,group),member};});
  let state=await read();
  if(state.group.status==='PAYMENT_OPEN'&&await this.advance(state.group.id))state=await read();
  return {group:state.aggregate,member:this.memberView(state.member,state.group)};
 }
 // Member decision during PAYMENT_OPEN, before the deadline. Approve records explicit consent for the exact stored
 // amount (the request must echo the nonce and amount the member was shown); it never calls the provider. Decline
 // withdraws consent until execution has picked the member up. Both are idempotent.
 async approvePayment(id:string,token:string,body:any){
  publicId(id);this.checkToken(token);
  const decision=body?.decision;
  if(decision!=='approve'&&decision!=='decline')fail();
  await this.locked(async db=>{
   const group=await this.group(db,id),member=await this.memberFor(db,group,token,true);
   if(group.status!=='PAYMENT_OPEN'||past(group.approval_deadline)||member.status!=='PLEDGED')throw notAvailable();
   if(member.payment_method_status!=='VERIFIED')throw new ApiError(409,'PAYMENT_METHOD_REQUIRED','לא נשמר אמצעי תשלום מאומת להצטרפות הזאת. פנו לחנות.');
   const approval=member.approval_status,charge=member.charge_status;
   if(decision==='decline'){
    if(approval==='DECLINED')return;
    if(!(approval==='REQUIRED'||(approval==='APPROVED'&&(charge==='NOT_STARTED'||charge==='FAILED'))))throw notAvailable();
    await db.query("UPDATE group_members SET approval_status='DECLINED',updated_at=NOW() WHERE id=$1",[member.id]);
    return;
   }
   if(approval==='APPROVED'&&charge!=='FAILED')return;// consent already recorded: idempotent
   if(!(approval==='REQUIRED'||approval==='DECLINED'||(approval==='APPROVED'&&charge==='FAILED')))throw notAvailable();
   const nonce=typeof body?.approvalNonce==='string'&&/^[a-f0-9]{32}$/.test(body.approvalNonce)?body.approvalNonce:'';
   const amount=BigInt(member.approval_amount_agorot),pledged=BigInt(member.pledged_total_agorot);
   if(!nonce||!timingSafeEqual(Buffer.from(nonce),Buffer.from(member.approval_nonce))||body?.amountAgorot!==Number(amount))throw amountChanged();
   // The approved amount must equal the frozen pledge and its stored line snapshot, to the agora.
   if(amount<=0n||amount!==pledged||snapshotTotal(member.cart_snapshot)!==pledged)throw amountChanged();
   await db.query("UPDATE group_members SET approval_status='APPROVED',approved_at=NOW(),approval_review_reason=NULL,charge_status=CASE WHEN charge_status='FAILED' THEN 'NOT_STARTED' ELSE charge_status END,charge_failure_code=NULL,updated_at=NOW() WHERE id=$1",[member.id]);
  });
  return this.membership(id,token);
 }
 // Merchant approval: "this Group Delivery is operationally feasible". Opens PAYMENT_OPEN, freezes joins and pledges at
 // once, starts a fixed approval window and asks every verified member to approve their exact frozen pledge.
 async approve(id:string){
  return this.locked(async db=>{
   const group=await this.group(db,id);
   if(group.status!=='THRESHOLD_REACHED'||BigInt(group.pledged_total_agorot)<BigInt(group.threshold_agorot))throw notAllowed('ניתן לאשר רק קבוצה פעילה שהגיעה לסף.');
   if(!this.verifications.available)throw new ApiError(503,'PAYMENTS_UNAVAILABLE','לא ניתן לפתוח שלב תשלום ללא ספק תשלומים מוגדר.');
   if(this.executionBlocked)throw new ApiError(503,'PAYMENTS_UNAVAILABLE','ספק התשלומים אינו תומך בהרשאה ולכידה, ולכן אי אפשר לפתוח שלב תשלום.');
   // Members from before payment verification cannot pay; the payment-capable pledges alone must reach the target.
   if((await this.stats(db,group.id)).capableTotal<BigInt(group.threshold_agorot))throw notAllowed('ההתחייבויות של משתתפים עם אמצעי תשלום מאומת נמוכות מהיעד, ולכן אי אפשר לפתוח שלב תשלום.');
   const updated=(await db.query("UPDATE delivery_groups SET status='PAYMENT_OPEN',payment_opened_at=NOW(),approval_deadline=NOW()+($2::int * INTERVAL '1 hour'),updated_at=NOW() WHERE id=$1 RETURNING *",[group.id,this.config.paymentApprovalHours])).rows[0];
   await db.query(`UPDATE group_members SET approval_status='REQUIRED',approval_amount_agorot=pledged_total_agorot,approval_nonce=replace(gen_random_uuid()::text,'-',''),approval_required_at=NOW(),approval_review_reason=NULL,updated_at=NOW()
    WHERE group_id=$1 AND status='PLEDGED' AND payment_method_status='VERIFIED' AND charge_status='NOT_STARTED'`,[group.id]);
   return this.aggregate(db,updated);
  });
 }
 // Merchant "execute now": start execution before the deadline once approved value covers the target.
 async execute(id:string){
  const group=await this.locked(async db=>{
   const group=await this.group(db,id);
   if(group.status!=='PAYMENT_OPEN')throw notAllowed('ניתן לבצע תשלומים רק לקבוצה בשלב התשלום.');
   if(!group.payment_execution_started_at&&(await this.stats(db,group.id)).approvedTotal<BigInt(group.threshold_agorot))throw notAllowed('סכום האישורים עדיין נמוך מהיעד.');
   return group;
  });
  await this.advance(group.id,true);
  return this.get(id);
 }
 // Execution step. Starts only in PAYMENT_OPEN, once approved value covers the target and either every verified
 // member has answered, the deadline has passed, or the merchant forced it. Then, per run (single lease holder):
 //  1. Revalidate each newly approved member's stored cart with Shopify; changed carts need new approval,
 //     unavailable carts are invalidated; nothing is charged for either.
 //  2. Submit authorizations (or direct charges) only when the still-collectible total covers the target.
 //  3. Capture once authorized + captured value covers the target (authorization providers).
 //  4. Finalize: CONFIRMED when captured value covers the target and nothing is outstanding; CANCELLED (voiding
 //     holds) when the target can no longer be reached. Otherwise wait for the next run.
 private async advance(groupId:string,force=false):Promise<boolean>{
  if(this.executionBlocked)return false;
  const leased=await this.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[groupId])).rows[0];
   if(group?.status!=='PAYMENT_OPEN'||(group.payment_execution_lease_until&&!past(group.payment_execution_lease_until)))return false;
   // Timing policy, re-checked on every run: new payments start only when no payment-capable member can still
   // answer (all answered, or the deadline passed) or the merchant forced execution; never below the target.
   const s=await this.stats(db,groupId);
   const due=force||group.payment_execution_forced===true||s.waiting===0||past(group.approval_deadline);
   if(!group.payment_execution_started_at&&(s.approvedTotal<BigInt(group.threshold_agorot)||!due))return false;
   await db.query("UPDATE delivery_groups SET payment_execution_started_at=COALESCE(payment_execution_started_at,NOW()),payment_execution_forced=payment_execution_forced OR $3,payment_execution_lease_until=NOW()+($2::int * INTERVAL '1 second'),updated_at=NOW() WHERE id=$1",[groupId,EXECUTION_LEASE_SECONDS,force]);
   return {due};
  });
  if(!leased)return false;
  const allowNew=leased.due;
  try{
   const rows=(await this.db.query("SELECT * FROM group_members WHERE group_id=$1 AND status='PLEDGED' AND approval_status='APPROVED' AND charge_status IN ('NOT_STARTED','PENDING') ORDER BY created_at,id",[groupId])).rows;
   const validated:any[]=[];
   // Not due (e.g. re-priced members are answering again): only reconcile in-flight attempts and capture holds.
   if(allowNew)for(const member of rows)if(member.charge_status==='NOT_STARTED'&&await this.revalidate(groupId,member))validated.push(member);
   const unknown=rows.filter(member=>member.charge_status==='PENDING');
   // Never start new payments that could not reach the target together with what is already committed.
   const group=(await this.db.query('SELECT threshold_agorot FROM delivery_groups WHERE id=$1',[groupId])).rows[0];
   const s=await this.stats(this.db,groupId);
   const committed=s.authorizedTotal+s.chargedTotal+(await this.amount(groupId,"charge_status='PENDING'"))+validated.reduce((sum,member)=>sum+BigInt(member.approval_amount_agorot),0n);
   const submit=[...unknown,...(committed>=BigInt(group.threshold_agorot)?validated:[])];
   for(const member of submit)await this.submit(member);
   if(this.provider.supportsAuthorization)await this.captureIfReady(groupId);
   await this.finalize(groupId);
  }finally{await this.db.query('UPDATE delivery_groups SET payment_execution_lease_until=NULL WHERE id=$1',[groupId]);}
  return true;
 }
 private async amount(groupId:string,where:string){return BigInt((await this.db.query('SELECT COALESCE(SUM(approval_amount_agorot),0)::text AS total FROM group_members WHERE group_id=$1 AND '+where,[groupId])).rows[0].total);}
 // Mandatory Shopify revalidation immediately before money can move. True only when the stored cart still validates
 // with the same variants, quantities and unit prices, in ILS, and totals exactly the approved amount.
 private async revalidate(groupId:string,member:any):Promise<boolean>{
  const snapshot=Array.isArray(member.cart_snapshot)?member.cart_snapshot:[];
  let cart:ValidatedCart;
  try{cart=await this.shopify.validate(lines(snapshot.map((line:any)=>({variantId:line.variantId,quantity:line.quantity}))));}
  catch(error){
   // Shopify unreachable: change nothing and retry on a later run. Anything else means the cart cannot be honoured.
   if(error instanceof ApiError&&error.code!=='SHOPIFY_UNAVAILABLE')await this.invalidate(groupId,member,'CART_UNAVAILABLE');
   return false;
  }
  const unchanged=cart.total===BigInt(member.approval_amount_agorot)&&cart.snapshot.length===snapshot.length&&cart.snapshot.every(line=>snapshot.some((old:any)=>old.variantId===line.variantId&&old.quantity===line.quantity&&String(old.unitAgorot)===line.unitAgorot));
  if(!unchanged)await this.reprice(groupId,member,cart);
  return unchanged;
 }
 private async invalidate(groupId:string,member:any,reason:'CART_UNAVAILABLE'|'CART_CHANGED'){
  await this.locked(db=>db.query("UPDATE group_members SET approval_status='INVALIDATED',approval_review_reason=$2,approval_nonce=NULL,approval_invalidated_at=NOW(),updated_at=NOW() WHERE id=$1 AND approval_status='APPROVED' AND charge_status='NOT_STARTED'",[member.id,reason]));
 }
 // Prices changed: the old approval is void. Before the deadline the member is asked to approve the new validated
 // amount (fresh nonce); after it, the approval is invalidated. Either way nothing is charged now.
 private async reprice(groupId:string,member:any,cart:ValidatedCart){
  await this.locked(async db=>{
   const group=(await db.query('SELECT approval_deadline FROM delivery_groups WHERE id=$1',[groupId])).rows[0];
   if(past(group.approval_deadline)){await db.query("UPDATE group_members SET approval_status='INVALIDATED',approval_review_reason='CART_CHANGED',approval_nonce=NULL,previous_approval_amount_agorot=approval_amount_agorot,approval_invalidated_at=NOW(),updated_at=NOW() WHERE id=$1 AND approval_status='APPROVED' AND charge_status='NOT_STARTED'",[member.id]);return;}
   const changed=(await db.query(`UPDATE group_members SET approval_status='REQUIRED',approval_review_reason='CART_CHANGED',previous_approval_amount_agorot=approval_amount_agorot,approval_invalidated_at=NOW(),approval_revision=approval_revision+1,approval_amount_agorot=$2,pledged_total_agorot=$2,cart_snapshot=$3::jsonb,approval_nonce=replace(gen_random_uuid()::text,'-',''),approval_required_at=NOW(),updated_at=NOW()
    WHERE id=$1 AND approval_status='APPROVED' AND charge_status='NOT_STARTED' RETURNING id`,[member.id,cart.total.toString(),JSON.stringify(cart.snapshot)])).rows[0];
   if(changed)await db.query("UPDATE delivery_groups SET pledged_total_agorot=(SELECT COALESCE(SUM(pledged_total_agorot),0) FROM group_members WHERE group_id=$1 AND status='PLEDGED'),updated_at=NOW() WHERE id=$1",[groupId]);
  });
 }
 // Claims an attempt (or re-submits an unknown one with the same key), then calls the provider outside the lock.
 private async submit(member:any){
  const claim=await this.locked(async db=>{
   const row=(await db.query('SELECT * FROM group_members WHERE id=$1 FOR UPDATE',[member.id])).rows[0];
   if(row?.status!=='PLEDGED'||row.approval_status!=='APPROVED')return undefined;
   if(row.charge_status==='PENDING')return {key:row.charge_idempotency_key as string,row};
   if(row.charge_status!=='NOT_STARTED')return undefined;
   const attempts=Number(row.charge_attempts)+1;if(attempts>MAX_CHARGE_ATTEMPTS)return undefined;
   const key='gdc_'+row.id.replaceAll('-','')+'_'+attempts;
   await db.query("UPDATE group_members SET charge_status='PENDING',charge_failure_code=NULL,charge_attempts=$2,charge_idempotency_key=$3,charge_requested_at=NOW(),updated_at=NOW() WHERE id=$1",[row.id,attempts,key]);
   return {key,row};
  });
  if(!claim)return;
  const amount=BigInt(claim.row.approval_amount_agorot);
  let methodRef:string;
  try{methodRef=await this.verifications.methodRef(this.db,claim.row.payment_verification_id);}catch{return;}
  const request={paymentMethodRef:methodRef,amountAgorot:amount,currency:'ILS' as const,idempotencyKey:claim.key,reference:claim.key};
  let result:AuthorizationResult|ChargeResult;
  try{result=this.provider.supportsAuthorization?await this.provider.authorize!(request):await this.provider.createCharge(request);}
  catch{return;}// Unknown outcome: stays PENDING; the next run re-submits the same key.
  await this.recordAttempt(claim.row.id,claim.key,amount,result);
 }
 // Records a provider result once: only the matching PENDING attempt can change. A success for another amount is
 // never accepted automatically; that attempt stays PENDING for reconciliation.
 private async recordAttempt(memberId:string,key:string,amount:bigint,result:AuthorizationResult|ChargeResult){
  if(result.status==='PENDING')return;
  if((result.status==='AUTHORIZED'||result.status==='SUCCEEDED')&&result.amountAgorot!==amount)return;
  await this.locked(async db=>{
   if(result.status==='AUTHORIZED')await db.query("UPDATE group_members SET charge_status='AUTHORIZED',authorization_ref=$3,authorized_at=NOW(),updated_at=NOW() WHERE id=$1 AND charge_status='PENDING' AND charge_idempotency_key=$2",[memberId,key,result.authorizationRef]);
   else if(result.status==='SUCCEEDED')await db.query("UPDATE group_members SET charge_status='SUCCEEDED',charge_ref=$3,charged_amount_agorot=$4,charged_at=NOW(),updated_at=NOW() WHERE id=$1 AND charge_status='PENDING' AND charge_idempotency_key=$2",[memberId,key,result.chargeRef,amount.toString()]);
   else await db.query("UPDATE group_members SET charge_status='FAILED',charge_failure_code=$3,updated_at=NOW() WHERE id=$1 AND charge_status='PENDING' AND charge_idempotency_key=$2",[memberId,key,result.failureCode]);
  });
 }
 // Captures every hold once authorized + captured value covers the target. Unknown capture outcomes stay CAPTURING
 // and are re-submitted with the same key on the next run.
 private async captureIfReady(groupId:string){
  const group=(await this.db.query('SELECT threshold_agorot FROM delivery_groups WHERE id=$1',[groupId])).rows[0];
  const s=await this.stats(this.db,groupId);
  if(s.authorizedTotal+s.chargedTotal<BigInt(group.threshold_agorot))return;
  const holds=(await this.db.query("SELECT id,authorization_ref,approval_amount_agorot,charge_idempotency_key FROM group_members WHERE group_id=$1 AND charge_status IN ('AUTHORIZED','CAPTURING') ORDER BY created_at,id",[groupId])).rows;
  for(const hold of holds){
   const claimed=await this.locked(async db=>(await db.query("UPDATE group_members SET charge_status='CAPTURING',updated_at=NOW() WHERE id=$1 AND charge_status IN ('AUTHORIZED','CAPTURING') RETURNING id",[hold.id])).rows[0]);
   if(!claimed)continue;
   const amount=BigInt(hold.approval_amount_agorot);
   let result:ChargeResult;
   try{result=await this.provider.capture!({authorizationRef:hold.authorization_ref,amountAgorot:amount,idempotencyKey:hold.charge_idempotency_key+'_capture'});}catch{continue;}
   if(result.status==='PENDING'||(result.status==='SUCCEEDED'&&result.amountAgorot!==amount))continue;
   await this.locked(async db=>{
    if(result.status==='SUCCEEDED')await db.query("UPDATE group_members SET charge_status='SUCCEEDED',charge_ref=$2,charged_amount_agorot=$3,charged_at=NOW(),updated_at=NOW() WHERE id=$1 AND charge_status='CAPTURING'",[hold.id,result.chargeRef,amount.toString()]);
    else if(result.status==='FAILED')await db.query("UPDATE group_members SET charge_status='FAILED',charge_failure_code=$2,updated_at=NOW() WHERE id=$1 AND charge_status='CAPTURING'",[hold.id,result.failureCode]);
   });
  }
 }
 private async finalize(groupId:string){
  const holds=await this.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[groupId])).rows[0];
   if(group?.status!=='PAYMENT_OPEN')return [];
   const s=await this.stats(db,groupId),threshold=BigInt(group.threshold_agorot),deadline=past(group.approval_deadline);
   // Unknown outcomes are reconciled first; nothing is decided around them.
   if(s.pending+s.capturing>0)return [];
   const answering=!deadline&&s.waiting+s.declined+s.retryable>0;
   if(s.chargedTotal>=threshold&&s.queued===0&&s.authorized===0&&(s.waiting===0||deadline)){
    await db.query("UPDATE delivery_groups SET status='CONFIRMED',confirmed_at=NOW(),paid_total_agorot=$2,updated_at=NOW() WHERE id=$1",[groupId,s.chargedTotal.toString()]);
    return [];
   }
   await db.query('UPDATE delivery_groups SET paid_total_agorot=$2 WHERE id=$1',[groupId,s.chargedTotal.toString()]);
   // Still reachable (members may answer, retry, or Shopify may come back): wait for the next run.
   if(answering||s.approvedTotal>=threshold)return [];
   // The target can no longer be collected: cancel without further charges and release every hold.
   await db.query("UPDATE delivery_groups SET status='CANCELLED',closed_reason='INSUFFICIENT_PAYMENTS',closed_at=NOW(),refund_required=$2,updated_at=NOW() WHERE id=$1",[groupId,s.chargedTotal>0n]);
   return [1];
  });
  if(holds.length)await this.releaseHolds(groupId);
 }
 // Voids every hold of a group that will not capture (CANCELLED/EXPIRED). Idempotent: VOIDED rows are skipped and
 // the provider deduplicates the void key. A failed void leaves the hold AUTHORIZED for the next maintenance run.
 private async releaseHolds(groupId:string){
  const holds=(await this.db.query("SELECT m.id,m.authorization_ref,m.charge_idempotency_key FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE m.group_id=$1 AND m.charge_status='AUTHORIZED' AND g.status IN ('CANCELLED','EXPIRED')",[groupId])).rows;
  let released=0;
  for(const hold of holds){
   try{
    const result=await this.provider.voidAuthorization!({authorizationRef:hold.authorization_ref,idempotencyKey:hold.charge_idempotency_key+'_void'});
    if(result.status==='VOIDED'&&(await this.locked(db=>db.query("UPDATE group_members SET charge_status='VOIDED',voided_at=NOW(),updated_at=NOW() WHERE id=$1 AND charge_status='AUTHORIZED' RETURNING id",[hold.id]))).rows.length)released++;
   }catch{/* Retried by the next maintenance run; admin shows the open hold. */}
  }
  return released;
 }
 /**
  * Scheduled payment maintenance, safe to run any number of times (and concurrently with shopper/admin requests):
  * applies deadline transitions, lets every due PAYMENT_OPEN group execute (revalidate, authorize, capture,
  * reconcile unknown outcomes with the same keys, finalize) and releases holds left on closed groups. It never
  * resolves refund-required groups. Returns counts only.
  */
 async maintain(){
  const due=(await this.db.query("SELECT id,status FROM delivery_groups g WHERE status='PAYMENT_OPEN' OR (status IN ('CANCELLED','EXPIRED') AND EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=g.id AND m.charge_status='AUTHORIZED'))")).rows;
  await this.locked(async()=>undefined);// time-based transitions (deadlines) apply here even if nothing else runs
  const summary={checked:due.length,executionRuns:0,confirmed:0,cancelled:0,expired:0,holdsReleased:0,blocked:0,attention:0};
  for(const group of due){
   const now=(await this.db.query('SELECT status FROM delivery_groups WHERE id=$1',[group.id])).rows[0].status;
   if(now==='PAYMENT_OPEN'){if(this.executionBlocked)summary.blocked++;else if(await this.advance(group.id))summary.executionRuns++;}
   summary.holdsReleased+=await this.releaseHolds(group.id);
   const after=(await this.db.query('SELECT status FROM delivery_groups WHERE id=$1',[group.id])).rows[0].status;
   if(after!==group.status){if(after==='CONFIRMED')summary.confirmed++;else if(after==='CANCELLED')summary.cancelled++;else if(after==='EXPIRED')summary.expired++;}
  }
  summary.attention=Number((await this.db.query(ATTENTION_SQL)).rows[0].n);
  return summary;
 }
 async list(){
  // Let payment-phase groups make progress first (lease-guarded, idempotent).
  const open=(await this.locked(db=>db.query("SELECT id FROM delivery_groups WHERE status='PAYMENT_OPEN'"))).rows;
  for(const group of open)await this.advance(group.id);
  return this.locked(async db=>{
   const groups=(await db.query("SELECT * FROM delivery_groups ORDER BY refund_required DESC,CASE status WHEN 'PAYMENT_OPEN' THEN 0 WHEN 'THRESHOLD_REACHED' THEN 1 WHEN 'OPEN' THEN 2 WHEN 'APPROVED' THEN 3 ELSE 4 END,created_at DESC LIMIT 200")).rows,result=[];
   // Merchant aggregates only: counts and integer totals, never contact data or provider references.
   for(const group of groups){
    const s=await this.stats(db,group.id);
    result.push({...await this.aggregate(db,group,s),createdAt:new Date(group.created_at).toISOString(),legacy:group.area_id===null,
     payment:{verified:s.verified,legacyMembers:s.legacy,approved:s.approved,approvedPledgeTotalAgorot:Number(s.approvedTotal),waiting:s.waiting,declined:s.declined,expired:s.expired,invalidated:s.invalidated,
      authorized:s.authorized,authorizedTotalAgorot:Number(s.authorizedTotal),processing:s.pending+s.capturing,charged:s.charged,chargedTotalAgorot:Number(s.chargedTotal),failed:s.failed,voided:s.voided,
      ready:group.status==='PAYMENT_OPEN'&&s.approvedTotal>=BigInt(group.threshold_agorot),executionStarted:!!group.payment_execution_started_at,
      deadline:group.approval_deadline?new Date(group.approval_deadline).toISOString():null,closedReason:group.closed_reason??null,refundRequired:group.refund_required===true,
      openHolds:group.status==='PAYMENT_OPEN'?0:s.authorized,executionBlocked:group.status==='PAYMENT_OPEN'&&this.executionBlocked,
      // Fully resolved only when the group is terminal, nothing is held or in flight and no refund is owed.
      resolved:['CONFIRMED','CANCELLED','EXPIRED'].includes(group.status)&&group.refund_required!==true&&s.authorized+s.pending+s.capturing===0}});
   }
   return result;
  });
 }
}
