// Order lifecycle (migration 018). A group_members row is one customer's order in one delivery cycle.
//  - The store owner records a payment received outside the online flow (attested, never a Shopify or Cardcom
//    transaction); the order is then LOCKED and nobody can edit or withdraw it.
//  - A customer holding a receipt places ANOTHER order explicitly: a new, separate order in the area's current cycle,
//    linked to the first one. Editing an open order stays the separate update-pledge action.
//  - The owner ends a cycle and opens the next one (cycle split): selected open orders are carried to the area's
//    current cycle (or a new one) as new rows linked from the originals (rows never move; ids never change), an overwritten paid order is restored from its verified cart and its current cart becomes a new,
//    separate order, the rest stay as history; the old cycle is completed. One transaction under the coordination lock,
//    checked against the previewed state, idempotent by key, and audited step by step.
import {randomBytes,randomUUID} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {ApiError,hash,lines,publicId} from './domain.js';
import {ACTIVE_MEMBER_STATUS,LOCKED_MESSAGE,issueToken,recordCart,type Groups} from './groups.js';
import type {CartValidator,SnapshotLine} from './shopify.js';
import {auditStrict} from './audit.js';
import {reference} from './renewals.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const PAYMENT_METHODS=['CASH','BANK_TRANSFER','BIT','PAYBOX','CARD_EXTERNAL','OTHER'] as const;
export const SPLIT_REASONS=['PAID_ORDERS_DELIVERED','ORDER_OVERWRITE_RECONCILIATION'] as const;
// Device receipts a linked order can get through its first order's receipt (one per device; a bound against abuse).
const LINK_TOKEN_LIMIT=20;
export const cartLines=(snapshot:unknown)=>(Array.isArray(snapshot)?snapshot:[]).map((l:any)=>({variantId:String(l.variantId).split('/').pop()!,quantity:Number(l.quantity),unitAgorot:Number(l.unitAgorot),lineAgorot:Number(l.quantity)*Number(l.unitAgorot)}));
const lineInput=(snapshot:SnapshotLine[])=>snapshot.map(line=>({variantId:String(line.variantId),quantity:Number(line.quantity)}));
const uuid=(value:unknown,code:'INVALID_INPUT'|'MEMBER_NOT_FOUND'='INVALID_INPUT')=>{
 if(typeof value!=='string'||!UUID.test(value))throw new ApiError(code==='MEMBER_NOT_FOUND'?404:400,code);
 return value;
};
// The state a preview was computed from: every order (id, status, amount, lock, cart) and the group's totals.
const STATE_SQL=`SELECT md5(COALESCE(string_agg(m.id::text||':'||m.status||':'||m.pledged_total_agorot||':'||m.order_state||':'||md5(m.cart_snapshot::text),',' ORDER BY m.id),'')
 ||'|'||g.status||'|'||g.pledged_total_agorot||'|'||g.operational_status) AS state FROM delivery_groups g LEFT JOIN group_members m ON m.group_id=g.id WHERE g.id=$1 GROUP BY g.id`;

export class Orders {
 constructor(private db:Database,private groups:Groups,private shopify:CartValidator){}

 // ---------- Owner: payment received outside the online flow ----------
 async attestPayment(id:string,memberId:string,body:any,actor:string){
  const target=publicId(id);uuid(memberId,'MEMBER_NOT_FOUND');
  if(body?.attest!==true)throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לאשר במפורש שהתשלום התקבל.');
  const amount=Number(body?.amountAgorot);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new ApiError(400,'INVALID_PAYMENT_RECORD','סכום התשלום אינו תקין.');
  if(!(PAYMENT_METHODS as readonly string[]).includes(body?.method))throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לבחור אמצעי תשלום.');
  const day=typeof body?.receivedOn==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(body.receivedOn)?body.receivedOn:null;
  if(!day||Number.isNaN(Date.parse(day+'T00:00:00Z'))||Date.parse(day+'T00:00:00Z')>Date.now()+86400000)throw new ApiError(400,'INVALID_PAYMENT_RECORD','תאריך קבלת התשלום אינו תקין.');
  let note:string|null;
  try{note=reference(body?.reference);}catch{throw new ApiError(400,'INVALID_PAYMENT_RECORD','ההערה יכולה להכיל עד 60 תווים, בלי פרטי קשר או כרטיס.');}
  return this.groups.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[target])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
   if(group.payment_mode!=='NONE')throw new ApiError(409,'INVALID_PAYMENT_RECORD','בקבוצה עם כרטיס אשראי התשלום מתבצע במערכת עצמה.');
   const member=(await db.query('SELECT id,status,pledged_total_agorot,order_state,md5(cart_snapshot::text) AS fingerprint FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
   if(!member)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
   if(member.status!==ACTIVE_MEMBER_STATUS)throw new ApiError(409,'INVALID_PAYMENT_RECORD','ההזמנה אינה פעילה.');
   if(Number(member.pledged_total_agorot)!==amount)throw new ApiError(409,'INVALID_PAYMENT_RECORD','הסכום חייב להיות זהה לסכום ההזמנה ('+(Number(member.pledged_total_agorot)/100).toFixed(2)+' ₪).');
   const existing=(await db.query("SELECT amount_agorot,cart_fingerprint,method,to_char(received_on,'YYYY-MM-DD') AS day,reference FROM member_payment_records WHERE member_id=$1 AND voided_at IS NULL",[member.id])).rows[0];
   if(existing){
    // Only an exact retry of the same record is a no-op; any other record needs the existing one voided first.
    if(Number(existing.amount_agorot)===amount&&existing.cart_fingerprint===member.fingerprint&&existing.method===body.method&&existing.day===day&&(existing.reference??null)===note)
     return {memberId:member.id,recorded:false,locked:true};
    throw new ApiError(409,'PAYMENT_ALREADY_RECORDED','כבר נרשם תשלום להזמנה הזו.');
   }
   await db.query(`INSERT INTO member_payment_records(id,member_id,group_id,amount_agorot,method,received_on,reference,cart_fingerprint,attested_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),member.id,group.id,amount,body.method,day,note,member.fingerprint,actor]);
   if(member.order_state==='OPEN')await db.query("UPDATE group_members SET order_state='LOCKED',locked_at=NOW(),locked_reason='PAID_EXTERNAL',updated_at=NOW() WHERE id=$1",[member.id]);
   await auditStrict(db,{action:'member.payment_attest',actor,target,subject:member.id,result:'OK',detail:body.method,amountAgorot:amount,newStatus:'LOCKED'});
   return {memberId:member.id,recorded:true,locked:true};
  });
 }

 // Owner: a mistaken payment record is voided (kept, with when, who and why) and optionally replaced by a corrected
 // one in the same transaction. The order stays LOCKED either way: a voided payment never reopens it to the customer.
 // Never a refund and never a Shopify or Cardcom change.
 async correctPayment(id:string,memberId:string,body:any,actor:string){
  const target=publicId(id);uuid(memberId,'MEMBER_NOT_FOUND');
  if(body?.attest!==true)throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לאשר במפורש את התיקון.');
  const why=typeof body?.reason==='string'?body.reason.trim().replace(/\s+/g,' '):'';
  if(why.length<3||why.length>60||/@/.test(why)||/\d[\d\s-]{6,}\d/.test(why)||/[<>]/.test(why))throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לכתוב סיבה קצרה (3 עד 60 תווים, בלי פרטי קשר).');
  const replacement=body?.replacement?this.paymentInput(body.replacement):null;
  return this.groups.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[target])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
   const member=(await db.query('SELECT id,status,pledged_total_agorot,order_state,md5(cart_snapshot::text) AS fingerprint FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
   if(!member)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
   const active=(await db.query('SELECT id,amount_agorot FROM member_payment_records WHERE member_id=$1 AND voided_at IS NULL FOR UPDATE',[member.id])).rows[0];
   if(!active)throw new ApiError(409,'NO_PAYMENT_RECORD','אין תשלום רשום להזמנה הזו.');
   if(replacement&&Number(member.pledged_total_agorot)!==replacement.amount)throw new ApiError(409,'INVALID_PAYMENT_RECORD','הסכום המתוקן חייב להיות זהה לסכום ההזמנה ('+(Number(member.pledged_total_agorot)/100).toFixed(2)+' ₪).');
   await db.query('UPDATE member_payment_records SET voided_at=NOW(),voided_by=$2,void_reason=$3 WHERE id=$1',[active.id,actor,why]);
   await auditStrict(db,{action:'member.payment_void',actor,target,subject:member.id,result:'OK',amountAgorot:Number(active.amount_agorot),detail:replacement?'CORRECTED':'VOIDED'});
   let corrected=null;
   if(replacement){
    corrected=randomUUID();
    await db.query(`INSERT INTO member_payment_records(id,member_id,group_id,amount_agorot,method,received_on,reference,cart_fingerprint,attested_by,replaces_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[corrected,member.id,group.id,replacement.amount,replacement.method,replacement.day,replacement.note,member.fingerprint,actor,active.id]);
    await auditStrict(db,{action:'member.payment_attest',actor,target,subject:member.id,result:'OK',detail:replacement.method,amountAgorot:replacement.amount,newStatus:'LOCKED'});
   }
   // Never unlocked here: the order stays protected until the owner reconciles it (a new record, or an explicit release).
   return {memberId:member.id,voided:true,corrected:corrected!==null,locked:member.order_state==='LOCKED'};
  });
 }
 // Owner: releases an order locked only by a payment record that was voided (never a delivered order, never a
 // completed cycle), so the customer can edit it again. Explicit, with a reason, audited.
 async releaseOrder(id:string,memberId:string,body:any,actor:string){
  const target=publicId(id);uuid(memberId,'MEMBER_NOT_FOUND');
  if(body?.attest!==true)throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לאשר במפורש את השחרור.');
  const why=typeof body?.reason==='string'?body.reason.trim().replace(/\s+/g,' '):'';
  if(why.length<3||why.length>60||/@/.test(why)||/\d[\d\s-]{6,}\d/.test(why)||/[<>]/.test(why))throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לכתוב סיבה קצרה (3 עד 60 תווים, בלי פרטי קשר).');
  return this.groups.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[target])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
   const member=(await db.query('SELECT id,order_state,locked_reason FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
   if(!member)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא בקבוצה הזאת.');
   if(member.order_state!=='LOCKED'||member.locked_reason!=='PAID_EXTERNAL'||group.operational_status==='COMPLETED')
    throw new ApiError(409,'RELEASE_NOT_ALLOWED','רק הזמנה שננעלה בגלל תשלום שבוטל, במחזור שעוד לא הושלם, יכולה להשתחרר לעריכה.');
   if((await db.query('SELECT 1 FROM member_payment_records WHERE member_id=$1 AND voided_at IS NULL',[member.id])).rows.length)
    throw new ApiError(409,'RELEASE_NOT_ALLOWED','להזמנה יש תשלום רשום ופעיל. יש לבטל אותו קודם.');
   // Same row, open again; the cart, its versions and every payment record stay as they were.
   await db.query("UPDATE group_members SET order_state='OPEN',locked_at=NULL,locked_reason=NULL,updated_at=NOW() WHERE id=$1",[member.id]);
   await auditStrict(db,{action:'member.order_release',actor,target,subject:member.id,result:'OK',previousStatus:'LOCKED',newStatus:'OPEN',detail:'PAYMENT_VOIDED'});
   return {memberId:member.id,released:true};
  });
 }
 private paymentInput(body:any){
  const amount=Number(body?.amountAgorot);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new ApiError(400,'INVALID_PAYMENT_RECORD','סכום התשלום אינו תקין.');
  if(!(PAYMENT_METHODS as readonly string[]).includes(body?.method))throw new ApiError(400,'INVALID_PAYMENT_RECORD','יש לבחור אמצעי תשלום.');
  const day=typeof body?.receivedOn==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(body.receivedOn)?body.receivedOn:null;
  if(!day||Number.isNaN(Date.parse(day+'T00:00:00Z'))||Date.parse(day+'T00:00:00Z')>Date.now()+86400000)throw new ApiError(400,'INVALID_PAYMENT_RECORD','תאריך קבלת התשלום אינו תקין.');
  let note:string|null;
  try{note=reference(body?.reference);}catch{throw new ApiError(400,'INVALID_PAYMENT_RECORD','ההערה יכולה להכיל עד 60 תווים, בלי פרטי קשר או כרטיס.');}
  return {amount,method:body.method as string,day,note};
 }

 // ---------- Customer: another, separate order from an existing receipt ----------
 async anotherOrder(id:string,token:string,body:any){
  const proof=await this.groups.member(id,token);
  if(body?.confirm!==true)throw new ApiError(400,'ORDER_CONFIRMATION_REQUIRED','יש לאשר שזו הזמנה נוספת ונפרדת.');
  const requestId=typeof body?.requestId==='string'&&UUID.test(body.requestId)?body.requestId:null;
  if(!requestId)throw new ApiError(400,'INVALID_INPUT');
  if(this.groups.paymentMode()==='CARDCOM')throw new ApiError(409,'CARD_RESERVATION_REQUIRED','כדי לשריין מקום במשלוח הקבוצתי יש להזין כרטיס אשראי. לא יתבצע חיוב כעת.');
  if(Array.isArray(body?.lines)&&body.lines.length===0)throw new ApiError(422,'EMPTY_CART_CANNOT_UPDATE_PLEDGE','הסל ריק.');
  const cart=await this.shopify.validate(lines(body?.lines));
  return this.groups.locked(async db=>{
   if((await db.query('SELECT 1 FROM member_links WHERE request_id=$1',[requestId])).rows.length)throw new ApiError(409,'DUPLICATE_REQUEST','ההזמנה הזו כבר נשלחה.');
   const source=(await db.query('SELECT m.email,m.phone,a.public_id AS area FROM group_members m JOIN delivery_groups g ON g.id=m.group_id JOIN delivery_areas a ON a.id=g.area_id WHERE m.id=$1',[proof.id])).rows[0];
   if(!source)throw new ApiError(409,'GROUP_CLOSED');
   const place=this.groups.areas.place(await this.groups.areas.resolve(db,source.area));
   const existing=await this.groups.match(db,place);
   const group=existing||await this.groups.create(db,place);
   // At most one OPEN order per customer per cycle: an open order there is edited instead (update-pledge). The
   // customer's LOCKED orders (paid or delivered) stay untouched beside the new one.
   if((await db.query("SELECT 1 FROM group_members WHERE group_id=$1 AND (email=$2 OR phone=$3) AND order_state='OPEN'",[group.id,source.email,source.phone])).rows.length)
    throw new ApiError(409,'ORDER_EXISTS_IN_CYCLE','כבר יש לך הזמנה פתוחה במחזור הנוכחי. אפשר לעדכן אותה.');
   const admitted=await this.groups.admit(db,group,place,{email:source.email,phone:source.phone},cart,{cartSource:'ANOTHER_ORDER',besideLocked:true});
   await db.query("INSERT INTO member_links(id,from_member_id,to_member_id,reason,request_id) VALUES($1,$2,$3,'ANOTHER_ORDER',$4)",[randomUUID(),proof.id,admitted.memberId,requestId]);
   return {group:admitted.group,memberToken:admitted.memberToken!,validatedPledgeAgorot:admitted.validatedPledgeAgorot,created:!existing};
  });
 }
 // A receipt for each order linked to this receipt's order (split or placed from it). One new device receipt per call.
 async linkedReceipts(id:string,token:string){
  const proof=await this.groups.member(id,token);
  return this.groups.locked(async db=>{
   const links=(await db.query('SELECT l.to_member_id,g.public_id FROM member_links l JOIN group_members t ON t.id=l.to_member_id JOIN delivery_groups g ON g.id=t.group_id WHERE l.from_member_id=$1 ORDER BY l.created_at',[proof.id])).rows;
   const out=[];
   for(const link of links){
    const issued=Number((await db.query("SELECT count(*) AS n FROM member_tokens WHERE member_id=$1 AND source='LINK'",[link.to_member_id])).rows[0].n);
    if(issued>=LINK_TOKEN_LIMIT)throw new ApiError(429,'RATE_LIMITED');
    out.push({groupPublicId:link.public_id as string,memberToken:await issueToken(db,link.to_member_id,'LINK')});
   }
   return {orders:out};
  });
 }

 // ---------- Owner: end the cycle and open the next one ----------
 private plan(body:any){
  const restore=(Array.isArray(body?.restore)?body.restore:[]).map((r:any)=>({memberId:uuid(r?.memberId),reconfirmationId:uuid(r?.reconfirmationId)}));
  const transfer=(Array.isArray(body?.transfer)?body.transfer:[]).map((m:any)=>uuid(m));
  const ids=[...restore.map((r:any)=>r.memberId),...transfer];
  if(!ids.length||new Set(ids).size!==ids.length||ids.length>50)throw new ApiError(400,'INVALID_INPUT','יש לבחור הזמנות להעברה למחזור החדש, כל אחת פעם אחת.');
  const accept:Record<string,number>={};
  for(const [k,v] of Object.entries(body?.acceptTotals&&typeof body.acceptTotals==='object'?body.acceptTotals:{})){uuid(k);if(!Number.isSafeInteger(Number(v)))throw new ApiError(400,'INVALID_INPUT');accept[k]=Number(v);}
  return {restore,transfer,accept};
 }
 private async inspect(db:Queryable,id:string,plan:{restore:any[];transfer:string[]}){
  const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  const blockers:string[]=[];
  if(group.payment_mode!=='NONE')blockers.push('CARD_GROUP');
  if(group.operational_status==='COMPLETED')blockers.push('ALREADY_COMPLETED');
  if(!['OPEN','THRESHOLD_REACHED','EXPIRED'].includes(group.status))blockers.push('STATUS_'+group.status);
  if(group.area_id===null)blockers.push('NO_AREA');
  if(Number(group.paid_total_agorot)!==0||group.payment_state!==null)blockers.push('PAYMENT_RECORDED');
  if((await db.query('SELECT 1 FROM group_payment_charges WHERE group_id=$1 UNION ALL SELECT 1 FROM group_payment_reservations WHERE group_id=$1 OR member_id IN (SELECT id FROM group_members WHERE group_id=$1) LIMIT 1',[group.id])).rows.length)blockers.push('CHARGES_OR_RESERVATIONS');
  if(this.groups.paymentMode()!=='NONE')blockers.push('CARD_MODE_ACTIVE');
  const members=(await db.query(`SELECT m.id,m.status,m.email,m.phone,m.locality_key,m.pledged_total_agorot,m.cart_snapshot,m.order_state,m.created_at,md5(m.cart_snapshot::text) AS fingerprint,
   EXISTS(SELECT 1 FROM member_payment_records p WHERE p.member_id=m.id AND p.voided_at IS NULL) AS paid
   FROM group_members m WHERE m.group_id=$1 ORDER BY m.created_at,m.id`,[group.id])).rows;
  const byId=new Map(members.map((m:any)=>[m.id,m]));
  const restores=[];
  for(const r of plan.restore){
   const m=byId.get(r.memberId);
   if(!m||m.status!==ACTIVE_MEMBER_STATUS||m.order_state!=='OPEN')throw new ApiError(409,'RESTORE_SOURCE_INVALID','ההזמנה לשחזור אינה הזמנה פעילה ופתוחה בקבוצה.');
   const c=(await db.query('SELECT id,confirmed_snapshot,confirmed_amount_agorot,md5(confirmed_snapshot::text) AS fingerprint FROM member_reconfirmations WHERE id=$1 AND member_id=$2 AND group_id=$3 AND used_at IS NOT NULL',[r.reconfirmationId,m.id,group.id])).rows[0];
   if(!c)throw new ApiError(409,'RESTORE_SOURCE_INVALID','לא נמצא אישור לקוח מאומת עם הסל המקורי של ההזמנה.');
   if(c.fingerprint===m.fingerprint)throw new ApiError(409,'RESTORE_SOURCE_INVALID','הסל הנוכחי זהה לסל המקורי; אין מה לשחזר.');
   restores.push({member:m,confirmation:c});
  }
  const transfers=plan.transfer.map(mid=>{
   const m=byId.get(mid);
   if(!m||m.status!==ACTIVE_MEMBER_STATUS||m.order_state!=='OPEN'||m.paid)throw new ApiError(409,'SPLIT_NOT_ALLOWED','רק הזמנה פעילה, פתוחה ושלא שולמה עוברת למחזור החדש.');
   return m;
  });
  const carried=new Set([...plan.transfer]);
  const historical=members.filter((m:any)=>m.status===ACTIVE_MEMBER_STATUS&&!carried.has(m.id));
  const state=(await db.query(STATE_SQL,[group.id])).rows[0].state as string;
  return {group,blockers,members,restores,transfers,historical,state};
 }
 // The current cycle of the area other than the source, if any (a customer may have started it meanwhile).
 private async currentOther(db:Queryable,group:any){
  return (await db.query("SELECT * FROM delivery_groups WHERE area_id=$1 AND id<>$2 AND status IN ('OPEN','THRESHOLD_REACHED') AND operational_status<>'COMPLETED' AND expires_at>NOW() AND payment_mode='NONE' ORDER BY created_at LIMIT 1",[group.area_id,group.id])).rows[0];
 }
 // Today's Shopify total of every carried cart (network, outside any lock).
 private async check(carts:{memberId:string;snapshot:SnapshotLine[];stored:number}[],accept:Record<string,number>){
  const out=new Map<string,{snapshot:SnapshotLine[];total:number;changed:boolean;accepted:boolean}>();
  for(const c of carts){
   const v=await this.shopify.validate(lineInput(c.snapshot));
   const total=Number(v.total);
   out.set(c.memberId,{snapshot:v.snapshot,total,changed:total!==c.stored,accepted:total===c.stored||accept[c.memberId]===total});
  }
  return out;
 }
 private carried(inspected:any){
  return [...inspected.restores.map((r:any)=>({memberId:r.member.id,snapshot:r.member.cart_snapshot,stored:Number(r.member.pledged_total_agorot)})),
   ...inspected.transfers.map((m:any)=>({memberId:m.id,snapshot:m.cart_snapshot,stored:Number(m.pledged_total_agorot)}))];
 }
 async splitPreview(id:string,body:any){
  const plan=this.plan(body);
  await this.groups.expire();
  const inspected=await this.inspect(this.db,id,plan);
  const prices=await this.check(this.carried(inspected),plan.accept);
  const target=await this.currentOther(this.db,inspected.group);
  const restoredTotal=inspected.restores.reduce((s:number,r:any)=>s+Number(r.confirmation.confirmed_amount_agorot),0);
  const keptTotal=inspected.historical.filter((m:any)=>!inspected.restores.some((r:any)=>r.member.id===m.id)).reduce((s:number,m:any)=>s+Number(m.pledged_total_agorot),0);
  const carriedTotal=[...prices.values()].reduce((s,v)=>s+v.total,0);
  return {state:inspected.state,blockers:inspected.blockers,
   before:{publicId:inspected.group.public_id,status:inspected.group.status,totalAgorot:Number(inspected.group.pledged_total_agorot),orders:inspected.members.filter((m:any)=>m.status===ACTIVE_MEMBER_STATUS).length},
   after:{
    source:{publicId:inspected.group.public_id,status:'COMPLETED',totalAgorot:keptTotal+restoredTotal,orders:inspected.historical.length,
     thresholdAgorot:Number(inspected.group.threshold_agorot),thresholdMet:keptTotal+restoredTotal>=Number(inspected.group.threshold_agorot)},
    target:{publicId:target?.public_id??null,created:!target,totalAgorot:(target?Number(target.pledged_total_agorot):0)+carriedTotal,
     orders:(target?Number((await this.db.query("SELECT count(*) AS n FROM group_members WHERE group_id=$1 AND status='PLEDGED'",[target.id])).rows[0].n):0)+prices.size}},
   restore:inspected.restores.map((r:any)=>({memberId:r.member.id,email:r.member.email,phone:r.member.phone,currentAgorot:Number(r.member.pledged_total_agorot),restoredAgorot:Number(r.confirmation.confirmed_amount_agorot),
    restoredLines:r.confirmation.confirmed_snapshot.length,restoredFingerprint:r.confirmation.fingerprint,restoredCart:cartLines(r.confirmation.confirmed_snapshot),
    newOrderAgorot:prices.get(r.member.id)!.total,newOrderCart:cartLines(prices.get(r.member.id)!.snapshot),newOrderFingerprint:r.member.fingerprint})),
   transfer:inspected.transfers.map((m:any)=>({memberId:m.id,email:m.email,phone:m.phone,amountAgorot:prices.get(m.id)!.total,cart:cartLines(prices.get(m.id)!.snapshot),fingerprint:m.fingerprint})),
   priceChanges:[...prices.entries()].filter(([,v])=>v.changed).map(([memberId,v])=>({memberId,todayAgorot:v.total,accepted:v.accepted})),
   historical:inspected.historical.map((m:any)=>{const r=inspected.restores.find((x:any)=>x.member.id===m.id);
    return {memberId:m.id,email:m.email,phone:m.phone,restored:!!r,locked:m.order_state==='LOCKED',amountAgorot:r?Number(r.confirmation.confirmed_amount_agorot):Number(m.pledged_total_agorot),
     cart:cartLines(r?r.confirmation.confirmed_snapshot:m.cart_snapshot),paidRecorded:m.paid};})};
 }
 async split(id:string,body:any,actor:string){
  const plan=this.plan(body);
  if(body?.confirm!==true||body?.deliveredAttested!==true)throw new ApiError(400,'SPLIT_CONFIRMATION_REQUIRED','יש לאשר במפורש שהמשלוח של המחזור הקודם בוצע ושהפעולה מבוקשת.');
  if(!(SPLIT_REASONS as readonly string[]).includes(body?.reason))throw new ApiError(400,'INVALID_INPUT','יש לבחור את סיבת הפעולה.');
  const key=uuid(body?.idempotencyKey),expected=typeof body?.expectedState==='string'?body.expectedState:'';
  // Replay of a completed split: the same result, nothing written again.
  const done=(await this.db.query('SELECT summary FROM group_cycle_splits WHERE idempotency_key=$1',[key])).rows[0];
  if(done)return {...done.summary,replayed:true};
  await this.groups.expire();
  const inspected0=await this.inspect(this.db,id,plan);
  if(inspected0.blockers.length)throw new ApiError(409,'SPLIT_NOT_ALLOWED','לא ניתן לבצע את הפעולה ('+inspected0.blockers.join(', ')+').');
  if(inspected0.state!==expected)throw new ApiError(409,'SPLIT_STATE_CHANGED','הנתונים השתנו מאז התצוגה המקדימה. יש להציג אותה שוב.');
  const prices=await this.check(this.carried(inspected0),plan.accept);
  for(const [,v] of prices)if(!v.accepted)throw new ApiError(409,'PRICE_CHANGED','מחיר של הזמנה שעוברת למחזור החדש השתנה. יש לאשר עם הלקוח את הסכום החדש.');
  return this.groups.locked(async db=>{
   if((await db.query('SELECT 1 FROM group_cycle_splits WHERE idempotency_key=$1',[key])).rows.length)throw new ApiError(409,'DUPLICATE_REQUEST','הפעולה כבר בוצעה.');
   await db.query('SELECT id FROM delivery_groups WHERE id=$1 FOR UPDATE',[inspected0.group.id]);
   const inspected=await this.inspect(db,id,plan);
   if(inspected.blockers.length)throw new ApiError(409,'SPLIT_NOT_ALLOWED','לא ניתן לבצע את הפעולה ('+inspected.blockers.join(', ')+').');
   if(inspected.state!==expected)throw new ApiError(409,'SPLIT_STATE_CHANGED','הנתונים השתנו מאז התצוגה המקדימה. יש להציג אותה שוב.');
   const source=inspected.group,sourceId=source.public_id as string;
   const existing=await this.currentOther(db,source);
   const area=(await db.query('SELECT * FROM delivery_areas WHERE id=$1',[source.area_id])).rows[0];
   const target=existing||await this.groups.create(db,this.groups.areas.place(area),'NONE');
   await db.query('SELECT id FROM delivery_groups WHERE id=$1 FOR UPDATE',[target.id]);
   const conflict=async(m:any)=>{
    if((await db.query('SELECT 1 FROM group_members WHERE group_id=$1 AND (email=$2 OR phone=$3)',[target.id,m.email,m.phone])).rows.length)
     throw new ApiError(409,'TRANSFER_CONFLICT','ללקוח כבר יש הזמנה במחזור החדש. לא בוצע שינוי.');
   };
   const reasonDetail=body.reason as string;
   // 1. Overwritten paid orders: restored from the verified cart; the current cart becomes a new, separate order.
   for(const r of inspected.restores){
    const m=r.member,carriedCart=prices.get(m.id)!;
    await conflict(m);
    const newId=randomUUID();
    await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
     [newId,target.id,m.email,m.phone,m.locality_key,JSON.stringify(carriedCart.snapshot),carriedCart.total.toString(),hash(randomBytes(32).toString('hex'))]);
    await recordCart(db,newId,'ADMIN_SPLIT',actor);
    await db.query("INSERT INTO member_links(id,from_member_id,to_member_id,reason) VALUES($1,$2,$3,'ORDER_SPLIT')",[randomUUID(),m.id,newId]);
    await db.query('UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,updated_at=NOW() WHERE id=$3',[JSON.stringify(r.confirmation.confirmed_snapshot),r.confirmation.confirmed_amount_agorot,m.id]);
    await recordCart(db,m.id,'ADMIN_RESTORE',actor);
    await auditStrict(db,{action:'member.order_restore',actor,target:sourceId,subject:m.id,result:'OK',detail:reasonDetail,amountAgorot:Number(r.confirmation.confirmed_amount_agorot)});
    await auditStrict(db,{action:'member.order_split',actor,target:target.public_id,subject:newId,result:'OK',detail:'FROM:'+m.id,amountAgorot:carriedCart.total});
   }
   // 2. Open, unpaid orders that belong to the next cycle: carried as a new row there (same customer, same cart),
   //    linked from the original; the original stays in the old cycle as history (WITHDRAWN, reason TRANSFERRED, its
   //    cart kept) and its receipt opens the new order through the link. Counted once: in the new cycle only.
   for(const m of inspected.transfers){
    await conflict(m);
    const carriedCart=prices.get(m.id)!,newId=randomUUID();
    await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
     [newId,target.id,m.email,m.phone,m.locality_key,JSON.stringify(carriedCart.snapshot),carriedCart.total.toString(),hash(randomBytes(32).toString('hex'))]);
    await recordCart(db,newId,'ADMIN_TRANSFER',actor);
    await db.query("INSERT INTO member_links(id,from_member_id,to_member_id,reason) VALUES($1,$2,$3,'CYCLE_TRANSFER')",[randomUUID(),m.id,newId]);
    await db.query("UPDATE group_members SET status='WITHDRAWN',pledged_total_agorot=0,withdrawn_at=NOW(),withdrawn_by='TRANSFERRED',updated_at=NOW() WHERE id=$1 AND status='PLEDGED'",[m.id]);
    await auditStrict(db,{action:'member.transfer',actor,target:sourceId,subject:m.id,result:'OK',detail:'TO:'+newId,amountAgorot:carriedCart.total});
   }
   // 3. Every order left in the old cycle is history: locked (paid if attested, otherwise delivered).
   await db.query(`UPDATE group_members m SET order_state='LOCKED',locked_at=NOW(),updated_at=NOW(),
    locked_reason=CASE WHEN EXISTS(SELECT 1 FROM member_payment_records p WHERE p.member_id=m.id AND p.voided_at IS NULL) THEN 'PAID_EXTERNAL' ELSE 'DELIVERED' END
    WHERE m.group_id=$1 AND m.status='${ACTIVE_MEMBER_STATUS}' AND m.order_state='OPEN'`,[source.id]);
   // 4. Totals from the orders themselves, then the old cycle is completed (closed history; its business status keeps
   //    whether the target was reached, never claimed otherwise).
   await this.groups.recalculate(db,source);
   const targetAggregate=await this.groups.recalculate(db,(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[target.id])).rows[0]);
   const closed=(await db.query("UPDATE delivery_groups SET operational_status='COMPLETED',completed_at=NOW(),completed_by=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[source.id,actor])).rows[0];
   const sourceAggregate=await this.groups.aggregate(db,closed);
   await auditStrict(db,{action:'group.complete',actor,target:sourceId,result:'OK',previousStatus:source.operational_status,newStatus:'COMPLETED',amountAgorot:Number(closed.pledged_total_agorot),detail:'CYCLE_SPLIT'});
   await auditStrict(db,{action:'group.cycle_split',actor,target:sourceId,result:'OK',detail:'TO:'+target.public_id,amountAgorot:Number(closed.pledged_total_agorot),newStatus:closed.status});
   const summary={source:{publicId:sourceId,status:sourceAggregate.status,totalAgorot:sourceAggregate.pledgedTotalAgorot,orders:sourceAggregate.participantCount,thresholdMet:closed.status==='THRESHOLD_REACHED'},
    target:{publicId:target.public_id as string,created:!existing,status:targetAggregate.status,totalAgorot:targetAggregate.pledgedTotalAgorot,orders:targetAggregate.participantCount},
    restored:inspected.restores.length,split:inspected.restores.length,transferred:inspected.transfers.length};
   await db.query('INSERT INTO group_cycle_splits(id,idempotency_key,source_group_id,target_group_id,reason,summary,actor) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',
    [randomUUID(),key,source.id,target.id,body.reason,JSON.stringify(summary),actor]);
   return summary;
  });
 }

 // Admin form: the cycle's active orders, and for each one the verified original cart a restore can bring back
 // (a used reconfirmation whose cart differs from the current one). Read-only.
 async candidates(id:string){
  await this.groups.expire();
  const group=(await this.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  const rows=(await this.db.query(`SELECT m.id,m.email,m.phone,m.pledged_total_agorot,m.cart_snapshot,m.order_state,m.locked_reason,m.created_at,m.updated_at,
   EXISTS(SELECT 1 FROM member_payment_records p WHERE p.member_id=m.id AND p.voided_at IS NULL) AS paid,
   (SELECT row_to_json(r) FROM (SELECT x.id,x.confirmed_amount_agorot,x.confirmed_snapshot FROM member_reconfirmations x WHERE x.member_id=m.id AND x.group_id=m.group_id AND x.used_at IS NOT NULL
     AND md5(x.confirmed_snapshot::text)<>md5(m.cart_snapshot::text) ORDER BY x.used_at DESC LIMIT 1) r) AS original
   FROM group_members m WHERE m.group_id=$1 AND m.status='${ACTIVE_MEMBER_STATUS}' ORDER BY m.created_at,m.id`,[group.id])).rows;
  const target=group.area_id?await this.currentOther(this.db,group):null;
  return {group:{publicId:group.public_id as string,areaName:group.area_name as string,status:group.status as string,operationalStatus:group.operational_status as string,paymentMode:group.payment_mode as string,
    totalAgorot:Number(group.pledged_total_agorot),thresholdAgorot:Number(group.threshold_agorot)},
   target:target?{publicId:target.public_id as string,totalAgorot:Number(target.pledged_total_agorot)}:null,
   orders:rows.map((m:any)=>({id:m.id,email:m.email,phone:m.phone,amountAgorot:Number(m.pledged_total_agorot),cart:cartLines(m.cart_snapshot),locked:m.order_state==='LOCKED',lockedReason:m.locked_reason,paid:m.paid,
    createdAt:new Date(m.created_at).toISOString(),updatedAt:new Date(m.updated_at).toISOString(),
    original:m.original?{reconfirmationId:m.original.id as string,amountAgorot:Number(m.original.confirmed_amount_agorot),cart:cartLines(m.original.confirmed_snapshot)}:null}))};
 }
 // Admin payment reconciliation: every active order of the cycle, its delivery state and its external payment record.
 async payments(id:string){
  const group=(await this.db.query('SELECT id,payment_mode,operational_status FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  const rows=(await this.db.query(`SELECT m.id,m.email,m.phone,m.pledged_total_agorot,m.order_state,m.locked_reason,
   p.amount_agorot AS paid_agorot,p.method,to_char(p.received_on,'YYYY-MM-DD') AS received_on,p.reference,p.recorded_at,
   (SELECT count(*) FROM member_payment_records v WHERE v.member_id=m.id AND v.voided_at IS NOT NULL)::int AS voided
   FROM group_members m LEFT JOIN member_payment_records p ON p.member_id=m.id AND p.voided_at IS NULL
   WHERE m.group_id=$1 AND m.status='${ACTIVE_MEMBER_STATUS}' ORDER BY m.created_at,m.id`,[group.id])).rows;
  return {paymentMode:group.payment_mode as string,completed:group.operational_status==='COMPLETED',orders:rows.map((m:any)=>({id:m.id,email:m.email,phone:m.phone,amountAgorot:Number(m.pledged_total_agorot),
   locked:m.order_state==='LOCKED',lockedReason:m.locked_reason as string|null,voidedRecords:Number(m.voided),
   // Delivery and payment are separate: an order is delivered when it was locked as delivered or its cycle completed.
   delivery:m.locked_reason==='DELIVERED'||group.operational_status==='COMPLETED'?'DELIVERED':'OPEN',
   payment:m.paid_agorot===null?null:{amountAgorot:Number(m.paid_agorot),method:m.method,receivedOn:m.received_on,reference:m.reference,recordedAt:new Date(m.recorded_at).toISOString()}}))};
 }
 // Admin: every cart version and payment record of one order (no contact details).
 async history(memberId:string){
  uuid(memberId,'MEMBER_NOT_FOUND');
  const versions=(await this.db.query('SELECT amount_agorot,source,recorded_at,jsonb_array_length(cart_snapshot) AS lines,md5(cart_snapshot::text) AS fingerprint FROM member_cart_versions WHERE member_id=$1 ORDER BY recorded_at,id',[memberId])).rows;
  const payments=(await this.db.query('SELECT amount_agorot,method,received_on,reference,recorded_at,voided_at,voided_by,void_reason,replaces_id FROM member_payment_records WHERE member_id=$1 ORDER BY recorded_at',[memberId])).rows;
  return {versions:versions.map((v:any)=>({amountAgorot:Number(v.amount_agorot),source:v.source,lines:Number(v.lines),fingerprint:v.fingerprint,recordedAt:new Date(v.recorded_at).toISOString()})),
   payments:payments.map((p:any)=>({amountAgorot:Number(p.amount_agorot),method:p.method,receivedOn:String(p.received_on instanceof Date?p.received_on.toISOString().slice(0,10):p.received_on),reference:p.reference,recordedAt:new Date(p.recorded_at).toISOString(),voided:p.voided_at!==null,
   voidReason:p.void_reason??null,voidedBy:p.voided_by??null,correction:p.replaces_id!==null}))};
 }
}
export {LOCKED_MESSAGE};
