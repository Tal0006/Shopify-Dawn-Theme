import {randomUUID} from 'node:crypto';
import type {Queryable} from './db.js';
export type AuditAction='login'|'logout'|'group.approve'|'area.create'|'area.update'|'group.export'|'member.withdraw';
export type AuditResult='OK'|'DENIED'|'FAILED';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Actor label from the stored session hash (already a SHA-256 of the cookie): short, stable, not reversible.
export const actorOf=(session?:{token_hash:string}|null)=>session?'session:'+session.token_hash.slice(0,12):'anonymous';
// Audit failures never block or change the admin action itself; they are reported without details.
// subject/previousStatus/amountAgorot are for member-level actions: the internal member id, the status before the
// action and the pledge before it. Never contact details, tokens or cart contents.
export async function audit(db:Queryable,entry:{action:AuditAction;actor:string;target?:string|null;result:AuditResult;detail?:string|null;subject?:string|null;previousStatus?:string|null;amountAgorot?:number|null}){
 const detail=entry.detail&&/^[A-Z0-9_.:-]{1,60}$/i.test(entry.detail)?entry.detail:null;
 const target=entry.target&&/^[a-f0-9-]{8,64}$/.test(entry.target)?entry.target:null;
 const subject=entry.subject&&UUID.test(entry.subject)?entry.subject:null;
 const previous=entry.previousStatus==='PLEDGED'||entry.previousStatus==='WITHDRAWN'?entry.previousStatus:null;
 const amount=Number.isSafeInteger(entry.amountAgorot)&&entry.amountAgorot!>=0?entry.amountAgorot:null;
 try{await db.query('INSERT INTO admin_audit(id,action,actor,target,result,detail,subject,previous_status,amount_agorot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),entry.action,entry.actor,target,entry.result,detail,subject,previous,amount]);}
 catch{console.error('Group delivery admin audit write failed.');}
}
export async function auditPage(db:Queryable,query:any){
 const page=Number.parseInt(String(query?.page??'1'),10),size=50,current=Number.isSafeInteger(page)&&page>0&&page<=100000?page:1;
 const total=(await db.query('SELECT COUNT(*)::int AS n FROM admin_audit')).rows[0].n;
 const rows=(await db.query(`SELECT at,action,actor,target,result,detail,subject,previous_status,amount_agorot FROM admin_audit ORDER BY at DESC,id LIMIT ${size} OFFSET ${(current-1)*size}`)).rows;
 return {events:rows.map((row:any)=>({at:new Date(row.at).toISOString(),action:row.action,actor:row.actor,target:row.target,result:row.result,detail:row.detail,
  subject:row.subject??null,previousStatus:row.previous_status??null,amountAgorot:row.amount_agorot===null||row.amount_agorot===undefined?null:Number(row.amount_agorot)})),
  pagination:{page:current,pageSize:size,total,pageCount:Math.max(1,Math.ceil(total/size))}};
}
