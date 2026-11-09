
import {randomBytes,randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,hash,contact,lines,publicId,distance,center,areaReference,type AreaPlace} from './domain.js';
import type {CartValidator,ValidatedCart} from './shopify.js';
import {Areas,type AreaRow} from './areas.js';
export class Groups {
 constructor(private db:Database,private config:Pick<Config,'threshold'|'expiryDays'|'standardRadius'|'storeLocation'|'areaSuggestionRadius'>,private shopify:CartValidator,private areas:Areas=new Areas(db,config)){}
 private async locked<T>(fn:(db:Queryable)=>Promise<T>):Promise<T>{
  return transaction(this.db,async db=>{
   await db.query('SELECT id FROM group_coordination WHERE id=1 FOR UPDATE');
   await this.expire(db);
   return fn(db);
  });
 }
 async expire(db:Queryable=this.db){await db.query("UPDATE delivery_groups SET status='EXPIRED',updated_at=NOW() WHERE expires_at<=NOW() AND status IN ('OPEN','THRESHOLD_REACHED','APPROVED')");}
 private async group(db:Queryable,id:string){
  const group=(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId(id)])).rows[0];
  if(!group)throw new ApiError(404,'GROUP_NOT_FOUND');return group;
 }
 private async aggregate(db:Queryable,group:any){
  const count=(await db.query("SELECT COUNT(*)::int AS count FROM group_members WHERE group_id=$1 AND status='PLEDGED'",[group.id])).rows[0].count;
  const total=BigInt(group.pledged_total_agorot),threshold=BigInt(group.threshold_agorot);
  return {publicId:group.public_id,areaName:group.area_name,status:group.status,participantCount:Number(count),currency:'ILS',thresholdAgorot:Number(threshold),pledgedTotalAgorot:Number(total),remainingAmountAgorot:Number(total<threshold?threshold-total:0n),progressPercent:Number(total>=threshold?100n:total*100n/threshold),expiresAt:new Date(group.expires_at).toISOString()};
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
  return this.aggregate(db,updated);
 }
 // Shared membership insert; must run inside locked(). Every rule applies to new and existing groups alike.
 // Members store no coordinates.
 private async enroll(db:Queryable,group:any,place:AreaPlace,person:{email:string;phone:string},cart:ValidatedCart){
  if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))throw new ApiError(409,'GROUP_CLOSED');
  if(!this.fits(group,place))throw new ApiError(409,'LOCATION_OUTSIDE_GROUP','המיקום אינו מתאים לקבוצה הזאת. חפשו קבוצה באזור שלכם.');
  const members=(await db.query('SELECT email,phone FROM group_members WHERE group_id=$1',[group.id])).rows;
  if(members.length>=100)throw new ApiError(409,'GROUP_FULL');
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
 async update(id:string,token:string,body:any){
  publicId(id);if(!/^[a-f0-9]{64}$/.test(token))throw new ApiError(401,'MEMBER_AUTH_REQUIRED');
  // Authenticate before spending a Shopify request.
  const proof=(await this.db.query('SELECT m.id FROM group_members m JOIN delivery_groups g ON m.group_id=g.id WHERE g.public_id=$1 AND m.token_hash=$2',[id,hash(token)])).rows[0];
  if(!proof)throw new ApiError(401,'MEMBER_AUTH_REQUIRED');
  const cart=Array.isArray(body?.lines)&&body.lines.length===0?{total:0n,snapshot:[]}:await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
   const group=await this.group(db,id);
   if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))throw new ApiError(409,'GROUP_CLOSED');
   await db.query('UPDATE group_members SET cart_snapshot=$1::jsonb,pledged_total_agorot=$2,status=$5,updated_at=NOW() WHERE id=$3 AND group_id=$4',[JSON.stringify(cart.snapshot),cart.total.toString(),proof.id,group.id,cart.total===0n?'WITHDRAWN':'PLEDGED']);
   return {group:await this.recalculate(db,group),validatedPledgeAgorot:Number(cart.total)};
  });
 }
 async list(){
  return this.locked(async db=>{
   const groups=(await db.query("SELECT * FROM delivery_groups ORDER BY CASE status WHEN 'THRESHOLD_REACHED' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'APPROVED' THEN 2 ELSE 3 END,created_at DESC LIMIT 200")).rows,result=[];
   for(const group of groups)result.push({...await this.aggregate(db,group),createdAt:new Date(group.created_at).toISOString(),legacy:group.area_id===null});
   return result;
  });
 }
 async approve(id:string){
  return this.locked(async db=>{
   const group=await this.group(db,id);
   if(group.status!=='THRESHOLD_REACHED'||BigInt(group.pledged_total_agorot)<BigInt(group.threshold_agorot))throw new ApiError(409,'APPROVAL_NOT_ALLOWED','ניתן לאשר רק קבוצה פעילה שהגיעה לסף.');
   const updated=(await db.query("UPDATE delivery_groups SET status='APPROVED',updated_at=NOW() WHERE id=$1 RETURNING *",[group.id])).rows[0];
   return this.aggregate(db,updated);
  });
 }
}
