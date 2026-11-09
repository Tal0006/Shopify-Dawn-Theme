
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Groups} from '../src/groups.js';
import {Areas} from '../src/areas.js';
import {Shopify} from '../src/shopify.js';
import {config} from '../src/config.js';
import {agorot,location,distance,lines,contact,localityKey,ApiError} from '../src/domain.js';
import {migrate,type Database,type Connection} from '../src/db.js';
// Seeded in migrations/002_delivery_areas.sql with fixed public IDs.
const AREA={beerSheva:'6f1a2c00-0001-4a00-8000-0000000000a1',ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3',kiryatGat:'6f1a2c00-0004-4a00-8000-0000000000a4',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',ofakim:'6f1a2c00-0006-4a00-8000-0000000000a6',sderot:'6f1a2c00-0007-4a00-8000-0000000000a7'};
const SEEDED=['באר שבע','אשדוד','אשקלון','קריית גת','נתיבות','אופקים','שדרות'];
// PGlite-backed Database with an SQL/value log (to prove searches and lookups never write or persist) and one-shot
// member-insert failure injection (to prove join/create atomicity). Connections are serialized, like one pool slot.
function harness(dir:string){
 const state={engine:new PGlite(dir),log:null as null|{sql:string;values:any[]}[],failMemberInsert:false};
 const raw=async(sql:string,values?:any[]):Promise<any>=>values?state.engine.query(sql,values):(await state.engine.exec(sql)).at(-1)||{rows:[]};
 const query=async(sql:string,values?:any[]):Promise<any>=>{
  state.log?.push({sql:sql.trim(),values:values||[]});
  if(state.failMemberInsert&&/^INSERT INTO group_members/.test(sql.trim())){state.failMemberInsert=false;throw Error('injected member insert failure');}
  return raw(sql,values);
 };
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const db:Database={
  async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},
  async connect(){const release=await acquire();return {query,release} as Connection;}
 };
 return {state,db};
}
test('Durable PostgreSQL group service',{timeout:180000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-group-db-'));const {state,db}=harness(dir);
 const writes=()=>state.log!.filter(entry=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(entry.sql)).map(entry=>entry.sql);
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
 const areas=new Areas(db,cfg),service=new Groups(db,cfg,validator,areas),app=createApp(db,cfg,validator);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 const line=(quantity=2)=>[{variantId:'1',quantity}];
 const place=(lat=31.8,lng=34.64)=>({areaName:'אשדוד',lat,lng});
 let personIndex=0;
 const person=()=>({email:'fixture'+(++personIndex)+'@example.test',phone:'+972501'+String(personIndex).padStart(6,'0')});
 const post=(path:string,body:any,extra:Record<string,string>={})=>fetch(cfg.origin+path,{method:'POST',headers:{Origin:cfg.origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body),redirect:'manual'});
 const find=async(area=AREA.ashdod)=>service.find({areaPublicId:area});
 const start=(area=AREA.ashdod,quantity=2,who=person())=>service.joinArea({...who,areaPublicId:area,lines:line(quantity)});
 const legacy=(loc:any=place())=>service.legacyFindOrCreate({location:loc});
 const count=async(table:string)=>Number((await db.query('SELECT COUNT(*)::int AS n FROM '+table)).rows[0].n);
 const publicAreas=async()=>((await (await fetch(cfg.origin+'/api/v1/areas')).json()) as any).areas as {publicId:string;name:string}[];
 t.beforeEach(async()=>{mode='ok';state.log=null;state.failMemberInsert=false;barrier=null;await db.query('TRUNCATE group_members, delivery_groups, request_limits, admin_sessions CASCADE');});
 try{
  await migrate(db);await migrate(db);
  await t.test('seeded areas are idempotent, normalized and listed publicly without coordinates',async()=>{
   assert.equal(await count('delivery_areas'),7);
   const seeded=(await db.query('SELECT slug,name FROM delivery_areas')).rows;
   for(const row of seeded)assert.equal(row.slug,localityKey(row.name),'slug normalization');
   for(const row of (await db.query('SELECT alias_key FROM delivery_area_aliases')).rows)assert.equal(row.alias_key,localityKey(row.alias_key),'alias normalization '+row.alias_key);
   const list=await publicAreas();
   assert.deepEqual(list.map(area=>area.name),SEEDED,'ordered by sort order');
   for(const area of list)assert.deepEqual(Object.keys(area).sort(),['name','publicId']);
   assert.equal(list[1].publicId,AREA.ashdod);
  });
  await t.test('inactive areas are hidden, cannot be searched or create groups, and keep historical groups',async()=>{
   const member=await start(AREA.sderot);
   await areas.update(AREA.sderot,{active:false});
   try{
    assert.ok(!(await publicAreas()).some(area=>area.publicId===AREA.sderot));
    await assert.rejects(()=>find(AREA.sderot),(e:any)=>e.code==='INVALID_AREA');
    const before=await count('delivery_groups');
    await assert.rejects(()=>start(AREA.sderot),(e:any)=>e.code==='INVALID_AREA');
    await assert.rejects(()=>service.join(member.group.publicId,{...person(),areaPublicId:AREA.sderot,lines:line()}),(e:any)=>e.code==='INVALID_AREA');
    assert.equal(await count('delivery_groups'),before);
    // Historical group stays readable and its members can still update.
    assert.equal((await service.get(member.group.publicId)).participantCount,1);
    assert.equal((await service.update(member.group.publicId,member.memberToken,{lines:line(3)})).group.pledgedTotalAgorot,37500);
    assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.sderot})).status,400);
   }finally{await areas.update(AREA.sderot,{active:true});}
   assert.ok((await publicAreas()).some(area=>area.publicId===AREA.sderot));
  });
  await t.test('invalid area references are rejected before any Shopify or database work',async()=>{
   for(const value of [undefined,'','ashdod','אשדוד',42,'6f1a2c00-0002-4a00-8000-0000000000a2x','00000000-0000-4000-8000-000000000000']){
    await assert.rejects(()=>service.find({areaPublicId:value}),(e:any)=>e.code==='INVALID_AREA',String(value));
    await assert.rejects(()=>service.joinArea({...person(),areaPublicId:value,lines:line()}),(e:any)=>e.code==='INVALID_AREA',String(value));
   }
   // Client-supplied names never select an area.
   await assert.rejects(()=>service.find({location:{areaName:'אשדוד'}}),(e:any)=>e.code==='INVALID_AREA');
   const response=await post('/api/v1/groups/join',{...person(),areaPublicId:'nope',lines:line()});
   assert.equal(response.status,400);assert.equal(((await response.json()) as any).code,'INVALID_AREA');
   assert.equal(await count('delivery_groups'),0);
  });
  await t.test('nearest area: closest active area, strict validation, distance limit, nothing stored or logged',async()=>{
   const nearest=async(body:any)=>{const response=await post('/api/v1/areas/nearest',body);return {status:response.status,body:await response.json() as any};};
   const printed:string[]=[],original={info:console.info,warn:console.warn,error:console.error,log:console.log};
   for(const level of ['info','warn','error','log'] as const)console[level]=(...args:any[])=>{printed.push(args.map(String).join(' '));};
   state.log=[];
   try{
    assert.deepEqual((await nearest({latitude:31.7987,longitude:34.6521})).body,{area:{publicId:AREA.ashdod,name:'אשדוד'}});
    assert.equal((await nearest({latitude:31.2633,longitude:34.8044})).body.area.publicId,AREA.beerSheva);
    assert.equal((await nearest({latitude:31.5172,longitude:34.5953})).body.area.publicId,AREA.sderot);
    // Tel Aviv is ~34 km from Ashdod: beyond the 25 km limit, so no forced suggestion.
    assert.deepEqual((await nearest({latitude:32.0853,longitude:34.7818})).body,{area:null});
    assert.deepEqual((await nearest({latitude:29.5577,longitude:34.9519})).body,{area:null});
    await db.query('TRUNCATE request_limits');// The 10-per-window limit itself is covered by the next test.
    for(const body of [{},{latitude:'31.8',longitude:'34.6'},{latitude:91,longitude:34},{latitude:31,longitude:181},{latitude:31.8},{latitude:null,longitude:null},{lat:31.8,lng:34.6}]){
     const reply=await nearest(body);assert.equal(reply.status,400,JSON.stringify(body));assert.equal(reply.body.code,'INVALID_COORDINATES');
    }
   }finally{Object.assign(console,original);}
   const persisted=state.log.filter(entry=>/^(INSERT|UPDATE)/i.test(entry.sql)&&!/request_limits/.test(entry.sql));
   assert.deepEqual(persisted,[],'nearest-area lookups write nothing but the anonymous rate-limit counter');
   const coordinates=[31.7987,34.6521,31.2633,34.8044,32.0853];
   assert.ok(!state.log.some(entry=>entry.values.some(value=>coordinates.includes(value))),'coordinates never reach SQL');
   assert.ok(!printed.some(text=>/31\.79|34\.65|32\.08/.test(text)),'coordinates never logged');
   state.log=null;
   // Inactive areas are never suggested.
   await areas.update(AREA.ashdod,{active:false});
   try{assert.notEqual((await nearest({latitude:31.8014,longitude:34.6435})).body.area?.publicId,AREA.ashdod);}
   finally{await areas.update(AREA.ashdod,{active:true});}
  });
  await t.test('nearest area has its own rate limit separate from joins',async()=>{
   for(let i=0;i<10;i++)assert.equal((await post('/api/v1/areas/nearest',{latitude:31.8,longitude:34.64})).status,200);
   assert.equal((await post('/api/v1/areas/nearest',{latitude:31.8,longitude:34.64})).status,429);
   assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod})).status,200,'search budget untouched');
  });
  await t.test('search with no group performs zero writes, repeatedly, and says a join will create it',async()=>{
   state.log=[];
   for(const area of [AREA.ashdod,AREA.ashdod,AREA.ashkelon,AREA.netivot]){
    const result=await find(area);
    assert.equal(result.group,null);assert.equal(result.canCreateOnJoin,true);
   }
   const priced=await service.find({areaPublicId:AREA.ashdod,lines:line()});
   assert.equal(priced.group,null);assert.equal(priced.validatedPledgeAgorot,25000);
   assert.deepEqual(writes(),[],'search must not write');
   assert.ok(!state.log.some(entry=>/FOR UPDATE|^BEGIN/i.test(entry.sql)),'search must not take the coordination lock');
   state.log=null;
   assert.equal(await count('delivery_groups'),0);assert.equal(await count('group_members'),0);
  });
  await t.test('search with an existing group in the area returns it without writing',async()=>{
   const created=await start();
   state.log=[];
   const found=await find();
   assert.equal(found.group.publicId,created.group.publicId);assert.equal(found.canCreateOnJoin,false);assert.equal(found.group.participantCount,1);
   assert.deepEqual(writes(),[]);state.log=null;
  });
  await t.test('first join creates group and member atomically under the lock, inside the selected area',async()=>{
   state.log=[];
   const first=await start();
   assert.equal(first.created,true);assert.equal(first.group.participantCount,1);assert.match(first.memberToken,/^[a-f0-9]{64}$/);
   assert.equal(first.group.areaName,'אשדוד');
   // Expire, resolve area, re-match, create and insert all happen inside one transaction after the coordination lock.
   const at=(pattern:RegExp)=>state.log!.findIndex(entry=>pattern.test(entry.sql));
   const order=[/^BEGIN/,/FOR UPDATE/,/^UPDATE delivery_groups SET status='EXPIRED'/,/^SELECT \* FROM delivery_areas WHERE public_id/,/^SELECT g\.\* FROM delivery_groups/,/^INSERT INTO delivery_groups/,/^INSERT INTO group_members/,/^COMMIT/].map(at);
   assert.ok(order.every(i=>i>=0),'missing step '+order);assert.deepEqual([...order].sort((a,b)=>a-b),order);
   state.log=null;
   const row=(await db.query('SELECT g.area_id,g.anchor_lat,a.public_id FROM delivery_groups g JOIN delivery_areas a ON a.id=g.area_id')).rows[0];
   assert.equal(row.public_id,AREA.ashdod);assert.equal(row.anchor_lat,null);
   const member=(await db.query('SELECT approx_lat,approx_lng FROM group_members')).rows[0];
   assert.equal(member.approx_lat,null);assert.equal(member.approx_lng,null,'area members store no coordinates');
   // A failure after creating the group rolls the group back too: no memberless groups.
   await db.query('TRUNCATE group_members, delivery_groups CASCADE');
   state.failMemberInsert=true;
   await assert.rejects(()=>start(AREA.ashkelon),/injected member insert failure/);
   assert.equal(await count('delivery_groups'),0);assert.equal(await count('group_members'),0);
  });
  await t.test('second join joins the same group; area A never matches area B',async()=>{
   const first=await start(),second=await start();
   assert.equal(second.created,false);assert.equal(second.group.publicId,first.group.publicId);assert.equal(second.group.participantCount,2);
   const other=await start(AREA.ashkelon);
   assert.equal(other.created,true);assert.notEqual(other.group.publicId,first.group.publicId);
   assert.equal((await find(AREA.ashkelon)).group.publicId,other.group.publicId);
   assert.equal((await find(AREA.kiryatGat)).group,null);
   await assert.rejects(()=>service.join(first.group.publicId,{...person(),areaPublicId:AREA.ashkelon,lines:line()}),(e:any)=>e.code==='LOCATION_OUTSIDE_GROUP');
   assert.equal(await count('delivery_groups'),2);
  });
  await t.test('duplicate contact rules apply to area joins and group joins',async()=>{
   const who=person(),first=await start(AREA.ashdod,2,who);
   await assert.rejects(()=>start(AREA.ashdod,2,who),(e:any)=>e.code==='ALREADY_JOINED');
   await assert.rejects(()=>start(AREA.ashdod,2,{email:who.email,phone:'+972509999999'}),(e:any)=>e.code==='ALREADY_JOINED');
   await assert.rejects(()=>service.join(first.group.publicId,{...who,areaPublicId:AREA.ashdod,lines:line()}),(e:any)=>e.code==='ALREADY_JOINED');
   assert.equal(await count('delivery_groups'),1);assert.equal(await count('group_members'),1);
  });
  await t.test('a full group is skipped by area joins and rejected by direct joins',async()=>{
   const first=await start();
   const id=(await db.query('SELECT id FROM delivery_groups')).rows[0].id;
   for(let i=0;i<99;i++)await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,$2,$3,'אשדוד','[]'::jsonb,100,$4)",[id,'bulk'+i+'@example.test','+97250'+String(i).padStart(7,'0'),'bulk-token-'+i]);
   await assert.rejects(()=>service.join(first.group.publicId,{...person(),areaPublicId:AREA.ashdod,lines:line()}),(e:any)=>e.code==='GROUP_FULL');
   assert.equal((await find()).group,null,'full groups are not offered');
   const overflow=await start();
   assert.equal(overflow.created,true);assert.notEqual(overflow.group.publicId,first.group.publicId);
  });
  await t.test('near-simultaneous first joins for one area create one group with two members',async()=>{
   // Both shoppers searched (no group) and finish Shopify validation before either enters the lock.
   assert.equal((await find()).group,null);
   arm();
   const [a,b]=await Promise.all([start(),start()]);
   assert.equal(a.group.publicId,b.group.publicId);
   assert.deepEqual([a.created,b.created].sort(),[false,true]);
   assert.equal(await count('delivery_groups'),1);assert.equal(await count('group_members'),2);
   assert.equal((await service.get(a.group.publicId)).participantCount,2);
   arm();
   const other=await Promise.all([start(AREA.ofakim),start(AREA.ofakim)]);
   assert.equal(other[0].group.publicId,other[1].group.publicId);assert.equal(await count('delivery_groups'),2);
  });
  await t.test('DEPRECATED find-or-create keeps the old client contract while /groups/find stays read-only',async()=>{
   // New search on a miss: null, and no writes to group tables over HTTP.
   state.log=[];
   const miss=await (await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:line()})).json() as any;
   assert.equal(miss.group,null);assert.equal(miss.canCreateOnJoin,true);
   assert.ok(!writes().some(sql=>/delivery_groups|group_members/.test(sql)),'find must not touch group tables');
   state.log=null;assert.equal(await count('delivery_groups'),0);
   // Legacy text naming an area keeps the old shape (non-null group, created on a miss) and lands in that area.
   const response=await post('/api/v1/groups/find-or-create',{location:{areaName:'אשדוד'},lines:line()});
   assert.equal(response.status,200);assert.equal(response.headers.get('deprecation'),'true');
   const old=await response.json() as any;
   assert.deepEqual(Object.keys(old).sort(),['group','validatedPledgeAgorot','withinStandardRadius']);
   assert.match(old.group.publicId,/^[a-f0-9-]{36}$/);assert.equal(old.group.participantCount,0);assert.equal(old.validatedPledgeAgorot,25000);
   assert.ok(!('canCreateOnJoin' in old),'legacy shape must not change');
   assert.equal((await find()).group.publicId,old.group.publicId,'old and new clients converge on the area group');
   // Exact alias spellings reach the same area group; unknown names stay separate legacy text groups.
   assert.equal((await legacy({areaName:'Ashdod'})).group.publicId,old.group.publicId);
   const unknown=await legacy({areaName:'תל אביב'});assert.notEqual(unknown.group.publicId,old.group.publicId);
   // The old client then joins by publicId with free text exactly as before.
   const joined=await post('/api/v1/groups/'+old.group.publicId+'/join',{...person(),location:{areaName:'אשדוד'},lines:line()});
   assert.equal(joined.status,201);const member=await joined.json() as any;
   assert.match(member.memberToken,/^[a-f0-9]{64}$/);assert.equal(member.group.participantCount,1);
   // Legacy coordinate searches keep creating legacy coordinate groups that area searches never return.
   const coordinate=await legacy(place());assert.notEqual(coordinate.group.publicId,old.group.publicId);
   assert.equal((await find()).group.publicId,old.group.publicId);
   // The new join flow is unchanged next to the legacy route.
   const started=await post('/api/v1/groups/join',{...person(),areaPublicId:AREA.ashkelon,lines:line()});
   assert.equal(started.status,201);const fresh=await started.json() as any;
   assert.equal(fresh.created,true);assert.equal(fresh.group.participantCount,1);
   assert.equal((await service.joinArea({...person(),areaPublicId:AREA.ashdod,lines:line()})).group.publicId,old.group.publicId);
  });
  await t.test('legacy coordinate groups keep fixed-anchor anti-chain matching and approximate coordinate privacy',async()=>{
   const first=await legacy(place());
   await service.join(first.group.publicId,{...person(),location:place(31.85,34.64),lines:line(1)});
   const chained=await legacy(place(31.9,34.64));assert.notEqual(chained.group.publicId,first.group.publicId);
   const row=(await db.query('SELECT anchor_lat,center_lat,area_id FROM delivery_groups WHERE public_id=$1',[first.group.publicId])).rows[0];
   assert.equal(row.anchor_lat,31.8);assert.ok(row.center_lat>row.anchor_lat);assert.equal(row.area_id,null);
   const geo=await legacy({areaName:'אשקלון',lat:31.612345,lng:34.554321});
   const anchor=(await db.query('SELECT anchor_lat,anchor_lng FROM delivery_groups WHERE public_id=$1',[geo.group.publicId])).rows[0];
   assert.equal(anchor.anchor_lat,31.61);assert.equal(anchor.anchor_lng,34.55);
   assert.ok(!JSON.stringify(geo).includes('31.61'));
   // Area places never join legacy coordinate groups, and legacy coordinates never join area groups.
   await assert.rejects(()=>service.join(first.group.publicId,{...person(),areaPublicId:AREA.ashdod,lines:line()}),(e:any)=>e.code==='LOCATION_OUTSIDE_GROUP');
   const area=await start();
   await assert.rejects(()=>service.join(area.group.publicId,{...person(),location:place(),lines:line()}),(e:any)=>e.code==='LOCATION_OUTSIDE_GROUP');
  });
  await t.test('duplicate membership and concurrent joins preserve integer totals',async()=>{
   const group=(await start()).group,who=person();
   const attempts=await Promise.allSettled([service.join(group.publicId,{...who,areaPublicId:AREA.ashdod,lines:line()}),service.join(group.publicId,{...who,areaPublicId:AREA.ashdod,lines:line()})]);
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
   const member=await start(AREA.ashdod,4),group=member.group;
   await db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 second'");
   assert.equal((await service.get(group.publicId)).status,'EXPIRED');
   await assert.rejects(()=>service.update(group.publicId,member.memberToken,{lines:line()}),(e:any)=>e.status===409);
   await assert.rejects(()=>service.join(group.publicId,{...person(),areaPublicId:AREA.ashdod,lines:line()}),(e:any)=>e.status===409);
   await assert.rejects(()=>service.approve(group.publicId),(e:any)=>e.status===409);
   assert.equal((await find()).group,null,'expired groups are not offered');
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
   const response=await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:line(),total:1});assert.equal(response.status,200);
   const searched=await response.json() as any;assert.equal(searched.validatedPledgeAgorot,25000);
   assert.equal(searched.group,null);assert.equal(searched.canCreateOnJoin,true);
   const privateContact=person();
   const joined=await post('/api/v1/groups/join',{...privateContact,areaPublicId:AREA.ashdod,areaName:'שדרות',lines:line(),pledged_total_agorot:99999999});
   assert.equal(joined.status,201);const result=await joined.json() as any;assert.equal(result.group.pledgedTotalAgorot,25000);assert.equal(result.created,true);
   assert.equal(result.group.areaName,'אשדוד','client-supplied names are ignored');
   for(const forbidden of [privateContact.email,privateContact.phone,'approx_lat','anchor','snapshot','latitude','34.64'])assert.ok(!JSON.stringify(result).includes(forbidden),forbidden);
   const found=await (await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod})).json() as any;
   assert.equal(found.group.publicId,result.group.publicId);assert.equal(found.canCreateOnJoin,false);
   assert.equal((await post('/api/v1/groups/'+found.group.publicId+'/join',{...person(),areaPublicId:AREA.ashdod,lines:line()})).status,201);
   const publicResponse=await fetch(cfg.origin+'/api/v1/groups/'+found.group.publicId),body=await publicResponse.text();
   for(const forbidden of [privateContact.email,privateContact.phone,'approx_lat','center_lat','snapshot','memberToken','test-private-shopify-token','testing-password'])assert.ok(!body.includes(forbidden),forbidden);
   assert.deepEqual(Object.keys(JSON.parse(body).group).sort(),['areaName','currency','expiresAt','participantCount','pledgedTotalAgorot','progressPercent','publicId','remainingAmountAgorot','status','thresholdAgorot'].sort());
   const areasBody=await (await fetch(cfg.origin+'/api/v1/areas')).text();
   for(const forbidden of ['31.8014','34.6435','latitude','slug'])assert.ok(!areasBody.includes(forbidden),'areas list exposes '+forbidden);
   const update=await post('/api/v1/groups/'+found.group.publicId+'/update-pledge',{lines:line(3)},{Authorization:'Bearer '+result.memberToken});assert.equal(update.status,200);
   mode='network';const failed=await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:line()});
   assert.equal(failed.status,503);assert.ok(!(await failed.text()).includes('upstream-secret'));
  });
  await t.test('origin checks, request limits, body cap and public health',async()=>{
   assert.equal((await fetch(cfg.origin+'/health')).status,200);
   assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/groups/join',{...person(),areaPublicId:AREA.ashdod,lines:line()},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/areas/nearest',{latitude:31.8,longitude:34.64},{Origin:'https://evil.example'})).status,403);
   assert.equal((await post('/api/v1/groups/find-or-create',{location:place()},{Origin:'https://evil.example'})).status,403,'legacy route keeps origin checks');
   assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod,padding:'x'.repeat(30000)})).status,413);
   await db.query('TRUNCATE request_limits');
   for(let i=0;i<20;i++)assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod})).status,200);
   assert.equal((await post('/api/v1/groups/find',{areaPublicId:AREA.ashdod})).status,429);
   assert.equal(await count('delivery_groups'),0,'HTTP searches create no groups');
  });
  const loginAdmin=async()=>{
   const login=await fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password:cfg.password})});
   const cookie=login.headers.get('set-cookie')!.split(';')[0],page=await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   return {cookie,page,csrf:page.match(/name="csrf" value="([^"]+)"/)![1]};
  };
  await t.test('admin login, CSRF, approval gate, freeze after approval and logout',async()=>{
   assert.equal((await fetch(cfg.origin+'/admin/api/groups')).status,401);
   assert.match(await (await fetch(cfg.origin+'/admin')).text(),/name="password"/);
   const login=(password:string)=>fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password})});
   assert.equal((await login('wrong')).status,401);
   const authenticated=await login(cfg.password);assert.equal(authenticated.status,303);
   const cookieHeader=authenticated.headers.get('set-cookie')!;assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/SameSite=Strict/i);
   const cookie=cookieHeader.split(';')[0],page=await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   const csrf=page.match(/name="csrf" value="([^"]+)"/)![1];
   const group=(await start(AREA.ashdod,1)).group;
   const approve=(token=csrf)=>post('/admin/api/groups/'+group.publicId+'/approve',{},{Cookie:cookie,'X-CSRF-Token':token});
   assert.equal((await approve('bad')).status,403);assert.equal((await approve()).status,409);
   const member=await service.join(group.publicId,{...person(),areaPublicId:AREA.ashdod,lines:line(4)});
   const approved=await approve();assert.equal(approved.status,200);assert.equal((await approved.json() as any).group.status,'APPROVED');
   assert.equal((await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).status,200);
   await assert.rejects(()=>service.update(group.publicId,member.memberToken,{lines:line()}),(e:any)=>e.status===409);
   assert.equal((await post('/admin/logout',{},{Cookie:cookie,'X-CSRF-Token':csrf})).status,303);
   assert.equal((await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).status,401);
  });
  await t.test('admin area management: create, update, deactivate, with auth, Origin and CSRF',async()=>{
   // Unauthenticated and forged requests are blocked before any change.
   assert.equal((await fetch(cfg.origin+'/admin/api/areas')).status,401);
   assert.equal((await post('/admin/api/areas',{name:'דימונה',latitude:31.07,longitude:35.03})).status,401);
   const {cookie,page,csrf}=await loginAdmin();
   assert.match(page,/אזורי משלוח/);assert.match(page,/action="\/admin\/areas"/);
   assert.equal((await post('/admin/api/areas',{name:'דימונה',latitude:31.07,longitude:35.03},{Cookie:cookie,'X-CSRF-Token':'bad'})).status,403);
   assert.equal((await post('/admin/api/areas',{name:'דימונה',latitude:31.07,longitude:35.03},{Cookie:cookie,'X-CSRF-Token':csrf,Origin:'https://evil.example'})).status,403);
   assert.equal((await fetch(cfg.origin+'/admin/areas',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({name:'דימונה',latitude:'31.07',longitude:'35.03'})})).status,403,'form without csrf');
   assert.ok(!(await publicAreas()).some(area=>area.name==='דימונה'));
   // JSON create.
   const created=await post('/admin/api/areas',{name:'דימונה',latitude:31.0700,longitude:35.0300,sortOrder:80},{Cookie:cookie,'X-CSRF-Token':csrf});
   assert.equal(created.status,201);const area=((await created.json()) as any).area;
   assert.equal(area.name,'דימונה');assert.equal(area.active,true);assert.equal(area.sortOrder,80);
   assert.equal((await publicAreas()).at(-1)!.name,'דימונה');
   assert.equal((await post('/admin/api/areas',{name:' דימונה ',latitude:31,longitude:35},{Cookie:cookie,'X-CSRF-Token':csrf})).status,409,'duplicate name');
   for(const bad of [{name:'x',latitude:31,longitude:35},{name:'ירוחם',latitude:91,longitude:35},{name:'ירוחם',latitude:'abc',longitude:35},{name:'ירוחם',latitude:31,longitude:35,sortOrder:-1},{name:'ירוחם',latitude:31,longitude:35,active:'yes'}])
    assert.equal((await post('/admin/api/areas',bad,{Cookie:cookie,'X-CSRF-Token':csrf})).status,400,JSON.stringify(bad));
   // JSON update: rename, recenter and reorder; the slug (grouping key) stays stable.
   const updated=((await (await post('/admin/api/areas/'+area.publicId,{name:'דימונה והסביבה',latitude:31.0688,longitude:35.0335,sortOrder:5},{Cookie:cookie,'X-CSRF-Token':csrf})).json()) as any).area;
   assert.equal(updated.name,'דימונה והסביבה');assert.equal(updated.slug,'דימונה');assert.equal(updated.latitude,31.0688);
   assert.equal((await publicAreas())[0].name,'דימונה והסביבה','sort order applied');
   assert.equal(((await (await post('/api/v1/areas/nearest',{latitude:31.07,longitude:35.03})).json()) as any).area.publicId,area.publicId);
   // Groups work in a merchant-created area.
   const member=await start(area.publicId);assert.equal(member.group.areaName,'דימונה והסביבה');
   // HTML form deactivation (unchecked checkbox) redirects and hides the area; its group stays readable.
   const form=await fetch(cfg.origin+'/admin/areas/'+area.publicId,{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,name:'דימונה והסביבה',latitude:'31.0688',longitude:'35.0335',sortOrder:'5'})});
   assert.equal(form.status,303);
   assert.ok(!(await publicAreas()).some(item=>item.publicId===area.publicId));
   assert.equal(((await (await fetch(cfg.origin+'/admin/api/areas',{headers:{Cookie:cookie}})).json()) as any).areas.find((item:any)=>item.publicId===area.publicId).active,false);
   assert.equal((await service.get(member.group.publicId)).participantCount,1);
   assert.match(await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text(),/דימונה והסביבה \(לא פעיל\)/);
   assert.equal((await post('/admin/api/areas/00000000-0000-4000-8000-000000000000',{name:'אין'},{Cookie:cookie,'X-CSRF-Token':csrf})).status,404);
   // HTML form create with an unchecked checkbox creates an inactive area.
   assert.equal((await fetch(cfg.origin+'/admin/areas',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,name:'ירוחם',latitude:'30.987',longitude:'34.931',sortOrder:'90'})})).status,303);
   assert.ok(!(await publicAreas()).some(item=>item.name==='ירוחם'));
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
   await state.engine.close();state.engine=new PGlite(dir);
   assert.equal((await service.get(group.publicId)).participantCount,1);
   assert.equal((await service.update(group.publicId,member.memberToken,{lines:line(3)})).group.pledgedTotalAgorot,37500);
  });
 }finally{
  await new Promise<void>(r=>server.close(()=>r()));await state.engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-group-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
// Upgrade path: a database that already ran 001 with legacy groups, then receives 002.
test('Delivery-areas migration maps only exact text-only legacy groups and rewrites nothing',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-group-db-'));const {state,db}=harness(dir);
 try{
  await db.query(await readFile(new URL('../migrations/001_initial.sql',import.meta.url),'utf8'));
  await db.query('CREATE TABLE schema_migrations (name text PRIMARY KEY)');
  await db.query("INSERT INTO schema_migrations(name) VALUES('001_initial.sql')");
  const insert=(publicId:string,name:string,key:string,lat:number|null,lng:number|null)=>db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,anchor_lat,anchor_lng,center_lat,center_lng,threshold_agorot,pledged_total_agorot,expires_at) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$4,$5,50000,12500,NOW()+INTERVAL '3 days')",[publicId,name,key,lat,lng]);
  const ids={kiryat:'11111111-0000-4000-8000-000000000001',english:'11111111-0000-4000-8000-000000000002',unknown:'11111111-0000-4000-8000-000000000003',coordinates:'11111111-0000-4000-8000-000000000004',near:'11111111-0000-4000-8000-000000000005'};
  await insert(ids.kiryat,'קרית גת','קרית גת',null,null);
  await insert(ids.english,'Ashdod','ashdod',null,null);
  await insert(ids.unknown,'תל אביב','תל אביב',null,null);
  await insert(ids.coordinates,'אשדוד','אשדוד',31.8,34.64);
  await insert(ids.near,'באר-שבע הצפונית','באר שבע הצפונית',null,null);
  const groupId=(await db.query('SELECT id FROM delivery_groups WHERE public_id=$1',[ids.kiryat])).rows[0].id;
  await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,'legacy@example.test','+972501111111','קרית גת','[]'::jsonb,12500,'legacy-token')",[groupId]);
  const before=(await db.query('SELECT public_id,area_name,locality_key,anchor_lat,status,pledged_total_agorot FROM delivery_groups ORDER BY public_id')).rows;
  await migrate(db);await migrate(db);
  const mapped=Object.fromEntries((await db.query('SELECT g.public_id,a.public_id AS area FROM delivery_groups g LEFT JOIN delivery_areas a ON a.id=g.area_id')).rows.map((row:any)=>[row.public_id,row.area]));
  assert.equal(mapped[ids.kiryat],AREA.kiryatGat,'exact alias spelling');
  assert.equal(mapped[ids.english],AREA.ashdod,'exact English alias');
  assert.equal(mapped[ids.unknown],null,'no alias: stays legacy');
  assert.equal(mapped[ids.coordinates],null,'coordinate groups stay legacy');
  assert.equal(mapped[ids.near],null,'no fuzzy or partial matching');
  const after=(await db.query('SELECT public_id,area_name,locality_key,anchor_lat,status,pledged_total_agorot FROM delivery_groups ORDER BY public_id')).rows;
  assert.deepEqual(after,before,'names, keys, coordinates, status and totals unchanged');
  assert.equal(Number((await db.query('SELECT COUNT(*)::int AS n FROM group_members')).rows[0].n),1);
  // Mapped groups join area matching; unmapped groups stay readable and joinable through legacy paths.
  const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'});
  const validator={validate:async()=>({total:12500n,snapshot:[{variantId:'gid://shopify/ProductVariant/1',quantity:1,unitAgorot:'12500'}]})};
  const service=new Groups(db,cfg,validator);
  assert.equal((await service.find({areaPublicId:AREA.kiryatGat})).group.publicId,ids.kiryat);
  assert.equal((await service.find({areaPublicId:AREA.ashdod})).group.publicId,ids.english,'coordinate legacy group is never offered to area search');
  for(const id of Object.values(ids))assert.equal((await service.get(id)).publicId,id);
  const joined=await service.join(ids.unknown,{email:'later@example.test',phone:'+972502222222',location:{areaName:'תל אביב'},lines:[{variantId:'1',quantity:1}]});
  assert.equal(joined.group.participantCount,1);
 }finally{
  await state.engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-group-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
