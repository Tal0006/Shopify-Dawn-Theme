// Renewal of expired groups by the store owner, inside the existing admin. An expired group keeps its members' pledges;
// none of them counts again silently. The owner records each customer's explicit reconfirmation (re-checked against
// today's Shopify prices and availability), then reopens the group for a limited time. Under the coordination lock the
// reopen counts only reconfirmed pledges; every other pledge is kept as an expired, unconfirmed commitment (the row,
// its cart and its device receipts stay, so the customer can renew it themselves from the storefront). Card groups, paid or charged groups, groups
// whose delivery started and areas that already have a current group are refused. Every attempt is audited.
import {randomUUID} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {ApiError,publicId} from './domain.js';
import {ACTIVE_MEMBER_STATUS,type Groups} from './groups.js';
import type {CartValidator,SnapshotLine} from './shopify.js';
import {auditStrict} from './audit.js';

export const RECONFIRM_METHODS=['PHONE','WHATSAPP','EMAIL','IN_PERSON'] as const;
export type ReconfirmMethod=typeof RECONFIRM_METHODS[number];
export const REOPEN_DAYS={min:1,max:30,default:14};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Current groups of an area: still collecting pledges before their deadline, or approved and not delivered yet.
const CURRENT=`(x.status IN ('OPEN','THRESHOLD_REACHED') AND x.expires_at>NOW() OR x.status='APPROVED') AND x.operational_status<>'COMPLETED'`;

// A short free-text note (date, ticket number). Contact details are refused: no e-mail and no phone-like digit run.
export function reference(value:unknown):string|null{
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string')throw new ApiError(400,'INVALID_RECONFIRMATION','הערת האישור אינה תקינה.');
 const text=value.trim().replace(/\s+/g,' ');
 if(!text)return null;
 if(text.length>60||/@/.test(text)||/\d[\d\s-]{6,}\d/.test(text)||/[<>]/.test(text))
  throw new ApiError(400,'INVALID_RECONFIRMATION','הערת האישור יכולה להכיל עד 60 תווים, בלי כתובת אימייל או מספר טלפון.');
 return text;
}
const lineInput=(snapshot:SnapshotLine[])=>snapshot.map(line=>({variantId:String(line.variantId),quantity:Number(line.quantity)}));
const sameLines=(a:SnapshotLine[],b:SnapshotLine[])=>JSON.stringify(a.map(l=>[l.variantId,Number(l.quantity),String(l.unitAgorot)]))===JSON.stringify(b.map(l=>[l.variantId,Number(l.quantity),String(l.unitAgorot)]));

export class Renewals {
 constructor(private db:Database,private groups:Groups,private shopify:CartValidator){}

 // What blocks a renewal of this group, checked again inside every write. Codes only; the page explains them.
 private async blockers(db:Queryable,group:any):Promise<string[]>{
  const out:string[]=[];
  if(group.status!=='EXPIRED')out.push('NOT_EXPIRED');
  if(group.operational_status!=='NEW')out.push('DELIVERY_STARTED');
  if(group.payment_mode!=='NONE')out.push('CARD_GROUP');
  if(Number(group.paid_total_agorot)!==0||group.payment_state!==null)out.push('PAYMENT_RECORDED');
  if(group.area_id===null)out.push('NO_AREA');
  if((await db.query('SELECT 1 FROM group_payment_charges WHERE group_id=$1 LIMIT 1',[group.id])).rows.length)out.push('CHARGES_EXIST');
  if((await db.query("SELECT 1 FROM group_members WHERE group_id=$1 AND payment_status IN ('CHARGE_PENDING','CHARGED','PAYMENT_FAILED') LIMIT 1",[group.id])).rows.length)out.push('PAYMENT_RECORDED');
  if(group.area_id!==null&&(await db.query(`SELECT 1 FROM delivery_groups x WHERE x.area_id=$1 AND x.id<>$2 AND ${CURRENT} LIMIT 1`,[group.area_id,group.id])).rows.length)out.push('CURRENT_GROUP_EXISTS');
  return [...new Set(out)];
 }
 // The same person (same e-mail or phone) already counted in another current group.
 private async activeElsewhere(db:Queryable,memberId:string):Promise<boolean>{
  return (await db.query(`SELECT 1 FROM group_members m JOIN group_members o ON o.id<>m.id AND (o.email=m.email OR o.phone=m.phone) AND o.status='${ACTIVE_MEMBER_STATUS}'
   JOIN delivery_groups x ON x.id=o.group_id WHERE m.id=$1 AND x.id<>m.group_id AND ${CURRENT} LIMIT 1`,[memberId])).rows.length>0;
 }
 // The confirmation that counts for a member: the newest one recorded after the group expired, not used or revoked.
 private async confirmation(db:Queryable,group:any,memberId:string){
  return (await db.query('SELECT * FROM member_reconfirmations WHERE group_id=$1 AND member_id=$2 AND used_at IS NULL AND revoked_at IS NULL AND recorded_at>=$3 ORDER BY recorded_at DESC LIMIT 1',
   [group.id,memberId,group.expires_at])).rows[0];
 }

 // Renewal state of one group for its admin page: blockers, and each stored pledge with its confirmation.
 async state(id:string){
  await this.groups.expire();
  const group=(await this.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  if(group.status!=='EXPIRED')return {eligible:false,expired:false,blockers:[] as string[],members:[] as any[],reopenedCount:Number(group.reopened_count),lastReopenedAt:group.last_reopened_at?new Date(group.last_reopened_at).toISOString():null};
  const blockers=await this.blockers(this.db,group);
  const members=[];
  for(const m of (await this.db.query(`SELECT id,email,phone,pledged_total_agorot,created_at FROM group_members WHERE group_id=$1 AND status='${ACTIVE_MEMBER_STATUS}' ORDER BY created_at,id`,[group.id])).rows){
   const c=await this.confirmation(this.db,group,m.id);
   members.push({id:m.id,email:m.email,phone:m.phone,pledgedTotalAgorot:Number(m.pledged_total_agorot),
    confirmation:c?{method:c.method,reference:c.reference,confirmedAmountAgorot:Number(c.confirmed_amount_agorot),recordedAt:new Date(c.recorded_at).toISOString()}:null,
    activeElsewhere:await this.activeElsewhere(this.db,m.id)});
  }
  return {eligible:blockers.length===0&&members.some(m=>m.confirmation&&!m.activeElsewhere),expired:true,blockers,members,
   reopenedCount:Number(group.reopened_count),lastReopenedAt:group.last_reopened_at?new Date(group.last_reopened_at).toISOString():null};
 }

 // Today's total of a member's stored cart (for the price-change step of the form). Read-only.
 async currentTotal(id:string,memberId:string):Promise<number>{
  const row=(await this.db.query('SELECT m.cart_snapshot FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1 AND m.id=$2',[publicId(id),memberId])).rows[0];
  if(!row)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא.');
  return Number((await this.shopify.validate(lineInput(Array.isArray(row.cart_snapshot)?row.cart_snapshot:[]))).total);
 }
 // Records a customer's explicit reconfirmation of their stored pledge. The cart is re-checked with Shopify now; when
 // today's total differs from the stored pledge, the owner must state the new total the customer agreed to.
 async reconfirm(id:string,memberId:string,body:any,actor:string){
  const target=publicId(id);
  if(typeof memberId!=='string'||!UUID.test(memberId))throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא.');
  const method=body?.method;
  if(!(RECONFIRM_METHODS as readonly string[]).includes(method))throw new ApiError(400,'INVALID_RECONFIRMATION','יש לבחור כיצד הלקוח אישר.');
  const note=reference(body?.reference);
  const before=(await this.db.query('SELECT m.cart_snapshot,m.pledged_total_agorot FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1 AND m.id=$2',[target,memberId])).rows[0];
  if(!before)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא.');
  const snapshot:SnapshotLine[]=Array.isArray(before.cart_snapshot)?before.cart_snapshot:[];
  // Network call outside the lock: availability, quantity rules and today's prices, exactly as a customer update.
  const cart=await this.shopify.validate(lineInput(snapshot));
  const total=Number(cart.total);
  if(total!==Number(before.pledged_total_agorot)&&Number(body?.acceptTotalAgorot)!==total)
   throw new ApiError(409,'PRICE_CHANGED','מחירי המוצרים השתנו. סכום ההתחייבות היום: '+(total/100).toFixed(2)+' ₪. יש לאשר עם הלקוח את הסכום החדש ולסמן זאת.');
  return this.groups.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[target])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
   const blockers=(await this.blockers(db,group)).filter(code=>code!=='CURRENT_GROUP_EXISTS');
   if(blockers.length)throw new ApiError(409,'RENEWAL_NOT_ALLOWED','לא ניתן לחדש את הקבוצה הזו ('+blockers.join(', ')+'). לא בוצע שינוי.');
   const member=(await db.query('SELECT id,status,pledged_total_agorot,cart_snapshot FROM group_members WHERE id=$1 AND group_id=$2 FOR UPDATE',[memberId,group.id])).rows[0];
   if(!member)throw new ApiError(404,'MEMBER_NOT_FOUND','הלקוח לא נמצא.');
   if(member.status!==ACTIVE_MEMBER_STATUS)throw new ApiError(409,'RENEWAL_NOT_ALLOWED','הלקוח כבר אינו פעיל בקבוצה. הוא יכול לחדש בעצמו לאחר פתיחת הקבוצה.');
   if(!sameLines(member.cart_snapshot,snapshot))throw new ApiError(409,'RENEWAL_NOT_ALLOWED','הסל השתנה בזמן הבדיקה. יש לנסות שוב.');
   if(await this.activeElsewhere(db,member.id))throw new ApiError(409,'ALREADY_ACTIVE_ELSEWHERE','הלקוח כבר רשום במשלוח קבוצתי פעיל אחר. לא בוצע שינוי.');
   await db.query('UPDATE member_reconfirmations SET revoked_at=NOW() WHERE member_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[member.id]);
   await db.query(`INSERT INTO member_reconfirmations(id,group_id,member_id,method,reference,previous_amount_agorot,confirmed_amount_agorot,confirmed_snapshot,recorded_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[randomUUID(),group.id,member.id,method,note,member.pledged_total_agorot,cart.total.toString(),JSON.stringify(cart.snapshot),actor]);
   await auditStrict(db,{action:'member.reconfirm',actor,target,subject:member.id,result:'OK',detail:method,amountAgorot:total,previousStatus:'PLEDGED'});
   return {memberId:member.id,method,confirmedAmountAgorot:total,previousAmountAgorot:Number(member.pledged_total_agorot)};
  });
 }

 // Reopens an expired group for `days` days. Counts only reconfirmed pledges (re-checked against Shopify again: a
 // price change since the confirmation refuses the reopen); every other pledge is kept as an expired, unconfirmed commitment.
 async reopen(id:string,body:any,actor:string){
  const target=publicId(id);
  if(body?.confirm!==true)throw new ApiError(400,'REOPEN_CONFIRMATION_REQUIRED','נדרש אישור מפורש לפתיחת הקבוצה מחדש.');
  const days=Number(body?.days);
  if(!Number.isInteger(days)||days<REOPEN_DAYS.min||days>REOPEN_DAYS.max)throw new ApiError(400,'INVALID_INPUT','מספר הימים חייב להיות בין '+REOPEN_DAYS.min+' ל-'+REOPEN_DAYS.max+'.');
  await this.groups.expire();
  const group0=(await this.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[target])).rows[0];
  if(!group0)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  const confirmed0=(await this.db.query(`SELECT DISTINCT ON (r.member_id) r.* FROM member_reconfirmations r JOIN group_members m ON m.id=r.member_id AND m.status='${ACTIVE_MEMBER_STATUS}'
   WHERE r.group_id=$1 AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.recorded_at>=$2 ORDER BY r.member_id,r.recorded_at DESC`,[group0.id,group0.expires_at])).rows;
  // Re-check every confirmed cart now (outside the lock): the amount must still be exactly what the customer confirmed.
  for(const c of confirmed0){
   const cart=await this.shopify.validate(lineInput(c.confirmed_snapshot));
   if(Number(cart.total)!==Number(c.confirmed_amount_agorot))throw new ApiError(409,'PRICE_CHANGED','המחירים השתנו מאז אישור הלקוח. יש לאשר עם הלקוח את הסכום החדש לפני הפתיחה.');
  }
  return this.groups.locked(async db=>{
   const group=(await db.query('SELECT * FROM delivery_groups WHERE id=$1 FOR UPDATE',[group0.id])).rows[0];
   const blockers=await this.blockers(db,group);
   if(blockers.includes('CURRENT_GROUP_EXISTS'))throw new ApiError(409,'CURRENT_GROUP_EXISTS','כבר קיימת קבוצה פעילה באזור הזה. פתיחת קבוצה נוספת הייתה מפצלת את ההתקדמות. לא בוצע שינוי.');
   if(blockers.includes('CARD_GROUP'))throw new ApiError(409,'CARD_GROUP_REQUIRES_CUSTOMER','בקבוצה עם שריון כרטיס, כל לקוח צריך לשריין כרטיס מחדש בעצמו. לא בוצע שינוי.');
   if(blockers.length)throw new ApiError(409,'RENEWAL_NOT_ALLOWED','לא ניתן לפתוח את הקבוצה מחדש ('+blockers.join(', ')+'). לא בוצע שינוי.');
   const members=(await db.query(`SELECT id,pledged_total_agorot FROM group_members WHERE group_id=$1 AND status='${ACTIVE_MEMBER_STATUS}' ORDER BY created_at FOR UPDATE`,[group.id])).rows;
   const counted:{member:any;c:any}[]=[],unconfirmed:any[]=[];
   for(const m of members){
    const c=await this.confirmation(db,group,m.id);
    if(c&&confirmed0.some(x=>x.id===c.id)){
     if(await this.activeElsewhere(db,m.id))throw new ApiError(409,'ALREADY_ACTIVE_ELSEWHERE','לקוח שאישר מחדש כבר רשום במשלוח קבוצתי פעיל אחר. לא בוצע שינוי.');
     counted.push({member:m,c});
    }else if(c){
     // A confirmation recorded after the Shopify check above (another tab): it was not checked, and treating the
     // customer as unconfirmed would wrongly expire a reconfirmed pledge. Refuse; a retry checks the current one.
     throw new ApiError(409,'RENEWAL_CHANGED','אישור של לקוח עודכן בזמן הבדיקה. לא בוצע שינוי; יש לנסות שוב.');
    }else unconfirmed.push(m);
   }
   if(!counted.length)throw new ApiError(409,'RECONFIRMATION_REQUIRED','אף לקוח עדיין לא אישר מחדש את ההתחייבות. יש לרשום אישור של לקוח אחד לפחות. לא בוצע שינוי.');
   for(const {member,c} of counted){
    await db.query('UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,updated_at=NOW() WHERE id=$3',[JSON.stringify(c.confirmed_snapshot),c.confirmed_amount_agorot,member.id]);
    await db.query('UPDATE member_reconfirmations SET used_at=NOW() WHERE id=$1',[c.id]);
   }
   for(const m of unconfirmed){
    // Not reconfirmed: kept as an expired, unconfirmed commitment (reason EXPIRED, dated at the group's expiry), never
    // shown as a withdrawal or a removal. The row, its cart (the original amount) and its device receipts stay; it no
    // longer counts. The customer sees an inactive membership and can renew it themselves.
    await db.query("UPDATE group_members SET status='WITHDRAWN',pledged_total_agorot=0,withdrawn_at=$2,withdrawn_by='EXPIRED',updated_at=NOW() WHERE id=$1",[m.id,group.expires_at]);
    await auditStrict(db,{action:'member.expire_unconfirmed',actor,target,subject:m.id,result:'OK',previousStatus:'PLEDGED',amountAgorot:Number(m.pledged_total_agorot),detail:'NOT_RECONFIRMED'});
   }
   await db.query("UPDATE delivery_groups SET expires_at=NOW()+($1::int*INTERVAL '1 day'),reopened_count=reopened_count+1,last_reopened_at=NOW(),updated_at=NOW() WHERE id=$2",[days,group.id]);
   const updated=(await db.query('SELECT * FROM delivery_groups WHERE id=$1',[group.id])).rows[0];
   // The service's own rule decides OPEN or THRESHOLD_REACHED from the counted pledges.
   const aggregate=await this.groups.recalculate(db,updated);
   const total=counted.reduce((sum,{c})=>sum+Number(c.confirmed_amount_agorot),0);
   await auditStrict(db,{action:'group.reopen',actor,target,result:'OK',previousStatus:'EXPIRED',newStatus:aggregate.status,amountAgorot:total,detail:'COUNTED_'+counted.length+'_EXPIRED_'+unconfirmed.length+'_DAYS_'+days});
   return {group:aggregate,counted:counted.length,expiredUnconfirmed:unconfirmed.length,days};
  });
 }
}
