// Email OTP membership recovery: the real Express app on on-disk PGlite with the real migrations, a mocked Shopify
// Storefront API and the in-memory email provider (no email ever leaves the test).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join as joinPath} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Groups} from '../src/groups.js';
import {Areas} from '../src/areas.js';
import {Shopify} from '../src/shopify.js';
import {config} from '../src/config.js';
import {AdminData} from '../src/admin-data.js';
import {memberPage} from '../src/admin.js';
import {systemsView,opsConfig} from '../src/system.js';
import {migrate,type Database,type Connection} from '../src/db.js';
import {MemoryEmailProvider,ResendEmailProvider,EmailDeliveryError,recoveryEmail,recoveryConfig,RECOVERY_SUBJECT,type EmailProvider} from '../src/email.js';
import type {Recovery} from '../src/recovery.js';

const AREA={ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3'};
const ENV={PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'};

async function fixture(email:EmailProvider|null){
 const dir=await mkdtemp(joinPath(tmpdir(),'fankee-recovery-db-'));
 const engine=new PGlite(dir);
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const query=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 const db:Database={async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},async connect(){const release=await acquire();return {query,release} as Connection;}};
 const cfg=config(ENV);
 const validator=new Shopify(cfg,async(_input,options)=>{
  const body=JSON.parse(String(options?.body));
  return new Response(JSON.stringify({data:{nodes:body.variables.ids.map((id:string)=>({id,title:'Default Title',availableForSale:true,requiresComponents:false,quantityAvailable:100,price:{amount:'125.00',currencyCode:'ILS'},quantityRule:{minimum:1,increment:1,maximum:null},product:{title:'מוצר',requiresSellingPlan:false}}))}}));
 });
 await migrate(db);
 const app=createApp(db,cfg,validator,{email});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 const recovery=app.locals.recovery as Recovery;
 const post=async(path:string,body:any,token?:string)=>{
  const response=await fetch(cfg.origin+'/api/v1'+path,{method:'POST',headers:{Origin:cfg.origin,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const text=await response.text();
  return {status:response.status,text,body:JSON.parse(text)};
 };
 let n=0;
 const person=()=>({email:'Member'+(++n)+'@Example.test',phone:'050-'+String(1000000+n)});
 const join=async(area=AREA.ashdod,who=person())=>{const r=await post('/groups/join',{...who,areaPublicId:area,lines:[{variantId:'1',quantity:2}]});assert.equal(r.status,201,r.text);return {...who,token:r.body.memberToken as string,group:r.body.group.publicId as string};};
 const close=async()=>{await recovery.idle();await new Promise(r=>server.close(r));await engine.close();await rm(dir,{recursive:true,force:true});};
 const areas=new Areas(db,cfg),groups=new Groups(db,cfg,validator,areas),admin=new AdminData(db,groups,validator);
 return {db,cfg,app,recovery,post,join,person,close,admin};
}

test('Email OTP membership recovery',{timeout:180000},async t=>{
 const mail=new MemoryEmailProvider();
 const f=await fixture(mail);
 // Every console line written during the suite, checked at the end for codes, tokens, contacts and keys.
 const logged:string[]=[];
 const originals={error:console.error,warn:console.warn,info:console.info,log:console.log};
 for(const level of ['error','warn','info','log'] as const)console[level]=(...args:any[])=>{logged.push(args.map(String).join(' '));};
 const secrets:string[]=[];
 const start=(m:{group:string;email:string;phone:string},group=m.group)=>f.post('/groups/'+group+'/recovery/start',{email:m.email,phone:m.phone});
 const verify=(group:string,challengeId:string,code:string)=>f.post('/groups/'+group+'/recovery/verify',{challengeId,code});
 const codeFor=async(email:string)=>{await f.recovery.idle();const message=mail.last(email.toLowerCase());assert.ok(message,'a code was sent to '+email);secrets.push(message!.code);return message!.code;};
 const wrong=(code:string)=>String((Number(code)+1)%1000000).padStart(6,'0');
 const memberRow=async(email:string)=>(await f.db.query('SELECT id,status,pledged_total_agorot,updated_at,token_hash,withdrawn_at FROM group_members WHERE email=$1',[email.toLowerCase()])).rows[0];
 const tokens=async(memberId:string)=>(await f.db.query('SELECT source,token_hash FROM member_tokens WHERE member_id=$1 ORDER BY created_at',[memberId])).rows;
 const challenge=async(id:string)=>(await f.db.query('SELECT * FROM member_recovery_challenges WHERE id=$1',[id])).rows[0];
 // Moves this group's recovery history back in time (cooldown, hourly windows) without waiting.
 const age=async(seconds:number)=>f.db.query("UPDATE member_recovery_challenges SET created_at=created_at-($1::int * INTERVAL '1 second')",[seconds]);
 t.beforeEach(async()=>{await f.db.query('TRUNCATE request_limits, member_recovery_challenges, security_events');mail.fail=false;});
 try{
  await t.test('start sends a 6-digit code to the stored email and answers generically',async()=>{
   const a=await f.join();secrets.push(a.token);
   const r=await start(a);
   assert.equal(r.status,200,r.text);
   assert.deepEqual(Object.keys(r.body).sort(),['challengeId','expiresInSeconds','message','ok','resendAfterSeconds']);
   assert.equal(r.body.ok,true);assert.equal(r.body.message,'אם הפרטים תואמים להצטרפות קיימת, קוד אימות נשלח למייל.');
   assert.equal(r.body.expiresInSeconds,600);assert.equal(r.body.resendAfterSeconds,60);
   const code=await codeFor(a.email);
   assert.match(code,/^\d{6}$/);
   const message=mail.last()!;
   assert.equal(message.to,a.email.toLowerCase(),'sent to the stored (normalized) membership email');
   assert.equal(message.subject,RECOVERY_SUBJECT);assert.equal(message.expiresInMinutes,10);
   assert.ok(message.text.includes(code)&&message.html.includes(code));
   assert.ok(!r.text.includes(code),'the code is never in the response');
   const row=await challenge(r.body.challengeId);
   assert.ok(row.member_id,'linked to the membership');
   assert.match(row.code_hash,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(row).includes(code),'no plaintext code stored');
   assert.equal(row.attempts,0);assert.equal(row.consumed_at,null);
   const left=(new Date(row.expires_at).getTime()-new Date(row.created_at).getTime())/1000;
   assert.ok(Math.abs(left-600)<2,'valid for 10 minutes');
   const events=(await f.db.query('SELECT event,member_id FROM security_events ORDER BY at')).rows.map((e:any)=>e.event);
   assert.deepEqual(events,['RECOVERY_REQUESTED','RECOVERY_SENT']);
  });
  await t.test('unknown details and mismatched email/phone get the same answer and no email',async()=>{
   const a=await f.join();const before=mail.sent.length;
   const real=await start(a);
   const shape=(r:any)=>({status:r.status,keys:Object.keys(r.body).sort(),message:r.body.message,ok:r.body.ok,expires:r.body.expiresInSeconds,resend:r.body.resendAfterSeconds});
   const cases=[{email:'nobody@example.test',phone:'0509999999'},{email:a.email,phone:'0509999998'},{email:'other@example.test',phone:a.phone}];
   for(const c of cases){
    const r=await start({group:a.group,...c});
    assert.deepEqual(shape(r),shape(real),'same public answer for '+JSON.stringify(c));
    assert.match(r.body.challengeId,/^[a-f0-9-]{36}$/,'a challenge id is always returned');
    const row=await challenge(r.body.challengeId);
    assert.equal(row.member_id,null,'nothing matched, so the challenge can never verify');
   }
   await f.recovery.idle();
   assert.equal(mail.sent.length,before+1,'only the real membership received a code');
   assert.ok(!mail.sent.some(m=>['nobody@example.test','other@example.test'].includes(m.to)),'never sent to a submitted address that is not stored');
   // A decoy challenge refuses every code exactly like a wrong code, and locks after 5 attempts like a real one.
   const decoy=(await start({group:a.group,email:'nobody2@example.test',phone:'0509999997'})).body.challengeId;
   for(let i=1;i<5;i++)assert.equal((await verify(a.group,decoy,'000000')).body.code,'INVALID_OR_EXPIRED_CODE');
   assert.equal((await verify(a.group,decoy,'000000')).body.code,'TOO_MANY_ATTEMPTS');
  });
  await t.test('the response does not wait for the email provider',async()=>{
   let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started=false;
   const slow=new MemoryEmailProvider();const original=slow.sendRecoveryCode.bind(slow);
   slow.sendRecoveryCode=async message=>{started=true;await gate;return original(message);};
   const g=await fixture(slow);
   try{
    const a=await g.join();
    const r=await g.post('/groups/'+a.group+'/recovery/start',{email:a.email,phone:a.phone});
    assert.equal(r.status,200);assert.equal(slow.sent.length,0,'answered while the email is still being sent');
    release();await g.recovery.idle();
    assert.ok(started);assert.equal(slow.sent.length,1);
   }finally{release();await g.close();}
  });
  await t.test('a provider failure keeps the generic answer and changes no membership',async()=>{
   const a=await f.join();const before=await memberRow(a.email),tokensBefore=await tokens(before.id);
   mail.fail='always';
   const r=await start(a);
   assert.equal(r.status,200);assert.equal(r.body.ok,true);
   await f.recovery.idle();
   const row=await challenge(r.body.challengeId);
   assert.equal(row.closed_reason,'DELIVERY_FAILED');assert.ok(row.consumed_at);
   const after=await memberRow(a.email);
   assert.deepEqual([after.status,after.pledged_total_agorot,String(after.updated_at),after.token_hash],[before.status,before.pledged_total_agorot,String(before.updated_at),before.token_hash]);
   assert.deepEqual(await tokens(before.id),tokensBefore);
   assert.ok((await f.db.query("SELECT 1 FROM security_events WHERE event='RECOVERY_DELIVERY_FAILED'")).rows.length);
   assert.ok(logged.some(line=>line==='Group delivery recovery email could not be delivered.'),'a generic log line only');
   mail.fail=false;
  });
  await t.test('cooldown, hourly, per-group and per-IP limits',async()=>{
   const a=await f.join();
   assert.equal((await start(a)).status,200);
   const again=await start(a);
   assert.equal(again.status,429);assert.equal(again.body.code,'RATE_LIMITED');
   // Same refusal for details that match nothing (limits never depend on whether a membership exists).
   const ghost={group:a.group,email:'ghost@example.test',phone:'0501231231'};
   assert.equal((await start(ghost)).status,200);assert.equal((await start(ghost)).status,429);
   // After the cooldown, up to 5 codes per hour for the same details.
   for(let i=2;i<=5;i++){await age(61);assert.equal((await start(a)).status,200,'send '+i);}
   await age(61);
   assert.equal((await start(a)).status,429,'6th code within the hour is refused');
   await age(3600);
   assert.equal((await start(a)).status,200,'the hour has passed');
   // Per IP: 10 starts per hour across any details.
   await f.db.query('TRUNCATE request_limits, member_recovery_challenges');
   const statuses=[];
   for(let i=0;i<11;i++)statuses.push((await start({group:a.group,email:'ip'+i+'@example.test',phone:'05077'+String(i).padStart(5,'0')})).status);
   assert.deepEqual(statuses,[...Array(10).fill(200),429]);
   // Per group: 30 starts per hour.
   await f.db.query('TRUNCATE request_limits, member_recovery_challenges');
   const gid=(await f.db.query('SELECT id FROM delivery_groups WHERE public_id=$1',[a.group])).rows[0].id;
   await f.db.query("INSERT INTO member_recovery_challenges(id,group_id,identity_hash,requester_hash,code_hash,expires_at) SELECT gen_random_uuid(),$1,md5(i::text)||md5(i::text),md5('ip')||md5('ip'),md5('c')||md5('c'),NOW()+INTERVAL '10 minutes' FROM generate_series(1,30) i",[gid]);
   assert.equal((await start({group:a.group,email:'late@example.test',phone:'0507000001'})).status,429);
  });
  await t.test('correct code issues a new device receipt; the existing receipt keeps working',async()=>{
   const a=await f.join();
   const started=await start(a);const code=await codeFor(a.email);
   const r=await verify(a.group,started.body.challengeId,code);
   assert.equal(r.status,200,r.text);
   assert.deepEqual(Object.keys(r.body).sort(),['group','member','memberToken']);
   assert.deepEqual(r.body.member,{status:'PLEDGED'});
   assert.match(r.body.memberToken,/^[a-f0-9]{64}$/);assert.notEqual(r.body.memberToken,a.token);
   secrets.push(r.body.memberToken);
   assert.equal(r.body.group.publicId,a.group);
   assert.ok(!r.text.includes(a.email.toLowerCase())&&!r.text.includes('member_id')&&!r.text.includes('token_hash'),'no contact or internal fields');
   // Both devices act for the same membership.
   for(const token of [a.token,r.body.memberToken]){
    const m=await f.post('/groups/'+a.group+'/member',{},token);
    assert.equal(m.status,200);assert.equal(m.body.member.status,'PLEDGED');
   }
   const row=await memberRow(a.email);
   assert.deepEqual((await tokens(row.id)).map((t:any)=>t.source),['JOIN','RECOVERY']);
   assert.ok((await tokens(row.id)).every((t:any)=>/^[a-f0-9]{64}$/.test(t.token_hash)&&t.token_hash!==r.body.memberToken),'hashes only');
   const c=await challenge(started.body.challengeId);
   assert.equal(c.closed_reason,'VERIFIED');
   // The new receipt is accepted by the existing pledge update (same receipt architecture).
   const updated=await f.post('/groups/'+a.group+'/update-pledge',{lines:[{variantId:'1',quantity:3}]},r.body.memberToken);
   assert.equal(updated.status,200,updated.text);assert.equal(updated.body.validatedPledgeAgorot,37500);
   // Admin sees device access and events, never a code or token.
   const detail=await f.admin.member(a.group,row.id,false);
   assert.equal(detail.member.access.receipts,2);assert.equal(detail.member.access.recoveredReceipts,1);
   assert.deepEqual(detail.member.access.events.map((e:any)=>e.event).reverse(),['RECOVERY_REQUESTED','RECOVERY_SENT','RECOVERY_SUCCEEDED']);
   const html=memberPage({...detail,csrf:'x'.repeat(64)});
   assert.ok(html.includes('הגישה שוחזרה במכשיר נוסף')&&html.includes('אישורי הצטרפות פעילים'));
   assert.ok(!html.includes(code)&&!html.includes(r.body.memberToken)&&!html.includes(a.token));
  });
  await t.test('wrong codes count; the 5th locks the challenge, even for the right code afterwards',async()=>{
   const a=await f.join();
   const id=(await start(a)).body.challengeId,code=await codeFor(a.email);
   for(let i=1;i<=4;i++){
    const r=await verify(a.group,id,wrong(code));
    assert.equal(r.status,400);assert.equal(r.body.code,'INVALID_OR_EXPIRED_CODE');
    assert.equal((await challenge(id)).attempts,i);
   }
   const fifth=await verify(a.group,id,wrong(code));
   assert.equal(fifth.status,429);assert.equal(fifth.body.code,'TOO_MANY_ATTEMPTS');
   assert.equal((await challenge(id)).closed_reason,'LOCKED');
   assert.equal((await verify(a.group,id,code)).body.code,'TOO_MANY_ATTEMPTS','locked for good');
   assert.equal((await tokens((await memberRow(a.email)).id)).length,1,'no receipt issued');
   // Malformed input never counts as an attempt.
   await age(61);
   const next=(await start(a)).body.challengeId;
   for(const bad of ['12345','1234567','abcdef','12 456',123456 as any])assert.equal((await verify(a.group,next,bad)).body.code,'INVALID_OR_EXPIRED_CODE');
   assert.equal((await challenge(next)).attempts,0);
  });
  await t.test('expired, replayed, superseded and concurrent codes',async()=>{
   const a=await f.join();
   const first=(await start(a)).body.challengeId,firstCode=await codeFor(a.email);
   await f.db.query("UPDATE member_recovery_challenges SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[first]);
   assert.equal((await verify(a.group,first,firstCode)).body.code,'INVALID_OR_EXPIRED_CODE','expired');
   await age(61);
   const second=(await start(a)).body.challengeId,secondCode=await codeFor(a.email);
   await age(61);
   const third=(await start(a)).body.challengeId,thirdCode=await codeFor(a.email);
   assert.equal((await challenge(second)).closed_reason,'SUPERSEDED');
   assert.equal((await verify(a.group,second,secondCode)).body.code,'INVALID_OR_EXPIRED_CODE','a newer code replaces the older one');
   // Duplicate submissions of the right code: exactly one succeeds.
   const results=await Promise.all([verify(a.group,third,thirdCode),verify(a.group,third,thirdCode)]);
   assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
   assert.equal((await verify(a.group,third,thirdCode)).body.code,'INVALID_OR_EXPIRED_CODE','single use: replay refused');
   assert.equal((await tokens((await memberRow(a.email)).id)).length,2,'one recovery receipt only');
  });
  await t.test('tampered group id, unknown challenge and another member\'s challenge',async()=>{
   const a=await f.join(),b=await f.join(),other=await f.join(AREA.ashkelon);
   const aId=(await start(a)).body.challengeId,aCode=await codeFor(a.email);
   const bId=(await start(b)).body.challengeId,bCode=await codeFor(b.email);
   assert.equal((await verify(other.group,aId,aCode)).body.code,'INVALID_OR_EXPIRED_CODE','challenge of another group');
   assert.equal((await challenge(aId)).attempts,0,'a foreign group never touches the challenge');
   assert.equal((await verify(a.group,'00000000-0000-4000-8000-000000000000',aCode)).body.code,'INVALID_OR_EXPIRED_CODE');
   assert.equal((await verify(a.group,'not-a-uuid',aCode)).body.code,'INVALID_OR_EXPIRED_CODE');
   if(aCode!==bCode)assert.equal((await verify(a.group,bId,aCode)).body.code,'INVALID_OR_EXPIRED_CODE','A\'s code on B\'s challenge');
   const okB=await verify(b.group,bId,bCode);
   assert.equal(okB.status,200);
   // B's new receipt acts for B only.
   assert.equal((await f.post('/groups/'+other.group+'/member',{},okB.body.memberToken)).body.code,'MEMBER_AUTH_REQUIRED','a receipt never works for another group');
   assert.equal((await f.post('/groups/'+b.group+'/member',{},okB.body.memberToken)).body.member.pledgedTotalAgorot,25000);
   const bRow=await memberRow(b.email),aRow=await memberRow(a.email);
   assert.equal((await tokens(aRow.id)).length,1);assert.equal((await tokens(bRow.id)).length,2);
   assert.equal((await start({group:'00000000-0000-4000-8000-000000000001',email:a.email,phone:a.phone})).body.code,'GROUP_NOT_FOUND');
  });
  await t.test('status rules: recovery restores access and never changes the membership or group',async()=>{
   const recover=async(m:{group:string;email:string;phone:string})=>{await age(61);const id=(await start(m)).body.challengeId;const code=await codeFor(m.email);return verify(m.group,id,code);};
   // WITHDRAWN while the group still takes pledges, withdrawn between start and verify.
   const w=await f.join(AREA.ashkelon);
   const wid=(await start(w)).body.challengeId,wcode=await codeFor(w.email);
   assert.equal((await f.post('/groups/'+w.group+'/withdraw',{confirm:true},w.token)).status,200);
   const wr=await verify(w.group,wid,wcode);
   assert.equal(wr.status,200);assert.deepEqual(wr.body.member,{status:'WITHDRAWN'});
   const wRow=await memberRow(w.email);assert.equal(wRow.status,'WITHDRAWN');assert.equal(Number(wRow.pledged_total_agorot),0);
   assert.equal((await f.post('/groups/'+w.group+'/member',{},wr.body.memberToken)).body.member.status,'WITHDRAWN','not reactivated');
   // The member may then pledge again explicitly with a non-empty cart.
   assert.equal((await f.post('/groups/'+w.group+'/update-pledge',{lines:[]},wr.body.memberToken)).body.code,'EMPTY_CART_CANNOT_UPDATE_PLEDGE');
   assert.equal((await f.post('/groups/'+w.group+'/update-pledge',{lines:[{variantId:'1',quantity:1}]},wr.body.memberToken)).status,200);
   // APPROVED: access, but pledge changes stay disabled.
   const p=await f.join(AREA.ashdod);
   await f.db.query("UPDATE delivery_groups SET status='APPROVED' WHERE public_id=$1",[p.group]);
   const pr=await recover(p);
   assert.equal(pr.status,200);assert.equal(pr.body.group.status,'APPROVED');assert.deepEqual(pr.body.member,{status:'PLEDGED'});
   assert.equal((await f.post('/groups/'+p.group+'/update-pledge',{lines:[{variantId:'1',quantity:1}]},pr.body.memberToken)).body.code,'GROUP_CLOSED');
   // COMPLETED between start and verify: historical access only, nothing moves.
   const cid=(await (async()=>{await age(61);return (await start(p)).body.challengeId;})()),ccode=await codeFor(p.email);
   await f.db.query("UPDATE delivery_groups SET operational_status='COMPLETED',completed_at=NOW(),completed_by='session:test' WHERE public_id=$1",[p.group]);
   const cr=await verify(p.group,cid,ccode);
   assert.equal(cr.status,200);assert.equal(cr.body.group.status,'COMPLETED');assert.deepEqual(cr.body.member,{status:'PLEDGED'});
   assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM group_members WHERE email=$1',[p.email.toLowerCase()])).rows[0].n,1,'no new membership anywhere');
   // EXPIRED: closed history; recovery does not reopen it.
   const e=await f.join(AREA.ashkelon,f.person());
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 minute' WHERE public_id=$1",[e.group]);
   const er=await recover(e);
   assert.equal(er.status,200);assert.equal(er.body.group.status,'EXPIRED');
   assert.equal((await f.db.query('SELECT status FROM delivery_groups WHERE public_id=$1',[e.group])).rows[0].status,'EXPIRED');
  });
  await t.test('receipts from before migration 006 keep working; the backfill is idempotent; revocation wins',async()=>{
   const a=await f.join();const row=await memberRow(a.email);
   // A join written by the previous release (rolling deploy): group_members.token_hash only, no member_tokens row.
   await f.db.query('DELETE FROM member_tokens WHERE member_id=$1',[row.id]);
   assert.equal((await f.post('/groups/'+a.group+'/member',{},a.token)).status,200,'legacy join receipt still authenticates');
   const {readFile}=await import('node:fs/promises');
   const sql=await readFile(new URL('../migrations/006_member_recovery.sql',import.meta.url),'utf8');
   await f.db.query(sql);await f.db.query(sql);
   assert.deepEqual((await tokens(row.id)).map((t:any)=>t.source),['JOIN'],'backfilled once');
   await f.db.query('UPDATE member_tokens SET revoked_at=NOW() WHERE member_id=$1',[row.id]);
   assert.equal((await f.post('/groups/'+a.group+'/member',{},a.token)).body.code,'MEMBER_AUTH_REQUIRED','a revoked receipt is refused');
  });
  await t.test('disabled or misconfigured recovery fails closed',async()=>{
   const g=await fixture(null);
   try{
    const a=await g.join();
    for(const path of ['start','verify']){
     const r=await g.post('/groups/'+a.group+'/recovery/'+path,{email:a.email,phone:a.phone,challengeId:'00000000-0000-4000-8000-000000000000',code:'123456'});
     assert.equal(r.status,503);assert.equal(r.body.code,'RECOVERY_UNAVAILABLE');
    }
    assert.equal((await g.db.query('SELECT COUNT(*)::int AS n FROM member_recovery_challenges')).rows[0].n,0);
   }finally{await g.close();}
   assert.equal(recoveryConfig({},true).state,'DISABLED');
   assert.equal(recoveryConfig({RECOVERY_EMAIL_PROVIDER:'memory'},true).state,'MISCONFIGURED','memory never in production');
   assert.equal(recoveryConfig({RECOVERY_EMAIL_PROVIDER:'memory'},false).state,'ENABLED');
   const missing=recoveryConfig({RECOVERY_EMAIL_PROVIDER:'resend',RECOVERY_EMAIL_FROM:'פאנקי <no-reply@mail.fanakee.com>'},true);
   assert.equal(missing.state,'MISCONFIGURED');assert.ok(missing.problems.some(p=>p.startsWith('RESEND_API_KEY')));
   const badFrom=recoveryConfig({RECOVERY_EMAIL_PROVIDER:'resend',RESEND_API_KEY:'re_live_secret_value',RECOVERY_EMAIL_FROM:'not an address'},true);
   assert.equal(badFrom.state,'MISCONFIGURED');assert.ok(!JSON.stringify(badFrom.problems).includes('re_live_secret_value'),'problems never echo values');
   const ok=recoveryConfig({RECOVERY_EMAIL_PROVIDER:'resend',RESEND_API_KEY:'re_live_secret_value',RECOVERY_EMAIL_FROM:'פאנקי <no-reply@mail.fanakee.com>',RECOVERY_EMAIL_REPLY_TO:'support@fanakee.com'},true);
   assert.equal(ok.state,'ENABLED');assert.equal(ok.senderDomain,'mail.fanakee.com');
   // The operations page shows the state and sender domain, never the key.
   const view=JSON.stringify(systemsView(opsConfig({}),{results:{},checkedAt:new Date().toISOString(),cached:false},'https://svc.example.test',ok));
   assert.ok(view.includes('mail.fanakee.com')&&view.includes('recovery-email'));assert.ok(!view.includes('re_live_secret_value'));
   // A misconfigured provider never stops the service from starting.
   assert.equal(config({...ENV,NODE_ENV:'development',RECOVERY_EMAIL_PROVIDER:'resend'}).recovery.state,'MISCONFIGURED');
  });
  await t.test('Resend provider request, and errors that carry nothing',async()=>{
   const calls:{url:string;init:RequestInit}[]=[];let reply:()=>Promise<Response>=async()=>new Response('{"id":"x"}',{status:200});
   const provider=new ResendEmailProvider({apiKey:'re_test_key_0001',from:'פאנקי <no-reply@mail.fanakee.com>',replyTo:'support@fanakee.com'},async(url,init)=>{calls.push({url,init});return reply();});
   await provider.sendRecoveryCode({to:'member@example.test',code:'048213',expiresInMinutes:10,idempotencyKey:'group-recovery-abc'});
   assert.equal(calls[0].url,'https://api.resend.com/emails');assert.equal(calls[0].init.method,'POST');
   const headers=calls[0].init.headers as Record<string,string>;
   assert.equal(headers.Authorization,'Bearer re_test_key_0001');assert.equal(headers['Idempotency-Key'],'group-recovery-abc');
   const body=JSON.parse(String(calls[0].init.body));
   assert.deepEqual(Object.keys(body).sort(),['from','html','reply_to','subject','text','to']);
   assert.deepEqual(body.to,['member@example.test']);assert.equal(body.subject,RECOVERY_SUBJECT);assert.equal(body.reply_to,'support@fanakee.com');
   reply=async()=>new Response('{"message":"invalid key re_test_key_0001 for member@example.test"}',{status:403});
   const failed=await provider.sendRecoveryCode({to:'member@example.test',code:'048213',expiresInMinutes:10}).catch(e=>e);
   assert.ok(failed instanceof EmailDeliveryError);
   assert.ok(!/re_test|member@|048213|invalid key/.test(String(failed.message)+String(failed.stack)),'no provider detail in the error');
   reply=async()=>{throw Error('connect ECONNREFUSED api.resend.com re_test_key_0001');};
   assert.ok((await provider.sendRecoveryCode({to:'member@example.test',code:'048213',expiresInMinutes:10}).catch(e=>e)) instanceof EmailDeliveryError);
  });
  await t.test('email content: Hebrew, RTL, prominent code, no marketing or account data',()=>{
   const email=recoveryEmail('048213',10);
   assert.equal(email.subject,'קוד אימות לשחזור ההצטרפות שלך בפאנקי');
   for(const line of ['שלום,','ביקשת לשחזר את הגישה למשלוח הקבוצתי שלך בפאנקי.','קוד האימות שלך:','048213','הקוד תקף ל-10 דקות.','אם לא ביקשת לשחזר את ההצטרפות, אפשר להתעלם מהמייל.'])assert.ok(email.text.includes(line),line);
   assert.match(email.html,/<html lang="he" dir="rtl">/);assert.match(email.html,/font-size:34px[^>]*>048213</);
   assert.ok(!/token|password|סיסמה|₪|http/i.test(email.text+email.html.replace(/<meta[^>]*>/g,'')),'no links, tokens or amounts');
   assert.throws(()=>recoveryEmail('<b>1</b>',10));assert.throws(()=>recoveryEmail('12345',10));
  });
  await t.test('no code, token, contact or key in any log line',()=>{
   for(const line of logged){
    for(const secret of [...secrets,'re_live_secret_value','re_test_key_0001','testing-session-secret'])assert.ok(!line.includes(secret),'log leaked a secret: '+line);
    assert.ok(!/\b\d{6}\b/.test(line)||!secrets.some(s=>line.includes(s)));
    assert.ok(!/@example\.test/i.test(line),'log leaked an email: '+line);
   }
  });
 }finally{
  Object.assign(console,originals);
  await f.close();
 }
});
