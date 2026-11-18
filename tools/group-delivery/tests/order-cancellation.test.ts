import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentsFixture,timeline} from './payments-fixture.js';
import {ShopifyOrders} from '../src/shopify-orders.js';
const staticAuth=(token:string)=>({accessToken:async()=>token,invalidate(){}}) as any;

test('orderCancel request: DECLINED, restock true, no refund, no customer notification',async()=>{
 const sent:any[]=[];
 const orders=new ShopifyOrders({domain:'example.myshopify.com',clientId:'client-id-test',clientSecret:'client-secret-not-real-0000',version:'2026-10',test:false},(async(_u:any,init:any)=>{
  sent.push(JSON.parse(init.body));
  return new Response(JSON.stringify({data:{orderCancel:{job:{id:'gid://shopify/Job/1',done:false},orderCancelUserErrors:[]}}}),{status:200});
 }) as any,1000,staticAuth('test-access-token'));
 await orders.cancelOrder('gid://shopify/Order/7');
 const {query,variables}=sent[0];
 assert.match(query,/orderCancel\(orderId:\$orderId,reason:DECLINED,restock:true,notifyCustomer:false,staffNote:\$staffNote\)/);
 assert.doesNotMatch(query,/refund/i,'nothing was paid, so no refund');
 assert.equal(variables.orderId,'gid://shopify/Order/7');
 // A user error (e.g. already canceled) is an error, never a silent success.
 const refused=new ShopifyOrders({domain:'example.myshopify.com',clientId:'client-id-test',clientSecret:'client-secret-not-real-0000',version:'2026-10',test:false},
  (async()=>new Response(JSON.stringify({data:{orderCancel:{job:null,orderCancelUserErrors:[{field:['orderId'],message:'x',code:'INVALID'}]}}}),{status:200})) as any,1000,staticAuth('test-access-token'));
 await assert.rejects(refused.cancelOrder('gid://shopify/Order/7'));
});

test('Unpaid Shopify order is canceled and restocked after a definitive Cardcom failure',{timeout:300000},async t=>{
 const f=await paymentsFixture();
 const charge=async(reservationId:string)=>(await f.db.query('SELECT c.* FROM group_payment_charges c JOIN group_payment_reservations r ON r.member_id=c.member_id WHERE r.id=$1',[reservationId])).rows[0];
 const cancels=(orderId?:string)=>f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCancel'&&(!orderId||r.variables.orderId===orderId)).length;
 const creates=()=>f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCreate').length;
 const cardcomCalls=()=>f.cardcom.state.requests.filter(r=>r.path.startsWith('/api/v11/Transactions/')).length;
 const order=(id:string)=>f.shopifyAdmin.state.orders.get(id)!;
 // Two members reach the threshold; `setup` configures the fakes per member before approval.
 const approved=async(setup:(a:any,b:any)=>void=()=>{})=>{
  const a=await f.join({quantity:2}),b=await f.join({quantity:2});setup(a,b);
  const session=await f.login();
  assert.equal((await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve')).status,200);
  await f.payments.idle();
  return {a,b,id:a.group.publicId,session};
 };
 t.beforeEach(async()=>{
  await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups, request_limits, admin_sessions CASCADE');
  f.cardcom.state.requests.length=0;f.cardcom.state.chargeModes.clear();f.cardcom.state.lpMode='ok';
  Object.assign(f.shopifyAdmin.state,{createMode:'ok',payMode:'ok',cancelMode:'ok'});f.shopifyAdmin.state.requests.length=0;f.shopifyAdmin.state.orders.clear();f.shopifyAdmin.state.pendingCancels.clear();
  timeline.length=0;
 });
 try{
  await t.test('Cardcom FAILED -> orderCancel (restock) -> inventory released; the Cardcom state stays FAILED',async()=>{
   const {a,b}=await approved(m=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   const c=await charge(a.reservationId);
   assert.equal(c.status,'FAILED');assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);assert.ok(c.shopify_canceled_at);
   assert.equal(cancels(c.shopify_order_id),1);
   assert.ok(order(c.shopify_order_id).cancelledAt);assert.equal(order(c.shopify_order_id).restocked,true);assert.equal(order(c.shopify_order_id).financial,'PENDING');
   assert.ok(timeline.indexOf('cardcom:charge:'+c.external_uniq_tran_id)<timeline.indexOf('shopify:cancel:'+c.shopify_order_id),'canceled after the failure');
   // The paid member's order is untouched.
   const paid=await charge(b.reservationId);
   assert.equal(paid.status,'SUCCEEDED');assert.equal(paid.shopify_cancel_state,null);assert.equal(cancels(paid.shopify_order_id),0);
  });
  await t.test('an expired card (FAILED without a Cardcom call) also releases its stock',async()=>{
   const a=await f.join({quantity:2}),b=await f.join({quantity:2});void b;
   await f.db.query('UPDATE group_payment_reservations SET card_exp_month=1,card_exp_year=2024');
   const session=await f.login();await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve');await f.payments.idle();
   const c=await charge(a.reservationId);
   assert.equal(c.failure_code,'CARD_EXPIRED');assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.equal(cardcomCalls(),0);
  });
  await t.test('UNKNOWN (lost answer or network error): the order is NOT canceled',async()=>{
   const {a,b,id}=await approved((x,y)=>{f.cardcom.state.chargeModes.set(x.page.token,'lost');f.cardcom.state.chargeModes.set(y.page.token,'network');});
   for(const m of [a,b]){const c=await charge(m.reservationId);assert.equal(c.status,'UNKNOWN');assert.equal(c.shopify_cancel_state,null);assert.equal(c.inventory_released_at,null);}
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(cancels(),0);
   // The DB refuses a cancellation state on anything but FAILED.
   await assert.rejects(f.db.query("UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCEL_REQUIRED' WHERE status='UNKNOWN'"));
  });
  await t.test('SUCCEEDED + Shopify payment sync failure: the order is NOT canceled',async()=>{
   f.shopifyAdmin.state.payMode='network';
   const {a,id,session}=await approved();
   const c=await charge(a.reservationId);
   assert.equal(c.status,'SUCCEEDED');assert.equal(c.shopify_payment_state,'SYNC_REQUIRED');assert.equal(c.shopify_cancel_state,null);
   await f.payments.processCharges(id);await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');await f.payments.idle();
   assert.equal(cancels(),0);
   await assert.rejects(f.db.query("UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCEL_REQUIRED' WHERE status='SUCCEEDED'"));
  });
  await t.test('duplicate processing never cancels twice',async()=>{
   const {a,id,session}=await approved(m=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   const c=await charge(a.reservationId);
   await Promise.all([f.payments.processCharges(id),f.payments.processCharges(id),f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile'),f.adminPost(session,'/admin/api/groups/'+id+'/charges/process')]);
   await f.payments.idle();
   assert.equal(cancels(c.shopify_order_id),1);assert.equal((await charge(a.reservationId)).shopify_cancel_state,'ORDER_CANCELED');
  });
  await t.test('cancellation network failure -> ORDER_CANCEL_REQUIRED; reconciliation retries only the cancellation',async()=>{
   f.shopifyAdmin.state.cancelMode='network';
   const {a,id,session}=await approved(m=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   let c=await charge(a.reservationId);
   assert.equal(c.status,'FAILED','the Cardcom state is unchanged');assert.equal(c.shopify_cancel_state,'ORDER_CANCEL_REQUIRED');assert.equal(c.inventory_released_at,null,'not released before Shopify confirms');
   assert.equal((await f.db.query('SELECT payment_status FROM group_members WHERE id=$1',[c.member_id])).rows[0].payment_status,'PAYMENT_FAILED');
   let summary=(await f.send('/admin/api/groups/'+id,undefined,{Cookie:session.cookie})).data.group.charges;
   assert.equal(summary.cancelRequired,1);
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   assert.match(html,/החיוב נכשל – נדרש ביטול ההזמנה בשופיפיי/);assert.match(html,/בדיקה מול קארדקום ושופיפיי \(ללא חיוב\)/);
   // Retry while Shopify still fails: still required, nothing else happens.
   const cardcomBefore=cardcomCalls(),createsBefore=creates();
   await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal((await charge(a.reservationId)).shopify_cancel_state,'ORDER_CANCEL_REQUIRED');
   // Shopify back: reconciliation cancels; no Cardcom call and no new Shopify order during the retry.
   f.shopifyAdmin.state.cancelMode='ok';
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.status,200);assert.equal(rec.data.canceled,1);
   c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);assert.equal(c.status,'FAILED');
   assert.equal(cardcomCalls(),cardcomBefore,'no Cardcom call during the cancellation retry');
   assert.equal(creates(),createsBefore,'no new Shopify order during the cancellation retry');
   assert.ok(order(c.shopify_order_id).restocked);
   summary=rec.data.summary;assert.equal(summary.cancelRequired,0);assert.equal(summary.ordersCanceled,1);
  });
  await t.test('a cancellation Shopify refuses stays ORDER_CANCEL_REQUIRED (never recorded as released)',async()=>{
   f.shopifyAdmin.state.cancelMode='rejected';
   const {a}=await approved(m=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   const c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCEL_REQUIRED');assert.equal(c.inventory_released_at,null);
   await assert.rejects(f.db.query("UPDATE group_payment_charges SET inventory_released_at=NOW() WHERE id=$1",[c.id]),'released only with ORDER_CANCELED');
  });
  await t.test('asynchronous cancellation: REQUESTED until Shopify reports cancelledAt; not sent twice',async()=>{
   f.shopifyAdmin.state.cancelMode='async';
   const {a,id,session}=await approved(m=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   let c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCEL_REQUESTED');assert.equal(c.inventory_released_at,null);
   // Still running at Shopify: a retry only reads the state and does not send orderCancel again.
   await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal((await charge(a.reservationId)).shopify_cancel_state,'ORDER_CANCEL_REQUESTED');
   f.shopifyAdmin.completeCancels();
   await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);
   assert.equal(cancels(c.shopify_order_id),1,'the accepted request is not repeated');
  });
  await t.test('ORDER_TOTAL_MISMATCH 1, 2, 6, 7: never charged; canceled with restock; inventory released; no second order',async()=>{
   f.shopifyAdmin.state.createMode='wrong-total';
   const {a,b,id}=await approved();
   for(const m of [a,b]){
    const c=await charge(m.reservationId);
    assert.equal(c.status,'ORDER_FAILED');assert.equal(c.failure_code,'ORDER_TOTAL_MISMATCH');
    assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);assert.ok(c.shopify_canceled_at);
    assert.equal(cancels(c.shopify_order_id),1);
    assert.ok(order(c.shopify_order_id).cancelledAt);assert.equal(order(c.shopify_order_id).restocked,true);assert.equal(order(c.shopify_order_id).financial,'PENDING');
   }
   assert.equal(cardcomCalls(),0,'Cardcom never called after a mismatch');
   assert.equal(creates(),2,'one order per member, no second one');
   // Further processing and reconciliation create nothing, charge nothing and cancel nothing again.
   f.shopifyAdmin.state.createMode='ok';
   const session=await f.login();
   await f.payments.processCharges(id);await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');await f.payments.idle();
   assert.equal(cardcomCalls(),0);assert.equal(creates(),2);assert.equal(cancels(),2);
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   assert.match(html,/סכום ההזמנה שגוי – לא חויב, ההזמנה בוטלה והמלאי שוחרר/);
  });
  await t.test('ORDER_TOTAL_MISMATCH 3: a pending (asynchronous) cancellation is never sent twice',async()=>{
   Object.assign(f.shopifyAdmin.state,{createMode:'wrong-total',cancelMode:'async'});
   const {a,id,session}=await approved();
   let c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCEL_REQUESTED');assert.equal(c.inventory_released_at,null,'not released before cancelledAt');
   await f.payments.processCharges(id);await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');await f.payments.idle();
   assert.equal(cancels(c.shopify_order_id),1,'no duplicate cancel while pending');
   assert.equal((await charge(a.reservationId)).shopify_cancel_state,'ORDER_CANCEL_REQUESTED');
   f.shopifyAdmin.completeCancels();
   await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   c=await charge(a.reservationId);
   assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);assert.equal(cancels(c.shopify_order_id),1);
   assert.equal(cardcomCalls(),0);
  });
  await t.test('ORDER_TOTAL_MISMATCH 4, 5: cancellation failure stays ORDER_CANCEL_REQUIRED; reconciliation retries only the cancellation',async()=>{
   Object.assign(f.shopifyAdmin.state,{createMode:'wrong-total',cancelMode:'network'});
   const {a,id,session}=await approved();
   let c=await charge(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.shopify_cancel_state,'ORDER_CANCEL_REQUIRED');assert.equal(c.inventory_released_at,null);
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   assert.match(html,/סכום ההזמנה שגוי – לא חויב, נדרש ביטול ההזמנה בשופיפיי/);
   Object.assign(f.shopifyAdmin.state,{createMode:'ok',cancelMode:'ok'});
   const createsBefore=creates();
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.data.canceled,2);
   c=await charge(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);
   assert.equal(creates(),createsBefore,'no new Shopify order');assert.equal(cardcomCalls(),0,'no Cardcom call');
  });
  await t.test('ORDER_TOTAL_MISMATCH found by reconciliation (lost orderCreate answer) is canceled, not charged',async()=>{
   f.shopifyAdmin.state.createMode='lost';
   const {a,id,session}=await approved();
   assert.equal((await charge(a.reservationId)).status,'ORDER_UNKNOWN');
   // The order Shopify did create carries a different total.
   for(const o of f.shopifyAdmin.state.orders.values())o.total=o.outstanding=(Number(o.total)+11.7).toFixed(2);
   f.shopifyAdmin.state.createMode='ok';
   await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   const c=await charge(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.failure_code,'ORDER_TOTAL_MISMATCH');assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(cardcomCalls(),0);assert.equal(creates(),2);
  });
  await t.test('payment record verified: PAID with nothing outstanding, otherwise SYNC_REQUIRED',async()=>{
   for(const mode of ['partial','paid-outstanding'] as const){
    await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups CASCADE');
    f.shopifyAdmin.state.payMode=mode;
    const {a}=await approved();
    const c=await charge(a.reservationId);
    assert.equal(c.status,'SUCCEEDED');assert.equal(c.shopify_payment_state,'SYNC_REQUIRED',mode);
    assert.equal(c.shopify_cancel_state,null,'a paid charge is never canceled');
   }
   await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups CASCADE');
   f.shopifyAdmin.state.payMode='ok';
   const {a}=await approved();
   const c=await charge(a.reservationId);
   assert.equal(c.shopify_payment_state,'SYNCED');assert.equal(order(c.shopify_order_id).outstanding,'0.00');
  });
 }finally{await f.close();}
});
