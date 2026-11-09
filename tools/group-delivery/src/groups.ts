
import {randomBytes,randomUUID} from 'node:crypto';
import type {Config} from './config.js';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,hash,location,contact,lines,publicId,distance,center,type Location} from './domain.js';
import type {CartValidator,ValidatedCart} from './shopify.js';
export class Groups {
 constructor(private db:Database,private config:Pick<Config,'clusterRadius'|'threshold'|'expiryDays'|'standardRadius'|'storeLocation'>,private shopify:CartValidator){}
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
 private async fits(db:Queryable,group:any,place:Location):Promise<boolean>{
  if(group.anchor_lat===null)return place.lat===null&&group.locality_key===place.key;
  if(place.lat===null||place.lng===null)return false;
  const point={lat:place.lat,lng:place.lng},radius=this.config.clusterRadius;
  if(distance(point,{lat:group.anchor_lat,lng:group.anchor_lng})>radius||distance(point,{lat:group.center_lat,lng:group.center_lng})>radius)return false;
  const rows=(await db.query("SELECT approx_lat,approx_lng FROM group_members WHERE group_id=$1 AND status='PLEDGED'",[group.id])).rows;
  const points=rows.map(row=>({lat:row.approx_lat,lng:row.approx_lng}));points.push(point);
  const next=center(points);
  return points.every(p=>distance(p,next)<=radius);
 }
 private async create(db:Queryable,place:Location){
  const group=(await db.query(`INSERT INTO delivery_groups(id,public_id,area_name,locality_key,anchor_lat,anchor_lng,center_lat,center_lng,threshold_agorot,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$5,$6,$7,NOW()+($8::int * INTERVAL '1 day')) RETURNING *`,
   [randomUUID(),randomUUID(),place.areaName,place.key,place.lat,place.lng,this.config.threshold.toString(),this.config.expiryDays])).rows[0];
  return group;
 }
 // Compatible OPEN, unexpired group with capacity, nearest center first. Read-only. Fixed anchors stop a moving center
 // from chaining outward. Callers that create on a miss must run this inside locked() so the check and the insert
 // are one serialized step.
 private async match(db:Queryable,place:Location):Promise<any|undefined>{
  const candidates=(await db.query("SELECT g.* FROM delivery_groups g WHERE status='OPEN' AND expires_at>NOW() AND (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id)<100 AND (($1::double precision IS NULL AND anchor_lat IS NULL AND locality_key=$2) OR ($1::double precision IS NOT NULL AND anchor_lat IS NOT NULL AND ABS(anchor_lat-$1)<=$3)) ORDER BY created_at LIMIT 500",[place.lat,place.key,this.config.clusterRadius/110])).rows;
  const nearby=candidates.filter(group=>place.lat===null?group.anchor_lat===null&&group.locality_key===place.key:group.anchor_lat!==null&&distance({lat:place.lat,lng:place.lng!},{lat:group.anchor_lat,lng:group.anchor_lng})<=this.config.clusterRadius);
  nearby.sort((a,b)=>place.lat===null?0:distance({lat:place.lat,lng:place.lng!},{lat:a.center_lat,lng:a.center_lng})-distance({lat:place.lat,lng:place.lng!},{lat:b.center_lat,lng:b.center_lng}));
  for(const group of nearby)if(await this.fits(db,group,place))return group;
  return undefined;
 }
 private standard(place:Location){return this.config.storeLocation&&place.lat!==null?distance({lat:place.lat,lng:place.lng!},this.config.storeLocation)<=this.config.standardRadius:null;}
 // Search never writes: no group creation, no expiry update, no lock. A miss is reported as group:null and the
 // first join for the area creates the group (see joinArea).
 async find(body:any){
  const place=location(body?.location);
  const cart=body?.lines===undefined?undefined:await this.shopify.validate(lines(body.lines));
  const group=await this.match(this.db,place);
  return {group:group?await this.aggregate(this.db,group):null,canCreateOnJoin:!group,withinStandardRadius:this.standard(place),...(cart?{validatedPledgeAgorot:Number(cart.total)}:{})};
 }
 // DEPRECATED legacy compatibility for POST /groups/find-or-create, used only by the theme that is live before the
 // staged rollout. Keeps the old contract exactly: always returns a non-null group, creating an empty one on a miss
 // (under the lock), and has no canCreateOnJoin. Deliberately separate from find(), which must stay read-only.
 // Remove together with the route once production traffic uses /groups/find.
 async legacyFindOrCreate(body:any){
  const place=location(body?.location);
  const cart=body?.lines===undefined?undefined:await this.shopify.validate(lines(body.lines));
  return this.locked(async db=>{
   const group=await this.match(db,place)||await this.create(db,place);
   return {group:await this.aggregate(db,group),withinStandardRadius:this.standard(place),...(cart?{validatedPledgeAgorot:Number(cart.total)}:{})};
  });
 }
 async get(id:string){return this.locked(async db=>this.aggregate(db,await this.group(db,id)));}
 private async recalculate(db:Queryable,group:any){
  const rows=(await db.query("SELECT pledged_total_agorot,approx_lat,approx_lng FROM group_members WHERE group_id=$1 AND status='PLEDGED'",[group.id])).rows;
  const total=rows.reduce((sum:bigint,row:any)=>sum+BigInt(row.pledged_total_agorot),0n);
  if(total>1000000000n)throw new ApiError(422,'GROUP_LIMIT');
  let next={lat:group.anchor_lat,lng:group.anchor_lng};
  if(group.anchor_lat!==null&&rows.length)next=center(rows.map(row=>({lat:row.approx_lat,lng:row.approx_lng})));
  const updated=(await db.query('UPDATE delivery_groups SET pledged_total_agorot=$1,center_lat=$2,center_lng=$3,status=$4,updated_at=NOW() WHERE id=$5 RETURNING *',
   [total.toString(),next.lat,next.lng,total>=BigInt(group.threshold_agorot)?'THRESHOLD_REACHED':'OPEN',group.id])).rows[0];
  return this.aggregate(db,updated);
 }
 // Shared membership insert; must run inside locked(). Every rule applies to new and existing groups alike.
 private async enroll(db:Queryable,group:any,place:Location,person:{email:string;phone:string},cart:ValidatedCart){
  if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))throw new ApiError(409,'GROUP_CLOSED');
  if(!await this.fits(db,group,place))throw new ApiError(409,'LOCATION_OUTSIDE_GROUP','המיקום אינו מתאים לקבוצה הזאת. חפשו קבוצה באזור שלכם.');
  const members=(await db.query('SELECT email,phone FROM group_members WHERE group_id=$1',[group.id])).rows;
  if(members.length>=100)throw new ApiError(409,'GROUP_FULL');
  if(members.some(member=>member.email===person.email||member.phone===person.phone))throw new ApiError(409,'ALREADY_JOINED','לא ניתן להצטרף שוב עם אותם פרטים. לעדכון הסל השתמשו באישור ההצטרפות הקיים.');
  const token=randomBytes(32).toString('hex');
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,approx_lat,approx_lng,cart_snapshot,pledged_total_agorot,token_hash)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
   [randomUUID(),group.id,person.email,person.phone,place.key,place.lat,place.lng,JSON.stringify(cart.snapshot),cart.total.toString(),hash(token)]);
  return {group:await this.recalculate(db,group),memberToken:token,validatedPledgeAgorot:Number(cart.total)};
 }
 // Join a specific group the shopper was shown.
 async join(id:string,body:any){
  publicId(id);const place=location(body?.location),person=contact(body),cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>this.enroll(db,await this.group(db,id),place,person,cart));
 }
 // Join the area's group, creating it only now. Under the coordination lock: expire, re-match (another shopper may
 // have created a compatible group since the search), create on a miss, insert the first member. A failure at any
 // step rolls back the transaction, so a group never exists without its first member.
 async joinArea(body:any){
  const place=location(body?.location),person=contact(body),cart=await this.shopify.validate(lines(body?.lines));
  return this.locked(async db=>{
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
   for(const group of groups)result.push({...await this.aggregate(db,group),createdAt:new Date(group.created_at).toISOString()});
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
