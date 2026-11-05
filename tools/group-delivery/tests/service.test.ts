
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
 const query=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const db:Database={
  async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},
  async connect(){const release=await acquire();return {query,release} as Connection;}
 };
 const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'});
 let mode='ok';
 const validator=new Shopify(cfg,async(input,options)=>{
  assert.equal(String(input),'https://example.myshopify.com/api/2026-10/graphql.json');
  const body=JSON.parse(String(options?.body));
  assert.match(body.query,/@inContext\(country:IL\)/);
  if(mode==='network')throw Error('upstream-secret-should-never-escape');
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
 t.beforeEach(async()=>{mode='ok';await db.query('TRUNCATE group_members, delivery_groups, request_limits, admin_sessions CASCADE');});
 try{
  await migrate(db);await migrate(db);
  await t.test('first group, nearby match, distant group and fixed-anchor anti-chain matching',async()=>{
   const first=await find(),near=await find(place(31.82,34.66)),far=await find(place(32.2,34.9));
   assert.equal(first.group.publicId,near.group.publicId);assert.notEqual(first.group.publicId,far.group.publicId);
   await service.join(first.group.publicId,{...person(),location:place(31.85,34.64),lines:line(1)});
   const chained=await find(place(31.9,34.64));assert.notEqual(chained.group.publicId,first.group.publicId);
   const row=(await db.query('SELECT anchor_lat,center_lat FROM delivery_groups WHERE public_id=$1',[first.group.publicId])).rows[0];
   assert.equal(row.anchor_lat,31.8);assert.ok(row.center_lat>row.anchor_lat);
  });
  await t.test('text-only locality fallback and approximate coordinate privacy',async()=>{
   const a=await find({areaName:'אשדוד'}),b=await find({areaName:' אשדוד '});
   assert.equal(a.group.publicId,b.group.publicId);
   assert.notEqual(a.group.publicId,(await find({areaName:'אשקלון'})).group.publicId);
   const geo=await find({areaName:'אשדוד',lat:31.812345,lng:34.654321});
   const row=(await db.query('SELECT anchor_lat,anchor_lng FROM delivery_groups WHERE public_id=$1',[geo.group.publicId])).rows[0];
   assert.equal(row.anchor_lat,31.81);assert.equal(row.anchor_lng,34.65);
   assert.ok(!JSON.stringify(geo).includes('31.81'));
  });
  await t.test('duplicate membership and concurrent joins preserve integer totals',async()=>{
   const group=(await find()).group,contact=person();
   const attempts=await Promise.allSettled([service.join(group.publicId,{...contact,location:place(),lines:line()}),service.join(group.publicId,{...contact,location:place(),lines:line()})]);
   assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
   const after=await service.get(group.publicId);assert.equal(after.participantCount,1);assert.equal(after.pledgedTotalAgorot,25000);
  });
  await t.test('member receipt updates pledge; crossing and dropping below threshold; no payment transitions',async()=>{
   const group=(await find()).group;
   const member=await service.join(group.publicId,{...person(),location:place(),lines:line()});
   await assert.rejects(()=>service.update(group.publicId,'0'.repeat(64),{lines:line()}),(e:any)=>e.status===401);
   const reached=await service.update(group.publicId,member.memberToken,{lines:line(4)});
   assert.equal(reached.group.status,'THRESHOLD_REACHED');assert.equal(reached.group.pledgedTotalAgorot,50000);assert.equal(reached.group.remainingAmountAgorot,0);
   const down=await service.update(group.publicId,member.memberToken,{lines:line(1)});assert.equal(down.group.status,'OPEN');assert.equal(down.group.remainingAmountAgorot,37500);
   const withdrawn=await service.update(group.publicId,member.memberToken,{lines:[]});assert.equal(withdrawn.group.pledgedTotalAgorot,0);assert.equal(withdrawn.group.participantCount,0);
   assert.equal(String((await db.query('SELECT paid_total_agorot FROM delivery_groups')).rows[0].paid_total_agorot),'0');
  });
  await t.test('expiration prevents joins, updates and approval',async()=>{
   const group=(await find()).group;const member=await service.join(group.publicId,{...person(),location:place(),lines:line(4)});
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
   const response=await post('/api/v1/groups/find-or-create',{location:place(),lines:line(),total:1});assert.equal(response.status,200);
   const found=await response.json() as any;assert.equal(found.validatedPledgeAgorot,25000);
   const privateContact=person();
   const joined=await post('/api/v1/groups/'+found.group.publicId+'/join',{...privateContact,location:place(),lines:line(),pledged_total_agorot:99999999});
   assert.equal(joined.status,201);const result=await joined.json() as any;assert.equal(result.group.pledgedTotalAgorot,25000);
   const publicResponse=await fetch(cfg.origin+'/api/v1/groups/'+found.group.publicId),body=await publicResponse.text();
   for(const forbidden of [privateContact.email,privateContact.phone,'approx_lat','center_lat','snapshot','memberToken','test-private-shopify-token','testing-password'])assert.ok(!body.includes(forbidden),forbidden);
   assert.deepEqual(Object.keys(JSON.parse(body).group).sort(),['areaName','currency','expiresAt','participantCount','pledgedTotalAgorot','progressPercent','publicId','remainingAmountAgorot','status','thresholdAgorot'].sort());
   const update=await post('/api/v1/groups/'+found.group.publicId+'/update-pledge',{lines:line(3)},{Authorization:'Bearer '+result.memberToken});assert.equal(update.status,200);
   mode='network';const failed=await post('/api/v1/groups/find-or-create',{location:place(),lines:line()});
   assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('upstream-secret'));
  });
  await t.test('origin checks, request limits, body cap and public health',async()=>{
   assert.equal((await fetch(cfg.origin+'/health')).status,200);
   assert.equal((await post('/api/v1/groups/find-or-create',{location:place()},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/groups/find-or-create',{location:place(),padding:'x'.repeat(30000)})).status,413);
   await db.query('TRUNCATE request_limits');
   for(let i=0;i<20;i++)assert.equal((await post('/api/v1/groups/find-or-create',{location:place()})).status,200);
   assert.equal((await post('/api/v1/groups/find-or-create',{location:place()})).status,429);
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
   const group=(await find()).group;
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
   const group=(await find()).group,member=await service.join(group.publicId,{...person(),location:place(),lines:line()});
   await engine.close();engine=new PGlite(dir);
   assert.equal((await service.get(group.publicId)).participantCount,1);
   assert.equal((await service.update(group.publicId,member.memberToken,{lines:line(3)})).group.pledgedTotalAgorot,37500);
  });
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));await engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-group-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
