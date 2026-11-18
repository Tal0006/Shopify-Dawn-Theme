// OPS_COSTS → finance: positive ILS costs are synchronized into OPS-managed recurring charges on every finance read
// (from the 1st of the month of the first sync, no earlier history), changed prospectively, stopped when removed, and
// reactivated without backfill when they come back. Free and non-ILS costs never create expenses. Manual charges are
// never touched. The clock and OPS_COSTS are changed in place to simulate months passing and redeploys.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {Finance,importKeyOf} from '../src/finance.js';
import {opsConfig,financeAgorotOf} from '../src/system.js';

const cost=(service:string,amount:number,currency='ILS',frequency='MONTHLY')=>({service,amount,currency,frequency});
const INITIAL=[cost('Shopify',120),cost('Domain',60,'ILS','YEARLY'),cost('Render Group Delivery',7,'USD'),cost('Neon',0,'USD')];

test('OPS_COSTS synchronization into recurring expenses',{timeout:240000},async t=>{
 let clock=new Date('2026-03-15T10:00:00Z');
 const at=(iso:string)=>{clock=new Date(iso);};
 const f=await adminFixture({env:{OPS_COSTS:JSON.stringify(INITIAL)},now:()=>clock});
 // Simulates editing OPS_COSTS and redeploying: the service reads the same parsed array.
 const setOps=(entries:any[])=>{const parsed=opsConfig({OPS_COSTS:JSON.stringify(entries)}).costs;f.cfg.ops.costs.splice(0,f.cfg.ops.costs.length,...parsed);};
 try{
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const get=(path:string)=>fetch(origin+path,{redirect:'manual',headers:{Cookie:cookie}});
  const api=(method:string,path:string,body?:unknown)=>fetch(origin+path,{method,redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const load=async()=>(await(await get('/admin/api/finance/summary')).json() as any);
  const defs=async()=>(await f.db.query(`SELECT id,description,amount_agorot::text AS a,frequency_months,to_char(start_date,'YYYY-MM-DD') AS s,to_char(effective_from,'YYYY-MM-DD') AS ef,active,deactivated_reason,managed_by,import_key,source
   FROM business_recurring_transactions ORDER BY created_at,id`)).rows;
  const managed=async(name:string)=>(await defs()).find((d:any)=>d.managed_by==='OPS_COSTS'&&d.description===name);
  const rows=async(id:string)=>(await f.db.query(`SELECT to_char(transaction_date,'YYYY-MM-DD') AS d,amount_agorot::text AS a,category FROM business_transactions WHERE recurring_definition_id=$1 ORDER BY transaction_date`,[id])).rows.map((r:any)=>r.d+':'+r.a);
  const count=async(sql:string)=>Number((await f.db.query(sql)).rows[0].n);
  const syncAudits=()=>count("SELECT COUNT(*)::int AS n FROM admin_audit WHERE actor='system:ops-costs'");
  let manualId='';

  await t.test('a manual charge exists before the first sync (it must never be affected)',async()=>{
   const r=await api('POST','/admin/api/finance/transactions',{type:'EXPENSE',recurring:true,frequency:'MONTHLY',amountAgorot:9900,date:'2026-02-01',category:'Shopify',description:'Shopify'});
   assert.equal(r.status,201);manualId=(await r.json() as any).recurring.id;
   assert.deepEqual(await rows(manualId),['2026-02-01:9900','2026-03-01:9900']);
  });

  await t.test('first synchronization: one charge per positive ILS cost, from this month only',async()=>{
   const data=await load();
   const shopify=await managed('Shopify'),domain=await managed('Domain');
   assert.deepEqual([shopify.a,Number(shopify.frequency_months),shopify.s,shopify.source,shopify.import_key],['12000',1,'2026-03-01','SYSTEM',importKeyOf({service:'Shopify',currency:'ILS'})]);
   assert.deepEqual([domain.a,Number(domain.frequency_months),domain.s],['6000',12,'2026-03-01']);
   assert.equal(await count("SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE managed_by='OPS_COSTS'"),2,'USD and free costs create nothing');
   assert.deepEqual(await rows(shopify.id),['2026-03-01:12000'],'no January/February history');
   assert.deepEqual(await rows(domain.id),['2026-03-01:6000']);
   // Totals: the manual ₪99 + Shopify ₪120 + Domain ₪60 recorded in March; the USD cost is never included.
   assert.equal(data.summary.kpis.expenseAgorot,9900+12000+6000);
   assert.deepEqual(data.opsCosts.map((c:any)=>[c.service,c.state]),[['Shopify','SYNCED'],['Domain','SYNCED'],['Render Group Delivery','NOT_COUNTED'],['Neon','FREE']]);
   assert.equal(await syncAudits(),2);
   assert.deepEqual((await f.db.query("SELECT action,detail FROM admin_audit WHERE actor='system:ops-costs' ORDER BY at,id")).rows.map((r:any)=>r.action+':'+r.detail),['finance.recurring_create:OPS_COSTS_SYNC','finance.recurring_create:OPS_COSTS_SYNC']);
  });

  await t.test('repeated and concurrent loads create no duplicate charges, rows or audit entries',async()=>{
   for(let i=0;i<4;i++){await load();await get('/admin/system');await get('/admin/api/finance/transactions');}
   const other=new Finance(f.db,f.cfg.ops.costs,()=>clock);// a second service instance
   await Promise.all([...Array.from({length:8},()=>load()),...Array.from({length:4},()=>get('/admin/system')),...Array.from({length:6},()=>other.record())]);
   assert.equal(await count("SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE managed_by='OPS_COSTS'"),2);
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM business_transactions WHERE recurring_definition_id IS NOT NULL'),4,'manual Feb+Mar, Shopify Mar, Domain Mar');
   assert.equal(await syncAudits(),2,'nothing changed, nothing written');
  });

  await t.test('monthly and yearly costs bill on their own schedule',async()=>{
   at('2026-05-02T10:00:00Z');await load();
   assert.deepEqual(await rows((await managed('Shopify')).id),['2026-03-01:12000','2026-04-01:12000','2026-05-01:12000']);
   assert.deepEqual(await rows((await managed('Domain')).id),['2026-03-01:6000'],'yearly: next billing March 2027');
   const card=(await load()).summary.recurring;
   assert.equal(card.find((r:any)=>r.description==='Domain'&&r.managedBy).nextDate,'2027-03-01');
  });

  await t.test('an OPS amount or frequency change applies to future billing only',async()=>{
   at('2026-05-10T10:00:00Z');
   setOps([cost('Shopify',150),cost('Domain',60,'ILS','MONTHLY'),cost('Render Group Delivery',7,'USD'),cost('Neon',0,'USD')]);
   await load();await load();
   const shopify=await managed('Shopify'),domain=await managed('Domain');
   assert.deepEqual([shopify.a,shopify.ef],['15000','2026-05-10']);
   assert.deepEqual(await rows(shopify.id),['2026-03-01:12000','2026-04-01:12000','2026-05-01:12000'],'recorded rows unchanged');
   assert.equal(Number(domain.frequency_months),1);
   assert.equal(await syncAudits(),4,'one update per changed cost, written once');
   at('2026-06-02T10:00:00Z');await load();
   assert.deepEqual((await rows(shopify.id)).slice(-2),['2026-05-01:12000','2026-06-01:15000']);
   assert.deepEqual(await rows(domain.id),['2026-03-01:6000','2026-06-01:6000'],'monthly from the change on; April/May not backfilled');
  });

  await t.test('OPS-managed charges: amount/frequency/stop belong to OPS_COSTS; descriptive fields stay editable',async()=>{
   const shopify=await managed('Shopify');
   const base={type:'EXPENSE',recurring:true,frequency:'MONTHLY',date:'2026-03-01',category:'Shopify',description:'Shopify'};
   const bad=await api('POST','/admin/api/finance/transactions/'+shopify.id,{...base,amountAgorot:1});
   assert.equal(bad.status,422);assert.match((await bad.json() as any).fields.amount,/OPS_COSTS/);
   assert.equal((await api('POST','/admin/api/finance/transactions/'+shopify.id,{...base,amountAgorot:15000,frequency:'YEARLY'})).status,422);
   const ok=await api('POST','/admin/api/finance/transactions/'+shopify.id,{...base,amountAgorot:15000,category:'תוכנה ושירותים',paymentMethod:'CARD'});
   assert.equal(ok.status,200);
   assert.ok((await f.db.query('SELECT category FROM business_transactions WHERE recurring_definition_id=$1',[shopify.id])).rows.every((r:any)=>r.category==='Shopify'),'recorded rows keep their category');
   const stop=await api('POST','/admin/api/finance/transactions/'+shopify.id+'/delete',{confirm:true});
   assert.equal(stop.status,409);assert.equal((await stop.json() as any).code,'OPS_MANAGED');
   assert.match(await(await get('/admin/system?delete='+shopify.id)).text(),/החיוב מנוהל דרך OPS_COSTS/);
   const edit=await(await get('/admin/system?edit='+shopify.id)).text();
   assert.match(edit,/הוצאת מערכת מ־OPS_COSTS\./);assert.match(edit,/<input id="tx-edit-amount" name="amount" value="150.00"[^>]* readonly>/);
   const page=await(await get('/admin/system')).text();
   assert.equal((page.match(/<span class="tag tag--ops">הוצאת מערכת<\/span> <span dir="ltr">OPS_COSTS<\/span>/g)||[]).length,2,'both synced charges are marked');
   assert.doesNotMatch(page,/<tr data-ops-state="SYNCED">/,'a synced cost is shown once (in חיובים קבועים), not again in the OPS section');
  });

  await t.test('removing a cost from OPS_COSTS stops future billing and keeps history; re-adding resumes without backfill',async()=>{
   at('2026-07-02T10:00:00Z');await load();
   const shopify=await managed('Shopify'),history=await rows(shopify.id);
   assert.equal(history.at(-1),'2026-07-01:15000');
   setOps([cost('Domain',0,'ILS'),cost('Render Group Delivery',7,'USD'),cost('Neon',0,'USD')]);// Shopify removed, Domain now free
   await load();
   const after=await managed('Shopify'),domain=await managed('Domain');
   assert.deepEqual([after.active,after.deactivated_reason],[false,'OPS_SYNC']);
   assert.deepEqual([domain.active,domain.deactivated_reason],[false,'OPS_SYNC'],'a cost that became free stops too');
   at('2026-09-02T10:00:00Z');await load();
   assert.deepEqual(await rows(shopify.id),history,'history kept, nothing new');
   assert.equal((await load()).summary.recurring.find((r:any)=>r.id===shopify.id).status,'INACTIVE');
   // Back in OPS_COSTS: the same charge resumes from today (Aug 1 and Sep 1 are not backfilled).
   setOps([cost('Shopify',150),cost('Render Group Delivery',7,'USD'),cost('Neon',0,'USD')]);
   await load();
   const back=await managed('Shopify');
   assert.deepEqual([back.id,back.active,back.ef],[shopify.id,true,'2026-09-02']);
   at('2026-10-02T10:00:00Z');await load();
   assert.deepEqual((await rows(shopify.id)).slice(-2),['2026-07-01:15000','2026-10-01:15000']);
   assert.equal(await count("SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE managed_by='OPS_COSTS'"),2,'never a second charge for the same cost');
  });

  await t.test('a charge the admin stopped (before OPS management) is not restarted by synchronization',async()=>{
   const domain=await managed('Domain');
   await f.db.query("UPDATE business_recurring_transactions SET deactivated_reason='ADMIN' WHERE id=$1",[domain.id]);
   setOps([cost('Shopify',150),cost('Domain',60,'ILS','YEARLY'),cost('Render Group Delivery',7,'USD'),cost('Neon',0,'USD')]);
   const data=await load();
   assert.equal((await managed('Domain')).active,false);
   assert.equal(data.opsCosts.find((c:any)=>c.service==='Domain').state,'STOPPED');
   assert.match(await(await get('/admin/system')).text(),/<tr data-ops-state="STOPPED">.*Domain.*הופסק ידנית/);
  });

  await t.test('manual charges are never affected; USD and free costs never reach any total',async()=>{
   const manual=(await defs()).find((d:any)=>d.id===manualId);
   assert.deepEqual([manual.managed_by,manual.import_key,manual.active,manual.a],[null,null,true,'9900']);
   assert.equal((await rows(manualId)).length,9,'Feb–Oct, every month, unaffected by any sync');
   const data=await load();
   // Every total equals the sum of actual rows; nothing from the USD or free entries.
   const sql=async(month:string)=>Number((await f.db.query("SELECT COALESCE(SUM(amount_agorot),0)::text AS n FROM business_transactions WHERE type='EXPENSE' AND to_char(transaction_date,'YYYY-MM')=$1",[month])).rows[0].n);
   for(const m of data.summary.chart)assert.equal(m.expenseAgorot,await sql(m.month),m.month);
   assert.equal(await count("SELECT COUNT(*)::int AS n FROM business_transactions WHERE amount_agorot IN (700,0)"),0);
   assert.deepEqual(data.opsCosts.filter((c:any)=>c.currency==='USD').map((c:any)=>c.state),['NOT_COUNTED','FREE']);
  });

  await t.test('no configuration values or secrets reach the finance page',async()=>{
   const page=await(await get('/admin/system')).text();
   for(const secret of [f.cfg.password,f.cfg.secret,f.cfg.token,f.cfg.databaseUrl])assert.ok(!page.includes(secret));
   assert.doesNotMatch(page,/"service":|\[\{/,'no raw OPS_COSTS JSON');
  });
 }finally{await f.close();}
});

// financeAmountIls: a manually maintained ILS amount for a foreign-currency OPS cost. No exchange rate anywhere: the
// provider price is display only, and only financeAmountIls (or an ILS price) reaches the finance page.
test('financeAmountIls parsing: positive, at most 2 decimals, integer agorot, never from text',()=>{
 assert.deepEqual([150,39.9,0.01,7.75,1000000].map(financeAgorotOf),[15000,3990,1,775,100000000]);
 for(const bad of [0,-5,1.234,'150',1e21,Number.NaN,Infinity,1000000.01,null,true,{}])assert.equal(financeAgorotOf(bad as any),null,String(bad));
 const ops=opsConfig({OPS_COSTS:JSON.stringify([{service:'A',amount:2,currency:'USD',financeAmountIls:'oops'},{service:'B',amount:2,currency:'USD',financeAmountIls:-1},{service:'C',amount:2,currency:'USD',financeAmountIls:8.5}])});
 assert.deepEqual(ops.costs.map(c=>[c.service,c.financeAgorot]),[['A',null],['B',null],['C',850]],'invalid values are dropped, the cost stays');
 assert.ok(ops.warnings.includes('OPS_COSTS: financeAmountIls ignored for 2 entries (expected a positive ILS number with at most 2 decimals, up to 1000000).'));
 assert.ok(!ops.warnings.join(' ').includes('oops'),'the rejected value is never repeated');
 const old=opsConfig({OPS_COSTS:JSON.stringify([{service:'D',amount:60,currency:'ILS'}])});
 assert.deepEqual([old.costs[0].financeAgorot,old.warnings],[null,[]],'existing entries need no change');
});

test('Foreign-currency OPS costs with financeAmountIls become OPS-managed ILS expenses',{timeout:240000},async t=>{
 let clock=new Date('2026-03-15T10:00:00Z');
 const at=(iso:string)=>{clock=new Date(iso);};
 const entry=(service:string,amount:number,currency:string,extra:Record<string,unknown>={})=>({service,amount,currency,frequency:'MONTHLY',...extra});
 const base=()=>[
  entry('Shopify',39.9,'USD',{financeAmountIls:150}),
  entry('Sense RTL',7.75,'USD'),
  entry('Domain',20,'USD',{frequency:'YEARLY',financeAmountIls:75}),
  entry('Shipfn',2,'USD',{financeAmountIls:'abc'}),
  entry('Free tool',0,'USD',{financeAmountIls:10}),
  entry('Local host',50,'ILS'),
  entry('Render',7,'USD'),
 ];
 const f=await adminFixture({env:{OPS_COSTS:JSON.stringify(base())},now:()=>clock});
 const setOps=(entries:any[])=>{const parsed=opsConfig({OPS_COSTS:JSON.stringify(entries)}).costs;f.cfg.ops.costs.splice(0,f.cfg.ops.costs.length,...parsed);};
 try{
  // A legacy hand import (old "ייבוא כחיוב קבוע" flow) of the USD Render cost with an ILS amount typed by the admin,
  // as migrations 013/014 leave it: OPS-managed, amount_source MANUAL.
  const renderKey=importKeyOf({service:'Render',currency:'USD'}),legacyId='00000000-0000-4000-8000-0000000000aa';
  await f.db.query(`INSERT INTO business_recurring_transactions(id,amount_agorot,category,description,source,frequency_months,start_date,effective_from,import_key,managed_by,amount_source,created_by,updated_by)
   VALUES($1,2600,'Render','Render','SYSTEM',1,'2026-02-01','2026-02-01',$2,'OPS_COSTS','MANUAL','session:aaaaaaaaaaaa','session:aaaaaaaaaaaa')`,[legacyId,renderKey]);
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const get=(path:string)=>fetch(origin+path,{redirect:'manual',headers:{Cookie:cookie}});
  const api=(method:string,path:string,body?:unknown)=>fetch(origin+path,{method,redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const load=async()=>(await(await get('/admin/api/finance/summary')).json() as any);
  const def=async(name:string)=>(await f.db.query(`SELECT id,amount_agorot::text AS a,frequency_months,to_char(start_date,'YYYY-MM-DD') AS s,to_char(effective_from,'YYYY-MM-DD') AS ef,active,deactivated_reason,amount_source
   FROM business_recurring_transactions WHERE managed_by='OPS_COSTS' AND description=$1`,[name])).rows;
  const one=async(name:string)=>{const d=await def(name);assert.equal(d.length,1,name+': exactly one charge');return d[0];};
  const rows=async(id:string)=>(await f.db.query(`SELECT to_char(transaction_date,'YYYY-MM-DD') AS d,amount_agorot::text AS a FROM business_transactions WHERE recurring_definition_id=$1 ORDER BY transaction_date`,[id])).rows.map((r:any)=>r.d+':'+r.a);
  const count=async(sql:string)=>Number((await f.db.query(sql)).rows[0].n);
  const syncAudits=()=>count("SELECT COUNT(*)::int AS n FROM admin_audit WHERE actor='system:ops-costs'");
  let manualId='';

  await t.test('14. an invalid financeAmountIls is reported safely and the cost is not counted',async()=>{
   assert.ok(f.cfg.ops.warnings.includes('OPS_COSTS: financeAmountIls ignored for 1 entry (expected a positive ILS number with at most 2 decimals, up to 1000000).'));
   const manual=await api('POST','/admin/api/finance/transactions',{type:'EXPENSE',recurring:true,frequency:'MONTHLY',amountAgorot:4000,date:'2026-03-01',category:'Shopify',description:'Shopify'});
   manualId=(await manual.json() as any).recurring.id;
  });

  await t.test('1-2, 5-6, 12-13, 17. first sync: foreign costs with financeAmountIls, ILS price, legacy manual amount; nothing else',async()=>{
   const data=await load();
   const shopify=await one('Shopify'),domain=await one('Domain'),local=await one('Local host'),render=await one('Render');
   assert.deepEqual([shopify.a,Number(shopify.frequency_months),shopify.s,shopify.amount_source],['15000',1,'2026-03-01','OPS_CONFIG'],'₪150 from financeAmountIls, not $39.90');
   assert.deepEqual([domain.a,Number(domain.frequency_months)],['7500',12]);
   assert.deepEqual([local.a,local.amount_source],['5000','OPS_CONFIG'],'ILS cost without financeAmountIls: its own price, as before');
   assert.deepEqual([render.id,render.a,render.amount_source,render.active],[legacyId,'2600','MANUAL',true],'legacy manual amount kept, not duplicated');
   for(const name of ['Sense RTL','Shipfn','Free tool'])assert.equal((await def(name)).length,0,name+' creates no expense');
   assert.deepEqual(await rows(shopify.id),['2026-03-01:15000'],'no history before the first sync');
   assert.deepEqual(await rows(domain.id),['2026-03-01:7500']);
   assert.deepEqual(await rows(legacyId),['2026-02-01:2600','2026-03-01:2600']);
   assert.equal(data.summary.kpis.expenseAgorot,15000+7500+5000+2600+4000,'March: recorded rows only; Sense RTL/Shipfn/free excluded');
   assert.deepEqual(data.opsCosts.map((c:any)=>[c.service,c.state,c.financeAgorot,c.financeSource]),[
    ['Shopify','SYNCED',15000,'FINANCE_AMOUNT'],['Sense RTL','NOT_COUNTED',null,null],['Domain','SYNCED',7500,'FINANCE_AMOUNT'],['Shipfn','NOT_COUNTED',null,null],
    ['Free tool','FREE',null,null],['Local host','SYNCED',5000,'ILS_PRICE'],['Render','MANUAL_AMOUNT',2600,'MANUAL']]);
   // Finance page: synced charges once in "חיובים קבועים" with the provider price as secondary information.
   const page=await(await get('/admin/system')).text();
   assert.match(page,/Shopify<\/strong><span class="cell-note"><span class="tag tag--ops">הוצאת מערכת<\/span>/);
   assert.match(page,/<span dir="ltr">\$39\.90<\/span> אצל הספק/);
   assert.match(page,/סכום ידני \(ייבוא קודם\)/,'the legacy mapping is marked as such');
   const ops=page.slice(page.indexOf('id="ops-costs-title"'));
   assert.deepEqual([...ops.matchAll(/<tr data-ops-state="([A-Z_]+)"><td data-label="שירות">([^<]+)</g)].map(m=>m[2]+':'+m[1]),['Sense RTL:NOT_COUNTED','Shipfn:NOT_COUNTED','Free tool:FREE'],'counted costs are not listed twice');
   assert.match(ops,/Sense RTL.*לא נכלל בסיכומים · אין סכום בשקלים/);
   assert.match(ops,/financeAmountIls/,'the fix is explained');
  });

  await t.test('3-4. repeated and concurrent reads create nothing twice',async()=>{
   const audits=await syncAudits(),txs=await count('SELECT COUNT(*)::int AS n FROM business_transactions');
   const other=new Finance(f.db,f.cfg.ops.costs,()=>clock);
   await Promise.all([...Array.from({length:8},()=>load()),...Array.from({length:4},()=>get('/admin/system')),...Array.from({length:6},()=>other.record())]);
   for(let i=0;i<3;i++)await load();
   assert.equal(await count("SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE managed_by='OPS_COSTS'"),4);
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM business_transactions'),txs);
   assert.equal(await syncAudits(),audits);
  });

  await t.test('5-6. monthly and yearly foreign costs bill on their schedule',async()=>{
   at('2026-05-02T10:00:00Z');await load();
   assert.deepEqual(await rows((await one('Shopify')).id),['2026-03-01:15000','2026-04-01:15000','2026-05-01:15000']);
   assert.deepEqual(await rows((await one('Domain')).id),['2026-03-01:7500'],'yearly: next March');
  });

  await t.test('7-8. a financeAmountIls change applies to future billing only',async()=>{
   at('2026-05-10T10:00:00Z');
   const next=base();next[0]=entry('Shopify',39.9,'USD',{financeAmountIls:170});setOps(next);
   const before=await syncAudits();await load();await load();
   const shopify=await one('Shopify');
   assert.deepEqual([shopify.a,shopify.ef],['17000','2026-05-10']);
   assert.deepEqual(await rows(shopify.id),['2026-03-01:15000','2026-04-01:15000','2026-05-01:15000'],'recorded rows unchanged');
   assert.equal(await syncAudits(),before+1);
   at('2026-06-02T10:00:00Z');await load();
   assert.equal((await rows(shopify.id)).at(-1),'2026-06-01:17000');
  });

  await t.test('11. a provider (USD) price change alone does not touch the ILS amount',async()=>{
   at('2026-06-10T10:00:00Z');
   const next=base();next[0]=entry('Shopify',44.9,'USD',{financeAmountIls:170});setOps(next);
   const before=await syncAudits();await load();
   const shopify=await one('Shopify');
   assert.deepEqual([shopify.a,shopify.ef],['17000','2026-05-10']);
   assert.equal(await syncAudits(),before,'nothing written');
   const services=await(await get('/admin/system/services')).text();
   const row=services.match(/<tr><td data-label="שירות">Shopify<\/td>.*?<\/tr>/)![0];
   assert.match(row,/<td data-label="עלות ספק" class="num">[^<]*44\.90[^<]*\$<\/td>/);
   assert.match(row,/<td data-label="עלות לחישוב כספי"><span class="num" dir="ltr">₪170\.00<\/span> \/ חודש<\/td>/);
   assert.match(services,/<th scope="col">עלות ספק<\/th>.*<th scope="col">עלות לחישוב כספי<\/th>/);
   assert.match(services,/<td data-label="שירות">Sense RTL<\/td>.*?לא נכלל בכספים · יש להגדיר financeAmountIls/);
   assert.match(services,/<td data-label="שירות">Local host<\/td>.*?<span class="muted">כמו עלות הספק<\/span>/,'no duplicate amount for an ILS cost');
   assert.match(services,/<td data-label="שירות">Render<\/td>.*?₪26\.00.*?סכום ידני מייבוא קודם/);
   assert.match(services,/<td data-label="שירות">Free tool<\/td>.*?חינם · ללא הוצאה/);
  });

  await t.test('9-10. removing financeAmountIls stops finance billing; re-adding resumes without backfill',async()=>{
   at('2026-07-02T10:00:00Z');await load();
   const shopify=await one('Shopify'),history=await rows(shopify.id);
   assert.equal(history.at(-1),'2026-07-01:17000');
   const next=base();next[0]=entry('Shopify',44.9,'USD');setOps(next);
   const data=await load();
   const stopped=await one('Shopify');
   assert.deepEqual([stopped.active,stopped.deactivated_reason],[false,'OPS_SYNC']);
   assert.equal(data.opsCosts[0].state,'NOT_COUNTED');
   assert.match(await(await get('/admin/system')).text(),/<tr data-ops-state="NOT_COUNTED"><td data-label="שירות">Shopify<\/td>/);
   at('2026-09-02T10:00:00Z');await load();
   assert.deepEqual(await rows(shopify.id),history,'history kept, nothing new');
   const back=base();back[0]=entry('Shopify',44.9,'USD',{financeAmountIls:180});setOps(back);
   await load();
   const resumed=await one('Shopify');
   assert.deepEqual([resumed.id,resumed.active,resumed.a,resumed.ef],[shopify.id,true,'18000','2026-09-02']);
   at('2026-10-02T10:00:00Z');await load();
   assert.deepEqual((await rows(shopify.id)).slice(-2),['2026-07-01:17000','2026-10-01:18000'],'August and September not backfilled');
  });

  await t.test('17. a legacy manual mapping stays editable until financeAmountIls takes it over',async()=>{
   const body={type:'EXPENSE',recurring:true,frequency:'MONTHLY',date:'2026-02-01',category:'Render',description:'Render'};
   assert.equal((await api('POST','/admin/api/finance/transactions/'+legacyId,{...body,amountAgorot:2700})).status,200,'MANUAL: the admin owns the amount');
   const before=await rows(legacyId);
   const next=base();next[6]=entry('Render',7,'USD',{financeAmountIls:30});next[0]=entry('Shopify',44.9,'USD',{financeAmountIls:180});setOps(next);
   at('2026-10-05T10:00:00Z');await load();
   const render=await one('Render');
   assert.deepEqual([render.id,render.a,render.amount_source,render.ef],[legacyId,'3000','OPS_CONFIG','2026-10-05'],'taken over by the same charge');
   assert.deepEqual(await rows(legacyId),before,'its recorded rows keep the earlier amounts');
   const locked=await api('POST','/admin/api/finance/transactions/'+legacyId,{...body,amountAgorot:9999});
   assert.equal(locked.status,422,'now managed by OPS_COSTS');
   assert.equal(await count(`SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE import_key='${renderKey}'`),1);
  });

  await t.test('15-16. manual charges untouched; no raw OPS_COSTS or secrets in HTML or API',async()=>{
   const manual=(await f.db.query('SELECT managed_by,amount_source,active,amount_agorot::text AS a FROM business_recurring_transactions WHERE id=$1',[manualId])).rows[0];
   assert.deepEqual([manual.managed_by,manual.amount_source,manual.active,manual.a],[null,null,true,'4000']);
   assert.equal((await rows(manualId)).length,8,'March–October, every month');
   for(const path of ['/admin/system','/admin/system/services','/admin/api/finance/summary','/admin/api/system','/admin/api/finance/recurring']){
    const body=await(await get(path)).text();
    // Parsed, safe fields (service, amountCents, state…) are part of the admin API; raw input fields never are.
    assert.doesNotMatch(body,/"financeAmountIls"|financeAmountIls":|"abc"|"amount":/,path+': raw OPS_COSTS');
    for(const secret of [f.cfg.password,f.cfg.secret,f.cfg.token,f.cfg.databaseUrl])assert.ok(!body.includes(secret),path);
   }
  });
 }finally{await f.close();}
});
