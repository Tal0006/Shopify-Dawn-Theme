// Business finance ("כספים", /admin/system): persisted income/expenses in integer agorot, recurring definitions counted
// once per billing date, KPI/chart/list from the same entries, OPS_COSTS compatibility, admin session + CSRF + audit.
// The clock is fixed at 2026-11-17 (Israel), so "this month" is November 2026.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {parseAmount,occurrence,nextOccurrence,monthlyEquivalent,validate,FinanceInputError,israelDate,dueDates} from '../src/finance.js';
import {ils} from '../src/finance-page.js';

const OPS_COSTS=JSON.stringify([
 {service:'Render Group Delivery',amount:7,currency:'USD',system:'render-group-delivery'},
 {service:'Neon',amount:0,currency:'USD',system:'neon'},
]);

test('finance helpers: money parsing, billing dates, monthly equivalents, formatting',()=>{
 assert.equal(parseAmount('1234'),123400n);assert.equal(parseAmount('1,234.56'),123456n);assert.equal(parseAmount('₪ 99.9'),9990n);assert.equal(parseAmount('0.01'),1n);
 assert.equal(parseAmount('10000000'),1000000000n,'₪10M is the maximum');
 for(const bad of ['0','0.00','-5','12.345','1e3','abc','','1,23.00','10000000.01','99999999999','.5','5.',' '])assert.equal(parseAmount(bad),null,bad);
 assert.equal(parseAmount(12.5 as any),null,'numbers must be agorot integers (amountAgorot), not floats');
 // Day 31 lands on the month's last day; leap years handled; quarterly/yearly steps.
 assert.deepEqual([0,1,2,3,6].map(k=>occurrence('2026-08-31','MONTHLY',k)),['2026-08-31','2026-09-30','2026-10-31','2026-11-30','2027-02-28']);
 assert.equal(occurrence('2028-01-31','MONTHLY',1),'2028-02-29');
 assert.deepEqual([0,1,2].map(k=>occurrence('2026-01-15','QUARTERLY',k)),['2026-01-15','2026-04-15','2026-07-15']);
 assert.equal(occurrence('2024-02-29','YEARLY',1),'2025-02-28');
 assert.deepEqual(dueDates('2026-08-31','MONTHLY','2026-08-31','2026-11-17',null),['2026-08-31','2026-09-30','2026-10-31'],'never a future date');
 assert.deepEqual(dueDates('2026-01-15','QUARTERLY','2026-05-01','2026-12-31','2026-07-20'),['2026-07-15']);
 assert.deepEqual(dueDates('2026-12-05','MONTHLY','2026-12-05','2026-11-17',null),[]);
 assert.equal(nextOccurrence('2026-08-31','MONTHLY',null,'2026-11-17'),'2026-11-30');
 assert.equal(nextOccurrence('2026-08-31','MONTHLY',null,'2026-11-30'),'2026-11-30','the billing day itself counts');
 assert.equal(nextOccurrence('2026-03-10','YEARLY',null,'2026-11-17'),'2027-03-10');
 assert.equal(nextOccurrence('2026-01-15','QUARTERLY','2026-07-20','2026-11-17'),null,'ended');
 assert.equal(nextOccurrence('2026-12-05','MONTHLY',null,'2026-11-17'),'2026-12-05','scheduled');
 assert.deepEqual([monthlyEquivalent(6000n,'YEARLY'),monthlyEquivalent(1000n,'QUARTERLY'),monthlyEquivalent(1001n,'MONTHLY'),monthlyEquivalent(18n,'YEARLY')],[500n,333n,1001n,2n]);
 assert.deepEqual([ils(123456),ils(-83456),ils(0),ils(5,'always'),ils(100000000000)],['₪1,234.56','−₪834.56','₪0.00','+₪0.05','₪1,000,000,000.00']);
 assert.equal(israelDate(new Date('2026-11-30T22:30:00Z')),'2026-12-01','Israel time decides the day');
 // Validation rules shared by forms and JSON.
 const fields=(body:any)=>{try{validate(body);return {};}catch(e){assert.ok(e instanceof FinanceInputError);return e.fields;}};
 assert.deepEqual(Object.keys(fields({})).sort(),['amount','category','date','type']);
 assert.ok(fields({type:'INCOME',amount:'5',date:'2026-11-01',category:'x',recurring:true,frequency:'MONTHLY'}).recurring,'recurring income is refused');
 assert.ok(fields({type:'EXPENSE',amount:'5',date:'2026-11-01',category:'x',recurring:true}).frequency);
 assert.ok(fields({type:'EXPENSE',amount:'5',date:'2026-11-01',category:'x',recurring:true,frequency:'MONTHLY',startDate:'2026-10-01',endDate:'2026-09-30'}).endDate);
 assert.ok(fields({type:'EXPENSE',amount:'5',date:'2026-02-30',category:'x'}).date,'impossible date');
 assert.ok(fields({type:'EXPENSE',amount:'5',date:'2026-11-01',category:'x',paymentMethod:'BITCOIN'}).paymentMethod);
 assert.ok(fields({type:'EXPENSE',amount:'5',date:'2026-11-01',category:'x'.repeat(61)}).category);
 const ok=validate({type:'EXPENSE',amount:'5',date:'2026-11-01',category:' שונות ',frequency:'MONTHLY',startDate:'2026-01-01'});
 assert.deepEqual([ok.category,ok.recurring,ok.frequency,ok.startDate,ok.source],['שונות',false,null,null,'MANUAL'],'recurrence fields are ignored unless recurring');
});

test('Business finance dashboard (/admin/system)',{timeout:240000},async t=>{
 const f=await adminFixture({env:{OPS_COSTS},now:()=>new Date('2026-11-17T10:00:00Z')});
 try{
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const get=(path:string,c=cookie)=>fetch(origin+path,{redirect:'manual',headers:c?{Cookie:c}:{}});
  const api=(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method,redirect:'manual',
   headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf,...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const form=(path:string,fields:Record<string,string>,token=csrf)=>fetch(origin+path,{method:'POST',redirect:'manual',
   headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,...fields})});
  const summary=async(range='')=>(await(await get('/admin/api/finance/summary'+(range?'?range='+range:''))).json() as any);
  const list=async(q='')=>(await(await get('/admin/api/finance/transactions'+q)).json() as any);
  const count=async()=>Number((await f.db.query('SELECT COUNT(*)::int AS n FROM business_transactions')).rows[0].n);
  const audits=async(action:string)=>(await f.db.query('SELECT result,detail,target,amount_agorot::text AS amount FROM admin_audit WHERE action=$1 ORDER BY at,id',[action])).rows;
  const create=async(body:any)=>{const r=await api('POST','/admin/api/finance/transactions',body);assert.equal(r.status,201,JSON.stringify(await r.clone().json()));const b=await r.json() as any;return b.transaction??b.recurring;};
  const ids:Record<string,string>={};

  await t.test('16. unauthenticated access is rejected: API 401, page to login, no data',async()=>{
   for(const path of ['/admin/api/finance/summary','/admin/api/finance/transactions'])assert.equal((await get(path,'')).status,401,path);
   const page=await get('/admin/system','');assert.equal(page.status,303);assert.equal(page.headers.get('location'),'/admin?expired=1&next='+encodeURIComponent('/admin/system'));
   const post=await fetch(origin+'/admin/api/finance/transactions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({type:'INCOME',amountAgorot:100,date:'2026-11-01',category:'x'})});
   assert.equal(post.status,401);
   const html=await fetch(origin+'/admin/system/transactions',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:'type=INCOME&amount=1&date=2026-11-01&category=x'});
   assert.equal(html.status,303);assert.equal(html.headers.get('location'),'/admin?expired=1');
   assert.equal(await count(),0);
  });

  await t.test('17. mutations need CSRF and the same Origin; nothing changes otherwise',async()=>{
   const body={type:'INCOME',amountAgorot:100,date:'2026-11-01',category:'x'};
   const noToken=await api('POST','/admin/api/finance/transactions',body,{'X-CSRF-Token':''});assert.equal(noToken.status,403);assert.equal((await noToken.json() as any).code,'CSRF_REQUIRED');
   assert.equal((await api('POST','/admin/api/finance/transactions',body,{'X-CSRF-Token':'0'.repeat(64)})).status,403);
   assert.equal((await api('POST','/admin/api/finance/transactions',body,{Origin:'https://evil.example'})).status,403);
   assert.equal((await form('/admin/system/transactions',{type:'INCOME',amount:'1',date:'2026-11-01',category:'x'},'wrong')).status,403);
   assert.equal(await count(),0);
  });

  await t.test('15a. free and non-ILS OPS_COSTS entries are listed but never counted',async()=>{
   const s=await summary();
   assert.deepEqual(s.summary.kpis,{incomeAgorot:0,expenseAgorot:0,profitAgorot:0,recurringMonthlyAgorot:0,recurringActive:0,recurringThisMonthAgorot:0});
   assert.deepEqual(s.opsCosts.map((c:any)=>[c.service,c.currency,c.state,c.recurringId]),[['Render Group Delivery','USD','NOT_COUNTED',null],['Neon','USD','FREE',null]]);
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM business_recurring_transactions')).rows[0].n),0);
   const system=await(await get('/admin/api/system')).json() as any;assert.deepEqual(system.costs.monthlyTotals,{USD:7});
   const page=await(await get('/admin/system')).text();
   assert.match(page,/<h2 id="ops-costs-title">עלויות מערכת \(OPS_COSTS\)<\/h2>/);
   assert.match(page,/<tr data-ops-state="NOT_COUNTED">.*Render Group Delivery.*\$7\.00.*לא נכלל בסיכומים · אין סכום בשקלים/);
   assert.match(page,/<tr data-ops-state="FREE">.*Neon.*חינם · ללא הוצאה/);
   assert.doesNotMatch(page,/ייבוא כחיוב קבוע|name="importKey"/,'the manual import workflow is gone');
  });

  await t.test('1-3. create income (JSON), expense (form, ₪ text) and recurring expenses; audited',async()=>{
   ids.income=(await create({type:'INCOME',amountAgorot:50000,date:'2026-11-03',category:'מכירות Shopify',description:'מכירות שבוע 1',source:'SHOPIFY',paymentMethod:'CARD'})).id;
   const r=await form('/admin/system/transactions',{type:'EXPENSE',amount:'1,234.56',date:'2026-11-05',category:'פרסום',description:'קמפיין פייסבוק',paymentMethod:'CARD',source:'MANUAL',notes:'',back:'range=12m&type=EXPENSE'});
   assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/admin/system?range=12m&type=EXPENSE&notice=tx_created','back to the same filters');
   const expense=(await list('?q=פייסבוק')).entries[0];ids.expense=expense.id;
   assert.deepEqual([expense.type,expense.amountAgorot,expense.date,expense.category,expense.paymentMethod,expense.source,expense.occurrence],['EXPENSE',123456,'2026-11-05','פרסום','CARD','MANUAL',false]);
   const stored=(await f.db.query('SELECT amount_agorot::text AS a,pg_typeof(amount_agorot)::text AS t,currency,created_by FROM business_transactions WHERE id=$1',[ids.expense])).rows[0];
   assert.deepEqual([stored.a,stored.t,stored.currency],['123456','bigint','ILS']);assert.match(stored.created_by,/^session:[a-f0-9]{12}$/);
   // Recurring: monthly from Aug 31 (no start date: anchored on the date), yearly, quarterly that ended, one not started.
   const monthly=await create({type:'EXPENSE',amountAgorot:10000,date:'2026-08-31',category:'Shopify',description:'Shopify Basic',recurring:true,frequency:'MONTHLY',paymentMethod:'STANDING_ORDER'});
   assert.deepEqual([monthly.recurring,monthly.frequency,monthly.startDate,monthly.endDate,monthly.occurrences,monthly.lastOccurrence],[true,'MONTHLY','2026-08-31',null,3,'2026-10-31']);ids.monthly=monthly.id;
   ids.yearly=(await create({type:'EXPENSE',amountAgorot:6000,date:'2026-03-10',category:'תוכנה ושירותים',description:'דומיין',recurring:true,frequency:'YEARLY'})).id;
   ids.ended=(await create({type:'EXPENSE',amountAgorot:3000,date:'2026-01-15',category:'Render',description:'Render Starter',recurring:true,frequency:'QUARTERLY',endDate:'2026-07-20'})).id;
   ids.scheduled=(await create({type:'EXPENSE',amountAgorot:2000,date:'2026-11-17',category:'Shipfn',description:'Shipfn',recurring:true,frequency:'MONTHLY',startDate:'2026-12-05'})).id;
   ids.october=(await create({type:'INCOME',amountAgorot:2500,date:'2026-10-12',category:'משלוח קבוצתי',source:'GROUP_DELIVERY'})).id;
   ids.may=(await create({type:'EXPENSE',amountAgorot:7000,date:'2026-05-31',category:'מלאי',description:'מלאי קיץ'})).id;
   const rows=await audits('finance.transaction_create');
   assert.equal(rows.length,4);assert.ok(rows.every((r:any)=>r.result==='OK'&&/^[a-f0-9-]{36}$/.test(r.target)));
   assert.deepEqual(rows.slice(0,2).map((r:any)=>[r.detail,r.amount]),[['INCOME','50000'],['EXPENSE','123456']]);
   assert.deepEqual((await audits('finance.recurring_create')).map((r:any)=>[r.result,r.detail,r.amount]),
    [['OK','RECURRING_MONTHLY','10000'],['OK','RECURRING_YEARLY','6000'],['OK','RECURRING_QUARTERLY','3000'],['OK','RECURRING_MONTHLY','2000']]);
   // Recurring income does not exist: "חיוב קבוע" is an expense with recurrence metadata.
   const refused=await api('POST','/admin/api/finance/transactions',{type:'INCOME',amountAgorot:100,date:'2026-11-01',category:'x',recurring:true,frequency:'MONTHLY'});
   assert.equal(refused.status,422);assert.ok((await refused.json() as any).fields.recurring);
  });

  await t.test('6-7. invalid, negative and zero amounts are rejected (JSON and form) and audited as denied',async()=>{
   const before=await count();
   const base={type:'EXPENSE',date:'2026-11-01',category:'שונות'};
   for(const amount of [{amountAgorot:0},{amountAgorot:-100},{amountAgorot:1.5},{amountAgorot:'12.5'},{amountAgorot:1000000001},{amount:'0'},{amount:'-5'},{amount:'12.345'},{amount:'1e3'},{amount:'abc'},{amount:''},{}]){
    const r=await api('POST','/admin/api/finance/transactions',{...base,...amount});
    assert.equal(r.status,422,JSON.stringify(amount));const b=await r.json() as any;
    assert.equal(b.code,'INVALID_TRANSACTION');assert.ok(b.fields.amount,JSON.stringify(amount));
   }
   // The form comes back with the typed values, the field marked invalid and a linked error summary.
   const r=await form('/admin/system/transactions',{...base,amount:'-12',description:'בדיקה <b>'});
   assert.equal(r.status,422);const page=await r.text();
   assert.match(page,/<dialog id="tx-new"[^>]* open data-autoshow>/);assert.match(page,/data-error-summary/);
   assert.match(page,/<input id="tx-new-amount" name="amount" value="-12"[^>]*aria-invalid="true" aria-describedby="tx-new-amount-error">/);
   assert.match(page,/value="בדיקה &lt;b&gt;"/,'values escaped');
   assert.equal(await count(),before);
   assert.ok((await audits('finance.transaction_create')).filter((a:any)=>a.result==='DENIED').every((a:any)=>a.detail==='INVALID_TRANSACTION'));
   assert.ok((await audits('finance.transaction_create')).filter((a:any)=>a.result==='DENIED').length>=13);
  });

  await t.test('8-10. income, expense and profit KPIs for the current month (recurring billed once on its date)',async()=>{
   const s=(await summary()).summary;
   assert.equal(s.month,'2026-11');
   // November: the monthly charge bills on Nov 30, which is not due yet, so nothing recurring is recorded this month.
   assert.deepEqual(s.kpis,{incomeAgorot:50000,expenseAgorot:123456,profitAgorot:-73456,
    // Active: monthly ₪100 + yearly ₪60/12; the quarterly one ended in July, the Shipfn one starts in December.
    recurringMonthlyAgorot:10500,recurringActive:2,recurringThisMonthAgorot:0});
   assert.deepEqual(s.recurring.map((r:any)=>[r.description,r.status,r.nextDate,r.monthlyAgorot]),
    [['Shopify Basic','ACTIVE','2026-11-30',10000],['דומיין','ACTIVE','2027-03-10',500],['Shipfn','SCHEDULED','2026-12-05',2000],['Render Starter','ENDED',null,1000]]);
  });

  await t.test('11-12, 14. monthly aggregation: 6 months, 12 months, current year; recurring never counted twice',async()=>{
   const months=(s:any)=>s.summary.chart.map((m:any)=>[m.month,m.incomeAgorot,m.expenseAgorot]);
   assert.deepEqual(months(await summary()),[['2026-06',0,0],['2026-07',0,3000],['2026-08',0,10000],['2026-09',0,10000],['2026-10',2500,10000],['2026-11',50000,123456]]);
   const year=months(await summary('12m'));
   assert.equal(year.length,12);assert.deepEqual(year[0],['2025-12',0,0]);
   assert.deepEqual(year.slice(1,6),[['2026-01',0,3000],['2026-02',0,0],['2026-03',0,6000],['2026-04',0,3000],['2026-05',0,7000]]);
   assert.deepEqual(months(await summary('year')).map((m:any)=>m[0]),['2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08','2026-09','2026-10','2026-11']);
   assert.equal((await summary('bogus')).summary.range,'6m','unknown range falls back to 6 months');
   // The monthly charge (from Aug 31) is a definition; only its due billing dates exist as rows: 3 × ₪100.
   const shopify=(await list('?category=Shopify')).entries;
   assert.deepEqual(shopify.map((e:any)=>[e.date,e.amountAgorot,e.occurrence,e.recurringDefinitionId]),[['2026-10-31',10000,true,ids.monthly],['2026-09-30',10000,true,ids.monthly],['2026-08-31',10000,true,ids.monthly]]);
   // The list, the KPIs and the chart agree: the same entries.
   const november=await list('?month=2026-11');
   assert.deepEqual(november.totals,{incomeAgorot:50000,expenseAgorot:123456,profitAgorot:-73456});
   const all=await list();
   assert.equal(all.pagination.total,11,'4 one-offs + 3 monthly + 1 yearly + 3 quarterly recorded billing dates; the scheduled one has none yet');
   assert.equal(all.totals.expenseAgorot,year.reduce((sum:number,m:any)=>sum+m[2],0),'every entry falls inside the 12-month window');
  });

  await t.test('13. filters: type, category, month, search (wildcards are literal) and combinations',async()=>{
   const income=await list('?type=INCOME');assert.deepEqual(income.entries.map((e:any)=>e.id),[ids.income,ids.october]);assert.equal(income.totals.incomeAgorot,52500);
   const october=await list('?month=2026-10');
   assert.deepEqual(october.entries.map((e:any)=>[e.date,e.type,e.occurrence]),[['2026-10-31','EXPENSE',true],['2026-10-12','INCOME',false]]);
   assert.deepEqual(october.totals,{incomeAgorot:2500,expenseAgorot:10000,profitAgorot:-7500});
   assert.deepEqual((await list('?q='+encodeURIComponent('פייסבוק'))).entries.map((e:any)=>e.id),[ids.expense]);
   assert.equal((await list('?q=%25')).pagination.total,0,'% is searched literally');
   assert.equal((await list('?type=EXPENSE&month=2026-11')).pagination.total,1);
   assert.equal((await list('?category='+encodeURIComponent('מלאי'))).entries[0].id,ids.may);
   assert.deepEqual((await list('?type=NOPE&month=2026-13&page=-1')).filters,{q:'',type:'',category:'',month:'',page:1},'invalid filters are ignored');
   assert.ok((await list()).categories.includes('Shopify'));
   // The page renders the filters server-side.
   const page=await(await get('/admin/system?type=INCOME&month=2026-10')).text();
   assert.equal((page.match(/<tr data-type="/g)||[]).length,1);
   assert.match(page,/<option value="INCOME" selected>הכנסות<\/option>/);assert.match(page,/<input id="fin-month" name="month" type="month" value="2026-10"/);
   assert.match(page,/בסינון: <span>הכנסות <span class="money" dir="ltr">₪25.00<\/span>/);
  });

  await t.test('4. edit: form and JSON updates, the change is reflected everywhere and audited',async()=>{
   const r=await form('/admin/system/transactions/'+ids.expense,{type:'EXPENSE',amount:'1000',date:'2026-11-05',category:'פרסום',description:'קמפיין פייסבוק',notes:'עודכן',back:'month=2026-11'});
   assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/admin/system?month=2026-11&notice=tx_updated');
   assert.equal((await summary()).summary.kpis.expenseAgorot,100000);
   // An end date in the past stops future billing only: the October row that was already recorded stays.
   const ended=await api('POST','/admin/api/finance/transactions/'+ids.monthly,{type:'EXPENSE',amountAgorot:10000,date:'2026-08-31',category:'Shopify',description:'Shopify Basic',recurring:true,frequency:'MONTHLY',endDate:'2026-09-30'});
   assert.equal(ended.status,200);const body=await ended.json() as any;assert.equal(body.previous.endDate,null);assert.equal(body.recurring.endDate,'2026-09-30');
   assert.deepEqual((await summary()).summary.chart.slice(2).map((m:any)=>m.expenseAgorot),[10000,10000,10000,100000]);
   await api('POST','/admin/api/finance/transactions/'+ids.monthly,{type:'EXPENSE',amountAgorot:10000,date:'2026-08-31',category:'Shopify',description:'Shopify Basic',recurring:true,frequency:'MONTHLY'});
   assert.equal((await summary()).summary.kpis.expenseAgorot,100000);
   // An invalid edit is refused without changing the row; an unknown id is 404.
   const bad=await form('/admin/system/transactions/'+ids.expense,{type:'EXPENSE',amount:'0',date:'2026-11-05',category:'פרסום'});
   assert.equal(bad.status,422);assert.match(await bad.text(),/<dialog id="tx-edit"[^>]* open data-autoshow>/);
   assert.equal((await(await get('/admin/api/finance/transactions/'+ids.expense)).json() as any).transaction.amountAgorot,100000);
   assert.equal((await api('POST','/admin/api/finance/transactions/00000000-0000-4000-8000-000000000000',{type:'EXPENSE',amountAgorot:1,date:'2026-11-01',category:'x'})).status,404);
   assert.equal((await get('/admin/api/finance/transactions/not-a-uuid')).status,404);
   const rows=await audits('finance.transaction_update');
   assert.deepEqual(rows.filter((a:any)=>a.result==='OK').map((a:any)=>[a.target,a.detail]),[[ids.expense,'EXPENSE']]);
   assert.deepEqual((await audits('finance.recurring_update')).map((a:any)=>[a.target,a.detail]),[[ids.monthly,'RECURRING_MONTHLY_TERMS'],[ids.monthly,'RECURRING_MONTHLY_TERMS']]);
   assert.ok(rows.some((a:any)=>a.result==='DENIED'&&a.detail==='INVALID_TRANSACTION'));
   assert.ok(rows.some((a:any)=>a.result==='DENIED'&&a.detail==='TRANSACTION_NOT_FOUND'));
  });

  await t.test('5. delete needs explicit confirmation; it is audited and removed from every total',async()=>{
   const unconfirmed=await api('POST','/admin/api/finance/transactions/'+ids.may+'/delete',{});
   assert.equal(unconfirmed.status,400);assert.equal((await unconfirmed.json() as any).code,'DELETE_CONFIRMATION_REQUIRED');
   const formUnconfirmed=await form('/admin/system/transactions/'+ids.may+'/delete',{back:'range=12m'});
   assert.equal(formUnconfirmed.status,303);assert.equal(formUnconfirmed.headers.get('location'),'/admin/system?range=12m&error=delete_confirm');
   assert.ok((await get('/admin/api/finance/transactions/'+ids.may)).ok,'still there');
   // The confirmation dialog names what will be deleted.
   const dialog=await(await get('/admin/system?delete='+ids.may)).text();
   assert.match(dialog,/<dialog id="delete-dialog"[^>]* open data-autoshow>/);assert.match(dialog,/מלאי · מלאי קיץ/);assert.match(dialog,/₪70\.00/);
   const r=await form('/admin/system/transactions/'+ids.may+'/delete',{confirm:'yes',back:'range=12m'});
   assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/admin/system?range=12m&notice=tx_deleted');
   assert.equal((await get('/admin/api/finance/transactions/'+ids.may)).status,404);
   assert.equal((await summary('12m')).summary.chart[5].expenseAgorot,0);
   const json=await api('POST','/admin/api/finance/transactions/'+ids.scheduled+'/delete',{confirm:true});
   assert.equal(json.status,200);assert.equal((await json.json() as any).deleted.id,ids.scheduled);
   assert.equal((await api('POST','/admin/api/finance/transactions/'+ids.scheduled+'/delete',{confirm:true})).status,404,'second delete');
   const rows=await audits('finance.transaction_delete');
   assert.deepEqual(rows.filter((a:any)=>a.result==='OK').map((a:any)=>[a.target,a.amount]),[[ids.may,'7000']]);
   assert.deepEqual((await audits('finance.recurring_delete')).map((a:any)=>[a.target,a.amount]),[[ids.scheduled,'2000']],'nothing was recorded yet, so the charge is deleted');
   assert.ok(rows.some((a:any)=>a.result==='DENIED'&&a.detail==='DELETE_CONFIRMATION_REQUIRED'));
  });

  await t.test('page: Hebrew RTL dashboard, KPI cards, chart, tables, dialogs, navigation, no inline styles or secrets',async()=>{
   const response=await get('/admin/system');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
   const page=await response.text();
   assert.match(page,/<html lang="he" dir="rtl">/);assert.match(page,/<title>כספים · /);assert.match(page,/<h1>כספים<\/h1>/);
   assert.match(page,/<a href="\/admin\/system" aria-current="page">כספים<\/a>/);assert.match(page,/<a href="\/admin\/system\/services">מערכות האתר<\/a>/);
   assert.doesNotMatch(page,/הזמנות<\/a>|סקירה<\/a>/,'future sections are not linked yet');
   for(const label of ['הכנסות החודש','הוצאות החודש','רווח / הפסד','חיובים קבועים'])assert.match(page,new RegExp('<span class="metric__label">'+label.replace('/','\\/')+'</span>'),label);
   for(const button of ['+ הכנסה','+ הוצאה','+ חיוב קבוע'])assert.ok(page.includes('aria-haspopup="dialog">'+button+'</a>'),button);
   assert.match(page,/<li class="metric metric--fin metric--loss">/);assert.match(page,/הפסד<\/span> · הכנסות פחות הוצאות/,'loss is stated in words, not only color');
   assert.match(page,/<h2 id="chart-title">הכנסות מול הוצאות<\/h2>/);assert.equal((page.match(/<rect class="chart__bar /g)||[]).length,12,'6 months × 2 bars');
   assert.match(page,/<svg class="chart__svg chart__svg--6" viewBox="0 0 [0-9]+ 250" role="img" aria-labelledby="chart-title chart-desc"/);
   assert.match(page,/<summary>הצגת הנתונים כטבלה<\/summary>/);
   assert.match(page,/<h2 id="tx-title">תנועות אחרונות<\/h2>/);
   for(const col of ['תאריך','סוג','קטגוריה','תיאור','סכום','מקור','פעולות'])assert.match(page,new RegExp('<th scope="col">'+col+'</th>'),col);
   assert.match(page,/<span class="tx-type tx-type--expense"><span aria-hidden="true">↓<\/span> הוצאה<\/span>/);
   assert.match(page,/<span class="money tx-amount tx-amount--income" dir="ltr">\+₪500\.00<\/span>/);
   assert.match(page,/<h2 id="recurring-title">חיובים קבועים<\/h2>/);
   assert.match(page,/<dialog id="tx-new" class="dialog dialog--form"[^>]*data-mode="create">/,'the add dialog is present and closed');
   assert.doesNotMatch(page,/\sstyle=|<script>|javascript:/,'CSP: no inline styles or scripts');
   for(const secret of [f.cfg.password,f.cfg.secret,f.cfg.token,f.cfg.databaseUrl])assert.ok(!page.includes(secret));
   // No-JS dialogs and ranges.
   assert.match(await(await get('/admin/system?add=RECURRING')).text(),/<input type="checkbox" id="tx-new-recurring" name="recurring" value="on" checked data-tx-recurring>/);
   assert.match(await(await get('/admin/system?add=INCOME')).text(),/<input type="radio" name="type" value="INCOME" id="tx-new-type-INCOME" checked data-tx-type>/);
   const edit=await(await get('/admin/system?edit='+ids.income)).text();
   assert.match(edit,/<form method="post" action="\/admin\/system\/transactions\/[a-f0-9-]{36}"/);assert.match(edit,/value="500.00"/);
   assert.match(await(await get('/admin/system?edit=00000000-0000-4000-8000-000000000000')).text(),/התנועה לא נמצאה/);
   const twelve=await(await get('/admin/system?range=12m')).text();
   assert.match(twelve,/aria-current="true">12 חודשים<\/a>/);assert.equal((twelve.match(/<rect class="chart__bar /g)||[]).length,24);
   assert.match(await(await get('/admin/system?notice=tx_created')).text(),/<p class="notice notice--ok" role="status">התנועה נשמרה\.<\/p>/);
   // The audit page describes finance changes in Hebrew.
   const auditPage=await(await get('/admin/audit')).text();
   assert.match(auditPage,/רישום תנועה כספית/);assert.match(auditPage,/מחיקת תנועה כספית/);assert.match(auditPage,/<span class="audit__desc">הוצאה · ₪1,000\.00<\/span>/);
  });

  await t.test('rate limit: finance writes have their own bucket',async()=>{
   // Fill the bucket directly (the HMAC key is internal), then expect 429.
   const {createHmac}=await import('node:crypto');
   const key=createHmac('sha256',f.cfg.secret).update('admin-finance-write:127.0.0.1').digest('hex');
   await f.db.query('UPDATE request_limits SET hits=1000 WHERE key=$1 OR key=$2',[key,createHmac('sha256',f.cfg.secret).update('admin-finance-write:::ffff:127.0.0.1').digest('hex')]);
   const r=await api('POST','/admin/api/finance/transactions',{type:'INCOME',amountAgorot:1,date:'2026-11-01',category:'x'});
   assert.equal(r.status,429);
  });
 }finally{await f.close();}
});
