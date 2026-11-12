// Admin dashboard: authentication, privacy, metrics, filters, pagination, details, CSV, audit and logging.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture,AREA} from './admin-fixture.js';
import {csv,israelMidnight,israelToday} from '../src/admin-data.js';
import {safeNext} from '../src/auth.js';

test('Admin dashboard service',{timeout:180000},async t=>{
 const f=await adminFixture();
 // Capture everything the service logs during the run: nothing sensitive may appear.
 const logged:string[]=[];const originals={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const level of ['log','info','warn','error'] as const)console[level]=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
 try{
  const ids=await f.seed();
  const get=(path:string,cookie='')=>fetch(f.cfg.origin+path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}});
  const json=async(path:string,cookie:string)=>{const r=await get(path,cookie);assert.equal(r.status,200,path);return r.json() as Promise<any>;};
  const {cookie,csrf}=await f.login();
  assert.ok(cookie&&csrf,'logged in');

  await t.test('unauthenticated: JSON API 401, pages redirect to login, exports never leak data',async()=>{
   for(const path of ['/admin/api/dashboard','/admin/api/groups','/admin/api/groups/'+ids.ashdod,'/admin/api/groups/'+ids.ashdod+'/members','/admin/api/audit']){
    const r=await get(path);assert.equal(r.status,401,path);assert.ok(!(await r.text()).includes('@example.test'));
   }
   for(const path of ['/admin/groups/'+ids.ashdod,'/admin/groups/'+ids.ashdod+'/export.csv','/admin/groups/'+ids.ashdod+'/export-lines.csv','/admin/areas','/admin/audit']){
    const r=await get(path);assert.equal(r.status,303,path);
    assert.equal(r.headers.get('location'),'/admin?expired=1&next='+encodeURIComponent(path));
    assert.ok(!(await r.text()).includes('@example.test'),path);
   }
   const login=await get('/admin?expired=1');const page=await login.text();
   assert.match(page,/name="password"/);assert.match(page,/פג תוקף ההתחברות/);assert.ok(!page.includes('@example.test'));
   // Forged writes without a session go nowhere.
   const approve=await fetch(f.cfg.origin+'/admin/groups/'+ids.reached+'/approve',{method:'POST',redirect:'manual',headers:{Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
   assert.equal(approve.status,303);assert.equal((await json('/admin/api/groups/'+ids.reached,cookie)).group.status,'THRESHOLD_REACHED');
  });

  await t.test('admin responses: noindex, no-store and a same-origin-only CSP; the public API keeps its own policy',async()=>{
   for(const path of ['/admin','/admin/groups/'+ids.ashdod,'/admin/api/dashboard','/admin/app.js']){
    const r=await get(path,cookie);
    assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow',path);assert.equal(r.headers.get('cache-control'),'no-store',path);
    assert.match(r.headers.get('content-security-policy')!,/script-src 'self'; style-src 'self'/,path);
   }
   const login=await get('/admin');assert.equal(login.headers.get('x-robots-tag'),'noindex, nofollow');
   assert.match((await get('/api/v1/areas')).headers.get('content-security-policy')!,/script-src 'none'/);
   const page=await(await get('/admin',cookie)).text();
   assert.doesNotMatch(page,/<script(?![^>]*src="\/admin\/app\.js")/,'no inline scripts');assert.doesNotMatch(page,/\sstyle="/,'no inline styles');
  });

  await t.test('login: generic failure, safe next redirect, rate limit, session cookie flags',async()=>{
   const bad=await f.login('wrong-password');
   assert.equal(bad.response.status,401);const body=await bad.response.text();
   assert.match(body,/שם המשתמש או הסיסמה אינם נכונים/);assert.ok(!body.includes('wrong-password'));assert.equal(bad.cookie,'');
   const unknownUser=await fetch(f.cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'nobody',password:f.cfg.password})});
   assert.equal((await unknownUser.text()).replace(/value="[^"]*"/g,''),body.replace(/value="[^"]*"/g,''),'same response for an unknown username');
   const next=await f.login(f.cfg.password,'/admin/groups/'+ids.ashdod);
   assert.equal(next.response.headers.get('location'),'/admin/groups/'+ids.ashdod);
   assert.match(next.response.headers.get('set-cookie')!,/HttpOnly/);assert.match(next.response.headers.get('set-cookie')!,/SameSite=Strict/i);assert.match(next.response.headers.get('set-cookie')!,/Max-Age=28800/);
   for(const evil of ['//evil.example','https://evil.example','/admin//evil','/administrator','/admin\\evil','javascript:alert(1)'])assert.equal(safeNext(evil),'/admin',evil);
   assert.equal(safeNext('/admin/groups/x?page=2'),'/admin/groups/x?page=2');
   await f.db.query('TRUNCATE request_limits');
   let last=0;for(let i=0;i<11;i++)last=(await f.login('wrong-password')).response.status;
   assert.equal(last,429,'the 11th attempt within 15 minutes is refused');
   const limited=await f.login();assert.equal(limited.response.status,429,'even the right password while limited');
   await f.db.query('TRUNCATE request_limits');
  });

  await t.test('dashboard metrics follow the real statuses and Israel calendar days',async()=>{
   const d=(await json('/admin/api/dashboard',cookie)).dashboard;
   // Active = OPEN/THRESHOLD_REACHED: Ashdod (open), Beer Sheva (reached), legacy (open). Sderot expired, Ashkelon approved.
   assert.deepEqual([d.activeGroups,d.reachedGroups,d.approvedGroups,d.expiredGroups,d.allGroups],[3,1,1,1,5]);
   // Pledged members in active groups: Ashdod 2 (one withdrew), Beer Sheva 1, legacy 1; distinct by email.
   assert.deepEqual([d.activeCustomers,d.activePledges],[4,4]);
   assert.equal(d.activePledgedAgorot,37500+62500+12500);
   assert.equal(d.openedToday,3,'Ashdod, Beer Sheva and the legacy group were created today');
   assert.ok(d.openedThisWeek>=3&&d.openedThisWeek<=4,'the approved group was created 3 days ago');
   const {dayStart,weekStart}=israelToday(new Date('2026-11-12T10:00:00Z'));
   assert.equal(dayStart.toISOString(),'2026-11-11T22:00:00.000Z','winter: UTC+2');assert.equal(weekStart.toISOString(),'2026-11-07T22:00:00.000Z','Sunday');
   assert.equal(israelMidnight(2026,7,1).toISOString(),'2026-06-30T21:00:00.000Z','summer: UTC+3');
  });

  await t.test('groups list: pagination with limits, sorting, filters and search run on the server',async()=>{
   const all=await json('/admin/api/groups?pageSize=5',cookie);
   assert.deepEqual(all.pagination,{page:1,pageSize:5,total:5,pageCount:1});
   assert.deepEqual(Object.keys(all.groups[0]).sort(),['active','activeMembers','areaName','areaPublicId','completedAt','completedBy','createdAt','expiresAt','legacy','operationalStatus','pledgedTotalAgorot','progressPercent','publicId','remainingAgorot','shortId','status','thresholdAgorot','totalMembers','updatedAt']);
   assert.ok(!JSON.stringify(all).includes('@example.test'),'no contact details in the list');
   assert.equal((await json('/admin/api/groups?pageSize=1000',cookie)).pagination.pageSize,100,'maximum page size');
   const small=await json('/admin/api/groups?pageSize=5&page=2',cookie);assert.equal(small.groups.length,0);assert.equal(small.pagination.page,2);
   const byPledge=await json('/admin/api/groups?sort=pledged&dir=asc',cookie);
   assert.deepEqual(byPledge.groups.map((g:any)=>g.pledgedTotalAgorot),[...byPledge.groups.map((g:any)=>g.pledgedTotalAgorot)].sort((a:number,b:number)=>a-b));
   const ids_=(r:any)=>r.groups.map((g:any)=>g.publicId).sort();
   assert.deepEqual(ids_(await json('/admin/api/groups?status=THRESHOLD_REACHED',cookie)),[ids.reached]);
   assert.deepEqual(ids_(await json('/admin/api/groups?state=closed',cookie)),[ids.approved,ids.expired].sort());
   assert.deepEqual(ids_(await json('/admin/api/groups?area='+AREA.ashdod,cookie)),[ids.ashdod]);
   assert.deepEqual(ids_(await json('/admin/api/groups?area=none',cookie)),[ids.legacy]);
   const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jerusalem'}).format(new Date());
   assert.equal((await json('/admin/api/groups?from='+today,cookie)).pagination.total,3,'opened today');
   assert.deepEqual(ids_(await json('/admin/api/groups?to=2000-01-01',cookie)),[]);
   // Search: group id prefix, email (case-insensitive, partial), phone in local or international form.
   assert.deepEqual(ids_(await json('/admin/api/groups?q='+ids.reached.slice(0,8),cookie)),[ids.reached]);
   assert.deepEqual(ids_(await json('/admin/api/groups?q=BIG.buyer',cookie)),[ids.reached]);
   assert.deepEqual(ids_(await json('/admin/api/groups?q=050-123',cookie)),[ids.ashdod]);
   assert.deepEqual(ids_(await json('/admin/api/groups?q=%2B972521112233',cookie)),[ids.reached]);
   assert.deepEqual(ids_(await json('/admin/api/groups?q=leaving%40',cookie)),[ids.ashdod],'withdrawn members are searchable too');
   assert.deepEqual(ids_(await json('/admin/api/groups?q=%25',cookie)),[],'LIKE wildcards are literal');
   assert.equal((await json('/admin/api/groups?q=nothing-matches',cookie)).groups.length,0);
   for(const bad of ['status=PAID','state=maybe','area=not-a-uuid','from=12/11/2026','sort=x;DROP'])
    assert.ok([200,400].includes((await get('/admin/api/groups?'+bad,cookie)).status),bad);
   assert.equal((await get('/admin/api/groups?status=PAID',cookie)).status,400);
   const html=await(await get('/admin?q=nothing-matches',cookie)).text();
   assert.match(html,/לא נמצאו קבוצות שמתאימות לחיפוש/);
  });

  await t.test('group details, members with filters and pagination, member details with one batched product lookup',async()=>{
   const group=(await json('/admin/api/groups/'+ids.ashdod,cookie)).group;
   assert.deepEqual([group.areaName,group.status,group.activeMembers,group.totalMembers,group.withdrawnMembers,group.pledgedTotalAgorot,group.thresholdAgorot,group.progressPercent],['אשדוד','OPEN',2,3,1,37500,50000,75]);
   const members=await json('/admin/api/groups/'+ids.ashdod+'/members',cookie);
   assert.equal(members.members.length,3);assert.deepEqual(Object.keys(members.members[0]).sort(),['cartLines','createdAt','email','id','phone','pledgedTotalAgorot','status','updatedAt','withdrawnAt','withdrawnBy']);
   assert.equal(members.members[0].email,'dana@example.test');assert.equal(members.members[0].phone,'+972501234567');assert.equal(members.members[0].cartLines,2);
   assert.deepEqual((await json('/admin/api/groups/'+ids.ashdod+'/members?memberStatus=WITHDRAWN',cookie)).members.map((m:any)=>m.email),['leaving@example.test']);
   assert.deepEqual((await json('/admin/api/groups/'+ids.ashdod+'/members?pageSize=5&page=1',cookie)).pagination,{page:1,pageSize:5,total:3,pageCount:1});
   // Member details: titles and today's price from ONE Shopify request; stored prices and pledge unchanged.
   f.shopify.prices['1']='150.00';const before=f.shopify.requests;
   const detail=(await json('/admin/api/groups/'+ids.ashdod+'/members/'+members.members[0].id,cookie)).member;
   assert.equal(f.shopify.requests-before,1,'one batched request for all lines');
   assert.equal(detail.pledgedTotalAgorot,25000);assert.equal(detail.snapshotTotalAgorot,25000);assert.equal(detail.productLookup,'OK');
   assert.deepEqual(detail.lines.map((l:any)=>[l.variantId,l.title,l.quantity,l.storedUnitAgorot,l.storedLineAgorot,l.currentUnitAgorot]),[['1','מוצר 1',1,12500,12500,15000],['2','מוצר 2',1,12500,12500,12500]]);
   const page=await(await get('/admin/groups/'+ids.ashdod+'/members/'+members.members[0].id,cookie)).text();
   assert.match(page,/סכום התחייבות שנשמר/);assert.match(page,/מחיר נוכחי בשופיפיי/);assert.match(page,/השתנה/);
   assert.match(page,/href="tel:\+972501234567"/);assert.match(page,/href="https:\/\/wa\.me\/972501234567"/);assert.match(page,/href="mailto:dana@example\.test"/);
   f.shopify.mode='down';
   const offline=(await json('/admin/api/groups/'+ids.ashdod+'/members/'+members.members[0].id,cookie)).member;
   assert.equal(offline.productLookup,'UNAVAILABLE');assert.equal(offline.lines[0].title,null);assert.equal(offline.lines[0].storedUnitAgorot,12500);
   f.shopify.mode='ok';f.shopify.prices={};
   // The members table makes no Shopify request at all (no N+1).
   const listed=f.shopify.requests;await get('/admin/groups/'+ids.ashdod,cookie);assert.equal(f.shopify.requests,listed);
   // Unknown ids: 404 HTML page without internals.
   const missing=await get('/admin/groups/00000000-0000-4000-8000-000000000000',cookie);assert.equal(missing.status,404);
   const text=await missing.text();assert.match(text,/לא נמצא/);assert.doesNotMatch(text,/Error|at \w+ \(|SELECT/);
   assert.equal((await get('/admin/groups/'+ids.ashdod+'/members/00000000-0000-4000-8000-000000000000',cookie)).status,404);
   assert.equal((await get('/admin/groups/'+ids.ashdod+'/members/'+(await json('/admin/api/groups/'+ids.reached+'/members',cookie)).members[0].id,cookie)).status,404,'a member of another group');
  });

  await t.test('CSV exports: authenticated, UTF-8 with BOM, formula injection neutralised, audited',async()=>{
   const r=await get('/admin/groups/'+ids.legacy+'/export.csv',cookie);
   assert.equal(r.status,200);assert.match(r.headers.get('content-type')!,/text\/csv; charset=utf-8/);assert.match(r.headers.get('content-disposition')!,/attachment; filename="group-11111111-members.csv"/);
   const bytes=new Uint8Array(await r.arrayBuffer());assert.deepEqual([...bytes.slice(0,3)],[0xef,0xbb,0xbf],'BOM');
   const body=new TextDecoder().decode(bytes.slice(3));
   const [header,row]=body.trim().split('\r\n');
   assert.equal(header,'"אזור","מזהה קבוצה","סטטוס קבוצה","אימייל","טלפון","סטטוס לקוח","סכום התחייבות (₪)","שורות בסל","הצטרפות","עדכון אחרון"');
   assert.match(row,/^"תל אביב","11111111-2222-4333-8444-555555555555","OPEN","'=HYPERLINK\(""http:\/\/evil\.example"",""x""\)","'\+972509999999","PLEDGED","125\.00","1",/);
   const lines=new TextDecoder().decode(new Uint8Array(await(await get('/admin/groups/'+ids.ashdod+'/export-lines.csv',cookie)).arrayBuffer()).slice(3)).trim().split('\r\n');
   assert.equal(lines.length,1+3,'one row per stored cart line (the withdrawn member has none)');
   assert.match(lines[1],/"dana@example\.test","'\+972501234567","PLEDGED","1","1","125\.00","125\.00"/);
   assert.equal(csv([['-1','@x','+1','=1','\tx','ok','plain "q"']]),'﻿"\'-1","\'@x","\'+1","\'=1","\'\tx","ok","plain ""q"""\r\n');
   const audit=(await json('/admin/api/audit',cookie)).events.filter((e:any)=>e.action==='group.export');
   assert.deepEqual(audit.slice(0,2).map((e:any)=>[e.target,e.detail,e.result]),[[ids.ashdod,'cart-lines','OK'],[ids.legacy,'members','OK']]);
  });

  await t.test('approval: explicit confirmation, CSRF, audited success and denial; nothing else is mutable',async()=>{
   const form=(body:Record<string,string>,extra:Record<string,string>={})=>fetch(f.cfg.origin+'/admin/groups/'+ids.reached+'/approve',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams(body)});
   assert.equal((await form({csrf:'bad',confirm:'yes'})).status,403);
   const unconfirmed=await form({csrf});assert.equal(unconfirmed.status,303);assert.match(unconfirmed.headers.get('location')!,/error=confirm/);
   assert.equal((await json('/admin/api/groups/'+ids.reached,cookie)).group.status,'THRESHOLD_REACHED');
   assert.match(await(await get('/admin/groups/'+ids.reached,cookie)).text(),/בדקתי את הקבוצה ואני מאשר\/ת אותה/);
   const ok=await form({csrf,confirm:'yes'});assert.match(ok.headers.get('location')!,/notice=approved/);
   assert.equal((await json('/admin/api/groups/'+ids.reached,cookie)).group.status,'APPROVED');
   const again=await form({csrf,confirm:'yes'});assert.match(again.headers.get('location')!,/error=APPROVAL_NOT_ALLOWED/);
   const events=(await json('/admin/api/audit',cookie)).events.filter((e:any)=>e.action==='group.approve').slice(0,2);
   assert.deepEqual(events.map((e:any)=>[e.result,e.detail,e.target]),[['DENIED','APPROVAL_NOT_ALLOWED',ids.reached],['OK',null,ids.reached]]);
   assert.match(events[0].actor,/^session:[a-f0-9]{12}$/);
   // No delete/edit routes exist for groups or members.
   for(const [method,path] of [['POST','/admin/api/groups/'+ids.ashdod+'/delete'],['DELETE','/admin/api/groups/'+ids.ashdod],['POST','/admin/api/groups/'+ids.ashdod+'/members']])
    assert.equal((await fetch(f.cfg.origin+path,{method,headers:{Cookie:cookie,Origin:f.cfg.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'})).status,404,method+' '+path);
  });

  await t.test('audit log holds safe metadata only; the audit page renders it',async()=>{
   const rows=(await f.db.query('SELECT * FROM admin_audit')).rows;
   assert.ok(rows.some((r:any)=>r.action==='login'&&r.result==='FAILED'&&r.actor==='anonymous'));
   const dump=JSON.stringify(rows);
   for(const secret of ['@example.test','+972',f.cfg.password,'wrong-password',cookie.split('=')[1],csrf])assert.ok(!dump.includes(secret),'audit leaks '+secret.slice(0,6));
   const page=await(await get('/admin/audit',cookie)).text();assert.match(page,/יומן פעולות ניהול/);assert.match(page,/אישור קבוצה/);
  });

  await t.test('public API never returns customer contact details',async()=>{
   const responses=[await get('/api/v1/groups/'+ids.ashdod),await get('/api/v1/areas')];
   for(const r of responses){const text=await r.text();assert.ok(!/@example\.test|\+972|dana|leaving/i.test(text),text.slice(0,80));}
   const member=await fetch(f.cfg.origin+'/api/v1/groups/'+ids.ashdod+'/member',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json',Authorization:'Bearer '+ids.ashdodToken},body:'{}'});
   assert.equal(member.status,200);assert.ok(!/@example\.test|\+972/.test(await member.text()));
  });

  await t.test('session expiry and logout end access; logout clears cached admin pages',async()=>{
   const second=await f.login();
   await f.db.query("UPDATE admin_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash<>''");
   assert.equal((await get('/admin/api/dashboard',second.cookie)).status,401);
   assert.equal((await get('/admin/groups/'+ids.ashdod,second.cookie)).status,303);
   const third=await f.login();
   const out=await fetch(f.cfg.origin+'/admin/logout',{method:'POST',redirect:'manual',headers:{Cookie:third.cookie,Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:third.csrf})});
   assert.equal(out.status,303);assert.equal(out.headers.get('clear-site-data'),'"cache"');assert.match(out.headers.get('set-cookie')!,/group_admin=;/);
   assert.equal((await get('/admin/api/dashboard',third.cookie)).status,401);
   const back=await get('/admin',third.cookie);assert.match(await back.text(),/name="password"/,'the old cookie shows only the login form');
  });

  await t.test('no credentials, tokens or customer data are logged',async()=>{
   const text=logged.join('\n');
   for(const secret of [f.cfg.password,'wrong-password','@example.test','+972',cookie.split('=')[1],ids.ashdodToken])assert.ok(!text.includes(secret),'logged '+secret.slice(0,6));
  });
 }finally{
  Object.assign(console,originals);
  await f.close();
 }
});
