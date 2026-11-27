// Order lifecycle (migration 018, src/orders.ts): locked (paid or delivered) orders, separate "another order", owner
// payment attestation, and the owner cycle split that repairs an overwritten paid order. Builds a synthetic case
// with fake customers: three orders paid outside the system, one overwritten by a second order (update-pledge), a
// fourth customer pushing the cycle to THRESHOLD_REACHED. In-process PGlite with the real migrations, the real Express
// app and a mocked Shopify: fake data, no network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {Renewals} from '../src/renewals.js';
import {Orders} from '../src/orders.js';

const AREA={ofakim:'6f1a2c00-0006-4a00-8000-0000000000a6',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',kiryatGat:'6f1a2c00-0004-4a00-8000-0000000000a4',
 sderot:'6f1a2c00-0007-4a00-8000-0000000000a7',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3',beerSheva:'6f1a2c00-0001-4a00-8000-0000000000a1',ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2'};
// A's original order: 5 lines, 112.40. A's second order: 4 lines, 86.10. B 127.30, C 98.60, D 2 x 141.20 = 282.40.
const PRICES:Record<string,string>={'31':'20.00','32':'25.00','33':'30.00','34':'12.40','35':'25.00','41':'20.00','42':'30.00','43':'16.10','44':'20.00','12':'127.30','13':'98.60','51':'141.20'};
const ORIGINAL=['31','32','33','34','35'].map(v=>({variantId:v,quantity:1})),SECOND=['41','42','43','44'].map(v=>({variantId:v,quantity:1}));
const SESSION='session:aaaaaaaaaaaa';

test('Order lifecycle and cycle split',{timeout:400000},async t=>{
 const f=await adminFixture();
 try{
  Object.assign(f.shopify.prices,PRICES);
  const validator=(f.groups as any).shopify;
  const renewals=new Renewals(f.db,f.groups,validator),orders=new Orders(f.db,f.groups,validator);
  const {cookie,csrf}=await f.login();
  const api=async(path:string,body?:any,auth=true)=>{
   const r=await fetch(f.cfg.origin+path,{method:body?'POST':'GET',redirect:'manual',headers:{...(auth?{Cookie:cookie,'X-CSRF-Token':csrf}:{}),Origin:f.cfg.origin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
   const text=await r.text();let json:any=null;try{json=JSON.parse(text);}catch{}
   return {status:r.status,body:json};
  };
  const one=async(sql:string,v:any[]=[])=>(await f.db.query(sql,v)).rows[0];
  const n=async(sql:string,v:any[]=[])=>Number((await one(sql,v)).n);
  const fp=async(sql:string,v:any[])=>(await one('SELECT md5(('+sql+')::text) AS h',v)).h;
  // A synthetic overwrite case: 3 paid orders, reopened with reconfirmations, A's second order overwrites the first, D joins.
  const scenario=async(area:string)=>{
   const people=[f.person(),f.person(),f.person(),f.person()];
   const a=await f.groups.joinArea({...people[0],areaPublicId:area,lines:ORIGINAL});const id=a.group.publicId;
   const b=await f.groups.join(id,{...people[1],areaPublicId:area,lines:[{variantId:'12',quantity:1}]});
   const c=await f.groups.join(id,{...people[2],areaPublicId:area,lines:[{variantId:'13',quantity:1}]});
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '2 days' WHERE public_id=$1",[id]);await f.groups.expire();
   const gid=(await one('SELECT id FROM delivery_groups WHERE public_id=$1',[id])).id;
   const [A,B,C]=(await f.db.query('SELECT id FROM group_members WHERE group_id=$1 ORDER BY created_at',[gid])).rows.map((x:any)=>x.id as string);
   for(const m of [A,B,C])await renewals.reconfirm(id,m,{method:'PHONE'},SESSION);
   await renewals.reopen(id,{confirm:true,days:14},SESSION);
   await f.groups.update(id,a.memberToken,{lines:SECOND});
   const d=await f.groups.joinArea({...people[3],areaPublicId:area,lines:[{variantId:'51',quantity:2}]});
   assert.equal(d.group.publicId,id,'D joined the same (open) cycle');
   const D=(await one('SELECT id FROM group_members WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1',[gid])).id;
   const reconfirmation=(await one('SELECT id FROM member_reconfirmations WHERE member_id=$1 AND used_at IS NOT NULL',[A])).id;
   return {id,gid,A,B,C,D,reconfirmation,tokens:{a:a.memberToken,b:b.memberToken,c:c.memberToken,d:d.memberToken},people};
  };
  const plan=(s:any)=>({restore:[{memberId:s.A,reconfirmationId:s.reconfirmation}],transfer:[s.D]});

  await t.test('THRESHOLD_REACHED: the overwritten cycle stops matching new customers; members can still edit; nothing automatic runs',async()=>{
   const s=await scenario(AREA.ofakim);
   const g=await one('SELECT status,pledged_total_agorot,payment_state,paid_total_agorot FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.deepEqual([g.status,Number(g.pledged_total_agorot),g.payment_state,Number(g.paid_total_agorot)],['THRESHOLD_REACHED',59440,null,0]);
   const found=await f.groups.find({areaPublicId:AREA.ofakim});
   assert.deepEqual([found.group,found.canCreateOnJoin],[null,true],'the next customer would start a new cycle');
   assert.equal(await n('SELECT count(*) AS n FROM group_payment_charges'),0,'no payment was triggered');
   // The overwrite is reproduced exactly: the original cart is gone from the member row, kept only in the reconfirmation.
   assert.equal(Number((await one('SELECT pledged_total_agorot FROM group_members WHERE id=$1',[s.A])).pledged_total_agorot),8610);
   assert.equal(Number((await one('SELECT confirmed_amount_agorot FROM member_reconfirmations WHERE id=$1',[s.reconfirmation])).confirmed_amount_agorot),11240);
   (globalThis as any).scenario1=s;
  });

  await t.test('cycle split: preview, then restore 112.40, separate 86.10, carry 282.40 once, close the old cycle without claiming its target',async()=>{
   const s=(globalThis as any).scenario1;
   const before={B:await fp('SELECT cart_snapshot FROM group_members WHERE id=$1',[s.B]),C:await fp('SELECT cart_snapshot FROM group_members WHERE id=$1',[s.C]),
    secondCart:await fp('SELECT cart_snapshot FROM group_members WHERE id=$1',[s.A]),dCart:await fp('SELECT cart_snapshot FROM group_members WHERE id=$1',[s.D]),
    original:await fp('SELECT confirmed_snapshot FROM member_reconfirmations WHERE id=$1',[s.reconfirmation])};
   const preview=(await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body;
   assert.deepEqual(preview.blockers,[]);
   assert.deepEqual([preview.before.status,preview.before.totalAgorot,preview.before.orders],['THRESHOLD_REACHED',59440,4]);
   assert.deepEqual([preview.after.source.status,preview.after.source.totalAgorot,preview.after.source.orders,preview.after.source.thresholdMet],['COMPLETED',33830,3,false]);
   assert.deepEqual([preview.after.target.created,preview.after.target.totalAgorot,preview.after.target.orders],[true,36850,2]);
   assert.deepEqual(preview.restore.map((r:any)=>[r.currentAgorot,r.restoredAgorot,r.restoredLines,r.restoredFingerprint,r.newOrderAgorot]),[[8610,11240,5,before.original,8610]]);
   assert.deepEqual(preview.priceChanges,[]);
   // Refused without the explicit confirmations, the reason or the previewed state; refused without a session.
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split',{...plan(s),confirm:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:preview.state})).body.code,'SPLIT_CONFIRMATION_REQUIRED');
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split',{...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:'stale'})).body.code,'SPLIT_STATE_CHANGED');
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split',{...plan(s)},false)).status,401);
   const key=crypto.randomUUID();
   const body={...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:key,expectedState:preview.state};
   const r=await api('/admin/api/groups/'+s.id+'/cycle-split',body);
   assert.equal(r.status,200,JSON.stringify(r.body));
   assert.deepEqual([r.body.source.status,r.body.source.totalAgorot,r.body.source.orders,r.body.source.thresholdMet],['COMPLETED',33830,3,false]);
   assert.deepEqual([r.body.target.created,r.body.target.status,r.body.target.totalAgorot,r.body.target.orders],[true,'OPEN',36850,2]);
   const target=await one('SELECT * FROM delivery_groups WHERE public_id=$1',[r.body.target.publicId]);
   assert.deepEqual([Number(target.threshold_agorot),target.payment_mode,target.area_id!==null],[50000,'NONE',true]);
   // Old cycle: three historical orders, locked; A restored exactly; B and C unchanged; D kept as TRANSFERRED history.
   const old=(await f.db.query('SELECT id,status,pledged_total_agorot,order_state,locked_reason,withdrawn_by,md5(cart_snapshot::text) AS h,jsonb_array_length(cart_snapshot) AS lines FROM group_members WHERE group_id=$1 ORDER BY created_at',[s.gid])).rows;
   assert.deepEqual(old.map((m:any)=>[m.status,Number(m.pledged_total_agorot),m.order_state,m.locked_reason,m.withdrawn_by]),
    [['PLEDGED',11240,'LOCKED','DELIVERED',null],['PLEDGED',12730,'LOCKED','DELIVERED',null],['PLEDGED',9860,'LOCKED','DELIVERED',null],['WITHDRAWN',0,'OPEN',null,'TRANSFERRED']]);
   assert.deepEqual([old[0].h,Number(old[0].lines)],[before.original,5],'A: the verified original cart, all 5 lines');
   assert.deepEqual([old[1].h,old[2].h],[before.B,before.C],'B and C untouched');
   assert.equal(old[3].h,before.dCart,'D: its cart kept as history');
   const g=await one('SELECT status,operational_status,pledged_total_agorot,completed_by FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.deepEqual([g.status,g.operational_status,Number(g.pledged_total_agorot)],['OPEN','COMPLETED',33830],'business status below the target: never claimed as reached');
   assert.match(g.completed_by,/^session:[a-f0-9]{12}$/,'completed by the owner session that ran the split');
   // New cycle: A's second order (new id, same 4-line cart) and D's order, each exactly once.
   const fresh=(await f.db.query('SELECT id,status,pledged_total_agorot,order_state,md5(cart_snapshot::text) AS h FROM group_members WHERE group_id=$1 ORDER BY pledged_total_agorot',[target.id])).rows;
   assert.deepEqual(fresh.map((m:any)=>[m.status,Number(m.pledged_total_agorot),m.order_state,m.h]),[['PLEDGED',8610,'OPEN',before.secondCart],['PLEDGED',28240,'OPEN',before.dCart]]);
   assert.ok(!fresh.some((m:any)=>[s.A,s.B,s.C,s.D].includes(m.id)),'new ids: rows never move');
   assert.equal(await n("SELECT count(*) AS n FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.area_id=$1 AND m.status='PLEDGED'",[target.area_id]),5,'five distinct orders');
   // Audit trail and cart versions.
   const actions=(await f.db.query("SELECT action,detail,amount_agorot FROM admin_audit WHERE result='OK' AND action IN ('member.order_restore','member.order_split','member.transfer','group.complete','group.cycle_split') ORDER BY action")).rows.map((x:any)=>[x.action,Number(x.amount_agorot)]);
   assert.deepEqual(actions,[['group.complete',33830],['group.cycle_split',33830],['member.order_restore',11240],['member.order_split',8610],['member.transfer',28240]]);
   assert.deepEqual((await f.db.query('SELECT source,amount_agorot FROM member_cart_versions WHERE member_id=$1 ORDER BY recorded_at,id',[s.A])).rows.map((x:any)=>[x.source,Number(x.amount_agorot)]),
    [['JOIN',11240],['REOPEN',11240],['CUSTOMER_UPDATE',8610],['ADMIN_RESTORE',11240]],'every cart A ever had');
   // Idempotent: the same key replays the result and writes nothing.
   const counts=async()=>[await n('SELECT count(*) AS n FROM group_members'),await n('SELECT count(*) AS n FROM delivery_groups'),await n('SELECT count(*) AS n FROM admin_audit')];
   const c0=await counts();
   const again=await api('/admin/api/groups/'+s.id+'/cycle-split',body);
   assert.deepEqual([again.status,again.body.replayed,again.body.target.publicId],[200,true,r.body.target.publicId]);
   assert.deepEqual(await counts(),c0);
   // Future customers join the new cycle.
   const next=await f.groups.joinArea({...f.person(),areaPublicId:AREA.ofakim,lines:[{variantId:'12',quantity:1}]});
   assert.equal(next.group.publicId,r.body.target.publicId);
   (globalThis as any).split1={s,target:r.body.target.publicId};
  });

  await t.test('receipts: the original receipt opens its historical order and the linked new one; locked orders never change',async()=>{
   const {s,target}=(globalThis as any).split1;
   const a=await f.groups.memberState(s.id,s.tokens.a);
   assert.deepEqual([a.member.status,a.member.pledgedTotalAgorot,(a.member as any).orderState,(a.member as any).linkedGroupPublicIds],['PLEDGED',11240,'LOCKED',[target]]);
   await assert.rejects(()=>f.groups.update(s.id,s.tokens.a,{lines:SECOND}),(e:any)=>e.code==='ORDER_LOCKED','no third overwrite');
   await assert.rejects(()=>f.groups.withdraw(s.id,s.tokens.a,{confirm:true}),(e:any)=>e.code==='ORDER_LOCKED');
   const linked=await orders.linkedReceipts(s.id,s.tokens.a);
   assert.equal(linked.orders.length,1);assert.equal(linked.orders[0].groupPublicId,target);
   const second=await f.groups.memberState(target,linked.orders[0].memberToken);
   assert.deepEqual([second.member.status,second.member.pledgedTotalAgorot],['PLEDGED',8610]);
   // The new order is open: the customer can edit it (explicitly) without touching the historical one.
   await f.groups.update(target,linked.orders[0].memberToken,{lines:[{variantId:'41',quantity:2},...SECOND.slice(1)]});
   assert.equal(Number((await one('SELECT pledged_total_agorot FROM group_members WHERE id=$1',[s.A])).pledged_total_agorot),11240,'historical order unchanged');
   await f.groups.update(target,linked.orders[0].memberToken,{lines:SECOND});
   // D: the old receipt shows the history (TRANSFERRED) and opens the carried order.
   const d=await f.groups.memberState(s.id,s.tokens.d);
   assert.deepEqual([d.member.status,(d.member as any).linkedGroupPublicIds],['WITHDRAWN',[target]]);
   const dLinked=await orders.linkedReceipts(s.id,s.tokens.d);
   assert.equal((await f.groups.memberState(target,dLinked.orders[0].memberToken)).member.pledgedTotalAgorot,28240);
   // B and C: their receipts read their locked historical orders; nothing can change them.
   assert.equal(((await f.groups.memberState(s.id,s.tokens.b)).member as any).orderState,'LOCKED');
   await assert.rejects(()=>f.groups.update(s.id,s.tokens.b,{lines:[{variantId:'13',quantity:1}]}),(e:any)=>e.code==='ORDER_LOCKED');
   await assert.rejects(()=>f.groups.adminWithdraw(s.id,s.B,{confirm:true}),(e:any)=>e.code==='ORDER_LOCKED'||e.code==='GROUP_CLOSED');
   // The historical cycle can never be renewed again.
   assert.ok((await renewals.state(s.id)).blockers?.length!==0||!(await renewals.state(s.id)).expired);
  });

  await t.test('owner payment attestation: separate step, exact amount, idempotent, never a charge or Shopify payment',async()=>{
   const {s}=(globalThis as any).split1;
   const pay=(member:string,body:any)=>api('/admin/api/groups/'+s.id+'/members/'+member+'/external-payment',body);
   assert.equal((await pay(s.A,{amountAgorot:11240,method:'BANK_TRANSFER',receivedOn:'2026-11-20'})).body.code,'INVALID_PAYMENT_RECORD','explicit attestation required');
   assert.equal((await pay(s.A,{attest:true,amountAgorot:8610,method:'BANK_TRANSFER',receivedOn:'2026-11-20'})).body.code,'INVALID_PAYMENT_RECORD','amount must be the order total');
   assert.equal((await pay(s.A,{attest:true,amountAgorot:11240,method:'BANK_TRANSFER',receivedOn:'2026-11-20',reference:'dana@example.test'})).body.code,'INVALID_PAYMENT_RECORD','no contact details');
   const ok=await pay(s.A,{attest:true,amountAgorot:11240,method:'BANK_TRANSFER',receivedOn:'2026-11-20',reference:'אסמכתא 4471'});
   assert.deepEqual([ok.status,ok.body.recorded],[200,true]);
   assert.deepEqual((await pay(s.A,{attest:true,amountAgorot:11240,method:'BANK_TRANSFER',receivedOn:'2026-11-20',reference:'אסמכתא 4471'})).body,{memberId:s.A,recorded:false,locked:true},'retry is a no-op');
   assert.equal((await pay(s.A,{attest:true,amountAgorot:11240,method:'CASH',receivedOn:'2026-11-21'})).body.code,'PAYMENT_ALREADY_RECORDED');
   for(const [m,amount] of [[s.B,12730],[s.C,9860]] as const)assert.equal((await pay(m,{attest:true,amountAgorot:amount,method:'CASH',receivedOn:'2026-11-19'})).status,200);
   const rec=(await f.db.query('SELECT p.amount_agorot,p.cart_fingerprint=md5(m.cart_snapshot::text) AS matches FROM member_payment_records p JOIN group_members m ON m.id=p.member_id WHERE p.group_id=$1 ORDER BY p.amount_agorot',[s.gid])).rows;
   assert.deepEqual(rec.map((x:any)=>[Number(x.amount_agorot),x.matches]),[[9860,true],[11240,true],[12730,true]],'each record names the exact paid cart');
   const g=await one('SELECT paid_total_agorot,payment_state FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.deepEqual([Number(g.paid_total_agorot),g.payment_state],[0,null],'online payment fields untouched');
   assert.equal(await n('SELECT count(*) AS n FROM group_payment_charges'),0);assert.equal(await n('SELECT count(*) AS n FROM group_members WHERE payment_status IS NOT NULL'),0);
   assert.equal(await n("SELECT count(*) AS n FROM admin_audit WHERE action='member.payment_attest' AND result='OK'"),3);
   const history=(await api('/admin/api/groups/'+s.id+'/members/'+s.A+'/history')).body;
   assert.deepEqual([history.versions.length,history.payments.length,history.payments[0].method],[4,1,'BANK_TRANSFER']);
  });

  await t.test('same customer, two separate orders: another order beside a paid one; one open order per cycle; duplicates refused',async()=>{
   const x=f.person();
   const first=await f.groups.joinArea({...x,areaPublicId:AREA.netivot,lines:[{variantId:'12',quantity:1}]});const id=first.group.publicId;
   const gid=(await one('SELECT id FROM delivery_groups WHERE public_id=$1',[id])).id;
   const mid=(await one('SELECT id FROM group_members WHERE group_id=$1',[gid])).id;
   // Open order: "another order" is refused (edit it instead), so an unpaid order is never silently duplicated.
   await assert.rejects(()=>orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'13',quantity:1}],confirm:true,requestId:crypto.randomUUID()}),(e:any)=>e.code==='ORDER_EXISTS_IN_CYCLE');
   assert.equal((await api('/admin/api/groups/'+id+'/members/'+mid+'/external-payment',{attest:true,amountAgorot:12730,method:'BIT',receivedOn:'2026-11-26'})).status,200);
   await assert.rejects(()=>f.groups.update(id,first.memberToken,{lines:[{variantId:'13',quantity:1}]}),(e:any)=>e.code==='ORDER_LOCKED');
   await assert.rejects(()=>orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'13',quantity:1}],requestId:crypto.randomUUID()}),(e:any)=>e.code==='ORDER_CONFIRMATION_REQUIRED');
   const requestId=crypto.randomUUID();
   const second=await orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'13',quantity:1}],confirm:true,requestId});
   assert.equal(second.group.publicId,id,'same open cycle');assert.equal(second.group.pledgedTotalAgorot,12730+9860);
   await assert.rejects(()=>orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'13',quantity:1}],confirm:true,requestId}),(e:any)=>e.code==='DUPLICATE_REQUEST');
   // Concurrent different requests: at most one more open order.
   const both=await Promise.allSettled([1,2].map(()=>orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'12',quantity:1}],confirm:true,requestId:crypto.randomUUID()})));
   assert.deepEqual(both.map(b=>b.status==='rejected'?(b.reason as any).code:'ok').sort(),['ORDER_EXISTS_IN_CYCLE','ORDER_EXISTS_IN_CYCLE'],'the second order is open: further ones edit it');
   const rows=(await f.db.query('SELECT pledged_total_agorot,order_state FROM group_members WHERE group_id=$1 ORDER BY created_at',[gid])).rows;
   assert.deepEqual(rows.map((r:any)=>[Number(r.pledged_total_agorot),r.order_state]),[[12730,'LOCKED'],[9860,'OPEN']],'both carts kept, the paid one untouched');
   // Ordinary joins with the same details stay refused; the database allows only one OPEN order per customer per cycle.
   await assert.rejects(()=>f.groups.join(id,{...x,areaPublicId:AREA.netivot,lines:[{variantId:'12',quantity:1}]}),(e:any)=>e.code==='ALREADY_JOINED');
   await assert.rejects(()=>f.db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) SELECT gen_random_uuid(),group_id,email,'0500000001',locality_key,cart_snapshot,1,'dup-hash' FROM group_members WHERE group_id=$1 AND order_state='OPEN'",[gid]));
   // Its receipts: the first one links to the second.
   assert.deepEqual(((await f.groups.memberState(id,first.memberToken)).member as any).linkedGroupPublicIds,[id]);
   assert.equal((await f.groups.memberState(id,second.memberToken)).member.pledgedTotalAgorot,9860);
  });

  await t.test('a concurrent new customer during the split ends in the one current cycle',async()=>{
   const s=await scenario(AREA.kiryatGat);
   const preview=(await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body;
   const [split,joined]=await Promise.all([
    orders.split(s.id,{...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:preview.state},SESSION),
    f.groups.joinArea({...f.person(),areaPublicId:AREA.kiryatGat,lines:[{variantId:'12',quantity:1}]})]);
   assert.equal(joined.group.publicId,split.target.publicId,'the joiner and the carried orders share one cycle');
   const area=(await one('SELECT area_id FROM delivery_groups WHERE id=$1',[s.gid])).area_id;
   assert.equal(await n("SELECT count(*) AS n FROM delivery_groups WHERE area_id=$1 AND status IN ('OPEN','THRESHOLD_REACHED') AND operational_status<>'COMPLETED'",[area]),1,'one current cycle');
   assert.equal(Number((await one('SELECT pledged_total_agorot FROM delivery_groups WHERE public_id=$1',[split.target.publicId])).pledged_total_agorot),8610+28240+12730);
  });

  await t.test('state guard: a customer edit after the preview refuses the split; nothing changes',async()=>{
   const s=await scenario(AREA.sderot);
   const preview=(await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body;
   await f.groups.update(s.id,s.tokens.d,{lines:[{variantId:'51',quantity:1}]});
   await assert.rejects(()=>orders.split(s.id,{...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:preview.state},SESSION),(e:any)=>e.code==='SPLIT_STATE_CHANGED');
   assert.equal((await one('SELECT operational_status FROM delivery_groups WHERE id=$1',[s.gid])).operational_status,'NEW');
   assert.equal(await n('SELECT count(*) AS n FROM group_cycle_splits WHERE source_group_id=$1',[s.gid]),0);
  });

  await t.test('rollback: a failure at the last step of the split leaves nothing changed',async()=>{
   const s=await scenario(AREA.ashkelon);
   const preview=(await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body;
   const snapshot=async()=>JSON.stringify((await f.db.query('SELECT id,status,pledged_total_agorot,order_state,withdrawn_by,cart_snapshot FROM group_members WHERE group_id=$1 ORDER BY id',[s.gid])).rows);
   const before=await snapshot(),groups0=await n('SELECT count(*) AS n FROM delivery_groups'),links0=await n('SELECT count(*) AS n FROM member_links');
   await f.db.query("ALTER TABLE admin_audit ADD CONSTRAINT zz_fail_split CHECK(action<>'group.cycle_split') NOT VALID");
   try{await assert.rejects(()=>orders.split(s.id,{...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:preview.state},SESSION));}
   finally{await f.db.query('ALTER TABLE admin_audit DROP CONSTRAINT zz_fail_split');}
   assert.equal(await snapshot(),before,'orders untouched');
   assert.deepEqual([await n('SELECT count(*) AS n FROM delivery_groups'),await n('SELECT count(*) AS n FROM member_links')],[groups0,links0],'no new cycle, no links');
   const g=await one('SELECT status,operational_status,pledged_total_agorot FROM delivery_groups WHERE id=$1',[s.gid]);
   assert.deepEqual([g.status,g.operational_status,Number(g.pledged_total_agorot)],['THRESHOLD_REACHED','NEW',59440]);
  });

  await t.test('payment and fulfilment safety: card groups, recorded charges and completed cycles are refused',async()=>{
   const s=await scenario(AREA.beerSheva);
   await f.db.query("UPDATE delivery_groups SET payment_mode='CARDCOM' WHERE id=$1",[s.gid]);
   assert.ok((await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body.blockers.includes('CARD_GROUP'));
   assert.equal((await api('/admin/api/groups/'+s.id+'/members/'+s.B+'/external-payment',{attest:true,amountAgorot:12730,method:'CASH',receivedOn:'2026-11-19'})).body.code,'INVALID_PAYMENT_RECORD');
   await f.db.query("UPDATE delivery_groups SET payment_mode='NONE',operational_status='COMPLETED',completed_at=NOW(),completed_by='session:bbbbbbbbbbbb' WHERE id=$1",[s.gid]);
   const preview=(await api('/admin/api/groups/'+s.id+'/cycle-split/preview',plan(s))).body;
   assert.ok(preview.blockers.includes('ALREADY_COMPLETED'));
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split',{...plan(s),confirm:true,deliveredAttested:true,reason:'ORDER_OVERWRITE_RECONCILIATION',idempotencyKey:crypto.randomUUID(),expectedState:preview.state})).body.code,'SPLIT_NOT_ALLOWED');
   // A restore needs a used reconfirmation of that very order, and a cart that actually differs.
   await f.db.query("UPDATE delivery_groups SET operational_status='NEW',completed_at=NULL,completed_by=NULL WHERE id=$1",[s.gid]);
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split/preview',{restore:[{memberId:s.B,reconfirmationId:s.reconfirmation}],transfer:[]})).body.code,'RESTORE_SOURCE_INVALID');
   const bConf=(await one('SELECT id FROM member_reconfirmations WHERE member_id=$1',[s.B])).id;
   assert.equal((await api('/admin/api/groups/'+s.id+'/cycle-split/preview',{restore:[{memberId:s.B,reconfirmationId:bConf}],transfer:[]})).body.code,'RESTORE_SOURCE_INVALID','B was never overwritten');
  });
 }finally{await f.close();}
});

test('Recovery with a paid order and a separate open order in the same cycle returns the open one',{timeout:120000},async()=>{
 const {MemoryEmailProvider}=await import('../src/email.js');
 const mail=new MemoryEmailProvider();
 const f=await adminFixture({email:mail});
 try{
  Object.assign(f.shopify.prices,PRICES);
  const validator=(f.groups as any).shopify,orders=new Orders(f.db,f.groups,validator);
  const post=async(path:string,body:any)=>{const r=await fetch(f.cfg.origin+'/api/v1'+path,{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const x=f.person();
  const first=await f.groups.joinArea({...x,areaPublicId:AREA.ashdod,lines:[{variantId:'12',quantity:1}]});const id=first.group.publicId;
  const paid=(await f.db.query('SELECT m.id FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1',[id])).rows[0].id;
  await orders.attestPayment(id,paid,{attest:true,amountAgorot:12730,method:'CASH',receivedOn:'2026-11-26'},SESSION);
  await orders.anotherOrder(id,first.memberToken,{lines:[{variantId:'13',quantity:1}],confirm:true,requestId:crypto.randomUUID()});
  // A new device: recovery by e-mail code for this group.
  const started=await post('/groups/'+id+'/recovery/start',{email:x.email,phone:x.phone});
  assert.equal(started.status,200,JSON.stringify(started.body));
  const code=mail.sent.at(-1)!.code;
  const verified=await post('/groups/'+id+'/recovery/verify',{challengeId:started.body.challengeId,code});
  assert.equal(verified.status,200,JSON.stringify(verified.body));
  const state=await f.groups.memberState(id,verified.body.memberToken);
  assert.deepEqual([state.member.status,state.member.pledgedTotalAgorot,(state.member as any).orderState],['PLEDGED',9860,undefined],'the open order');
  // The paid order stays reachable through the receipt it was placed with, and is never editable.
  assert.equal(((await f.groups.memberState(id,first.memberToken)).member as any).orderState,'LOCKED');
 }finally{await f.close();}
});
