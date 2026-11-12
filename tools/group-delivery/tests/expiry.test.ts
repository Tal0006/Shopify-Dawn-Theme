// Automatic expiry ends only the customer-pledging phase. Approved groups keep their business status through the whole
// delivery workflow; completed and already-expired groups are never rewritten.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminFixture} from './admin-fixture.js';

test('Expiry maintenance',{timeout:120000},async t=>{
 const f=await adminFixture();
 try{
  const ids=await f.seed();
  const statusOf=async(id:string)=>(await f.db.query('SELECT status,operational_status,updated_at,completed_at FROM delivery_groups WHERE public_id=$1',[id])).rows[0];
  // Groups well past the expiry window (created 20 days ago, deadline 13 days ago), in every relevant state.
  const old=async(status:string,operational='NEW')=>{
   const id=randomUUID();
   await f.db.query(`INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,status,operational_status,completed_at,created_at,updated_at,expires_at)
    VALUES($1,$2,'בדיקה','בדיקה',50000,$3,$4,$5,$6,NOW()-INTERVAL '20 days',NOW()-INTERVAL '19 days',NOW()-INTERVAL '13 days')`,
    [randomUUID(),id,status==='OPEN'?10000:60000,status,operational,operational==='COMPLETED'?new Date(Date.now()-86400000):null]);
   return id;
  };

  await t.test('only OPEN and THRESHOLD_REACHED expire; approved, completed and expired groups are left exactly as they are',async()=>{
   const cases={
    open:await old('OPEN'),reached:await old('THRESHOLD_REACHED'),
    approved:await old('APPROVED'),approvedInProgress:await old('APPROVED','IN_PROGRESS'),approvedReady:await old('APPROVED','READY_FOR_DELIVERY'),approvedOut:await old('APPROVED','OUT_FOR_DELIVERY'),
    approvedCompleted:await old('APPROVED','COMPLETED'),openCompleted:await old('OPEN','COMPLETED'),reachedCompleted:await old('THRESHOLD_REACHED','COMPLETED'),
    expired:await old('EXPIRED'),expiredInProgress:await old('EXPIRED','IN_PROGRESS'),
   };
   const before=Object.fromEntries(await Promise.all(Object.entries(cases).map(async([name,id])=>[name,await statusOf(id)])));
   await f.groups.expire();await f.groups.expire();
   const after=Object.fromEntries(await Promise.all(Object.entries(cases).map(async([name,id])=>[name,await statusOf(id)])));
   assert.equal(after.open.status,'EXPIRED');assert.equal(after.reached.status,'EXPIRED');
   for(const name of ['approved','approvedInProgress','approvedReady','approvedOut','approvedCompleted','openCompleted','reachedCompleted','expired','expiredInProgress'])
    assert.deepEqual(after[name],before[name],name+' must not be touched (status, operational status, updated_at, completed_at)');
   assert.deepEqual(['approved','approvedInProgress','approvedReady','approvedOut'].map(name=>after[name].status),['APPROVED','APPROVED','APPROVED','APPROVED']);
   assert.equal(after.expired.status,'EXPIRED','an existing EXPIRED group is not restored');
  });

  await t.test('the real flow: an approved group past its deadline stays APPROVED through delivery to completion',async()=>{
   const id=ids.approved;
   await f.db.query("UPDATE delivery_groups SET created_at=NOW()-INTERVAL '30 days',expires_at=NOW()-INTERVAL '23 days' WHERE public_id=$1",[id]);
   const {cookie}=await f.login();
   for(const status of ['IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY']){
    await f.groups.setOperationalStatus(id,{status},'session:000000000000');
    // Every read path runs expiry first: public aggregate (locked), admin JSON and the admin dashboard.
    assert.equal((await f.groups.get(id)).status,'APPROVED',status);
    const admin=await(await fetch(f.cfg.origin+'/admin/api/groups/'+id,{headers:{Cookie:cookie}})).json() as any;
    assert.deepEqual([admin.group.status,admin.group.operationalStatus],['APPROVED',status]);
   }
   await (await fetch(f.cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   assert.equal((await statusOf(id)).status,'APPROVED');
   await f.groups.setOperationalStatus(id,{status:'COMPLETED',confirm:true},'session:000000000000');
   await f.groups.expire();
   assert.deepEqual([(await statusOf(id)).status,(await statusOf(id)).operational_status],['APPROVED','COMPLETED']);
   // The seeded expired group stays EXPIRED; the expiry duration for open groups is unchanged (config.expiryDays).
   assert.equal((await statusOf(ids.expired)).status,'EXPIRED');
   const fresh=await f.groups.joinArea({...f.person(),areaPublicId:'6f1a2c00-0005-4a00-8000-0000000000a5',lines:[{variantId:'1',quantity:1}]});
   const row=(await f.db.query("SELECT EXTRACT(EPOCH FROM (expires_at-created_at))/86400 AS days FROM delivery_groups WHERE public_id=$1",[fresh.group.publicId])).rows[0];
   assert.equal(Math.round(Number(row.days)),f.cfg.expiryDays);
  });
 }finally{await f.close();}
});
