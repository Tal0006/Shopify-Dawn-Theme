
import {randomBytes,randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,hash,contact,lines,publicId,distance,center,areaReference,type AreaPlace} from './domain.js';
import type {CartValidator,ValidatedCart,InspectedLine} from './shopify.js';
import {Areas,type AreaRow} from './areas.js';
import {auditStrict} from './audit.js';
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
export class Groups {
 constructor(private db:Database,private config:Pick<Config,'threshold'|'expiryDays'|'standardRadius'|'storeLocation'|'areaSuggestionRadius'>,private shopify:CartValidator,private areas:Areas=new Areas(db,config)){}
 private async locked<T>(fn:(db:Queryable)=>Promise<T>):Promise<T>{
  return transaction(this.db,async db=>{
   await db.query('SELECT id FROM group_coordination WHERE id=1 FOR UPDATE');
   await this.expire(db);
   return fn(db);
  });
 }
 // Automatic expiry ends only the customer-pledging phase (OPEN/THRESHOLD_REACHED). APPROVED groups continue through the
 // delivery workflow without a deadline; completed deliveries and already-closed groups are never rewritten.
 async expire(db:Queryable=this.db){await db.query("UPDATE delivery_groups SET status='EXPIRED',updated_at=NOW() WHERE expires_at<=NOW() AND status IN ('OPEN','THRESHOLD_REACHED') AND operational_status<>'COMPLETED'");}
 private async group(db:Queryable,id:string){
  const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND');return group;
 }
 private async aggregate(db:Queryable,group:any){
  const count=(await db.query("SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND status=$2",[group.id,ACTIVE_MEMBER_STATUS])).rows[0].count;
  const total=BigInt(group.pledged_total_agorot),threshold=BigInt(group.threshold_agorot);
  return {publicId:group.public_id,areaName:group.area_name,status:group.operational_status==='COMPLETED'?'COMPLETED':group.status,participantCount:Number(count),currency:'ILS',thresholdAgorot:Number(threshold),pledgedTotalAgorot:Number(total),remainingAmountAgorot:Number(total<threshold?threshold-total:0n),progressPercent:Number(total>=threshold?100n:total*100n/threshold),expiresAt:new Date(group.expires_at).toISOString()};
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
 // The area's oldest OPEN, unexpired, not completed group with active capacity. Read-only. Callers that create on a miss must run this
 // inside locked() so the check and the insert are one serialized step.
 private async match(db:Queryable,place:AreaPlace):Promise<any|undefined>{
  return (await db.query("SELECT g.* FROM delivery_groups g WHERE area_id=$1 AND status='OPEN' AND operational_status<>'COMPLETED' AND expires_at>NOW() AND (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id AND m.status=$2)<$3 ORDER BY created_at LIMIT 1",[place.areaId,ACTIVE_MEMBER_STATUS,GROUP_CAPACITY])).rows[0];
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
 private async recalculate(db:Queryable,group:any){
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
 // Shared membership insert; must run inside locked(). Every rule applies to new and existing groups alike.
 // Members store no coordinates.
 private async enroll(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},cart:ValidatedCart){
  if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
  if(!this.fits(group,place))throw new ApiError(409,'LOCATION_OUTSIDE_GROUP','המיקום אינו מתאים לקבוצה הזאת. חפשו קבוצה באזור שלכם.');
  const members=(await db.query('SELECT email,phone,status FROM group_members WHERE group_id=$1',[group.id])).rows;
  // Capacity counts active (PLEDGED) members only; withdrawn rows are history and hold no slot.
  if(members.filter(member=>member.status===ACTIVE_MEMBER_STATUS).length>=GROUP_CAPACITY)throw new ApiError(409,'GROUP_FULL');
  // Any existing row with this email or phone, withdrawn or not, refuses a new join. A withdrawn member returns only
  // through their receipt (update-pledge); email + phone alone never reactivate a row or issue a token (no OTP yet).
  if(members.some(member=>member.email===person.email||member.phone===person.phone))throw new ApiError(409,'ALREADY_JOINED','לא ניתן להצטרף שוב עם אותם פרטים. לעדכון הסל השתמשו באישור ההצטרפות הקיים.');
  const token=randomBytes(32).toString('hex');
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
   [randomUUID(),group.id,person.email,person.phone,place.key,JSON.stringify(cart.snapshot),cart.total.toString(),hash(token)]);
  return {group:await this.recalculate(db,group),memberToken:token,validatedPledgeAgorot:Number(cart.total)};
 }
 // Join a specific group the shopper was shown in their selected area.
 async join(id:string,body:any){
  publicId(id);
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
  const areaId=areaReference(body?.areaPublicId),person=contact(body),cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const place=this.areas.place(await this.areas.resolve(db,areaId));
   const existing=await this.match(db,place);
   const group=existing||await this.create(db,place);
   return {...await this.enroll(db,group,place,person,cart),created:!existing};
  });
 }
 // The member behind a receipt (group public id + bearer token). Runs before any Shopify request or lock.
 private async member(id:string,token:string){
  publicId(id);if(!/^[a-f0-9]{64}$/.test(token))throw new ApiError(401,'MEMBER_AUTH_REQUIRED');
  const row=(await this.db.query('SELECT m.id,m.status,m.pledged_total_agorot,m.cart_snapshot FROM group_members m JOIN delivery_groups g ON m.group_id=g.id WHERE g.public_id=$1 AND m.token_hash=$2',[id,hash(token)])).rows[0];
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
   await db.query("UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,status='PLEDGED',withdrawn_at=NULL,withdrawn_by=NULL,updated_at=NOW() WHERE id=$3 AND group_id=$4",[JSON.stringify(cart.snapshot),cart.total.toString(),proof.id,group.id]);
   return {group:await this.recalculate(db,group),validatedPledgeAgorot:Number(cart.total)};
  });
 }
 // The one withdrawal implementation (customer receipt and store-owner removal). Must run inside locked(). Only an
 // active group (OPEN/THRESHOLD_REACHED) changes: an approved group is never reopened by a removal. The row is kept
 // (status WITHDRAWN, pledge 0, who/when recorded) and never deleted. The last cart_snapshot is kept as history only:
 // it never counts (recalculate sums PLEDGED rows), is never returned to the receipt (memberState) and is replaced by
 // the next explicit pledge. The group total, count and
 // threshold status come from recalculate(). Already withdrawn: no write, same result (idempotent).
 private async retire(db:Queryable,group:any,memberId:string,by:'MEMBER'|'ADMIN'){
  if(!acceptsPledges(group))throw new ApiError(409,'GROUP_CLOSED');
  const before=(await db.query('SELECT status,pledged_total_agorot FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
  if(!before)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
  const previous={status:before.status as 'PLEDGED'|'WITHDRAWN',pledgedTotalAgorot:Number(before.pledged_total_agorot)};
  if(previous.status==='WITHDRAWN')return {group:await this.aggregate(db,group),member:{status:'WITHDRAWN' as const,pledgedTotalAgorot:0},previous,changed:false};
  await db.query("UPDATE group_members SET pledged_total_agorot=0,status='WITHDRAWN',withdrawn_at=NOW(),withdrawn_by=$3,updated_at=NOW() WHERE id=$1 AND group_id=$2 AND status='PLEDGED'",[memberId,group.id,by]);
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
  return {member:{status:row.status as 'PLEDGED'|'WITHDRAWN',pledgedTotalAgorot:Number(row.pledged_total_agorot),cartCheck,cart}};
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
   const updated=(await db.query("UPDATE delivery_groups SET status='APPROVED',updated_at=NOW() WHERE id=$1 RETURNING *",[group.id])).rows[0];
   return this.aggregate(db,updated);
  });
 }
}
