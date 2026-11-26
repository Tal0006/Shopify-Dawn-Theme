// The manual rollback script for migration 017 (ops/rollback-017-group-renewals.sql): it refuses, changing nothing, once
// the feature was used; on an unused schema it restores the 004 shape exactly and 017 applies again cleanly.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {adminFixture,AREA} from './admin-fixture.js';
import {migrate} from '../src/db.js';

test('Migration 017 rollback script',{timeout:120000},async t=>{
 const f=await adminFixture();
 const script=await readFile(new URL('../ops/rollback-017-group-renewals.sql',import.meta.url),'utf8');
 const run=async()=>{try{await f.db.query(script);}catch(e){await f.db.query('ROLLBACK').catch(()=>{});throw e;}};
 const has=async(sql:string)=>(await f.db.query(sql)).rows.length>0;
 const table=()=>has("SELECT 1 FROM information_schema.tables WHERE table_name='member_reconfirmations'");
 try{
  await t.test('refuses once a membership carries reason EXPIRED, and changes nothing',async()=>{
   const joined=await f.groups.joinArea({...f.person(),areaPublicId:AREA.sderot,lines:[{variantId:'1',quantity:1}]});
   await f.db.query("UPDATE group_members SET status='WITHDRAWN',pledged_total_agorot=0,withdrawn_at=NOW(),withdrawn_by='EXPIRED' WHERE group_id=(SELECT id FROM delivery_groups WHERE public_id=$1)",[joined.group.publicId]);
   await assert.rejects(run,/rollback refused/);
   assert.ok(await table(),'schema untouched');
   assert.ok(await has("SELECT 1 FROM schema_migrations WHERE name='017_group_renewals.sql'"));
   await f.db.query("UPDATE group_members SET withdrawn_by='MEMBER' WHERE withdrawn_by='EXPIRED'");
  });
  await t.test('on an unused schema: restores the 004 check and drops the 017 objects; 017 then applies again',async()=>{
   await run();
   assert.equal(await table(),false);
   assert.equal(await has("SELECT 1 FROM information_schema.columns WHERE table_name='delivery_groups' AND column_name IN ('reopened_count','last_reopened_at')"),false);
   await assert.rejects(()=>f.db.query("UPDATE group_members SET withdrawn_by='EXPIRED' WHERE withdrawn_by='MEMBER'"),'004 check restored');
   await migrate(f.db);
   assert.ok(await table(),'017 re-applied');
   await f.db.query("UPDATE group_members SET withdrawn_by='EXPIRED' WHERE withdrawn_by='MEMBER'");
  });
 }finally{await f.close();}
});
