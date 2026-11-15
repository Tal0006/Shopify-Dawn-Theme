// "מערכות האתר": admin-only operations overview. Safe configuration, on-demand lightweight health checks (service
// /health, SELECT 1, storefront HEAD), manual and postponed systems, and manually configured costs per currency.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {opsConfig,systemsView,safeUrl} from '../src/system.js';

const ENV={
 OPS_SHOPIFY_ADMIN_URL:'https://admin.shopify.com/store/example-store',
 OPS_NEON_CONSOLE_URL:'https://console.neon.tech/app/projects/example-project',
 OPS_GOOGLE_BUSINESS_URL:'https://business.google.com/example',
 OPS_MERCHANT_CENTER_URL:'https://merchants.google.com/example',
 OPS_THEME_NAME:'Fankee live',OPS_THEME_ID:'123456789012',OPS_THEME_REVISION:'2026-11-12+ab875ef',
 RENDER_GIT_COMMIT:'ab875ef0123456789abcdef0123456789abcdef0',
 OPS_RENDER_DASHBOARD_URL:'https://user:secret-pass@dashboard.render.com/',
 OPS_RENDER_SERVICES:JSON.stringify([{name:'reviews-proxy',url:'https://reviews.example.test',healthPath:'/healthz',purpose:'שירות לדוגמה'}]),
 OPS_COSTS:JSON.stringify([
  {service:'Render Group Delivery',amount:7,currency:'USD',system:'render-group-delivery',note:'Starter'},
  {service:'Neon',amount:0,currency:'USD',system:'neon'},
  {service:'Shopify',amount:39,currency:'USD'},
  {service:'Domain',amount:60,currency:'ILS',frequency:'YEARLY'},
  {service:'Broken',amount:-1,currency:'EUR'},
 ]),
 OPS_NOTES:JSON.stringify({shopify:'Theme changes made in Shopify should be pulled before continuing local development.'}),
};

test('Operations page (מערכות האתר)',{timeout:180000},async t=>{
 let clock=Date.parse('2026-11-12T10:00:00Z');
 const modes={storefront:'ok' as 'ok'|'redirect'|'error'|'down'|'hang',extra:'ok' as 'ok'|'down'};
 const external=async(url:string,init?:RequestInit)=>{
  const host=new URL(url).host;
  if(host==='fanakee.com'){
   if(modes.storefront==='down')throw new TypeError('getaddrinfo ENOTFOUND fanakee.com');
   if(modes.storefront==='hang')return new Promise<Response>((_,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true}));
   return new Response(null,{status:modes.storefront==='redirect'?301:modes.storefront==='error'?500:200});
  }
  if(host==='reviews.example.test')return modes.extra==='ok'?new Response('{}'):new Response('nope',{status:503});
  throw new TypeError('unexpected host '+host);
 };
 const f=await adminFixture({env:ENV,external,health:{timeoutMs:300,ttlMs:60000,minRefreshMs:10000,now:()=>clock}});
 const logged:string[]=[];const originals={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const level of ['log','info','warn','error'] as const)console[level]=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
 try{
  const {cookie}=await f.login();
  const get=(path:string,c=cookie)=>fetch(f.cfg.origin+path,{redirect:'manual',headers:c?{Cookie:c}:{}});
  const system=async(query='')=>{const r=await get('/admin/api/system'+query);assert.equal(r.status,200);return r.json() as Promise<any>;};
  const byId=(data:any,id:string)=>[...data.systems,...data.postponed].find((s:any)=>s.id===id);

  await t.test('admin only: 401 for the API, login redirect for the page, no-store',async()=>{
   const api=await get('/admin/api/system','');assert.equal(api.status,401);
   const page=await get('/admin/system','');assert.equal(page.status,303);assert.equal(page.headers.get('location'),'/admin?expired=1&next='+encodeURIComponent('/admin/system'));
   assert.equal(f.outbound.length,0,'no check runs for anonymous requests');
   const r=await get('/admin/api/system');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-robots-tag'),'noindex, nofollow');
  });

  await t.test('statuses come from real checks, or are explicitly manual or postponed',async()=>{
   const data=await system('?refresh=1');
   const status=(id:string)=>byId(data,id).status;
   assert.deepEqual(['render-group-delivery','neon','domain','render-reviews-proxy','group-delivery-admin'].map(status),['OPERATIONAL','OPERATIONAL','OPERATIONAL','OPERATIONAL','OPERATIONAL']);
   for(const id of ['shopify','shopify-theme-editor','theme','github','google-business','merchant-center'])assert.equal(status(id),'MANUAL',id);
   assert.deepEqual(data.postponed.map((s:any)=>[s.id,s.status,s.statusLabel]),[['dynamic-google-reviews','POSTPONED','נדחה'],['group-delivery-payments','POSTPONED','בפיתוח / לא בפרודקשן']]);
   assert.match(byId(data,'dynamic-google-reviews').note,/כפתור ביקורות Google בפוטר נשאר פעיל/);
   assert.match(byId(data,'group-delivery-payments').note,/אין למזג אותו ל־main/);
   const neon=byId(data,'neon');assert.equal(neon.checkKind,'database');assert.equal(neon.check.reason,null);assert.ok(neon.check.lastSuccessAt);
   // Only the service itself, the configured extra service and the storefront were contacted; no Google/GitHub/Render/Neon APIs.
   const hosts=[...new Set(f.outbound.map(c=>new URL(c.url).host))].sort();
   assert.deepEqual(hosts,['127.0.0.1:'+new URL(f.cfg.origin).port,'fanakee.com','reviews.example.test'].sort());
   assert.deepEqual(f.outbound.find(c=>c.url.includes('fanakee'))!.method,'HEAD');
   assert.ok(f.outbound.some(c=>c.url===f.cfg.origin+'/health'));assert.ok(f.outbound.some(c=>c.url==='https://reviews.example.test/healthz'));
   // Details from configuration only.
   const theme=byId(data,'theme').details.map((d:any)=>[d.label,d.value]);
   assert.deepEqual(theme,[['תבנית חיה','Fankee live'],['מזהה תבנית','123456789012'],['גרסת תבנית','2026-11-12+ab875ef'],['תאריך שחרור אחרון','2026-11-12']]);
   const github=byId(data,'github');
   assert.deepEqual(github.details.map((d:any)=>d.value),['Tal0006/Shopify-Dawn-Theme','main','ab875ef']);
   assert.equal(github.details[2].href,'https://github.com/Tal0006/Shopify-Dawn-Theme/commit/ab875ef0123456789abcdef0123456789abcdef0');
   assert.equal(byId(data,'shopify-theme-editor').links[0].url,'https://admin.shopify.com/store/example-store/themes','derived from the configured admin URL');
   assert.equal(byId(data,'shopify').note,'Theme changes made in Shopify should be pulled before continuing local development.');
   assert.equal(byId(data,'render-group-delivery').details[0].value,f.cfg.origin,'the service URL defaults to APP_ORIGIN');
  });

  await t.test('checks are not repeated: cache, shared refresh floor, then a fresh run',async()=>{
   const before=f.outbound.length;
   assert.equal((await system()).cached,true);assert.equal((await system('?refresh=1')).cached,true,'refresh within 10 s reuses the result');
   await Promise.all([get('/admin/system'),get('/admin/api/system')]);
   assert.equal(f.outbound.length,before,'no new outbound requests');
   clock+=11000;const fresh=await system('?refresh=1');assert.equal(fresh.cached,false);assert.ok(f.outbound.length>before);
   const after=f.outbound.length;clock+=30000;await system();assert.equal(f.outbound.length,after,'within the 60 s cache');
   clock+=31000;await system();assert.ok(f.outbound.length>after,'cache expired');
  });

  await t.test('storefront: redirect counts as up; errors, outages and timeouts are reported without raw errors',async()=>{
   const run=async(mode:typeof modes.storefront)=>{modes.storefront=mode;clock+=11000;return byId(await system('?refresh=1'),'domain');};
   assert.equal((await run('redirect')).status,'OPERATIONAL');
   const bad=await run('error');assert.deepEqual([bad.status,bad.check.reason],['DEGRADED','BAD_RESPONSE']);
   const down=await run('down');assert.deepEqual([down.status,down.check.reason,down.check.latencyMs],['OFFLINE','UNREACHABLE',null]);assert.ok(down.check.lastSuccessAt,'last success kept in memory');
   const started=Date.now(),slow=await run('hang');
   assert.deepEqual([slow.status,slow.check.reason],['OFFLINE','TIMEOUT']);assert.ok(Date.now()-started<3000,'short timeout, no retries');
   const page=await(await get('/admin/system')).text();
   assert.match(page,/לא ניתן לבדוק את השירות כרגע \(תם הזמן הקצוב לבדיקה\)\./);assert.match(page,/בדיקה תקינה אחרונה/);
   assert.doesNotMatch(page,/ENOTFOUND|getaddrinfo|AbortError|TimeoutError|TypeError|stack/);
   assert.match(page,/<strong>1 דורשים תשומת לב<\/strong>/,'postponed systems are not counted as problems');
   modes.storefront='ok';
  });

  await t.test('Group Delivery service and Neon failures: degraded, offline and timeout states',async()=>{
   modes.extra='down';clock+=11000;
   let data=await system('?refresh=1');assert.deepEqual([byId(data,'render-reviews-proxy').status,byId(data,'render-reviews-proxy').check.reason],['DEGRADED','BAD_RESPONSE']);
   modes.extra='ok';
   f.faults.selectOne='fail';clock+=11000;data=await system('?refresh=1');
   assert.deepEqual([byId(data,'neon').status,byId(data,'neon').check.reason],['OFFLINE','UNREACHABLE']);
   assert.equal(byId(data,'group-delivery-admin').status,'OFFLINE','derived from service + database');
   assert.match(await(await get('/admin/system')).text(),/לא ניתן להתחבר למסד הנתונים כרגע\./);
   f.faults.selectOne='hang';clock+=11000;data=await system('?refresh=1');
   assert.deepEqual([byId(data,'neon').status,byId(data,'neon').check.reason],['OFFLINE','TIMEOUT']);
   f.faults.selectOne='ok';clock+=11000;data=await system('?refresh=1');assert.equal(byId(data,'neon').status,'OPERATIONAL');
   // The service's own /health: a bad answer and an unreachable service, checked through the same code path.
   const {SystemHealth}=await import('../src/system.js');
   const ok={query:async()=>({rows:[{ok:1}]})};
   const health=(fetcher:any)=>new SystemHealth(ok,{...f.cfg.ops,storefrontCheck:false,renderServices:[f.cfg.ops.renderServices[0]]},()=>'https://svc.example.test',fetcher,{timeoutMs:200});
   const r1=(await health(async()=>new Response('{"status":"starting"}')).results()).results['render-group-delivery'];assert.deepEqual([r1.status,r1.reason],['DEGRADED','BAD_RESPONSE']);
   const r2=(await health(async()=>new Response('',{status:503})).results()).results['render-group-delivery'];assert.deepEqual([r2.status,r2.reason],['DEGRADED','BAD_RESPONSE']);
   const r3=(await health(async()=>{throw new TypeError('ECONNREFUSED');}).results()).results['render-group-delivery'];assert.deepEqual([r3.status,r3.reason],['OFFLINE','UNREACHABLE']);
  });

  await t.test('costs: manual entries only, yearly spread monthly, currencies never mixed, invalid entries dropped',async()=>{
   const data=await system();
   assert.deepEqual(data.costs.entries.map((c:any)=>[c.service,c.amountCents,c.currency,c.frequency,c.monthlyCents]),
    [['Render Group Delivery',700,'USD','MONTHLY',700],['Neon',0,'USD','MONTHLY',0],['Shopify',3900,'USD','MONTHLY',3900],['Domain',6000,'ILS','YEARLY',500]]);
   assert.deepEqual(data.costs.monthlyTotals,{USD:46,ILS:5});
   assert.ok(data.warnings.some((w:string)=>w==='OPS_COSTS: 1 invalid entry ignored (service, amount ≥ 0, currency USD/ILS, frequency MONTHLY/YEARLY).'));
   assert.deepEqual(byId(data,'render-group-delivery').costs.map((c:any)=>c.amountCents),[700]);
   const page=await(await get('/admin/system')).text();
   assert.match(page,/<h2 id="costs-title">עלויות חודשיות<\/h2>/);assert.match(page,/סה"כ עלות חודשית משוערת:/);
   assert.match(page,/<strong data-currency="USD">[^<]*46\.00[^<]*\$ לחודש<\/strong>/);assert.match(page,/<strong data-currency="ILS">[^<]*5\.00[^<]*₪ לחודש<\/strong>/);
   assert.match(page,/<td data-label="עלות" class="num">חינם<\/td>/);assert.match(page,/המטבעות מוצגים בנפרד ואינם מומרים\./);
   // One currency only: one total. Nothing configured: no price shown at all.
   const usd=systemsView(opsConfig({OPS_COSTS:'[{"service":"Render","amount":7,"currency":"USD"}]'}),{results:{},checkedAt:new Date().toISOString(),cached:false},'https://svc.example.test');
   assert.deepEqual(usd.costs.monthlyTotals,{USD:7});
   const none=systemsView(opsConfig({}),{results:{},checkedAt:new Date().toISOString(),cached:false},'https://svc.example.test');
   assert.deepEqual([none.costs.entries,none.costs.monthlyTotals],[[],{}]);
  });

  await t.test('no secrets: credentials, database URL, tokens and rejected values never appear',async()=>{
   const responses=[JSON.stringify(await system()),await(await get('/admin/system')).text()];
   for(const body of responses)for(const secret of [f.cfg.password,f.cfg.secret,f.cfg.databaseUrl,f.cfg.token,'secret-pass','user:','postgresql://',cookie.split('=')[1]])
    assert.ok(!body.includes(secret),'leaks '+secret.slice(0,8));
   const data=await system();
   assert.ok(data.warnings.includes('OPS_RENDER_DASHBOARD_URL: ignored (needs an https URL without credentials).'));
   assert.equal(byId(data,'render-group-delivery').links.some((l:any)=>l.url.includes('dashboard.render.com')),false,'the rejected URL is not used');
   assert.deepEqual(Object.keys(data).sort(),['cached','checkedAt','costs','generatedAt','missing','postponed','quickLinks','systems','warnings']);
   for(const value of ['http://example.com/','javascript:alert(1)','https://u:p@example.com/','ftp://example.com/'])assert.equal(safeUrl(value),null,value);
   assert.equal(safeUrl('http://127.0.0.1:4330/health'),'http://127.0.0.1:4330/health');
  });

  await t.test('page: navigation, quick links in new tabs, missing configuration and postponed section',async()=>{
   const page=await(await get('/admin/system')).text();
   assert.match(page,/<a href="\/admin\/system" aria-current="page">מערכות האתר<\/a>/);
   assert.match(page,/<h1>מערכות האתר<\/h1><p class="muted">ניהול ומעקב אחר השירותים שמפעילים את פאנקי<\/p>/);
   assert.match(page,/<form method="get" action="\/admin\/system" class="sys-refresh"><input type="hidden" name="refresh" value="1"><button class="btn btn--primary">בדיקה מחדש<\/button>/);
   const external=[...page.matchAll(/<a [^>]*href="https?:[^"]+"[^>]*>/g)].map(m=>m[0]);
   assert.ok(external.length>10);for(const a of external)assert.match(a,/target="_blank" rel="noopener noreferrer"/,a);
   for(const label of ['פתיחת Shopify','פתיחת GitHub','פתיחת Neon','פתיחת Google Merchant Center','פתיחת Google Business Profile','פתיחת האתר','ניהול משלוחים קבוצתיים','יומן פעולות'])
    assert.match(page,new RegExp('class="sys-quick"[\\s\\S]*'+label.replace(/[()]/g,'\\$&')),label);
   assert.match(page,/<h2 id="postponed-title" class="sys-section-title">נדחה \/ לא פעיל כרגע<\/h2>/);
   assert.match(page,/<span class="chip chip--sys chip--sys-postponed">בפיתוח \/ לא בפרודקשן<\/span>/);
   // A system without a management link says so; unconfigured settings are listed by name only.
   const bare=systemsView(opsConfig({}),{results:{},checkedAt:new Date().toISOString(),cached:false},'https://svc.example.test');
   assert.deepEqual(bare.systems.find(s=>s.id==='shopify')!.links,[]);
   assert.deepEqual(bare.missing.sort(),['OPS_GOOGLE_BUSINESS_URL','OPS_MERCHANT_CENTER_URL','OPS_NEON_CONSOLE_URL','OPS_SHOPIFY_ADMIN_URL','OPS_SHOPIFY_THEME_EDITOR_URL / OPS_SHOPIFY_ADMIN_URL','OPS_THEME_ID','OPS_THEME_NAME','OPS_THEME_REVISION'].sort());
   assert.equal(bare.systems.find(s=>s.id==='theme')!.details.every(d=>d.value===''),true,'no invented theme values');
   const {systemPage}=await import('../src/system-page.js');
   const html=systemPage({...bare,csrf:'x'});
   assert.match(html,/לא הוגדר קישור ניהול\./);assert.match(html,/<span class="muted">לא הוגדר<\/span>/);assert.match(html,/<code dir="ltr">OPS_SHOPIFY_ADMIN_URL<\/code>/);
   assert.match(html,/לא הוגדרו עלויות\./);
  });

  await t.test('nothing sensitive is logged',async()=>{
   const text=logged.join('\n');
   for(const secret of [f.cfg.password,f.cfg.secret,f.cfg.token,'secret-pass','ENOTFOUND',cookie.split('=')[1]])assert.ok(!text.includes(secret),'logged '+secret.slice(0,6));
  });
 }finally{
  Object.assign(console,originals);
  await f.close();
 }
});
