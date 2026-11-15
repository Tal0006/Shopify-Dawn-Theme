import {randomInt,randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import type {Database,Queryable} from './db.js';
import {transaction} from './db.js';
import {ApiError,contact,publicId} from './domain.js';
import {issueToken,type Groups} from './groups.js';
import type {EmailProvider} from './email.js';

// Email OTP recovery of an existing membership on a browser/device without its receipt.
//  start:  the submitted email + phone must both match one membership of this group. A 6-digit code from
//          crypto.randomInt is sent to the membership's stored email (equal to the submitted one). The answer is the
//          same whether or not anything matched: a challenge row is always written (member_id NULL when nothing
//          matched, so it can never verify), limits are keyed by the submitted details (never by whether they
//          exist), and the email is sent after the response, so provider latency or failure is not observable.
//  verify: challenge id + code. Wrong codes count; the 5th wrong attempt locks the challenge. A correct code consumes
//          it (single use) and issues a NEW device receipt for the membership; existing receipts stay valid.
// Recovery restores access only: it never changes the membership status, the pledge or the group.
export const RECOVERY_LIMITS={codeTtlSeconds:600,cooldownSeconds:60,sendsPerHour:5,maxAttempts:5,groupStartsPerHour:30,retentionHours:24};
export type RecoveryLimits=typeof RECOVERY_LIMITS;
export const RECOVERY_GENERIC_MESSAGE='אם הפרטים תואמים להצטרפות קיימת, קוד אימות נשלח למייל.';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type SecurityEvent='RECOVERY_REQUESTED'|'RECOVERY_SENT'|'RECOVERY_DELIVERY_FAILED'|'RECOVERY_SUCCEEDED'|'RECOVERY_FAILED'|'RECOVERY_LOCKED';
const record=(db:Queryable,event:SecurityEvent,groupPublicId:string,memberId:string|null)=>
 db.query('INSERT INTO security_events(id,event,group_public_id,member_id) VALUES($1,$2,$3,$4)',[randomUUID(),event,groupPublicId,memberId]);
const unavailable=()=>new ApiError(503,'RECOVERY_UNAVAILABLE','שחזור ההצטרפות אינו זמין כרגע.');
const invalid=()=>new ApiError(400,'INVALID_OR_EXPIRED_CODE','הקוד שגוי או שתוקפו פג.');

export class Recovery {
 private pending=new Set<Promise<void>>();
 constructor(private db:Database,private secret:string,private provider:EmailProvider|null,private groups:Pick<Groups,'get'>,private limits:RecoveryLimits=RECOVERY_LIMITS){}
 get enabled(){return this.provider!==null;}
 // Domain-separated HMACs with the server secret: rate-limit identifiers and the code hash (a 6-digit code has only
 // 10^6 values, so a plain hash could be reversed from a database copy).
 private hmac(purpose:string,value:string){return createHmac('sha256',this.secret).update('group-recovery:'+purpose+'\n'+value).digest('hex');}
 private codeHash(challengeId:string,code:string){return this.hmac('code',challengeId+'\n'+code);}
 async start(id:string,body:any,ip:string){
  publicId(id);
  if(!this.provider)throw unavailable();
  const person=contact(body),limits=this.limits;
  const identity=this.hmac('identity',id+'\n'+person.email+'\n'+person.phone),requester=this.hmac('requester',ip||'unknown');
  const challengeId=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
  const match=await transaction(this.db,async db=>{
   // One recovery writer at a time, so two simultaneous requests cannot both pass the cooldown.
   await db.query('SELECT pg_advisory_xact_lock(4330002)');
   await db.query("DELETE FROM member_recovery_challenges WHERE created_at<NOW()-($1::int * INTERVAL '1 hour')",[limits.retentionHours]);
   const group=(await db.query('SELECT id FROM delivery_groups WHERE public_id=$1',[id])).rows[0];
   if(!group)throw new ApiError(404,'GROUP_NOT_FOUND');
   // Limits depend only on what was submitted (identity), the group and time, never on whether a membership matched.
   const sent=(await db.query("SELECT COUNT(*)::int AS hour,COUNT(*) FILTER (WHERE created_at>NOW()-($2::int * INTERVAL '1 second'))::int AS recent FROM member_recovery_challenges WHERE identity_hash=$1 AND created_at>NOW()-INTERVAL '1 hour'",[identity,limits.cooldownSeconds])).rows[0];
   if(sent.recent>0||sent.hour>=limits.sendsPerHour)throw new ApiError(429,'RATE_LIMITED','יותר מדי בקשות. נסו שוב מאוחר יותר.');
   const groupHour=(await db.query("SELECT COUNT(*)::int AS n FROM member_recovery_challenges WHERE group_id=$1 AND created_at>NOW()-INTERVAL '1 hour'",[group.id])).rows[0].n;
   if(groupHour>=limits.groupStartsPerHour)throw new ApiError(429,'RATE_LIMITED','יותר מדי בקשות. נסו שוב מאוחר יותר.');
   const member=(await db.query('SELECT id,email FROM group_members WHERE group_id=$1 AND email=$2 AND phone=$3',[group.id,person.email,person.phone])).rows[0];
   // Only the newest code for these details can be used: a new request closes the earlier ones, so repeated requests
   // never add up to more than one challenge's attempts at a time.
   await db.query("UPDATE member_recovery_challenges SET consumed_at=NOW(),closed_reason='SUPERSEDED' WHERE identity_hash=$1 AND consumed_at IS NULL",[identity]);
   await db.query("INSERT INTO member_recovery_challenges(id,group_id,member_id,identity_hash,requester_hash,code_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,NOW()+($7::int * INTERVAL '1 second'))",
    [challengeId,group.id,member?.id??null,identity,requester,member?this.codeHash(challengeId,code):this.codeHash(challengeId,randomBytes(16).toString('hex')),limits.codeTtlSeconds]);
   await record(db,'RECOVERY_REQUESTED',id,member?.id??null);
   return member?{memberId:member.id as string,to:member.email as string}:null;
  });
  if(match)this.deliver(challengeId,id,match.memberId,match.to,code);
  return {ok:true,message:RECOVERY_GENERIC_MESSAGE,challengeId,expiresInSeconds:limits.codeTtlSeconds,resendAfterSeconds:limits.cooldownSeconds};
 }
 // Sent after the response. A failure closes the challenge (nobody received its code) and changes nothing else;
 // the log line carries no address, code or provider detail.
 private deliver(challengeId:string,groupPublicId:string,memberId:string,to:string,code:string){
  const task=(async()=>{
   try{
    await this.provider!.sendRecoveryCode({to,code,expiresInMinutes:Math.round(this.limits.codeTtlSeconds/60),idempotencyKey:'group-recovery-'+challengeId});
    await record(this.db,'RECOVERY_SENT',groupPublicId,memberId).catch(()=>undefined);
   }catch{
    console.error('Group delivery recovery email could not be delivered.');
    await this.db.query("UPDATE member_recovery_challenges SET consumed_at=NOW(),closed_reason='DELIVERY_FAILED' WHERE id=$1 AND consumed_at IS NULL",[challengeId]).catch(()=>undefined);
    await record(this.db,'RECOVERY_DELIVERY_FAILED',groupPublicId,memberId).catch(()=>undefined);
   }
  })();
  this.pending.add(task);void task.finally(()=>this.pending.delete(task));
 }
 // Tests and graceful shutdown: wait for emails still being sent.
 async idle(){while(this.pending.size)await Promise.allSettled([...this.pending]);}
 async verify(id:string,body:any){
  publicId(id);
  if(!this.provider)throw unavailable();
  const challengeId=body?.challengeId,code=typeof body?.code==='string'?body.code.trim():'';
  // Malformed input is refused without touching any challenge (and without counting an attempt).
  if(typeof challengeId!=='string'||!UUID.test(challengeId)||!/^\d{6}$/.test(code))throw invalid();
  const limits=this.limits;
  const outcome=await transaction(this.db,async db=>{
   // The challenge must belong to the group in the path: another group's id behaves like an unknown challenge.
   const row=(await db.query(`SELECT c.id,c.member_id,c.code_hash,c.attempts,c.consumed_at,c.closed_reason,c.expires_at<=NOW() AS expired
    FROM member_recovery_challenges c JOIN delivery_groups g ON g.id=c.group_id WHERE c.id=$1 AND g.public_id=$2 FOR UPDATE OF c`,[challengeId,id])).rows[0];
   if(!row)return {fail:'INVALID' as const};
   if(row.closed_reason==='LOCKED'||row.attempts>=limits.maxAttempts)return {fail:'LOCKED' as const};
   if(row.consumed_at||row.expired)return {fail:'INVALID' as const};
   const matches=timingSafeEqual(Buffer.from(this.codeHash(challengeId,code),'hex'),Buffer.from(row.code_hash,'hex'));
   if(!matches||row.member_id===null){
    const attempts=row.attempts+1,locked=attempts>=limits.maxAttempts;
    await db.query("UPDATE member_recovery_challenges SET attempts=$2,consumed_at=CASE WHEN $3::boolean THEN NOW() END,closed_reason=CASE WHEN $3::boolean THEN 'LOCKED' END WHERE id=$1",[challengeId,attempts,locked]);
    await record(db,locked?'RECOVERY_LOCKED':'RECOVERY_FAILED',id,row.member_id);
    return {fail:locked?'LOCKED' as const:'INVALID' as const};
   }
   await db.query("UPDATE member_recovery_challenges SET consumed_at=NOW(),closed_reason='VERIFIED' WHERE id=$1",[challengeId]);
   const token=await issueToken(db,row.member_id,'RECOVERY');
   const member=(await db.query('SELECT status FROM group_members WHERE id=$1',[row.member_id])).rows[0];
   await record(db,'RECOVERY_SUCCEEDED',id,row.member_id);
   return {token,status:member.status as 'PLEDGED'|'WITHDRAWN'};
  });
  // The failed attempt is committed above before the refusal is returned.
  if('fail' in outcome)throw outcome.fail==='LOCKED'?new ApiError(429,'TOO_MANY_ATTEMPTS','היו יותר מדי ניסיונות. בקשו קוד חדש.'):invalid();
  // The group as it is now (it may have been completed or closed since the code was sent): access is restored either way.
  return {memberToken:outcome.token,group:await this.groups.get(id),member:{status:outcome.status}};
 }
}
