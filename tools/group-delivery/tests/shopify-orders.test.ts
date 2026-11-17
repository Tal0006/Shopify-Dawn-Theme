import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentsFixture,timeline,CARDCOM_ENV} from './payments-fixture.js';
import {CardcomService,cardExpiry} from '../src/cardcom.js';
import {ShopifyOrders} from '../src/shopify-orders.js';
const staticAuth=(token:string)=>({accessToken:async()=>token,invalidate(){}}) as any;

const GUID='0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10';
const respond=(body:any)=>(async()=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})) as any;
const lp=(top:number,tran:any=null,extra:any={})=>({ResponseCode:top,LowProfileId:GUID,TerminalNumber:1000,ReturnValue:'r',Operation:'CreateTokenOnly',
 TokenInfo:{Token:'11111111-2222-4333-8444-555555555555',TokenExDate:'20300131',CardMonth:7,CardYear:2029},TranzactionInfo:tran,...extra});
const result=(body:any)=>new CardcomService({terminalNumber:1000,apiName:'api'},respond(body),1000).getLowProfileResult(GUID);

test('14. card expiry is normalized explicitly to CardExpirationMMYY',()=>{
 assert.equal(cardExpiry(1,2028)?.mmyy,'0128');
 assert.equal(cardExpiry(12,2028)?.mmyy,'1228');
 assert.equal(cardExpiry(1,28)?.mmyy,'0128','2-digit year as Cardcom documents for TransactionInfo.CardYear');
 assert.deepEqual(cardExpiry(12,28),{month:12,year:2028,mmyy:'1228'});
 assert.equal(cardExpiry(7,2000)?.mmyy,'0700');
 for(const [m,y] of [[0,2028],[13,2028],[1,1999],[1,2100],[1,100],[1.5,2028],['07',2028],[7,'28']] as const)assert.equal(cardExpiry(m,y),null,'refused, never guessed: '+m+'/'+y);
});

test('12-13. GetLpResult: J2 (0 / 701) is accepted, J5 (700 / JParameter 5) and other results are not',async()=>{
 assert.equal((await result(lp(0))).state,'SUCCESS','no TranzactionInfo (CreateTokenOnly)');
 assert.equal((await result(lp(701))).state,'SUCCESS','top-level 701 = J2');
 const j2=await result(lp(0,{ResponseCode:701,JParameter:'2'}));
 assert.equal(j2.state,'SUCCESS');if(j2.state==='SUCCESS'){assert.equal(j2.cardExpirationMMYY,'0729');assert.equal(j2.cardMonth,7);assert.equal(j2.cardYear,2029);}
 assert.equal((await result(lp(0,{ResponseCode:0,JParameter:'2'}))).state,'SUCCESS');
 assert.deepEqual(await result(lp(700)),{state:'FAILED',responseCode:700,reason:'J5_NOT_ALLOWED'});
 assert.deepEqual(await result(lp(0,{ResponseCode:700,JParameter:'5'})),{state:'FAILED',responseCode:700,reason:'J5_NOT_ALLOWED'});
 assert.deepEqual(await result(lp(0,{ResponseCode:0,JParameter:'5'})),{state:'FAILED',responseCode:0,reason:'J5_NOT_ALLOWED'});
 assert.deepEqual(await result(lp(0,{ResponseCode:0,JParameter:'0'})),{state:'FAILED',responseCode:0,reason:'NOT_J2'},'a regular charge is never a reservation');
 assert.deepEqual(await result(lp(5005)),{state:'FAILED',responseCode:5005,reason:'DECLINED'},'rejected');
 assert.deepEqual(await result(lp(0,{ResponseCode:5005,JParameter:'2'})),{state:'FAILED',responseCode:5005,reason:'DECLINED'});
 assert.deepEqual(await result(lp(5118)),{state:'PENDING',responseCode:5118});
 await assert.rejects(result(lp(701,null,{Operation:'ChargeOnly'})),'operation must be CreateTokenOnly even with 701');
 const twoDigit=await result(lp(0,null,{TokenInfo:{Token:'11111111-2222-4333-8444-555555555555',TokenExDate:'20300131',CardMonth:1,CardYear:28}}));
 assert.equal(twoDigit.state==='SUCCESS'&&twoDigit.cardExpirationMMYY,'0128');
 await assert.rejects(result(lp(0,null,{TokenInfo:{Token:'11111111-2222-4333-8444-555555555555',CardMonth:13,CardYear:2028}})),'invalid month refused');
});

test('11. ExternalUniqTranId is at most 25 characters; longer ids are refused before any request',async()=>{
 const sent:any[]=[];
 const service=new CardcomService({terminalNumber:1000,apiName:'api'},(async(_u:any,init:any)=>{sent.push(JSON.parse(init.body));return new Response(JSON.stringify({ResponseCode:0,TranzactionId:5}),{status:200});}) as any,1000);
 const base={token:GUID,cardExpirationMMYY:'0729',amountAgorot:100n};
 await assert.rejects(service.chargeToken({...base,externalUniqTranId:'G'.repeat(26)}));
 await assert.rejects(service.chargeToken({...base,externalUniqTranId:GUID}),'a full UUID (36 characters) is refused');
 await assert.rejects(service.chargeToken({...base,cardExpirationMMYY:'1329',externalUniqTranId:'G1'}),'invalid month');
 assert.equal(sent.length,0);
 await service.chargeToken({...base,externalUniqTranId:'G'+'a'.repeat(24)});
 assert.equal(sent[0].ExternalUniqTranId.length,25);
 assert.equal(sent[0].CVV2,undefined,'no CVV with a token');
});

test('Shopify orderCreate request: approved prices, unpaid, inventory obeying policy, no receipts, no card data',async()=>{
 const sent:any[]=[];
 const orders=new ShopifyOrders({domain:'example.myshopify.com',clientId:'client-id-test',clientSecret:'client-secret-not-real-0000',version:'2026-10',test:false},(async(url:any,init:any)=>{
  sent.push({url:String(url),headers:init.headers,body:JSON.parse(init.body)});
  return new Response(JSON.stringify({data:{orderCreate:{order:{id:'gid://shopify/Order/7',name:'#1007',createdAt:'2026-11-17T10:00:00Z',displayFinancialStatus:'PENDING',totalPriceSet:{shopMoney:{amount:'287.50',currencyCode:'ILS'}}},userErrors:[]}}}),{status:200});
 }) as any,1000,staticAuth('shpat_test_admin_token_not_real_0000'));
 const out=await orders.createOrder({reference:'G0123456789abcdef01234567',groupPublicId:'11111111-2222-4333-8444-555555555555',areaName:'אשדוד',
  lines:[{variantId:'gid://shopify/ProductVariant/1',quantity:2,unitAgorot:12500n},{variantId:'gid://shopify/ProductVariant/2',quantity:1,unitAgorot:3750n}],totalAgorot:28750n});
 assert.deepEqual(out,{state:'CREATED',order:{id:'gid://shopify/Order/7',name:'#1007',createdAt:'2026-11-17T10:00:00Z',totalAgorot:28750n,currency:'ILS'}});
 const {url,headers,body}=sent[0];
 assert.equal(url,'https://example.myshopify.com/admin/api/2026-10/graphql.json');assert.equal(headers['X-Shopify-Access-Token'],'shpat_test_admin_token_not_real_0000');
 assert.match(body.query,/orderCreate\(order:\$order,options:\$options\)/);
 const order=body.variables.order;
 assert.deepEqual(order.lineItems,[{variantId:'gid://shopify/ProductVariant/1',quantity:2,requiresShipping:true,priceSet:{shopMoney:{amount:'125.00',currencyCode:'ILS'}}},{variantId:'gid://shopify/ProductVariant/2',quantity:1,requiresShipping:true,priceSet:{shopMoney:{amount:'37.50',currencyCode:'ILS'}}}]);
 assert.equal(order.financialStatus,'PENDING');assert.equal(order.taxesIncluded,true);assert.equal(order.currency,'ILS');
 // Business data only (no Level 2 customer data on Basic): exactly these top-level fields.
 assert.deepEqual(Object.keys(order).sort(),['currency','customAttributes','financialStatus','lineItems','note','sourceIdentifier','tags','taxesIncluded']);
 assert.deepEqual(order.tags,['group-delivery','group:11111111-2222-4333-8444-555555555555','gd-charge-G0123456789abcdef01234567']);
 assert.equal(order.sourceIdentifier,'G0123456789abcdef01234567');assert.equal(order.shippingLines,undefined,'no invented shipping price');assert.equal(order.transactions,undefined);
 assert.deepEqual(body.variables.options,{inventoryBehaviour:'DECREMENT_OBEYING_POLICY',sendReceipt:false,sendFulfillmentReceipt:false});
 assert.equal(order.test,undefined);
});

test('Shopify orders before Cardcom charges (Shopify Admin and Cardcom mocked)',{timeout:300000},async t=>{
 const f=await paymentsFixture();
 const refOf=async(reservationId:string)=>(await f.db.query('SELECT c.* FROM group_payment_charges c JOIN group_payment_reservations r ON r.member_id=c.member_id WHERE r.id=$1',[reservationId])).rows[0];
 const creates=(ref:string)=>f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCreate'&&r.variables.order.sourceIdentifier===ref).length;
 const cardcomCharges=()=>f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction');
 const orderOf=(id:string)=>f.shopifyAdmin.state.orders.get(id)!;
 // Two members reach the threshold; returns them and an approved, processed group.
 const approved=async(setup:(a:any,b:any)=>void=()=>{})=>{
  const a=await f.join({quantity:2}),b=await f.join({quantity:2});setup(a,b);
  const session=await f.login();
  const res=await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve');assert.equal(res.status,200);
  await f.payments.idle();
  return {a,b,id:a.group.publicId,session};
 };
 t.beforeEach(async()=>{
  await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups, request_limits, admin_sessions CASCADE');
  f.cardcom.state.requests.length=0;f.cardcom.state.chargeModes.clear();f.cardcom.state.lpMode='ok';
  f.shopifyAdmin.state.requests.length=0;f.shopifyAdmin.state.orders.clear();f.shopifyAdmin.state.createMode='ok';f.shopifyAdmin.state.payMode='ok';
  f.shopify.soldOut=[];timeline.length=0;
 });
 try{
  await t.test('1, 6, 11, 15. order first, then the charge; paid in Shopify with the Cardcom reference; no token in Shopify',async()=>{
   const {a,b,id}=await approved();
   for(const m of [a,b]){
    const c=await refOf(m.reservationId);
    assert.ok(c.external_uniq_tran_id.length<=25);
    assert.ok(timeline.indexOf('shopify:orderCreate:'+c.external_uniq_tran_id)>=0);
    assert.ok(timeline.indexOf('shopify:orderCreate:'+c.external_uniq_tran_id)<timeline.indexOf('cardcom:charge:'+c.external_uniq_tran_id),'order before charge');
    assert.equal(c.status,'SUCCEEDED');assert.equal(c.shopify_payment_state,'SYNCED');assert.match(c.shopify_order_id,/^gid:\/\/shopify\/Order\/\d+$/);assert.match(c.shopify_order_name,/^#\d+$/);assert.ok(c.shopify_order_created_at);
    const order=orderOf(c.shopify_order_id);
    assert.equal(order.financial,'PAID');assert.ok(order.tags.includes('cardcom-tx-'+c.cardcom_transaction_id));
    assert.ok(order.tags.includes('group-delivery')&&order.tags.includes('group:'+id));
    assert.equal(order.total,'250.00','the approved pledge exactly');
    assert.equal(order.input.order.email,undefined,'no customer email in Shopify');
   }
   for(const r of cardcomCharges())assert.ok(r.body.ExternalUniqTranId.length<=25,'11');
   assert.equal((await f.db.query('SELECT payment_state FROM delivery_groups WHERE public_id=$1',[id])).rows[0].payment_state,'PAID');
   // 15: nothing card-related ever reaches Shopify.
   const shopifyTraffic=JSON.stringify(f.shopifyAdmin.state.requests);
   for(const token of f.cardcom.state.tokens)assert.ok(!shopifyTraffic.includes(token),'Cardcom token sent to Shopify');
   assert.ok(!/CardExpiration|CVV|test-api-name-not-real/i.test(shopifyTraffic));
   // The paid record uses the external-payment mutation once per order.
   assert.equal(f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderPaid').length,2);
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:(await f.login()).cookie}})).text();
   assert.match(html,/שולם/);assert.match(html,new RegExp(orderOf((await refOf(a.reservationId)).shopify_order_id).name));
  });
  await t.test('2. Shopify order creation failure: no Cardcom charge, ORDER_FAILED, visible to the admin',async()=>{
   f.shopifyAdmin.state.createMode='rejected';
   const {a,id}=await approved();
   assert.equal(cardcomCharges().length,0,'nobody charged');
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.failure_code,'INVENTORY_NOT_AVAILABLE');assert.equal(c.shopify_order_id,null);
   assert.equal((await f.db.query('SELECT payment_status FROM group_members WHERE id=$1',[c.member_id])).rows[0].payment_status,'PAYMENT_FAILED');
   const summary=(await f.send('/admin/api/groups/'+id,undefined,{Cookie:(await f.login()).cookie})).data.group.charges;
   assert.equal(summary.orderFailed,2);assert.equal(summary.state,'PAYMENT_REVIEW_REQUIRED');
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:(await f.login()).cookie}})).text();
   assert.match(html,/יצירת ההזמנה נכשלה – לא חויב/);
   // Re-processing does not create orders or charge for failed rows.
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(cardcomCharges().length,0);assert.equal(f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCreate').length,2);
  });
  await t.test('cart revalidation: an item that cannot be sold any more gets no order and no charge',async()=>{
   const {a}=await approved(()=>{f.shopify.soldOut=['1'];});
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.failure_code,'CART_UNAVAILABLE');
   assert.equal(f.shopifyAdmin.state.requests.length,0);assert.equal(cardcomCharges().length,0);
  });
  await t.test('an order whose total differs from the approved amount is kept unpaid and not charged',async()=>{
   f.shopifyAdmin.state.createMode='wrong-total';
   const {a}=await approved();
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'ORDER_FAILED');assert.equal(c.failure_code,'ORDER_TOTAL_MISMATCH');assert.ok(c.shopify_order_id);
   assert.equal(orderOf(c.shopify_order_id).financial,'PENDING');assert.equal(cardcomCharges().length,0);
  });
  await t.test('3-4. duplicate and concurrent processing: one order and one charge per member',async()=>{
   const {a,b,id,session}=await approved();
   await Promise.all([f.payments.processCharges(id),f.adminPost(session,'/admin/api/groups/'+id+'/charges/process'),f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile'),f.payments.processCharges(id)]);
   await f.payments.idle();
   for(const m of [a,b]){const c=await refOf(m.reservationId);assert.equal(creates(c.external_uniq_tran_id),1,'one Shopify order');}
   assert.equal(cardcomCharges().length,2,'one Cardcom transaction per member');
   assert.equal(f.shopifyAdmin.state.orders.size,2);
   // DB guarantees: one charge row per member and group; one charge per Shopify order; derived external id.
   const c=await refOf(a.reservationId);
   await assert.rejects(f.db.query("INSERT INTO group_payment_charges(id,external_uniq_tran_id,group_id,member_id,reservation_id,amount_agorot) SELECT gen_random_uuid(),'Gx',group_id,member_id,reservation_id,100 FROM group_payment_charges WHERE id=$1",[c.id]));
   const other=await refOf(b.reservationId);
   await assert.rejects(f.db.query('UPDATE group_payment_charges SET shopify_order_id=$2 WHERE id=$1',[other.id,c.shopify_order_id]),'one order per charge');
   await assert.rejects(f.db.query("UPDATE group_payment_charges SET external_uniq_tran_id='GOTHER' WHERE id=$1",[c.id]),'id derivation enforced');
   await assert.rejects(f.db.query("UPDATE group_payment_charges SET status='ORDER_CREATED',shopify_order_id=NULL WHERE id=$1",[c.id]),'no order, no charge stage');
  });
  await t.test('5. a failed Cardcom charge leaves the Shopify order unpaid and cancels it (stock released)',async()=>{
   const {a,id}=await approved((m)=>{f.cardcom.state.chargeModes.set(m.page.token,'decline');});
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'FAILED');assert.ok(c.shopify_order_id);assert.equal(c.shopify_payment_state,'NOT_STARTED');
   assert.equal(orderOf(c.shopify_order_id).financial,'PENDING','never paid');
   assert.ok(orderOf(c.shopify_order_id).cancelledAt,'canceled');assert.equal(c.shopify_cancel_state,'ORDER_CANCELED');assert.ok(c.inventory_released_at);
   assert.equal(f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderPaid'&&r.variables.id===c.shopify_order_id).length,0);
   assert.equal((await f.db.query('SELECT payment_status FROM group_members WHERE id=$1',[c.member_id])).rows[0].payment_status,'PAYMENT_FAILED');
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:(await f.login()).cookie}})).text();
   assert.match(html,/החיוב נכשל – ההזמנה בוטלה והמלאי שוחרר/);assert.match(html,new RegExp(orderOf(c.shopify_order_id).name));
   // No automatic resend.
   const sent=cardcomCharges().length;await f.payments.processCharges(id);await f.payments.idle();assert.equal(cardcomCharges().length,sent);
  });
  await t.test('7-8. mark-as-paid failure: no second charge; reconciliation only fixes Shopify',async()=>{
   f.shopifyAdmin.state.payMode='network';
   const {a,id,session}=await approved();
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'SUCCEEDED');assert.equal(c.shopify_payment_state,'SYNC_REQUIRED');assert.ok(c.cardcom_transaction_id);assert.ok(c.shopify_order_id);
   assert.equal((await f.db.query('SELECT payment_status FROM group_members WHERE id=$1',[c.member_id])).rows[0].payment_status,'CHARGED');
   let summary=(await f.send('/admin/api/groups/'+id,undefined,{Cookie:session.cookie})).data.group.charges;
   assert.equal(summary.syncRequired,2);assert.equal(summary.state,'PAYMENT_REVIEW_REQUIRED');
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   assert.match(html,/חויב בקארדקום – נדרש עדכון בשופיפיי/);
   // 7: processing again does not charge again.
   await f.payments.processCharges(id);await f.payments.idle();assert.equal(cardcomCharges().length,2);
   // 8: the payment record went through but its answer was lost: reconciliation sees PAID and does not pay twice.
   f.shopifyAdmin.state.payMode='lost';
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(orderOf(c.shopify_order_id).financial,'PAID');assert.equal((await refOf(a.reservationId)).shopify_payment_state,'SYNC_REQUIRED');
   f.shopifyAdmin.state.payMode='ok';
   const before=f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderPaid').length;
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.status,200);assert.equal(rec.data.synced,2);
   assert.equal(f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderPaid').length,before,'already PAID: not recorded again');
   assert.equal(cardcomCharges().length,2,'reconciliation never charges');
   summary=rec.data.summary;assert.equal(summary.syncRequired,0);assert.equal(summary.state,'PAID');
   assert.ok(orderOf(c.shopify_order_id).tags.includes('cardcom-tx-'+c.cardcom_transaction_id));
  });
  await t.test('9. restart/lost answer after order creation: never a second order; reconciliation finds it, then one charge',async()=>{
   f.shopifyAdmin.state.createMode='lost';
   const {a,id,session}=await approved();
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'ORDER_UNKNOWN');assert.equal(cardcomCharges().length,0);assert.equal(f.shopifyAdmin.state.orders.size,2,'Shopify did create them');
   f.shopifyAdmin.state.createMode='ok';
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(creates(c.external_uniq_tran_id),1,'not created again');assert.equal(cardcomCharges().length,0,'not charged before reconciliation');
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.data.ordersFound,2);assert.equal(cardcomCharges().length,0,'reconciliation does not charge');
   assert.equal((await refOf(a.reservationId)).status,'ORDER_CREATED');
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal(cardcomCharges().length,2);assert.equal(creates(c.external_uniq_tran_id),1);assert.equal(f.shopifyAdmin.state.orders.size,2);
   assert.equal((await refOf(a.reservationId)).shopify_payment_state,'SYNCED');
  });
  await t.test('9. a crash while creating the order (row left ORDER_CREATING): ORDER_UNKNOWN on restart, never re-created blindly',async()=>{
   f.shopifyAdmin.state.createMode='not-executed';// rows stay PENDING
   const {a,id}=await approved();
   const c=await refOf(a.reservationId);
   await f.db.query("UPDATE group_payment_charges SET status='ORDER_CREATING',started_at=NOW()-INTERVAL '10 minutes' WHERE id=$1",[c.id]);
   f.shopifyAdmin.state.createMode='ok';f.shopifyAdmin.state.requests.length=0;
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal((await refOf(a.reservationId)).status,'ORDER_UNKNOWN');
   assert.equal(creates(c.external_uniq_tran_id),0,'not created again after the crash');
   assert.equal(cardcomCharges().filter(r=>r.body.ExternalUniqTranId===c.external_uniq_tran_id).length,0);
  });
  await t.test('10. restart after a Cardcom success whose answer was lost: no second charge; reconciliation completes it',async()=>{
   const {a,id,session}=await approved((m)=>{f.cardcom.state.chargeModes.set(m.page.token,'lost');});
   const c=await refOf(a.reservationId);
   assert.equal(c.status,'UNKNOWN','a lost answer is not a failure');assert.equal(orderOf(c.shopify_order_id).financial,'PENDING');
   // Simulate a restart mid-flight too: IN_FLIGHT rows older than 2 minutes become UNKNOWN, never re-sent.
   await f.db.query("UPDATE group_payment_charges SET status='IN_FLIGHT',started_at=NOW()-INTERVAL '5 minutes' WHERE id=$1",[c.id]);
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal((await refOf(a.reservationId)).status,'UNKNOWN');
   const sent=cardcomCharges().filter(r=>r.body.ExternalUniqTranId===c.external_uniq_tran_id).length;
   assert.equal(sent,1,'sent exactly once');
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.data.resolved,1);
   const done=await refOf(a.reservationId);
   assert.equal(done.status,'SUCCEEDED');assert.equal(done.shopify_payment_state,'SYNCED');assert.equal(orderOf(done.shopify_order_id).financial,'PAID');
   assert.equal(cardcomCharges().filter(r=>r.body.ExternalUniqTranId===c.external_uniq_tran_id).length,1,'still one transaction');
   assert.equal(f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/GetTransactionByExternalUniqTran'&&r.body.ExternalUniqTranId===c.external_uniq_tran_id).length>=1,true,'looked up by ExternalUniqTranId');
  });
  await t.test('a top-level Shopify error (throttled) creates nothing and is retried once later',async()=>{
   f.shopifyAdmin.state.createMode='not-executed';
   const {a,id}=await approved();
   assert.equal((await refOf(a.reservationId)).status,'PENDING');assert.equal(cardcomCharges().length,0);
   f.shopifyAdmin.state.createMode='ok';
   await f.payments.processCharges(id);await f.payments.idle();
   const c=await refOf(a.reservationId);assert.equal(c.status,'SUCCEEDED');assert.equal(f.shopifyAdmin.state.orders.size,2);
  });
  await t.test('12-14. J2 701 activates, J5 700 never does; CardMonth/CardYear persisted and used for MMYY',async()=>{
   for(const mode of ['top-701','tran-701'] as const){
    f.cardcom.state.lpMode=mode;const r=await f.join({quantity:1});
    const row=(await f.db.query('SELECT status,card_exp_month,card_exp_year,token_expires_on FROM group_payment_reservations WHERE id=$1',[r.reservationId])).rows[0];
    assert.equal(row.status,'CARD_RESERVED',mode);assert.equal(row.card_exp_month,7);assert.equal(row.card_exp_year,2029);assert.ok(row.token_expires_on);
   }
   for(const mode of ['top-700','tran-700','jparam-5'] as const){
    f.cardcom.state.lpMode=mode;
    const r=await f.reserve({quantity:1});const page=f.cardcom.pageFor(r.data.reservation.id)!;page.state='success';await f.webhook(page.id);
    const row=(await f.db.query('SELECT status,failure_code,token_ciphertext,member_id FROM group_payment_reservations WHERE id=$1',[r.data.reservation.id])).rows[0];
    assert.deepEqual({...row},{status:'RESERVATION_FAILED',failure_code:'J5_NOT_ALLOWED',token_ciphertext:null,member_id:null},mode);
   }
   f.cardcom.state.lpMode='jparam-0';
   const charged=await f.reserve({quantity:1});const p=f.cardcom.pageFor(charged.data.reservation.id)!;p.state='success';await f.webhook(p.id);
   assert.equal((await f.db.query('SELECT failure_code FROM group_payment_reservations WHERE id=$1',[charged.data.reservation.id])).rows[0].failure_code,'NOT_J2');
   // 14: a 2-digit CardYear (29) is normalized to 2029 and charged as 0729.
   f.cardcom.state.lpMode='year-2digit';
   await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups CASCADE');
   f.cardcom.state.requests.length=0;
   const {a}=await approved();
   const res=(await f.db.query('SELECT card_exp_month,card_exp_year FROM group_payment_reservations WHERE id=$1',[a.reservationId])).rows[0];
   assert.deepEqual({...res},{card_exp_month:7,card_exp_year:2029});
   for(const r of cardcomCharges())assert.equal(r.body.CardExpirationMMYY,'0729');
  });
  await t.test('14. an expired card is not sent to Cardcom; the order stays unpaid',async()=>{
   // A group whose members' cards expired before approval.
   const x=await f.join({quantity:2}),y=await f.join({quantity:2});
   await f.db.query('UPDATE group_payment_reservations SET card_exp_month=1,card_exp_year=2024');
   const session=await f.login();await f.adminPost(session,'/admin/api/groups/'+x.group.publicId+'/approve');await f.payments.idle();
   const c=await refOf(x.reservationId);
   assert.equal(c.status,'FAILED');assert.equal(c.failure_code,'CARD_EXPIRED');assert.equal(cardcomCharges().length,0);
   assert.equal(orderOf(c.shopify_order_id).financial,'PENDING');
   void y;
  });
 }finally{await f.close();}
});

test('Without Shopify client credentials, card groups cannot be approved (no charge without an order)',{timeout:120000},async()=>{
 const {SHOPIFY_CLIENT_ID:_id,SHOPIFY_CLIENT_SECRET:_secret,...env}=CARDCOM_ENV;
 const f=await paymentsFixture(env);
 try{
  assert.equal(f.cfg.payments.state,'ENABLED');assert.equal(f.cfg.payments.orders,undefined);
  assert.ok(f.cfg.payments.chargingProblems.some(p=>p.includes('SHOPIFY_CLIENT_ID')));assert.ok(f.cfg.payments.chargingProblems.some(p=>p.includes('SHOPIFY_CLIENT_SECRET')));
  const a=await f.join({quantity:2}),b=await f.join({quantity:2});void b;
  assert.equal(a.status.status,'CARD_RESERVED','reservations still work');
  const session=await f.login();
  const res=await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve');
  assert.equal(res.status,409);assert.equal(res.data.code,'PAYMENT_UNAVAILABLE');
  assert.equal(f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction').length,0);
  assert.equal((await f.db.query('SELECT status FROM delivery_groups WHERE public_id=$1',[a.group.publicId])).rows[0].status,'THRESHOLD_REACHED');
 }finally{await f.close();}
});
