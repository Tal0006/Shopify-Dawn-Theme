// Read-only data for the authenticated admin dashboard. Customer contact details are only ever returned from here,
// and this module is only reachable behind the admin session (see server.ts). Filtering, search, sorting and
// pagination all run in SQL; the browser never receives more than one page.
import type {Database} from './db.js';
import {ApiError,publicId} from './domain.js';
import type {Groups} from './groups.js';
import type {CartValidator,SnapshotLine} from './shopify.js';

// Every status allowed by the schema; only the first four are reachable by the current (non-payment) code paths.
export const GROUP_STATUSES=['OPEN','THRESHOLD_REACHED','APPROVED','EXPIRED','PAYMENT_OPEN','CONFIRMED','SCHEDULED','COMPLETED','CANCELLED'] as const;
export const REACHABLE_STATUSES=['OPEN','THRESHOLD_REACHED','APPROVED','EXPIRED'] as const;
// Accepting pledges: the same rule as join/update in groups.ts (expired groups are marked EXPIRED before reading).
export const ACTIVE_STATUSES=['OPEN','THRESHOLD_REACHED'];
export const MEMBER_STATUSES=['PLEDGED','WITHDRAWN'] as const;
const TZ='Asia/Jerusalem';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface Page {page:number;pageSize:number;total:number;pageCount:number}
const pageOf=(query:any,fallback=25)=>{
 const page=Number.parseInt(String(query?.page??'1'),10),size=Number.parseInt(String(query?.pageSize??fallback),10);
 return {page:Number.isSafeInteger(page)&&page>0&&page<=100000?page:1,pageSize:Number.isSafeInteger(size)?Math.min(100,Math.max(5,size)):fallback};
};
const meta=(page:{page:number;pageSize:number},total:number):Page=>({...page,total,pageCount:Math.max(1,Math.ceil(total/page.pageSize))});

// Israel calendar boundaries (DST-aware) for "today", "this week" (Sunday) and date filters.
function offsetMinutes(at:Date){
 const name=new Intl.DateTimeFormat('en-US',{timeZone:TZ,timeZoneName:'longOffset'}).formatToParts(at).find(part=>part.type==='timeZoneName')?.value||'';
 const match=name.match(/GMT([+-])(\d{2}):(\d{2})/);return match?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3])):0;
}
export function israelMidnight(year:number,month:number,day:number):Date{
 const guess=Date.UTC(year,month-1,day);let at=guess-offsetMinutes(new Date(guess))*60000;
 at=guess-offsetMinutes(new Date(at))*60000;return new Date(at);
}
export function israelToday(now=new Date()){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'numeric',day:'numeric',weekday:'short'}).formatToParts(now).map(part=>[part.type,part.value]));
 const year=Number(parts.year),month=Number(parts.month),day=Number(parts.day),dow=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday);
 return {dayStart:israelMidnight(year,month,day),weekStart:israelMidnight(year,month,day-Math.max(0,dow))};
}
const dateParam=(value:unknown)=>{
 if(typeof value!=='string'||value==='')return null;
 const match=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)throw new ApiError(400,'INVALID_INPUT','תאריך לא תקין.');
 const [year,month,day]=match.slice(1).map(Number);
 if(month<1||month>12||day<1||day>31)throw new ApiError(400,'INVALID_INPUT','תאריך לא תקין.');
 return {year,month,day};
};
const likeEscape=(value:string)=>value.replace(/[\\%_]/g,match=>'\\'+match);

export interface GroupFilters {q:string;area:string;status:string;state:string;from:string;to:string;sort:string;dir:'asc'|'desc'}
export const SORTS:Record<string,string>={created:'g.created_at',updated:'g.updated_at',area:'g.area_name',status:'g.status',pledged:'g.pledged_total_agorot',members:'active_members',expires:'g.expires_at'};
export function groupFilters(query:any):GroupFilters{
 const text=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max):'';
 const area=text(query?.area,40),status=text(query?.status,30),state=text(query?.state,10),sort=text(query?.sort,10),dir=text(query?.dir,4);
 if(area&&area!=='none'&&!UUID.test(area))throw new ApiError(400,'INVALID_INPUT','אזור לא תקין.');
 if(status&&!(GROUP_STATUSES as readonly string[]).includes(status))throw new ApiError(400,'INVALID_INPUT','סטטוס לא תקין.');
 if(state&&!['active','closed'].includes(state))throw new ApiError(400,'INVALID_INPUT','מצב לא תקין.');
 const from=text(query?.from,10),to=text(query?.to,10);dateParam(from);dateParam(to);
 return {q:text(query?.q,120),area,status,state,from,to,sort:SORTS[sort]?sort:'created',dir:dir==='asc'?'asc':'desc'};
}

const groupRow=(row:any)=>{
 const total=Number(row.pledged_total_agorot),threshold=Number(row.threshold_agorot);
 return {
  publicId:row.public_id,shortId:String(row.public_id).slice(0,8),areaName:row.area_name,areaPublicId:row.area_public_id??null,legacy:row.area_id===null,
  status:row.status,active:ACTIVE_STATUSES.includes(row.status),pledgedTotalAgorot:total,thresholdAgorot:threshold,
  remainingAgorot:Math.max(0,threshold-total),progressPercent:threshold>0?Math.min(100,Math.floor(total*100/threshold)):0,
  activeMembers:Number(row.active_members),totalMembers:Number(row.all_members),
  createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()
 };
};
const GROUP_SELECT=`SELECT g.*,a.public_id AS area_public_id,
 (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id AND m.status='PLEDGED')::int AS active_members,
 (SELECT COUNT(*) FROM group_members m WHERE m.group_id=g.id)::int AS all_members
 FROM delivery_groups g LEFT JOIN delivery_areas a ON a.id=g.area_id`;
const memberRow=(row:any)=>({
 id:row.id,email:row.email,phone:row.phone,status:row.status,pledgedTotalAgorot:Number(row.pledged_total_agorot),
 cartLines:Number(row.cart_lines),createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()
});
// A dialable international number for tel:/WhatsApp links, or null (stored phones are normalized by domain.contact()).
export const dialable=(phone:string)=>/^\+[1-9]\d{7,14}$/.test(phone)?phone:null;

export class AdminData{
 constructor(private db:Database,private groups:Groups,private shopify:CartValidator){}
 // Statuses are evaluated lazily elsewhere; mark expired groups first so every view agrees with the public API.
 private async fresh(){await this.groups.expire();}
 async dashboard(now=new Date()){
  await this.fresh();
  const {dayStart,weekStart}=israelToday(now);
  const row=(await this.db.query(`SELECT
   COUNT(*) FILTER (WHERE status IN ('OPEN','THRESHOLD_REACHED'))::int AS active_groups,
   COUNT(*) FILTER (WHERE status='THRESHOLD_REACHED')::int AS reached_groups,
   COUNT(*) FILTER (WHERE status='APPROVED')::int AS approved_groups,
   COUNT(*) FILTER (WHERE status='EXPIRED')::int AS expired_groups,
   COUNT(*)::int AS all_groups,
   COALESCE(SUM(pledged_total_agorot) FILTER (WHERE status IN ('OPEN','THRESHOLD_REACHED')),0)::bigint AS active_pledged,
   COUNT(*) FILTER (WHERE created_at>=$1)::int AS opened_today,
   COUNT(*) FILTER (WHERE created_at>=$2)::int AS opened_week
   FROM delivery_groups`,[dayStart.toISOString(),weekStart.toISOString()])).rows[0];
  const customers=(await this.db.query(`SELECT COUNT(DISTINCT m.email)::int AS customers,COUNT(*)::int AS pledges FROM group_members m JOIN delivery_groups g ON g.id=m.group_id
   WHERE m.status='PLEDGED' AND g.status IN ('OPEN','THRESHOLD_REACHED')`)).rows[0];
  return {
   activeGroups:row.active_groups,reachedGroups:row.reached_groups,approvedGroups:row.approved_groups,expiredGroups:row.expired_groups,allGroups:row.all_groups,
   activeCustomers:customers.customers,activePledges:customers.pledges,activePledgedAgorot:Number(row.active_pledged),
   openedToday:row.opened_today,openedThisWeek:row.opened_week,
   generatedAt:now.toISOString(),dayStart:dayStart.toISOString(),weekStart:weekStart.toISOString()
  };
 }
 async areas(){return (await this.db.query('SELECT public_id,name,active FROM delivery_areas ORDER BY sort_order,name')).rows.map((row:any)=>({publicId:row.public_id,name:row.name,active:row.active}));}
 async listGroups(query:any){
  await this.fresh();
  const filters=groupFilters(query),page=pageOf(query),where:string[]=[],values:any[]=[];
  const add=(sql:string,...params:any[])=>{let text=sql;for(const param of params){values.push(param);text=text.replace('?','$'+values.length);}where.push(text);};
  if(filters.q){
   const like='%'+likeEscape(filters.q.toLowerCase())+'%';
   let digits=filters.q.replace(/\D/g,'');if(digits.startsWith('0'))digits='972'+digits.slice(1);
   const phone=digits.length>=3?'%'+digits+'%':null;
   add(`(g.public_id::text ILIKE ? OR g.area_name ILIKE ? OR EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=g.id AND (m.email ILIKE ?${phone?' OR m.phone LIKE ?':''})))`,
    likeEscape(filters.q.toLowerCase())+'%',like,like,...(phone?[phone]:[]));
  }
  if(filters.area==='none')add('g.area_id IS NULL');else if(filters.area)add('a.public_id=?',filters.area);
  if(filters.status)add('g.status=?',filters.status);
  if(filters.state==='active')add("g.status IN ('OPEN','THRESHOLD_REACHED')");else if(filters.state==='closed')add("g.status NOT IN ('OPEN','THRESHOLD_REACHED')");
  const from=dateParam(filters.from),to=dateParam(filters.to);
  if(from)add('g.created_at>=?',israelMidnight(from.year,from.month,from.day).toISOString());
  if(to)add('g.created_at<?',israelMidnight(to.year,to.month,to.day+1).toISOString());
  const clause=where.length?' WHERE '+where.join(' AND '):'';
  const total=(await this.db.query('SELECT COUNT(*)::int AS n FROM delivery_groups g LEFT JOIN delivery_areas a ON a.id=g.area_id'+clause,values)).rows[0].n;
  const order=SORTS[filters.sort]+' '+(filters.dir==='asc'?'ASC':'DESC')+', g.created_at DESC';
  const rows=(await this.db.query(GROUP_SELECT+clause+' ORDER BY '+order+' LIMIT '+page.pageSize+' OFFSET '+(page.page-1)*page.pageSize,values)).rows;
  return {groups:rows.map(groupRow),pagination:meta(page,total),filters};
 }
 async group(id:string){
  await this.fresh();
  const row=(await this.db.query(GROUP_SELECT+' WHERE g.public_id=$1',[publicId(id)])).rows[0];
  if(!row)throw new ApiError(404,'GROUP_NOT_FOUND','הקבוצה לא נמצאה.');
  const withdrawn=(await this.db.query("SELECT COUNT(*)::int AS n FROM group_members m WHERE m.group_id=$1 AND m.status='WITHDRAWN'",[row.id])).rows[0].n;
  return {...groupRow(row),withdrawnMembers:withdrawn,_id:row.id as string};
 }
 async members(id:string,query:any){
  const group=await this.group(id),page=pageOf(query,50);
  const status=typeof query?.memberStatus==='string'&&(MEMBER_STATUSES as readonly string[]).includes(query.memberStatus)?query.memberStatus:'';
  const values:any[]=[group._id];let clause='WHERE group_id=$1';
  if(status){values.push(status);clause+=' AND status=$2';}
  const total=(await this.db.query('SELECT COUNT(*)::int AS n FROM group_members '+clause,values)).rows[0].n;
  const rows=(await this.db.query(`SELECT id,email,phone,status,pledged_total_agorot,jsonb_array_length(cart_snapshot)::int AS cart_lines,created_at,updated_at
   FROM group_members ${clause} ORDER BY created_at ASC,id ASC LIMIT ${page.pageSize} OFFSET ${(page.page-1)*page.pageSize}`,values)).rows;
  const {_id,...publicGroup}=group;
  return {group:publicGroup,members:rows.map(memberRow),pagination:meta(page,total),memberStatus:status};
 }
 // One member with the stored cart snapshot. Product titles and today's prices come from ONE batched Shopify request
 // (the existing validator's inspect); stored prices and the stored pledge are never rewritten.
 async member(id:string,memberId:string,resolve=true){
  const group=await this.group(id);
  if(typeof memberId!=='string'||!UUID.test(memberId))throw new ApiError(404,'NOT_FOUND','הלקוח לא נמצא.');
  const row=(await this.db.query(`SELECT id,email,phone,status,pledged_total_agorot,cart_snapshot,jsonb_array_length(cart_snapshot)::int AS cart_lines,created_at,updated_at
   FROM group_members WHERE id=$1 AND group_id=$2`,[memberId,group._id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND','הלקוח לא נמצא.');
  const snapshot:SnapshotLine[]=Array.isArray(row.cart_snapshot)?row.cart_snapshot:[];
  let current=new Map<string,{title:string|null;currentUnitAgorot:number|null;available:boolean}>(),productLookup:'OK'|'UNAVAILABLE'|'SKIPPED'='SKIPPED';
  if(resolve&&snapshot.length&&this.shopify.inspect){
   try{
    for(const line of await this.shopify.inspect(snapshot))current.set(line.variantId,{title:line.title,currentUnitAgorot:line.currentUnitAgorot,available:line.available});
    productLookup='OK';
   }catch{productLookup='UNAVAILABLE';}
  }else if(resolve&&snapshot.length)productLookup='UNAVAILABLE';
  const lines=snapshot.map(line=>{
   const variantId=String(line.variantId).replace('gid://shopify/ProductVariant/',''),unit=/^\d{1,12}$/.test(String(line.unitAgorot))?Number(line.unitAgorot):0;
   const now=current.get(variantId);
   return {variantId,quantity:Number(line.quantity),storedUnitAgorot:unit,storedLineAgorot:unit*Number(line.quantity),
    title:now?.title??null,currentUnitAgorot:now?.currentUnitAgorot??null,availableNow:now?now.available:null};
  });
  const {_id,...publicGroup}=group;
  return {group:publicGroup,member:{...memberRow(row),snapshotTotalAgorot:lines.reduce((sum,line)=>sum+line.storedLineAgorot,0),lines,productLookup}};
 }
 // All members of a group for the CSV exports (no pagination: a group holds at most 100 members by domain rule).
 async exportRows(id:string){
  const group=await this.group(id);
  const rows=(await this.db.query('SELECT id,email,phone,status,pledged_total_agorot,cart_snapshot,jsonb_array_length(cart_snapshot)::int AS cart_lines,created_at,updated_at FROM group_members WHERE group_id=$1 ORDER BY created_at ASC,id ASC',[group._id])).rows;
  const {_id,...publicGroup}=group;
  return {group:publicGroup,members:rows.map((row:any)=>({...memberRow(row),snapshot:Array.isArray(row.cart_snapshot)?row.cart_snapshot as SnapshotLine[]:[]}))};
 }
}

// CSV with a UTF-8 BOM (Hebrew in Excel), every field quoted, and spreadsheet formula injection neutralised: a value
// starting with = + - @ tab or carriage return is prefixed with an apostrophe so it is shown as text.
export function csv(rows:(string|number|null)[][]):string{
 const cell=(value:string|number|null)=>{
  let text=value===null||value===undefined?'':String(value);
  if(/^[=+\-@\t\r]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
 };
 return '﻿'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
}
