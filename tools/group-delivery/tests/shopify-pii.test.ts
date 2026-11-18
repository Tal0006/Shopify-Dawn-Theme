// The store is on Shopify Basic: no Level 2 protected customer data (email, phone, name, address). Shopify orders carry
// business data only; the member's contact details stay in the Group Delivery database.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentsFixture} from './payments-fixture.js';
import {REQUIRED_SCOPES} from '../src/shopify-auth.js';

test('Shopify orders contain no customer contact data; Group Delivery keeps and uses it',{timeout:300000},async t=>{
 const f=await paymentsFixture();
 // Members with distinctive contacts, so any leak into Shopify traffic is detectable as a substring.
 const who=[{email:'pii.leak.one@example.test',phone:'0527654321'},{email:'pii.leak.two@example.test',phone:'0541122334'}];
 const stored=['+972527654321','+972541122334'];
 const orderInputs=()=>f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCreate').map(r=>r.variables.order);
 const PII_KEYS=/^(email|phone|customer|customerId|shippingAddress|billingAddress|firstName|lastName|name|address1|address2|city|zip|province|country)$/;
 const keysOf=(value:unknown):string[]=>value&&typeof value==='object'?Object.entries(value).flatMap(([k,v])=>[k,...keysOf(v)]):[];
 try{
  const a=await f.join({quantity:2,who:who[0]}),b=await f.join({quantity:2,who:who[1]});
  const session=await f.login();
  assert.equal((await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve')).status,200);
  await f.payments.idle();
  await t.test('1-3. orderCreate has no email, phone, name or address anywhere (fields, note, tags, attributes)',async()=>{
   const inputs=orderInputs();assert.equal(inputs.length,2);
   for(const order of inputs){
    for(const key of keysOf(order))assert.ok(!PII_KEYS.test(key),'PII field sent to Shopify: '+key);
    const text=JSON.stringify(order);
    for(const m of who){assert.ok(!text.includes(m.email),'email in order');assert.ok(!text.includes(m.phone)&&!text.includes(m.phone.slice(1)),'phone in order');}
    for(const phone of stored)assert.ok(!text.includes(phone)&&!text.includes(phone.slice(4)),'normalized phone in order');
    assert.ok(!text.includes('@'),'nothing email-like in note, tags or attributes');
    // Phone-like values (local 05XXXXXXXX or +972 forms) never appear in free-text fields. (Hex ids contain digit runs,
    // so a generic digit check would be meaningless.)
    assert.ok(!/(?:\+972|\b0)5\d{8}\b/.test(JSON.stringify({note:order.note,tags:order.tags,customAttributes:order.customAttributes})),'nothing phone-like in note, tags or attributes');
    // What it does carry: the business data.
    assert.ok(order.lineItems.every((l:any)=>/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(l.variantId)&&l.quantity>0&&l.priceSet.shopMoney.currencyCode==='ILS'));
    assert.equal(order.currency,'ILS');assert.equal(order.financialStatus,'PENDING');
    assert.ok(order.tags.includes('group-delivery')&&order.tags.includes('group:'+a.group.publicId)&&order.tags.some((t:string)=>t.startsWith('gd-charge-')));
    assert.deepEqual(order.customAttributes.map((x:any)=>x.key).sort(),['group_delivery_area','group_delivery_charge_reference','group_delivery_group']);
   }
   // No Shopify request of any kind carries the contacts.
   const traffic=JSON.stringify(f.shopifyAdmin.state.requests);
   for(const m of who)assert.ok(!traffic.includes(m.email));
   for(const phone of stored)assert.ok(!traffic.includes(phone));
  });
  await t.test('5. the order is still created, charged and marked paid with the Cardcom reference',async()=>{
   const rows=(await f.db.query('SELECT status,shopify_payment_state,shopify_order_id,cardcom_transaction_id FROM group_payment_charges')).rows;
   assert.equal(rows.length,2);
   for(const row of rows){
    assert.equal(row.status,'SUCCEEDED');assert.equal(row.shopify_payment_state,'SYNCED');
    const order=f.shopifyAdmin.state.orders.get(row.shopify_order_id)!;
    assert.equal(order.financial,'PAID');assert.ok(order.tags.includes('cardcom-tx-'+row.cardcom_transaction_id));
   }
   assert.equal(f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction').length,2);
  });
  await t.test('4. email and phone are still stored and used inside Group Delivery',async()=>{
   const members=(await f.db.query('SELECT email,phone FROM group_members ORDER BY email')).rows;
   assert.deepEqual(members.map((m:any)=>[m.email,m.phone]),[[who[0].email,stored[0]],[who[1].email,stored[1]]]);
   // The admin still sees them (customer contact for the delivery) ...
   const list=(await f.send('/admin/api/groups/'+a.group.publicId+'/members',undefined,{Cookie:session.cookie})).data.members;
   assert.deepEqual(list.map((m:any)=>m.email).sort(),[who[0].email,who[1].email]);
   assert.deepEqual(list.map((m:any)=>m.phone).sort(),[...stored].sort());
   // ... and duplicate protection by email/phone keeps working.
   const again=await f.reserve({group:a.group.publicId,who:{email:who[0].email,phone:'0500000999'}});
   assert.equal(again.status,409);assert.equal(again.data.code,'GROUP_CLOSED','approved group');
   const next=await f.join({quantity:1,who:{email:'pii.leak.three@example.test',phone:'0509998877'}});
   const dup=await f.reserve({group:next.group.publicId,who:{email:'pii.leak.three@example.test',phone:'0501231231'}});
   assert.equal(dup.status,409);assert.equal(dup.data.code,'ALREADY_JOINED');
   void b;
  });
  await t.test('6. reconciliation still works (lost order answer -> found by reference tag, then charged once)',async()=>{
   await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups CASCADE');
   f.shopifyAdmin.state.requests.length=0;f.shopifyAdmin.state.orders.clear();f.cardcom.state.requests.length=0;
   f.shopifyAdmin.state.createMode='lost';
   const x=await f.join({quantity:2,who:{email:'pii.recon.one@example.test',phone:'0521000001'}}),y=await f.join({quantity:2,who:{email:'pii.recon.two@example.test',phone:'0521000002'}});void y;
   assert.equal((await f.adminPost(session,'/admin/api/groups/'+x.group.publicId+'/approve')).status,200);await f.payments.idle();
   f.shopifyAdmin.state.createMode='ok';
   const rec=await f.adminPost(session,'/admin/api/groups/'+x.group.publicId+'/charges/reconcile');
   assert.equal(rec.data.ordersFound,2);
   await f.payments.processCharges(x.group.publicId);await f.payments.idle();
   for(const row of (await f.db.query('SELECT status,shopify_payment_state FROM group_payment_charges')).rows)assert.deepEqual({...row},{status:'SUCCEEDED',shopify_payment_state:'SYNCED'});
   assert.equal(f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction').length,2);
   assert.ok(!JSON.stringify(f.shopifyAdmin.state.requests).includes('pii.recon'),'no email in any Shopify request');
  });
  await t.test('scope stays write_orders only (no customer scopes requested)',()=>{
   assert.deepEqual([...REQUIRED_SCOPES],['write_orders']);
   for(const form of f.shopifyAdmin.state.tokenRequests)assert.equal(form.scope,undefined,'no scope parameter in the token request');
  });
 }finally{await f.close();}
});
