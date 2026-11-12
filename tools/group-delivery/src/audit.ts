import {randomUUID} from 'node:crypto';
import type {Queryable} from './db.js';
export type AuditAction='login'|'logout'|'group.approve'|'area.create'|'area.update'|'group.export';
export type AuditResult='OK'|'DENIED'|'FAILED';
// Actor label from the stored session hash (already a SHA-256 of the cookie): short, stable, not reversible.
export const actorOf=(session?:{token_hash:string}|null)=>session?'session:'+session.token_hash.slice(0,12):'anonymous';
// Audit failures never block or change the admin action itself; they are reported without details.
export async function audit(db:Queryable,entry:{action:AuditAction;actor:string;target?:string|null;result:AuditResult;detail?:string|null}){
 const detail=entry.detail&&/^[A-Z0-9_.:-]{1,60}$/i.test(entry.detail)?entry.detail:null;
 const target=entry.target&&/^[a-f0-9-]{8,64}$/.test(entry.target)?entry.target:null;
 try{await db.query('INSERT INTO admin_audit(id,action,actor,target,result,detail) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),entry.action,entry.actor,target,entry.result,detail]);}
 catch{console.error('Group delivery admin audit write failed.');}
}
export async function auditPage(db:Queryable,query:any){
 const page=Number.parseInt(String(query?.page??'1'),10),size=50,current=Number.isSafeInteger(page)&&page>0&&page<=100000?page:1;
 const total=(await db.query('SELECT COUNT(*)::int AS n FROM admin_audit')).rows[0].n;
 const rows=(await db.query(`SELECT at,action,actor,target,result,detail FROM admin_audit ORDER BY at DESC,id LIMIT ${size} OFFSET ${(current-1)*size}`)).rows;
 return {events:rows.map((row:any)=>({at:new Date(row.at).toISOString(),action:row.action,actor:row.actor,target:row.target,result:row.result,detail:row.detail})),
  pagination:{page:current,pageSize:size,total,pageCount:Math.max(1,Math.ceil(total/size))}};
}
