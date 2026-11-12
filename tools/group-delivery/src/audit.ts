import {randomUUID} from 'node:crypto';
import type {Queryable} from './db.js';
export type AuditAction='login'|'logout'|'group.approve'|'area.create'|'area.update'|'group.export'|'member.withdraw'|'group.operational_status_change'|'group.complete';
export type AuditResult='OK'|'DENIED'|'FAILED';
export type AuditEntry={action:AuditAction;actor:string;target?:string|null;result:AuditResult;detail?:string|null;subject?:string|null;previousStatus?:string|null;newStatus?:string|null;amountAgorot?:number|null};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,STATUS=/^[A-Z_]{3,30}$/;
// Actor label from the stored session hash (already a SHA-256 of the cookie): short, stable, not reversible.
export const actorOf=(session?:{token_hash:string}|null)=>session?'session:'+session.token_hash.slice(0,12):'anonymous';
// Only safe, validated metadata is stored: ids, enum statuses, an amount, an error code. subject is an internal member
// id; previousStatus/newStatus are enum values (member or operational). Never contact details, tokens or cart contents.
const insert=(db:Queryable,entry:AuditEntry)=>{
 const detail=entry.detail&&/^[A-Z0-9_.:-]{1,60}$/i.test(entry.detail)?entry.detail:null;
 const target=entry.target&&/^[a-f0-9-]{8,64}$/.test(entry.target)?entry.target:null;
 const subject=entry.subject&&UUID.test(entry.subject)?entry.subject:null;
 const previous=entry.previousStatus&&STATUS.test(entry.previousStatus)?entry.previousStatus:null;
 const next=entry.newStatus&&STATUS.test(entry.newStatus)?entry.newStatus:null;
 const amount=Number.isSafeInteger(entry.amountAgorot)&&entry.amountAgorot!>=0?entry.amountAgorot:null;
 return db.query('INSERT INTO admin_audit(id,action,actor,target,result,detail,subject,previous_status,new_status,amount_agorot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[randomUUID(),entry.action,entry.actor,target,entry.result,detail,subject,previous,next,amount]);
};
// Audit failures never block or change the admin action itself; they are reported without details.
export async function audit(db:Queryable,entry:AuditEntry){
 try{await insert(db,entry);}catch{console.error('Group delivery admin audit write failed.');}
}
// Inside a transaction, for history the dashboard relies on (operational transitions): a failed write throws, so the
// change rolls back with it and the timeline never misses a transition.
export async function auditStrict(db:Queryable,entry:AuditEntry){await insert(db,entry);}
export async function auditPage(db:Queryable,query:any){
 const page=Number.parseInt(String(query?.page??'1'),10),size=50,current=Number.isSafeInteger(page)&&page>0&&page<=100000?page:1;
 const total=(await db.query('SELECT COUNT(*)::int AS n FROM admin_audit')).rows[0].n;
 const rows=(await db.query(`SELECT at,action,actor,target,result,detail,subject,previous_status,new_status,amount_agorot FROM admin_audit ORDER BY at DESC,id LIMIT ${size} OFFSET ${(current-1)*size}`)).rows;
 return {events:rows.map(event),pagination:{page:current,pageSize:size,total,pageCount:Math.max(1,Math.ceil(total/size))}};
}
const event=(row:any)=>({at:new Date(row.at).toISOString(),action:row.action,actor:row.actor,target:row.target,result:row.result,detail:row.detail,
 subject:row.subject??null,previousStatus:row.previous_status??null,newStatus:row.new_status??null,amountAgorot:row.amount_agorot===null||row.amount_agorot===undefined?null:Number(row.amount_agorot)});
// The operational timeline of one group: its successful transitions, oldest first.
export async function operationalHistory(db:Queryable,groupPublicId:string){
 const rows=(await db.query("SELECT at,action,actor,target,result,detail,subject,previous_status,new_status,amount_agorot FROM admin_audit WHERE target=$1 AND action IN ('group.operational_status_change','group.complete') AND result='OK' AND new_status IS NOT NULL ORDER BY at,id",[groupPublicId])).rows;
 return rows.map(event);
}
