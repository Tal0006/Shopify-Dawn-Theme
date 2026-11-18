// Recurring charges record immutable expense rows (migration 012): one row per due billing date, idempotent under
// repeated and concurrent reads, never in the future; changes apply only from today on; stopping keeps history; the
// dashboard reads actual rows only. Also: migrating 011-era recurring rows into definitions without losing history.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {adminFixture} from './admin-fixture.js';
import {Finance,importKeyOf,israelDate} from '../src/finance.js';
import {migrate,type Database,type Connection} from '../src/db.js';

test('Recurring charges record immutable expense rows',{timeout:240000},async t=>{
 let clock=new Date('2026-03-15T10:00:00Z');
 const at=(iso:string)=>{clock=new Date(iso);};
 const f=await adminFixture({now:()=>clock});
 try{
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const get=(path:string)=>fetch(origin+path,{redirect:'manual',headers:{Cookie:cookie}});
  const api=(method:string,path:string,body?:unknown)=>fetch(origin+path,{method,redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const form=(path:string,fields:Record<string,string>)=>fetch(origin+path,{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...fields})});
  const summary=async(range='')=>(await(await get('/admin/api/finance/summary'+(range?'?range='+range:''))).json() as any).summary;
  const list=async(q='')=>(await(await get('/admin/api/finance/transactions'+q)).json() as any);
  const rows=async(id:string)=>(await f.db.query(`SELECT to_char(transaction_date,'YYYY-MM-DD') AS d,amount_agorot::text AS a,category,description,created_by FROM business_transactions WHERE recurring_definition_id=$1 ORDER BY transaction_date`,[id])).rows;
  const dates=async(id:string)=>(await rows(id)).map((r:any)=>r.d+':'+r.a);
  const total=async()=>Number((await f.db.query('SELECT COUNT(*)::int AS n FROM business_transactions')).rows[0].n);
  const noFuture=async()=>{const max=(await f.db.query("SELECT to_char(MAX(transaction_date),'YYYY-MM-DD') AS m FROM business_transactions WHERE recurring_definition_id IS NOT NULL")).rows[0].m;
   assert.ok(!max||max<=israelDate(clock),'recorded '+max+' after today '+israelDate(clock));};
  const charge=async(body:any)=>{const r=await api('POST','/admin/api/finance/transactions',{type:'EXPENSE',recurring:true,frequency:'MONTHLY',...body});assert.equal(r.status,201);return (await r.json() as any).recurring;};
  const ids:Record<string,string>={};

  await t.test('1, 8. one row per due billing date, none in the future',async()=>{
   const a=await charge({amountAgorot:10000,date:'2026-01-01',category:'Shopify',description:'Shopify Basic'});ids.a=a.id;
   assert.deepEqual(await dates(a.id),['2026-01-01:10000','2026-02-01:10000','2026-03-01:10000']);
   assert.ok((await rows(a.id)).every((r:any)=>r.created_by==='system:recurring'&&r.category==='Shopify'));
   const b=await charge({amountAgorot:5000,date:'2026-01-20',category:'Render'});ids.b=b.id;
   assert.deepEqual(await dates(b.id),['2026-01-20:5000','2026-02-20:5000'],'Mar 20 is after Mar 15: not recorded');
   const scheduled=await charge({amountAgorot:777,date:'2026-06-01',category:'Shipfn'});ids.scheduled=scheduled.id;
   assert.deepEqual(await dates(scheduled.id),[]);
   await noFuture();
  });

  await t.test('2. reading the dashboard again and again never duplicates rows',async()=>{
   const before=await total();
   for(let i=0;i<5;i++){await summary();await list();await summary('12m');}
   assert.equal((await get('/admin/system')).status,200);assert.equal((await get('/admin/api/finance/recurring')).status,200);
   assert.equal(await total(),before);
   assert.equal((await dates(ids.a)).length,3);
  });

  await t.test('3. concurrent recording (many requests, two service instances) records each date once',async()=>{
   at('2026-03-21T10:00:00Z');// Mar 20 of charge b is now due
   const other=new Finance(f.db,[],()=>clock);// a second process on the same database
   await Promise.all([...Array.from({length:8},()=>summary()),...Array.from({length:8},()=>list()),...Array.from({length:4},()=>get('/admin/system')),...Array.from({length:6},()=>other.record())]);
   assert.deepEqual(await dates(ids.b),['2026-01-20:5000','2026-02-20:5000','2026-03-20:5000']);
   assert.equal((await dates(ids.a)).length,3);
   // The database itself refuses a second row for the same charge and date.
   await assert.rejects(f.db.query(`INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,recurring,created_by,updated_by,recurring_definition_id,recurring_occurrence_date)
    VALUES(gen_random_uuid(),'EXPENSE',1,'2026-03-20','x',false,'test','test',$1,'2026-03-20')`,[ids.b]),/unique|duplicate/i);
   await noFuture();
  });

  await t.test('4-5. a new amount applies from today on; recorded months keep their amount',async()=>{
   // April 1 (Israel), before anyone opened the dashboard today: ₪100 → ₪120.
   at('2026-04-01T07:00:00Z');
   const r=await api('POST','/admin/api/finance/transactions/'+ids.a,{type:'EXPENSE',amountAgorot:12000,date:'2026-01-01',category:'Shopify',description:'Shopify Basic',recurring:true,frequency:'MONTHLY'});
   assert.equal(r.status,200);const body=await r.json() as any;
   assert.equal(body.previous.amountAgorot,10000);assert.equal(body.recurring.amountAgorot,12000);assert.equal(body.recurring.effectiveFrom,'2026-04-01');
   assert.deepEqual(await dates(ids.a),['2026-01-01:10000','2026-02-01:10000','2026-03-01:10000','2026-04-01:12000']);
   // If today's billing was already recorded (the dashboard was opened earlier today), it keeps its amount.
   at('2026-04-20T07:00:00Z');await summary();
   await api('POST','/admin/api/finance/transactions/'+ids.b,{type:'EXPENSE',amountAgorot:6000,date:'2026-01-20',category:'Render',recurring:true,frequency:'MONTHLY'});
   assert.deepEqual((await dates(ids.b)).slice(-1),['2026-04-20:5000']);
   // Frequency changes are prospective too: monthly → yearly records nothing until next January.
   const c=await charge({amountAgorot:3000,date:'2026-01-10',category:'Neon'});ids.c=c.id;
   assert.equal((await dates(c.id)).length,4,'Jan–Apr 10 recorded on creation (start chosen in the past)');
   await api('POST','/admin/api/finance/transactions/'+c.id,{type:'EXPENSE',amountAgorot:3000,date:'2026-01-10',category:'Neon',recurring:true,frequency:'YEARLY'});
   at('2026-05-21T07:00:00Z');await summary();
   assert.deepEqual(await dates(ids.b),['2026-01-20:5000','2026-02-20:5000','2026-03-20:5000','2026-04-20:5000','2026-05-20:6000']);
   assert.equal((await dates(c.id)).length,4,'no May row after switching to yearly');
   // The recurring card shows the next billing date that is not recorded yet.
   const card=(await summary()).recurring;
   assert.equal(card.find((x:any)=>x.id===c.id).nextDate,'2027-01-10');assert.equal(card.find((x:any)=>x.id===ids.a).nextDate,'2026-06-01');
   await noFuture();
  });

  await t.test('6. new category/description apply to later rows only',async()=>{
   at('2026-05-25T07:00:00Z');
   const r=await form('/admin/system/transactions/'+ids.a,{type:'EXPENSE',recurring:'on',amount:'120.00',date:'2026-01-01',category:'תוכנה ושירותים',description:'Shopify Grow',frequency:'MONTHLY'});
   assert.equal(r.status,303);assert.match(r.headers.get('location')!,/notice=rec_updated/);
   assert.ok((await rows(ids.a)).every((x:any)=>x.category==='Shopify'&&x.description==='Shopify Basic'),'recorded rows untouched');
   at('2026-06-02T07:00:00Z');await summary();
   const last=(await rows(ids.a)).at(-1);
   assert.deepEqual([last.d,last.a,last.category,last.description],['2026-06-01','12000','תוכנה ושירותים','Shopify Grow']);
   assert.deepEqual((await f.db.query("SELECT detail FROM admin_audit WHERE action='finance.recurring_update' AND target=$1 ORDER BY at",[ids.a])).rows.map((x:any)=>x.detail),['RECURRING_MONTHLY_TERMS','RECURRING_MONTHLY_DETAILS']);
  });

  await t.test('7. stopping a charge keeps its history; recorded rows cannot be edited or deleted',async()=>{
   const before=await dates(ids.a);assert.equal(before.length,6);
   const page=await(await get('/admin/system?delete='+ids.a)).text();
   assert.match(page,/<h2 id="delete-dialog-title">הפסקת חיוב קבוע<\/h2>/);assert.match(page,/>הפסקה<\/button>/);
   const r=await form('/admin/system/transactions/'+ids.a+'/delete',{confirm:'yes'});
   assert.equal(r.status,303);assert.match(r.headers.get('location')!,/notice=tx_deactivated/);
   const def=(await f.db.query('SELECT active,deactivated_at FROM business_recurring_transactions WHERE id=$1',[ids.a])).rows[0];
   assert.equal(def.active,false);assert.ok(def.deactivated_at);
   at('2026-08-10T07:00:00Z');await summary();
   assert.deepEqual(await dates(ids.a),before,'history kept, nothing new recorded');
   assert.equal((await summary()).recurring.find((x:any)=>x.id===ids.a).status,'INACTIVE');
   assert.equal((await api('POST','/admin/api/finance/transactions/'+ids.a,{type:'EXPENSE',amountAgorot:1,date:'2026-01-01',category:'x',recurring:true,frequency:'MONTHLY'})).status,409);
   assert.match(await(await get('/admin/system?edit='+ids.a)).text(),/החיוב הקבוע הופסק ואינו ניתן לעריכה/);
   const recorded=(await list('?category='+encodeURIComponent('Render'))).entries[0];
   assert.equal(recorded.occurrence,true);
   for(const [path,body] of [['/admin/api/finance/transactions/'+recorded.id,{type:'EXPENSE',amountAgorot:1,date:recorded.date,category:'x'}],['/admin/api/finance/transactions/'+recorded.id+'/delete',{confirm:true}]] as const){
    const res=await api('POST',path,body);assert.equal(res.status,409);assert.equal((await res.json() as any).code,'RECURRING_OCCURRENCE');
   }
   assert.match(await(await get('/admin/system?edit='+recorded.id)).text(),new RegExp('action="/admin/system/transactions/'+ids.b+'"'),'editing a recorded row opens its charge');
   // The June charge has recorded rows by now, so it is stopped; a charge that never recorded anything is deleted.
   const stopped=await(await api('POST','/admin/api/finance/transactions/'+ids.scheduled+'/delete',{confirm:true})).json() as any;
   assert.equal(stopped.deactivated.id,ids.scheduled);assert.equal(stopped.deactivated.occurrences,3);
   const future=await charge({amountAgorot:900,date:'2026-12-01',category:'Shipfn'});
   const del=await api('POST','/admin/api/finance/transactions/'+future.id+'/delete',{confirm:true});
   assert.equal((await del.json() as any).deleted.id,future.id);
   assert.equal((await f.db.query('SELECT 1 FROM business_recurring_transactions WHERE id=$1',[future.id])).rows.length,0);
   await noFuture();
  });

  await t.test('9-10. clients cannot claim an OPS import key; manual charges never carry one',async()=>{
   const key=importKeyOf({service:'Shopify',currency:'ILS'});
   const r=await form('/admin/system/transactions',{type:'EXPENSE',recurring:'on',amount:'120.00',date:'2026-06-01',category:'Shopify',description:'Shopify',frequency:'MONTHLY',importKey:key});
   assert.equal(r.status,303);
   assert.equal(Number((await f.db.query("SELECT COUNT(*)::int AS n FROM business_recurring_transactions WHERE import_key IS NOT NULL AND managed_by IS NULL")).rows[0].n),0);
  });

  await t.test('11-13. KPIs, chart and list read actual rows only, and reconcile',async()=>{
   // Rewrite one recorded row directly: the dashboard follows the stored row, not the charge's amount.
   await f.db.query("UPDATE business_transactions SET amount_agorot=9999 WHERE recurring_definition_id=$1 AND transaction_date='2026-01-01'",[ids.a]);
   const year=await summary('year');
   const sql=async(month:string,type:string)=>Number((await f.db.query("SELECT COALESCE(SUM(amount_agorot),0)::text AS s FROM business_transactions WHERE type=$1 AND to_char(transaction_date,'YYYY-MM')=$2",[type,month])).rows[0].s);
   assert.equal(year.chart[0].expenseAgorot,9999+5000+3000,'Jan: stored rows only');
   for(const m of year.chart){
    assert.equal(m.expenseAgorot,await sql(m.month,'EXPENSE'),m.month);assert.equal(m.incomeAgorot,await sql(m.month,'INCOME'),m.month);
    const l=await list('?month='+m.month);
    assert.deepEqual([l.totals.incomeAgorot,l.totals.expenseAgorot],[m.incomeAgorot,m.expenseAgorot],'list and chart agree for '+m.month);
   }
   const current=year.chart.at(-1);
   assert.deepEqual([year.kpis.incomeAgorot,year.kpis.expenseAgorot,year.kpis.profitAgorot],[current.incomeAgorot,current.expenseAgorot,current.incomeAgorot-current.expenseAgorot]);
   assert.equal(year.kpis.recurringThisMonthAgorot,current.expenseAgorot,'August: only recorded billing rows');
   // A charge with nothing due yet adds nothing anywhere.
   const before=JSON.stringify((await summary('year')).chart);
   await charge({amountAgorot:50000,date:'2026-12-01',category:'מלאי'});
   assert.equal(JSON.stringify((await summary('year')).chart),before);
  });
 }finally{await f.close();}
});

test('Migration 012 moves 011 recurring rows into definitions without losing or doubling history',{timeout:120000},async()=>{
 const engine=new PGlite();
 let tail=Promise.resolve();
 const acquire=async()=>{let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;};
 const query=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 const db:Database={async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},async connect(){const release=await acquire();return {query,release} as Connection;}};
 try{
  // The database as it was after migration 011, with data recorded under 011's model.
  const dir=new URL('../migrations/',import.meta.url);
  await engine.exec('CREATE TABLE schema_migrations (name text PRIMARY KEY)');
  for(const name of readdirSync(dir).filter(n=>/^\d+.*\.sql$/.test(n)&&n<'012').sort()){await engine.exec(readFileSync(new URL(name,dir),'utf8'));await engine.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  const key=importKeyOf({service:'Shopify',currency:'ILS'});
  await engine.exec(`INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,description,recurring,created_by,updated_by) VALUES
   ('00000000-0000-4000-8000-000000000001','INCOME',50000,'2026-11-03','מכירות',NULL,false,'session:aaaaaaaaaaaa','session:aaaaaaaaaaaa')`);
  await engine.query(`INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,description,source,recurring,recurrence_frequency,recurrence_start_date,recurrence_end_date,import_key,created_by,updated_by) VALUES
   ('00000000-0000-4000-8000-000000000002','EXPENSE',12000,'2026-08-31','Shopify','Shopify Basic','SYSTEM',true,'MONTHLY',NULL,NULL,$1,'session:aaaaaaaaaaaa','session:aaaaaaaaaaaa'),
   ('00000000-0000-4000-8000-000000000003','EXPENSE',3000,'2026-01-01','Render',NULL,'MANUAL',true,'QUARTERLY','2026-01-15','2026-07-20',NULL,'session:aaaaaaaaaaaa','session:aaaaaaaaaaaa')`,[key]);
  await migrate(db);
  assert.ok((await db.query("SELECT 1 FROM schema_migrations WHERE name='012_recurring_definitions.sql'")).rows.length);
  assert.ok((await db.query("SELECT 1 FROM schema_migrations WHERE name='013_ops_managed_recurring.sql'")).rows.length);
  // business_transactions now holds the one-off only; the definitions keep their ids, anchors, ends and import key.
  assert.deepEqual((await db.query('SELECT id FROM business_transactions')).rows.map((r:any)=>r.id),['00000000-0000-4000-8000-000000000001']);
  const defs=(await db.query("SELECT id,amount_agorot::text AS a,frequency_months,to_char(start_date,'YYYY-MM-DD') AS s,to_char(end_date,'YYYY-MM-DD') AS e,to_char(effective_from,'YYYY-MM-DD') AS ef,active,import_key,source FROM business_recurring_transactions ORDER BY id")).rows;
  assert.deepEqual(defs.map((d:any)=>[d.id.slice(-1),d.a,Number(d.frequency_months),d.s,d.e,d.ef,d.active,d.import_key,d.source]),
   [['2','12000',1,'2026-08-31',null,'2026-08-31',true,key,'SYSTEM'],['3','3000',3,'2026-01-15','2026-07-20','2026-01-15',true,null,'MANUAL']]);
  await assert.rejects(db.query("INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,recurring,recurrence_frequency,created_by,updated_by) VALUES(gen_random_uuid(),'EXPENSE',1,'2026-01-01','x',true,'MONTHLY','ttt','ttt')"),/business_transactions_actual_only/,'011-style rows are no longer accepted');
  // Recording reproduces exactly what 011 showed (same dates and amounts up to today), once.
  const finance=new Finance(db,[{service:'Shopify',amountCents:12000,currency:'ILS',frequency:'MONTHLY',monthlyCents:12000,note:null,system:null}],()=>new Date('2026-11-17T10:00:00Z'));
  // Migration 013 marks the hand-imported charge as OPS-managed, so synchronization adopts it instead of adding a second one.
  for(let i=0;i<3;i++)await finance.record();
  const recorded=(await db.query("SELECT right(recurring_definition_id::text,1) AS d,to_char(transaction_date,'YYYY-MM-DD') AS t,amount_agorot::text AS a FROM business_transactions WHERE recurring_definition_id IS NOT NULL ORDER BY 1,2")).rows.map((r:any)=>r.d+' '+r.t+' '+r.a);
  assert.deepEqual(recorded,['2 2026-08-31 12000','2 2026-09-30 12000','2 2026-10-31 12000','3 2026-01-15 3000','3 2026-04-15 3000','3 2026-07-15 3000']);
  assert.deepEqual([(await finance.opsCosts())[0].recurringId,(await finance.opsCosts())[0].state],['00000000-0000-4000-8000-000000000002','SYNCED'],'the 011 import is adopted, not duplicated');
  assert.equal((await db.query("SELECT managed_by FROM business_recurring_transactions WHERE id='00000000-0000-4000-8000-000000000002'")).rows[0].managed_by,'OPS_COSTS');
  // Running the migrations again changes nothing.
  await migrate(db);
  assert.equal(Number((await db.query('SELECT COUNT(*)::int AS n FROM business_recurring_transactions')).rows[0].n),2);
 }finally{await engine.close();}
});
