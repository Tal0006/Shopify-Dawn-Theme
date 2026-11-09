
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Groups} from '../src/groups.js';
import {Shopify} from '../src/shopify.js';
import {config} from '../src/config.js';
import {agorot,location,distance,lines,contact,ApiError} from '../src/domain.js';
import {migrate,type Database,type Connection} from '../src/db.js';
test('Durable PostgreSQL group service',{timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-group-db-'));let engine=new PGlite(dir);
 // SQL log (to prove searches never write) and one-shot failure injection (to prove join/create atomicity).
 let log:string[]|null=null,failMemberInsert=false;
 const raw=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 const query=async(sql:string,values?:any[]):Promise<any>=>{
  log?.push(sql.trim());
  if(failMemberInsert&&/^INSERT INTO group_members/.test(sql.trim())){failMemberInsert=false;throw Error('injected member insert failure');}
  return raw(sql,values);
 };
 const writes=()=>log!.filter(sql=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(sql));
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const db:Database={
  async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},
  async connect(){const release=await acquire();return {query,release} as Connection;}
 };
 const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'});
 let mode='ok';
 // Barrier: both callers finish pre-lock Shopify validation before either may continue into the lock.
 let barrier:{waiting:number;gate:Promise<void>;release:()=>void}|null=null;
 const arm=()=>{let release!:()=>void;const gate=new Promise<void>(r=>release=r);barrier={waiting:0,gate,release};};
 const validator=new Shopify(cfg,async(input,options)=>{
  assert.equal(String(input),'https://example.myshopify.com/api/2026-10/graphql.json');
  const body=JSON.parse(String(options?.body));
  assert.match(body.query,/@inContext\(country:IL\)/);
  if(mode==='network')throw Error('upstream-secret-should-never-escape');
  if(barrier){const b=barrier;if(++b.waiting<2)await b.gate;else{barrier=null;b.release();}}
  return new Response(JSON.stringify({data:{nodes:body.variables.ids.map((id:string)=>id.endsWith('/999')?null:{id,availableForSale:mode!=='sold',requiresComponents:false,quantityAvailable:100,price:{amount:mode==='wrong-currency'?'2.00':'125.00',currencyCode:mode==='wrong-currency'?'USD':'ILS'},quantityRule:{minimum:1,increment:1,maximum:null},product:{requiresSellingPlan:false}})}}));
 });
 const service=new Groups(db,cfg,validator),app=createApp(db,cfg,validator);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 const line=(quantity=2)=>[{variantId:'1',quantity}];
 const place=(lat=31.8,lng=34.64)=>({areaName:'אשדוד',lat,lng});
 let personIndex=0;
 const person=()=>({email:'fixture'+(++personIndex)+'@example.test',phone:'+972501'+String(personIndex).padStart(6,'0')});
 const post=(path:string,body:any,extra:Record<string,string>={})=>fetch(cfg.origin+path,{method:'POST',headers:{Origin:cfg.origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body),redirect:'manual'});
 const find=async(loc:any=place())=>service.find({location:loc});
 const start=(loc:any=place(),quantity=2,who=person())=>service.joinArea({...who,location:loc,lines:line(quantity)});
 const count=async(table:string)=>Number((await db.query('SELECT COUNT(*)::int AS n FROM '+table)).rows[0].n);
 t.beforeEach(async()=>{mode='ok';log=null;failMemberInsert=false;barrier=null;await db.query('TRUNCATE group_members, delivery_groups, request_limits, admin_sessions CASCADE');});
 try{
  await migrate(db);await migrate(db);
  await t.test('search with no group performs zero writes, repeatedly, and says a join will create it',async()=>{
   log=[];
   for(const loc of [place(),place(),{areaName:'אשדוד'},place(32.2,34.9)]){
    const result=await find(loc);
    assert.equal(result.group,null);assert.equal(result.canCreateOnJoin,true);
   }
   const priced=await service.find({location:place(),lines:line()});
   assert.equal(priced.group,null);assert.equal(priced.validatedPledgeAgorot,25000);
   assert.deepEqual(writes(),[],'search must not write');
   assert.ok(!log.some(sql=>/FOR UPDATE|^BEGIN/i.test(sql)),'search must not take the coordination lock');
   log=null;
   assert.equal(await count('delivery_groups'),0);assert.equal(await count('group_members'),0);
  });
  await t.test('search with an existing compatible group returns it without writing',async()=>{
   const created=await start();
   log=[];
   const near=await find(place(31.82,34.66));
   assert.equal(near.group.publicId,created.group.publicId);assert.equal(near.canCreateOnJoin,false);assert.equal(near.group.participantCount,1);
   assert.deepEqual(writes(),[]);log=null;
  });
  await t.test('first join creates group and member atomically under the lock',async()=>{
   log=[];
   const first=await start();
   assert.equal(first.created,true);assert.equal(first.group.participantCount,1);assert.match(first.memberToken,/^[a-f0-9]{64}$/);
   // Expire, re-match, create and insert all happen inside one transaction after the coordination lock.
   const at=(pattern:RegExp)=>log!.findIndex(sql=>pattern.test(sql));
   const order=[/^BEGIN/,/FOR UPDATE/,/^UPDATE delivery_groups SET status='EXPIRED'/,/^SELECT g\.\* FROM delivery_groups/,/^INSERT INTO delivery_groups/,/^INSERT INTO group_members/,/^COMMIT/].map(at);
   assert.ok(order.every(i=>i>=0),'missing step '+order);assert.deepEqual([...order].sort((a,b)=>a-b),order);
   log=null;
   assert.equal(await count('delivery_groups'),1);assert.equal(await count('group_members'),1);
   // A failure after creating the group rolls the group back too: no memberless groups.
   await db.query('TRUNCATE group_members, delivery_groups CASCADE');
   failMemberInsert=true;
   await assert.rejects(()=>start(place(32.2,34.9)),/injected member insert failure/);
   assert.equal(await count('delivery_groups'),0);assert.equal(await count('group_members'),0);
  });
  await t.test('later compatible joins join the same group; incompatible ones never do',async()=>{
   const first=await start(),second=await start(place(31.82,34.66));
   assert.equal(second.created,false);assert.equal(second.group.publicId,first.group.publicId);assert.equal(second.group.participantCount,2);
   const far=await start(place(32.2,34.9));
   assert.equal(far.created,true);assert.notEqual(far.group.publicId,first.group.publicId);
   await assert.rejects(()=>service.join(first.group.publicId,{...person(),location:place(32.2,34.9),lines:line()}),(e:any)=>e.code==='LOCATION_OUTSIDE_GROUP');
   const text=await start({areaName:'אשדוד'});
   assert.equal(text.created,true,'text-only and coordinate groups never merge');
   assert.equal((await start({areaName:' אשדוד '})).group.publicId,text.group.publicId);
   assert.equal(await count('delivery_groups'),3);
  });
  await t.test('duplicate contact rules apply to area joins and group joins',async()=>{
   const who=person(),first=await start(place(),2,who);
   await assert.rejects(()=>start(place(),2,who),(e:any)=>e.code==='ALREADY_JOINED');
   await assert.rejects(()=>start(place(),2,{email:who.email,phone:'+972509999999'}),(e:any)=>e.code==='ALREADY_JOINED');
   await assert.rejects(()=>service.join(first.group.publicId,{...who,location:place(),lines:line()}),(e:any)=>e.code==='ALREADY_JOINED');
   assert.equal(await count('delivery_groups'),1);assert.equal(await count('group_members'),1);
  });
  await t.test('a full group is skipped by area joins and rejected by direct joins',async()=>{
   const first=await start();
   const id=(await db.query('SELECT id FROM delivery_groups')).rows[0].id;
   for(let i=0;i<99;i++)await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,approx_lat,approx_lng,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,$2,$3,'אשדוד',31.8,34.64,'[]'::jsonb,100,$4)",[id,'bulk'+i+'@example.test','+97250'+String(i).padStart(7,'0'),'bulk-token-'+i]);
   await assert.rejects(()=>service.join(first.group.publicId,{...person(),location:place(),lines:line()}),(e:any)=>e.code==='GROUP_FULL');
   assert.equal((await find()).group,null,'full groups are not offered');
   const overflow=await start();
   assert.equal(overflow.created,true);assert.notEqual(overflow.group.publicId,first.group.publicId);
  });
  await t.test('near-simultaneous first joins for one area create one group with two members',async()=>{
   // Both shoppers searched (no group) and finish Shopify validation before either enters the lock.
   assert.equal((await find()).group,null);
   arm();
   const [a,b]=await Promise.all([start(),start(place(31.81,34.65))]);
   assert.equal(a.group.publicId,b.group.publicId);
   assert.deepEqual([a.created,b.created].sort(),[false,true]);
   assert.equal(await count('delivery_groups'),1);assert.equal(await count('group_members'),2);
   assert.equal((await service.get(a.group.publicId)).participantCount,2);
   arm();
   const text=await Promise.all([start({areaName:'אשקלון'}),start({areaName:'אשקלון'})]);
   assert.equal(text[0].group.publicId,text[1].group.publicId);assert.equal(await count('delivery_groups'),2);
  });
  await t.test('DEPRECATED find-or-create keeps the old client contract while /groups/find stays read-only',async()=>{
   // New search on a miss: null, and no writes to group tables over HTTP.
   log=[];
   const miss=await (await post('/api/v1/groups/find',{location:place(),lines:line()})).json() as any;
   assert.equal(miss.group,null);assert.equal(miss.canCreateOnJoin,true);
   assert.ok(!writes().some(sql=>/delivery_groups|group_members/.test(sql)),'find must not touch group tables');
   log=null;assert.equal(await count('delivery_groups'),0);
   // Legacy search on the same miss keeps the old shape: always a non-null group, created under the lock.
   const legacy=await post('/api/v1/groups/find-or-create',{location:place(),lines:line()});
   assert.equal(legacy.status,200);assert.equal(legacy.headers.get('deprecation'),'true');
   const old=await legacy.json() as any;
   assert.deepEqual(Object.keys(old).sort(),['group','validatedPledgeAgorot','withinStandardRadius']);
   assert.match(old.group.publicId,/^[a-f0-9-]{36}$/);assert.equal(old.group.participantCount,0);assert.equal(old.validatedPledgeAgorot,25000);
   assert.ok(!('canCreateOnJoin' in old),'legacy shape must not change');
   assert.equal(await count('delivery_groups'),1);
   const again=await (await post('/api/v1/groups/find-or-create',{location:place(31.82,34.66)})).json() as any;
   assert.equal(again.group.publicId,old.group.publicId,'legacy reuses a compatible group');assert.equal(await count('delivery_groups'),1);
   // The old client then joins by publicId exactly as before.
   const joined=await post('/api/v1/groups/'+old.group.publicId+'/join',{...person(),location:place(),lines:line()});
   assert.equal(joined.status,201);const member=await joined.json() as any;
   assert.match(member.memberToken,/^[a-f0-9]{64}$/);assert.equal(member.group.participantCount,1);
   // Both clients see the same groups; the new search still never creates on a miss.
   assert.equal((await service.find({location:place()})).group.publicId,old.group.publicId);
   log=[];assert.equal((await service.find({location:place(32.2,34.9)})).group,null);assert.deepEqual(writes(),[]);log=null;
   assert.equal(await count('delivery_groups'),1);
   // The new join/create flow is unchanged next to the legacy route.
   const started=await post('/api/v1/groups/join',{...person(),location:place(32.2,34.9),lines:line()});
   assert.equal(started.status,201);const fresh=await started.json() as any;
   assert.equal(fresh.created,true);assert.notEqual(fresh.group.publicId,old.group.publicId);assert.equal(fresh.group.participantCount,1);
   assert.equal((await service.joinArea({...person(),location:place(),lines:line()})).group.publicId,old.group.publicId);
  });
  await t.test('fixed-anchor anti-chain matching and approximate coordinate privacy',async()=>{
   const first=await start(place(),1);
   await service.join(first.group.publicId,{...person(),location:place(31.85,34.64),lines:line(1)});
   const chained=await find(place(31.9,34.64));assert.notEqual(chained.group?.publicId,first.group.publicId);
   const row=(await db.query('SELECT anchor_lat,center_lat FROM delivery_groups WHERE public_id=$1',[first.group.publicId])).rows[0];
   assert.equal(row.anchor_lat,31.8);assert.ok(row.center_lat>row.anchor_lat);
   const geo=await start({areaName:'אשקלון',lat:31.612345,lng:34.554321});
   const anchor=(await db.query('SELECT anchor_lat,anchor_lng FROM delivery_groups WHERE public_id=$1',[geo.group.publicId])).rows[0];
   assert.equal(anchor.anchor_lat,31.61);assert.equal(anchor.anchor_lng,34.55);
   assert.ok(!JSON.stringify(geo).includes('31.61'));
  });
  await t.test('duplicate membership and concurrent joins preserve integer totals',async()=>{
   const group=(await start()).group,contact=person();
   const attempts=await Promise.allSettled([service.join(group.publicId,{...contact,location:place(),lines:line()}),service.join(group.publicId,{...contact,location:place(),lines:line()})]);
   assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
   const after=await service.get(group.publicId);assert.equal(after.participantCount,2);assert.equal(after.pledgedTotalAgorot,50000);
  });
  await t.test('member receipt updates pledge; crossing and dropping below threshold; no payment transitions',async()=>{
   const member=await start(),group=member.group;
   await assert.rejects(()=>service.update(group.publicId,'0'.repeat(64),{lines:line()}),(e:any)=>e.status===401);
   const reached=await service.update(group.publicId,member.memberToken,{lines:line(4)});
   assert.equal(reached.group.status,'THRESHOLD_REACHED');assert.equal(reached.group.pledgedTotalAgorot,50000);assert.equal(reached.group.remainingAmountAgorot,0);
   const down=await service.update(group.publicId,member.memberToken,{lines:line(1)});assert.equal(down.group.status,'OPEN');assert.equal(down.group.remainingAmountAgorot,37500);
   const withdrawn=await service.update(group.publicId,member.memberToken,{lines:[]});assert.equal(withdrawn.group.pledgedTotalAgorot,0);assert.equal(withdrawn.group.participantCount,0);
   assert.equal(String((await db.query('SELECT paid_total_agorot FROM delivery_groups')).rows[0].paid_total_agorot),'0');
  });
  await t.test('expiration prevents joins, updates and approval',async()=>{
   const member=await start(place(),4),group=member.group;
   await db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 second'");
   assert.equal((await service.get(group.publicId)).status,'EXPIRED');
   await assert.rejects(()=>service.update(group.publicId,member.memberToken,{lines:line()}),(e:any)=>e.status===409);
   await assert.rejects(()=>service.join(group.publicId,{...person(),location:place(),lines:line()}),(e:any)=>e.status===409);
   await assert.rejects(()=>service.approve(group.publicId),(e:any)=>e.status===409);
  });
  await t.test('invalid locations, invalid/unavailable carts and exact money arithmetic',async()=>{
   for(const input of [{areaName:'a'},{areaName:'email@example.test'},{areaName:'אשדוד',lat:91,lng:34},{areaName:'אשדוד',lat:30}]){
    assert.throws(()=>location(input),ApiError);
   }
   for(const phone of ['0501234567','972501234567','00972501234567','+972501234567'])assert.equal(contact({email:'fixture@example.test',phone}).phone,'+972501234567');
   assert.equal(agorot('19.90')*3n,5970n);assert.equal(agorot('0.10')+agorot('0.20'),30n);assert.throws(()=>agorot('1.001'));
   assert.ok(distance({lat:31.8,lng:34.64},{lat:31.8,lng:34.64})<0.001);
   assert.throws(()=>lines([{variantId:'1',quantity:1.5}]));assert.throws(()=>lines([{variantId:'1',quantity:1},{variantId:'1',quantity:1}]));
   await assert.rejects(()=>validator.validate(lines([{variantId:'999',quantity:1}])));mode='sold';
   await assert.rejects(()=>validator.validate(lines(line())));mode='wrong-currency';await assert.rejects(()=>validator.validate(lines(line())));
  });
  await t.test('public API never reflects PII, snapshots, coordinates, credentials or client totals',async()=>{
   const response=await post('/api/v1/groups/find',{location:place(),lines:line(),total:1});assert.equal(response.status,200);
   const searched=await response.json() as any;assert.equal(searched.validatedPledgeAgorot,25000);
   assert.equal(searched.group,null);assert.equal(searched.canCreateOnJoin,true);
   const privateContact=person();
   const joined=await post('/api/v1/groups/join',{...privateContact,location:place(),lines:line(),pledged_total_agorot:99999999});
   assert.equal(joined.status,201);const result=await joined.json() as any;assert.equal(result.group.pledgedTotalAgorot,25000);assert.equal(result.created,true);
   for(const forbidden of [privateContact.email,privateContact.phone,'approx_lat','anchor','snapshot'])assert.ok(!JSON.stringify(result).includes(forbidden),forbidden);
   const found=await (await post('/api/v1/groups/find',{location:place()})).json() as any;
   assert.equal(found.group.publicId,result.group.publicId);assert.equal(found.canCreateOnJoin,false);
   assert.equal((await post('/api/v1/groups/'+found.group.publicId+'/join',{...person(),location:place(),lines:line()})).status,201);
   const publicResponse=await fetch(cfg.origin+'/api/v1/groups/'+found.group.publicId),body=await publicResponse.text();
   for(const forbidden of [privateContact.email,privateContact.phone,'approx_lat','center_lat','snapshot','memberToken','test-private-shopify-token','testing-password'])assert.ok(!body.includes(forbidden),forbidden);
   assert.deepEqual(Object.keys(JSON.parse(body).group).sort(),['areaName','currency','expiresAt','participantCount','pledgedTotalAgorot','progressPercent','publicId','remainingAmountAgorot','status','thresholdAgorot'].sort());
   const update=await post('/api/v1/groups/'+found.group.publicId+'/update-pledge',{lines:line(3)},{Authorization:'Bearer '+result.memberToken});assert.equal(update.status,200);
   mode='network';const failed=await post('/api/v1/groups/find',{location:place(),lines:line()});
   assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('upstream-secret'));
  });
  await t.test('origin checks, request limits, body cap and public health',async()=>{
   assert.equal((await fetch(cfg.origin+'/health')).status,200);
   assert.equal((await post('/api/v1/groups/find',{location:place()},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/groups/join',{...person(),location:place(),lines:line()},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/groups/find-or-create',{location:place()},{Origin:'https://evil.example'})).status,403,'legacy route keeps origin checks');
   assert.equal((await post('/api/v1/groups/find',{location:place(),padding:'x'.repeat(30000)})).status,413);
   await db.query('TRUNCATE request_limits');
   for(let i=0;i<20;i++)assert.equal((await post('/api/v1/groups/find',{location:place()})).status,200);
   assert.equal((await post('/api/v1/groups/find',{location:place()})).status,429);
   assert.equal(await count('delivery_groups'),0,'HTTP searches create no groups');
  });
  await t.test('admin login, CSRF, approval gate, freeze after approval and logout',async()=>{
   assert.equal((await fetch(cfg.origin+'/admin/api/groups')).status,401);
   assert.match(await (await fetch(cfg.origin+'/admin')).text(),/name="password"/);
   const login=(password:string)=>fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password})});
   assert.equal((await login('wrong')).status,401);
   const authenticated=await login(cfg.password);assert.equal(authenticated.status,303);
   const cookieHeader=authenticated.headers.get('set-cookie')!;assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/i);
   const cookie=cookieHeader.split(';')[0],page=await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   const csrf=page.match(/name="csrf" value="([^"]+)"/)![1];
   const group=(await start(place(),1)).group;
   const approve=(token=csrf)=>post('/admin/api/groups/'+group.publicId+'/approve',{},{Cookie:cookie,'X-CSRF-Token':token});
   assert.equal((await approve('bad')).status,403);assert.equal((await approve()).status,409);
   const member=await service.join(group.publicId,{...person(),location:place(),lines:line(4)});
   const approved=await approve();assert.equal(approved.status,200);assert.equal((await approved.json() as any).group.status,'APPROVED');
   assert.equal((await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).status,200);
   await assert.rejects(()=>service.update(group.publicId,member.memberToken,{lines:line()}),(e:any)=>e.status===409);
   assert.equal((await post('/admin/logout',{},{Cookie:cookie,'X-CSRF-Token':csrf})).status,303);
   assert.equal((await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).status,401);
  });
  await t.test('production proxy and secure session cookie',async()=>{
   const production={...cfg,production:true,proxyHops:1},prod=createApp(db,production,validator).listen(0,'127.0.0.1');await new Promise<void>(r=>prod.once('listening',r));
   const base='http://127.0.0.1:'+(prod.address() as any).port;production.origin=base.replace('http:','https:');
   try{
    const reply=await fetch(base+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:production.origin,'X-Forwarded-Proto':'https','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password:cfg.password})});
    assert.equal(reply.status,303);assert.match(reply.headers.get('set-cookie')!,/__Host-group_admin=.*Secure/);
   }finally{await new Promise<void>(r=>prod.close(()=>r()));}
  });
  await t.test('groups and member receipts survive a database restart',async()=>{
   const member=await start(),group=member.group;
   await engine.close();engine=new PGlite(dir);
   assert.equal((await service.get(group.publicId)).participantCount,1);
   assert.equal((await service.update(group.publicId,member.memberToken,{lines:line(3)})).group.pledgedTotalAgorot,37500);
  });
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));await engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-group-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
