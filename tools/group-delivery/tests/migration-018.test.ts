// Migration 018 (order lifecycle) on a disposable database built with the real migrations 001-017 and data shaped
// like production (active, withdrawn, expired-unconfirmed and admin-removed orders; join and recovery receipts; a
// used reconfirmation). It must change no existing value, replace exactly the intended constraints, backfill one
// BASELINE cart version per order, keep the duplicate protection for open orders, and be a no-op when run again.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../src/db.js';

const MIG=new URL('../migrations/',import.meta.url);
async function through(last:string){
 const db=new PGlite(await mkdtemp(join(tmpdir(),'m018-')));
 await db.query('CREATE TABLE IF NOT EXISTS schema_migration_lock (id integer PRIMARY KEY)');
 await db.query('INSERT INTO schema_migration_lock(id) VALUES(1) ON CONFLICT DO NOTHING');
 await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
 for(const name of (await readdir(MIG)).filter(n=>/^\d+.*\.sql$/.test(n)).sort()){
  if(name>last)break;
  await db.exec('BEGIN;'+await readFile(new URL(name,MIG),'utf8')+';COMMIT;');
  await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
 }
 return db;
}
// As in tests/admin-fixture.ts: parameterless statements (whole migration files) go through exec.
const run=(db:PGlite)=>async(s:string,v?:any[]):Promise<any>=>v?db.query(s,v):(await db.exec(s)).at(-1)||{rows:[]};
const wrap=(db:PGlite):any=>({query:run(db),connect:async()=>({query:run(db),release(){}})});
const rows=async(db:PGlite,sql:string,v:any[]=[])=>(await db.query(sql,v)).rows as any[];
// Every existing column of every existing row, as text (the columns 018 adds are left out).
const fingerprint=async(db:PGlite)=>({
 members:(await rows(db,"SELECT md5(string_agg((to_jsonb(m)-'order_state'-'locked_at'-'locked_reason')::text,',' ORDER BY id)) AS h FROM group_members m"))[0].h,
 groups:(await rows(db,"SELECT md5(string_agg(to_jsonb(g)::text,',' ORDER BY id)) AS h FROM delivery_groups g"))[0].h,
 tokens:(await rows(db,"SELECT md5(string_agg(to_jsonb(t)::text,',' ORDER BY id)) AS h FROM member_tokens t"))[0].h,
 reconfirmations:(await rows(db,"SELECT md5(string_agg(to_jsonb(r)::text,',' ORDER BY id)) AS h FROM member_reconfirmations r"))[0].h});

test('Migration 018 on a disposable database with production-shaped data',{timeout:120000},async t=>{
 const db=await through('017_group_renewals.sql');
 const g1=randomUUID(),g2=randomUUID();
 await db.query(`INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,status,expires_at,reopened_count) VALUES
  ($1,$2,'Area A','a',50000,59440,'THRESHOLD_REACHED',NOW()+INTERVAL '14 days',1),($3,$4,'Area B','b',50000,0,'EXPIRED',NOW()-INTERVAL '1 day',0)`,[g1,randomUUID(),g2,randomUUID()]);
 const member=async(group:string,email:string,amount:number,status='PLEDGED',by:string|null=null)=>{
  const id=randomUUID();
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash,status,withdrawn_by,withdrawn_at)
   VALUES($1,$2,$3,$4,'a',$5::jsonb,$6,$7,$8,$9,CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END)`,
   [id,group,email,'05'+String(Math.floor(Math.random()*1e8)).padStart(8,'0'),JSON.stringify([{variantId:'gid://shopify/ProductVariant/1',quantity:1,unitAgorot:String(amount||100)}]),amount,'h-'+id,status,by]);
  await db.query("INSERT INTO member_tokens(id,member_id,token_hash,source) VALUES($1,$2,$3,'JOIN')",[randomUUID(),id,'h-'+id]);
  return id;
 };
 const a=await member(g1,'a@example.test',8610),b=await member(g1,'b@example.test',12730);await member(g1,'c@example.test',9860);await member(g1,'d@example.test',28240);
 await member(g2,'e@example.test',0,'WITHDRAWN','EXPIRED');await member(g2,'f@example.test',0,'WITHDRAWN','ADMIN');await member(g2,'g@example.test',0,'WITHDRAWN','MEMBER');
 await db.query("INSERT INTO member_tokens(id,member_id,token_hash,source) VALUES($1,$2,'recovered-hash','RECOVERY')",[randomUUID(),b]);
 await db.query(`INSERT INTO member_reconfirmations(id,group_id,member_id,method,previous_amount_agorot,confirmed_amount_agorot,confirmed_snapshot,recorded_by,used_at)
  VALUES($1,$2,$3,'PHONE',11240,11240,'[{"variantId":"gid://shopify/ProductVariant/31","quantity":1,"unitAgorot":"11240"}]'::jsonb,'session:aaaaaaaaaaaa',NOW())`,[randomUUID(),g1,a]);
 const before=await fingerprint(db);
 const uniques=await rows(db,"SELECT conname,pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='u' ORDER BY 1");
 assert.deepEqual(uniques.map(u=>u.d).sort(),['UNIQUE (group_id, email)','UNIQUE (group_id, phone)','UNIQUE (token_hash)'],'production shape before 018');

 await t.test('applied by the start-up runner: registered, every existing value unchanged, BASELINE backfilled',async()=>{
  await migrate(wrap(db));
  assert.deepEqual((await rows(db,'SELECT max(name) AS last,count(*)::int AS n FROM schema_migrations'))[0],{last:'018_order_lifecycle.sql',n:18});
  assert.deepEqual(await fingerprint(db),before,'no existing row or value changed');
  assert.deepEqual((await rows(db,"SELECT count(*)::int AS n FROM group_members WHERE order_state<>'OPEN' OR locked_at IS NOT NULL OR locked_reason IS NOT NULL"))[0].n,0,'every order stays open');
  const versions=await rows(db,"SELECT count(*)::int AS n,bool_and(v.source='BASELINE' AND v.cart_snapshot=m.cart_snapshot AND v.amount_agorot=m.pledged_total_agorot) AS same FROM member_cart_versions v JOIN group_members m ON m.id=v.member_id");
  assert.deepEqual(versions[0],{n:7,same:true},'one BASELINE version per order, equal to its cart');
  for(const table of ['member_payment_records','member_links','group_cycle_splits'])assert.equal((await rows(db,'SELECT count(*)::int AS n FROM '+table))[0].n,0,table+' starts empty');
 });
 await t.test('constraints: exactly the intended replacements',async()=>{
  const uniques=await rows(db,"SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='u'");
  assert.deepEqual(uniques.map(u=>u.d),['UNIQUE (token_hash)'],'the per-group email/phone constraints became partial indexes');
  const idx=await rows(db,"SELECT indexname,indexdef FROM pg_indexes WHERE tablename='group_members' AND indexname LIKE 'group_members_open_%' ORDER BY 1");
  assert.deepEqual(idx.map(i=>i.indexname),['group_members_open_email','group_members_open_phone']);
  assert.ok(idx.every(i=>/UNIQUE INDEX/.test(i.indexdef)&&/WHERE \(order_state = 'OPEN'::text\)/.test(i.indexdef)));
  const checks=await rows(db,"SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%withdrawn_by%'");
  assert.equal(checks.length,1);for(const v of ['MEMBER','ADMIN','EXPIRED','TRANSFERRED'])assert.ok(checks[0].d.includes("'"+v+"'"),v);
  const sources=await rows(db,"SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid='member_tokens'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%source%'");
  assert.equal(sources.length,1);for(const v of ['JOIN','RECOVERY','LINK'])assert.ok(sources[0].d.includes("'"+v+"'"),v);
 });
 await t.test('protection kept: no second OPEN order with the same e-mail or phone in a group; unknown values refused',async()=>{
  const dup=(email:string,phone:string)=>db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES($1,$2,$3,$4,'a','[]'::jsonb,1,$5)",[randomUUID(),g1,email,phone,'dup-'+randomUUID()]);
  await assert.rejects(()=>dup('a@example.test','0599999999'),'same e-mail');
  const phone=(await rows(db,'SELECT phone FROM group_members WHERE id=$1',[b]))[0].phone;
  await assert.rejects(()=>dup('new@example.test',phone),'same phone');
  // A locked order no longer blocks a separate new order of the same customer (the only intended relaxation).
  await db.query("UPDATE group_members SET order_state='LOCKED',locked_at=NOW(),locked_reason='PAID_EXTERNAL' WHERE id=$1",[a]);
  await dup('a@example.test','0598888888');
  await assert.rejects(()=>dup('a@example.test','0597777777'),'still only one OPEN order');
  await assert.rejects(()=>db.query("UPDATE group_members SET order_state='LOCKED' WHERE id=$1",[b]),'a lock needs its time and reason');
  await assert.rejects(()=>db.query("UPDATE group_members SET withdrawn_by='SOMETHING' WHERE id=$1",[b]));
  await assert.rejects(()=>db.query("INSERT INTO member_tokens(id,member_id,token_hash,source) VALUES($1,$2,'x-hash','OTHER')",[randomUUID(),b]));
 });
 await t.test('the runner again: nothing to apply',async()=>{
  const n0=(await rows(db,'SELECT count(*)::int AS n FROM member_cart_versions'))[0].n;
  await migrate(wrap(db));
  assert.equal((await rows(db,'SELECT count(*)::int AS n FROM schema_migrations'))[0].n,18);
  assert.equal((await rows(db,'SELECT count(*)::int AS n FROM member_cart_versions'))[0].n,n0,'no second backfill');
 });
});
