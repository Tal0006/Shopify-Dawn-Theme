// End-to-end renewal of an expired group through the existing admin, on a synthetic expired group: three customers
// (120.40, 88.90 and 141.30 ILS, one product each), payment mode NONE, internal id different from the
// public id. Also: the confirmation race between the Shopify check and the lock, concurrent reopens, Shopify failures,
// atomic rollback, and proof that a reopen creates no payment, order, reservation or outgoing message.
// In-process PGlite with the real migrations, the real Express app and a mocked Shopify: fake data, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {Renewals} from '../src/renewals.js';

const AREA={ofakim:'6f1a2c00-0006-4a00-8000-0000000000a6',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',kiryatGat:'6f1a2c00-0004-4a00-8000-0000000000a4',
 sderot:'6f1a2c00-0007-4a00-8000-0000000000a7',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3'};
const PRICES={'11':'120.40','12':'88.90','13':'141.30'};

test('Group renewal integration (synthetic expired group)',{timeout:300000},async t=>{
 const f=await adminFixture();
 try{
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const api=async(path:string,body?:any)=>{
   const response=await fetch(origin+path,{method:body?'POST':'GET',redirect:'manual',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
   const text=await response.text();let json:any=null;try{json=JSON.parse(text);}catch{}
   return {status:response.status,body:json,text};
  };
  const one=async(sql:string,values:any[]=[])=>(await f.db.query(sql,values)).rows[0];
  const n=async(sql:string,values:any[]=[])=>Number((await one(sql,values)).n);
  const members=async(gid:string)=>(await f.db.query('SELECT * FROM group_members WHERE group_id=$1 ORDER BY created_at,id',[gid])).rows;
  const sideEffects=async()=>({outbound:f.outbound.filter(o=>!o.url.startsWith(origin)).length,
   reservations:await n('SELECT count(*) AS n FROM group_payment_reservations'),charges:await n('SELECT count(*) AS n FROM group_payment_charges'),
   orders:await n('SELECT count(*) AS n FROM group_payment_charges WHERE shopify_order_id IS NOT NULL'),
   paid:await n("SELECT count(*) AS n FROM group_members WHERE payment_status IS NOT NULL AND payment_status<>'NONE'")});
  // The stand-in: one product per customer at the verified amounts, then expired.
  const standIn=async(area:string)=>{
   Object.assign(f.shopify.prices,PRICES);
   const people=[f.person(),f.person(),f.person()];
   const first=await f.groups.joinArea({...people[0],areaPublicId:area,lines:[{variantId:'11',quantity:1}]});
   const id=first.group.publicId,tokens=[first.memberToken];
   tokens.push((await f.groups.join(id,{...people[1],areaPublicId:area,lines:[{variantId:'12',quantity:1}]})).memberToken);
   tokens.push((await f.groups.join(id,{...people[2],areaPublicId:area,lines:[{variantId:'13',quantity:1}]})).memberToken);
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '2 days' WHERE public_id=$1",[id]);await f.groups.expire();
   const g=await one('SELECT * FROM delivery_groups WHERE public_id=$1',[id]);
   const ms=await members(g.id);
   return {id,gid:g.id as string,tokens,ids:ms.map((m:any)=>m.id as string)};
  };
  const realValidator=(f.groups as any).shopify;

  await t.test('workflow: expired view, original amounts, explicit reconfirmation at current prices, reopen counts only reconfirmed pledges',async()=>{
   const s=await standIn(AREA.ofakim);const effects=await sideEffects();
   const g=await one('SELECT * FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.notEqual(g.id,g.public_id,'internal id differs from public id');
   assert.deepEqual([g.status,g.payment_mode,Number(g.threshold_agorot),Number(g.pledged_total_agorot)],['EXPIRED','NONE',50000,35060]);
   // 1-2. The existing list shows it under the expired view; the group page keeps customers, amounts and products.
   assert.ok((await api('/admin/api/groups?view=expired')).body.groups.some((x:any)=>x.publicId===s.id));
   const page=(await api('/admin/groups/'+s.id)).text;
   for(const text of ['120.40','88.90','141.30','ממתין לאישור הלקוח','מוצרים בהתחייבויות','ללא תשלום מקוון'])assert.ok(page.includes(text),text);
   // 4. No reopen without a recorded reconfirmation.
   assert.equal((await api('/admin/api/groups/'+s.id+'/reopen',{confirm:true,days:14})).body.code,'RECONFIRMATION_REQUIRED');
   // 3. Reconfirmation at today's prices: unchanged price passes; a changed price needs the customer's agreed total.
   const a=await api('/admin/api/groups/'+s.id+'/members/'+s.ids[0]+'/reconfirm',{method:'PHONE',reference:'שיחה 27.11'});
   assert.deepEqual([a.status,a.body.confirmedAmountAgorot,a.body.previousAmountAgorot],[200,12040,12040]);
   f.shopify.prices['12']='92.50';
   const changed=await api('/admin/api/groups/'+s.id+'/members/'+s.ids[1]+'/reconfirm',{method:'WHATSAPP'});
   assert.deepEqual([changed.status,changed.body.code],[409,'PRICE_CHANGED']);
   assert.equal(await n('SELECT count(*) AS n FROM member_reconfirmations WHERE member_id=$1',[s.ids[1]]),0,'nothing recorded');
   const agreed=await api('/admin/api/groups/'+s.id+'/members/'+s.ids[1]+'/reconfirm',{method:'WHATSAPP',acceptTotalAgorot:9250});
   assert.deepEqual([agreed.status,agreed.body.confirmedAmountAgorot,agreed.body.previousAmountAgorot],[200,9250,8890]);
   // Before the reopen nothing counts and nothing changed on the stored pledges.
   assert.deepEqual((await members(s.gid)).map((m:any)=>[m.status,Number(m.pledged_total_agorot)]),[['PLEDGED',12040],['PLEDGED',8890],['PLEDGED',14130]]);
   // 5-6. Reopen: two reconfirmed pledges count at the confirmed amounts; the third stays an expired, unconfirmed commitment.
   const r=await api('/admin/api/groups/'+s.id+'/reopen',{confirm:true,days:14});
   assert.equal(r.status,200);assert.deepEqual([r.body.counted,r.body.expiredUnconfirmed,r.body.group.pledgedTotalAgorot,r.body.group.status],[2,1,21290,'OPEN']);
   const after=await members(s.gid);
   assert.deepEqual(after.map((m:any)=>[m.status,Number(m.pledged_total_agorot),m.withdrawn_by]),[['PLEDGED',12040,null],['PLEDGED',9250,null],['WITHDRAWN',0,'EXPIRED']]);
   assert.equal(after[2].cart_snapshot[0].unitAgorot,'14130','original cart and amount kept');
   assert.equal(new Date(after[2].withdrawn_at).getTime(),new Date(g.expires_at).getTime(),'dated at the original expiry');
   assert.equal(await n("SELECT count(*) AS n FROM admin_audit WHERE action='member.withdraw' AND target=$1",[s.id]),0,'never a withdrawal');
   const found=await f.groups.find({areaPublicId:AREA.ofakim});assert.deepEqual([found.group?.publicId,found.group?.pledgedTotalAgorot,found.group?.participantCount],[s.id,21290,2]);
   // 7. Audit trail and recovery links (device receipts).
   const trail=(await f.db.query('SELECT action,result,subject,amount_agorot FROM admin_audit WHERE target=$1 ORDER BY at,id',[s.id])).rows.map((x:any)=>[x.action,x.result,x.amount_agorot===null?null:Number(x.amount_agorot)]);
   // Rows of one transaction share a timestamp: compared as a set.
   assert.deepEqual(trail.filter(x=>x[1]==='OK').map(x=>JSON.stringify(x)).sort(),[['member.reconfirm','OK',12040],['member.reconfirm','OK',9250],['member.expire_unconfirmed','OK',14130],['group.reopen','OK',21290]].map(x=>JSON.stringify(x)).sort());
   assert.ok(trail.some(x=>x[0]==='group.reopen'&&x[1]==='DENIED'),'the refused reopen is audited');
   assert.ok(trail.some(x=>x[0]==='member.reconfirm'&&x[1]==='DENIED'),'the refused price change is audited');
   assert.deepEqual(await Promise.all(s.tokens.map(async tk=>(await f.groups.member(s.id,tk)).status)),['PLEDGED','PLEDGED','WITHDRAWN']);
   // 8. No payment, Shopify order, reservation or outgoing message.
   assert.deepEqual(await sideEffects(),effects);
   // The unconfirmed customer renews from their own receipt, at today's price; counted once.
   await f.groups.update(s.id,s.tokens[2],{lines:[{variantId:'13',quantity:1}]});
   assert.equal(Number((await one('SELECT pledged_total_agorot FROM delivery_groups WHERE id=$1',[s.gid])).pledged_total_agorot),35420);
   await assert.rejects(()=>f.groups.join(s.id,{email:(after[0] as any).email,phone:(after[0] as any).phone,areaPublicId:AREA.ofakim,lines:[{variantId:'11',quantity:1}]}),'no second membership for the same customer');
   f.shopify.prices={};
  });

  await t.test('race: a confirmation replaced while Shopify is being checked refuses the reopen (never marks a reconfirmed customer expired)',async()=>{
   const s=await standIn(AREA.netivot);
   for(const id of s.ids)assert.equal((await api('/admin/api/groups/'+s.id+'/members/'+id+'/reconfirm',{method:'PHONE'})).status,200);
   const plain=new Renewals(f.db,f.groups,realValidator);
   let fired=false;
   const racing=new Renewals(f.db,f.groups,{validate:async(lines:any)=>{
    // While the reopen is checking prices, the owner records a newer confirmation for the first customer (another tab).
    if(!fired){fired=true;await plain.reconfirm(s.id,s.ids[0],{method:'EMAIL'},'session:aaaaaaaaaaaa');}
    return realValidator.validate(lines);
   }} as any);
   await assert.rejects(()=>racing.reopen(s.id,{confirm:true,days:7},'session:bbbbbbbbbbbb'),(e:any)=>e.code==='RENEWAL_CHANGED');
   assert.equal((await one('SELECT status FROM delivery_groups WHERE id=$1',[s.gid])).status,'EXPIRED');
   assert.deepEqual((await members(s.gid)).map((m:any)=>m.status),['PLEDGED','PLEDGED','PLEDGED'],'nobody marked expired');
   assert.equal(await n('SELECT count(*) AS n FROM member_reconfirmations WHERE group_id=$1 AND used_at IS NOT NULL',[s.gid]),0);
   // A retry sees the current confirmations and counts all three.
   const retry=await plain.reopen(s.id,{confirm:true,days:7},'session:bbbbbbbbbbbb');
   assert.deepEqual([retry.counted,retry.expiredUnconfirmed,retry.group.pledgedTotalAgorot],[3,0,35060]);
   f.shopify.prices={};
  });

  await t.test('concurrent reopens: exactly one succeeds, counted once',async()=>{
   const s=await standIn(AREA.kiryatGat);
   for(const id of s.ids.slice(0,2))assert.equal((await api('/admin/api/groups/'+s.id+'/members/'+id+'/reconfirm',{method:'PHONE'})).status,200);
   const both=await Promise.all([1,2].map(()=>api('/admin/api/groups/'+s.id+'/reopen',{confirm:true,days:10})));
   assert.deepEqual(both.map(x=>x.status).sort(),[200,409]);
   assert.equal(Number((await one('SELECT pledged_total_agorot,reopened_count FROM delivery_groups WHERE id=$1',[s.gid])).pledged_total_agorot),20930);
   assert.equal(Number((await one('SELECT reopened_count FROM delivery_groups WHERE id=$1',[s.gid])).reopened_count),1);
   assert.equal(await n("SELECT count(*) AS n FROM admin_audit WHERE action='group.reopen' AND result='OK' AND target=$1",[s.id]),1);
   f.shopify.prices={};
  });

  t.afterEach(()=>{f.shopify.mode='ok';f.shopify.prices={};});
  await t.test('Shopify unavailable or stock short: nothing recorded, nothing reopened, the refusal is audited',async()=>{
   const s=await standIn(AREA.sderot);
   f.shopify.mode='down';
   const down=await api('/admin/api/groups/'+s.id+'/members/'+s.ids[0]+'/reconfirm',{method:'PHONE'});
   assert.ok(down.status>=500||down.body?.code==='SHOPIFY_UNAVAILABLE',JSON.stringify(down.body));
   assert.equal(await n('SELECT count(*) AS n FROM member_reconfirmations WHERE group_id=$1',[s.gid]),0);
   f.shopify.mode='ok';
   assert.equal((await api('/admin/api/groups/'+s.id+'/members/'+s.ids[0]+'/reconfirm',{method:'PHONE'})).status,200);
   f.shopify.mode='down';
   const r=await api('/admin/api/groups/'+s.id+'/reopen',{confirm:true,days:10});
   assert.ok(r.status>=500||r.body?.code==='SHOPIFY_UNAVAILABLE');
   f.shopify.mode='ok';
   assert.equal((await one('SELECT status FROM delivery_groups WHERE id=$1',[s.gid])).status,'EXPIRED');
   assert.ok(await n("SELECT count(*) AS n FROM admin_audit WHERE target=$1 AND result IN ('DENIED','FAILED')",[s.id])>=2);
   // Stock: a stored quantity above what Shopify has available is refused, nothing recorded.
   await f.db.query(`UPDATE group_members SET cart_snapshot=jsonb_set(cart_snapshot,'{0,quantity}','500') WHERE id=$1`,[s.ids[1]]);
   const short=await api('/admin/api/groups/'+s.id+'/members/'+s.ids[1]+'/reconfirm',{method:'PHONE'});
   assert.ok(short.status>=400,JSON.stringify(short.body));
   assert.equal(await n('SELECT count(*) AS n FROM member_reconfirmations WHERE member_id=$1',[s.ids[1]]),0);
   f.shopify.prices={};
  });

  await t.test('atomic: a failure in the middle of a reopen leaves nothing changed',async()=>{
   const s=await standIn(AREA.ashkelon);
   for(const id of s.ids.slice(0,2))assert.equal((await api('/admin/api/groups/'+s.id+'/members/'+id+'/reconfirm',{method:'PHONE'})).status,200);
   const before=await members(s.gid);
   // The audit write inside the transaction fails (simulated by a check that refuses the reopen's audit row).
   await f.db.query("ALTER TABLE admin_audit ADD CONSTRAINT zz_fail_reopen CHECK(action<>'group.reopen' OR result<>'OK') NOT VALID");
   try{await assert.rejects(()=>new Renewals(f.db,f.groups,realValidator).reopen(s.id,{confirm:true,days:7},'session:cccccccccccc'));}
   finally{await f.db.query('ALTER TABLE admin_audit DROP CONSTRAINT zz_fail_reopen');}
   const g=await one('SELECT status,reopened_count,pledged_total_agorot FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.deepEqual([g.status,Number(g.reopened_count),Number(g.pledged_total_agorot)],['EXPIRED',0,35060]);
   assert.deepEqual(await members(s.gid),before,'members untouched');
   assert.equal(await n('SELECT count(*) AS n FROM member_reconfirmations WHERE group_id=$1 AND used_at IS NOT NULL',[s.gid]),0);
   assert.equal(await n("SELECT count(*) AS n FROM admin_audit WHERE action='member.expire_unconfirmed' AND target=$1",[s.id]),0,'no partial audit');
   f.shopify.prices={};
  });
 }finally{await f.close();}
});
