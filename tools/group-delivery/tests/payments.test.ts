import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentsFixture,AREA,CARDCOM_ENV} from './payments-fixture.js';
import {TokenVault,parseEncryptionKey} from '../src/vault.js';
import {CardcomService,CardcomError} from '../src/cardcom.js';
import {paymentsConfig} from '../src/payments-config.js';
import {containsCardData} from '../src/domain.js';

test('Token vault: AES-256-GCM, bound to its row, tamper-evident, no fallback key',()=>{
 const key=parseEncryptionKey('9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8')!;
 assert.equal(key.length,32);
 assert.equal(parseEncryptionKey(''),null);assert.equal(parseEncryptionKey('short'),null);assert.equal(parseEncryptionKey(undefined),null);
 assert.equal(parseEncryptionKey(Buffer.alloc(32,7).toString('base64'))!.length,32);
 const vault=new TokenVault(key),sealed=vault.seal('secret-token','row-1');
 assert.ok(!sealed.includes('secret-token'));
 assert.equal(vault.open(sealed,'row-1'),'secret-token');
 assert.throws(()=>vault.open(sealed,'row-2'),'another row cannot open it');
 const parts=sealed.split('.');parts[3]=Buffer.from('tampered!').toString('base64url');
 assert.throws(()=>vault.open(parts.join('.'),'row-1'));
 assert.throws(()=>new TokenVault(Buffer.alloc(16)));
 assert.notEqual(vault.seal('x','r'),vault.seal('x','r'),'random IV');
});

test('Payments configuration: off by default, fails closed when enabled but incomplete',()=>{
 const context={production:true,origin:'https://groups.example.test',storefrontOrigins:['https://store.example.test']};
 assert.equal(paymentsConfig({},context).state,'DISABLED');
 assert.equal(paymentsConfig({CARDCOM_ENABLED:'false'},context).state,'DISABLED');
 const missingKey=paymentsConfig({...CARDCOM_ENV,GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY:''},context);
 assert.equal(missingKey.state,'MISCONFIGURED');assert.equal(missingKey.encryptionKey,undefined);
 assert.ok(missingKey.problems.some(p=>p.includes('GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY')));
 // Problems name variables only, never values.
 for(const problem of missingKey.problems)assert.ok(!problem.includes('test-api-name-not-real'));
 assert.equal(paymentsConfig({...CARDCOM_ENV,CARDCOM_SUCCESS_URL:'https://evil.example/pages/x'},context).state,'MISCONFIGURED','return page must be a storefront origin');
 assert.equal(paymentsConfig({...CARDCOM_ENV,CARDCOM_SUCCESS_URL:'http://store.example.test/pages/x'},context).state,'MISCONFIGURED','HTTPS in production');
 assert.equal(paymentsConfig({...CARDCOM_ENV,CARDCOM_WEBHOOK_URL:'https://other.example/webhooks/cardcom/low-profile'},context).state,'MISCONFIGURED');
 const ok=paymentsConfig(CARDCOM_ENV,context);
 assert.equal(ok.state,'ENABLED');assert.equal(ok.webhookUrl,'https://groups.example.test/webhooks/cardcom/low-profile');assert.equal(ok.failedUrl,ok.successUrl);
});

test('Raw card data is recognised anywhere in a body (and variant ids are not mistaken for cards)',()=>{
 assert.equal(containsCardData({cardNumber:'x'}),true);
 assert.equal(containsCardData({cvv:'123'}),true);
 assert.equal(containsCardData({nested:{CVV2:'1'}}),true);
 assert.equal(containsCardData({note:'4580 0000 0000 0000'}),true,'a Luhn-valid PAN in any text field');
 assert.equal(containsCardData({lines:[{variantId:'45800000000000',quantity:1}]}),false);
 assert.equal(containsCardData({email:'a@b.test',phone:'+972501234567',consent:{accepted:true,amountAgorot:25000}}),false);
});

test('Cardcom adapter: documented v11 contract, J2 token-only, no PII, fixed errors',async()=>{
 const sent:any[]=[];
 const ok=(body:any)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
 const service=new CardcomService({terminalNumber:1000,apiName:'api'},(async(_url:any,init:any)=>{sent.push(JSON.parse(init.body));return ok({ResponseCode:0,LowProfileId:'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10',Url:'https://secure.cardcom.solutions/EA/x'});}) as any,1000);
 const page=await service.createTokenReservation({reservationId:'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e11',amountAgorot:15720n,successUrl:'https://s/x',failedUrl:'https://s/y',webhookUrl:'https://w/z',productName:'p',language:'he'});
 assert.equal(page.lowProfileId,'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10');
 assert.equal(sent[0].Operation,'CreateTokenOnly');assert.equal(sent[0].AdvancedDefinition.JValidateType,2);assert.equal(sent[0].Amount,157.2);
 assert.equal(sent[0].ReturnValue,'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e11');
 assert.deepEqual(Object.keys(sent[0]).sort(),['AdvancedDefinition','Amount','ApiName','CancelRedirectUrl','FailedRedirectUrl','ISOCoinId','Language','Operation','ProductName','ReturnValue','SuccessRedirectUrl','TerminalNumber','WebHookUrl'],'no contact details or document data');
 // The hosted page must be Cardcom's own HTTPS host.
 const evil=new CardcomService({terminalNumber:1000,apiName:'api'},(async()=>ok({ResponseCode:0,LowProfileId:'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10',Url:'https://evil.example/pay'})) as any,1000);
 await assert.rejects(evil.createTokenReservation({reservationId:'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e11',amountAgorot:100n,successUrl:'https://s',failedUrl:'https://s',webhookUrl:'https://w',productName:'p',language:'he'}),(e:any)=>e instanceof CardcomError&&e.kind==='INVALID_RESPONSE');
 // Timeout -> TIMEOUT (ambiguous), error text never includes the request.
 const slow=new CardcomService({terminalNumber:1000,apiName:'api'},((_u:any,init:any)=>new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(Error('aborted with secret api'))))) as any,30);
 await assert.rejects(slow.getLowProfileResult('0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10'),(e:any)=>e instanceof CardcomError&&e.kind==='TIMEOUT'&&e.ambiguous&&!e.message.includes('api'));
 // 401 (credentials) on a charge performs nothing: a failed charge, not an unknown one.
 const denied=new CardcomService({terminalNumber:1000,apiName:'api'},(async()=>new Response(JSON.stringify({ResponseCode:401}),{status:401})) as any,1000);
 assert.deepEqual(await denied.chargeToken({token:'0b5f2c1e-8a1d-4b4f-9a43-5b5c2a7d9e10',cardExpirationMMYY:'0729',amountAgorot:100n,externalUniqTranId:'G0b5f2c1e8a1d4b4f9a435b5c'}),{state:'FAILED',responseCode:401});
});

test('Group Delivery card reservation and charging (Cardcom mocked)',{timeout:240000},async t=>{
 const f=await paymentsFixture();
 const originalConsole={...console};const consoleLines:string[]=[];
 for(const level of ['log','info','warn','error','debug'] as const)(console as any)[level]=(...args:unknown[])=>{consoleLines.push(args.map(String).join(' '));};
 const memberCount=async()=>Number((await f.db.query('SELECT COUNT(*)::int AS n FROM group_members')).rows[0].n);
 const groupRow=async(publicId:string)=>(await f.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[publicId])).rows[0];
 const reservationRow=async(id:string)=>(await f.db.query('SELECT * FROM group_payment_reservations WHERE id=$1',[id])).rows[0];
 const lpCalls=()=>f.cardcom.state.requests.filter(r=>r.path==='/api/v11/LowProfile/GetLpResult').length;
 const charges=()=>f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction');
 t.beforeEach(async()=>{
  await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups, request_limits, admin_sessions CASCADE');
  f.cardcom.state.requests.length=0;f.cardcom.state.chargeModes.clear();f.cardcom.state.lpMode='ok';f.cardcom.state.createMode='ok';f.shopify.prices={};
 });
 try{
  await t.test('free joins are refused while Cardcom is required; find reports it',async()=>{
   const found=await f.send('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:f.cart()});
   assert.equal(found.data.cardReservationRequired,true);
   const join=await f.send('/api/v1/groups/join',{areaPublicId:AREA.ashdod,...f.person(),lines:f.cart()});
   assert.equal(join.status,409);assert.equal(join.data.code,'CARD_RESERVATION_REQUIRED');
   assert.equal(await memberCount(),0);
  });
  await t.test('1-2. a reservation is not a membership and does not count toward the threshold',async()=>{
   const r=await f.reserve({quantity:4});// 500 ILS = the threshold
   assert.equal(r.status,201);
   assert.match(r.data.redirectUrl,/^https:\/\/secure\.cardcom\.solutions\//);
   assert.match(r.data.memberToken,/^[a-f0-9]{64}$/);assert.equal(r.data.reservation.status,'PENDING_RESERVATION');
   assert.equal(await memberCount(),0,'no member row');
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM delivery_groups')).rows[0].n),0,'no group without a member');
   // The receipt does not work as a member receipt yet.
   const status=await f.send('/api/v1/reservations/'+r.data.reservation.id,{},f.bearer(r.data.memberToken));
   assert.equal(status.data.reservation.status,'PENDING_RESERVATION');assert.equal(status.data.reservation.groupPublicId,null);
   // Cardcom page: CreateTokenOnly + J2, our reservation id as ReturnValue, no contact details.
   const page=f.cardcom.pageFor(r.data.reservation.id)!;
   assert.equal(page.operation,'CreateTokenOnly');assert.equal(page.jValidate,2);assert.equal(page.amount,500);
   assert.ok(!JSON.stringify(page.body).includes('@example.test'),'no email to Cardcom');
   assert.match(page.body.SuccessRedirectUrl,/^https:\/\/store\.example\.test\/pages\/group-delivery\?gd_result=success$/);
   assert.ok(!page.body.SuccessRedirectUrl.includes(r.data.memberToken)&&!page.body.SuccessRedirectUrl.includes(r.data.reservation.id),'no ids or tokens in the return URL');
   // A second shopper's reserved membership in the same area also does not see the pending one.
   const other=await f.join({quantity:1});
   assert.equal(other.group.participantCount,1);assert.equal(other.group.pledgedTotalAgorot,12500);assert.equal(other.group.status,'OPEN');
  });
  await t.test('3-4. a webhook activates only after a server-to-server GetLpResult success',async()=>{
   const r=await f.reserve();const page=f.cardcom.pageFor(r.data.reservation.id)!;
   const before=lpCalls();page.state='success';
   const hook=await f.webhook(page.id);assert.equal(hook.status,200);
   assert.equal(lpCalls(),before+1,'GetLpResult was called');
   const call=f.cardcom.state.requests.filter(x=>x.path==='/api/v11/LowProfile/GetLpResult').at(-1)!;
   assert.equal(call.body.LowProfileId,page.id);
   const row=await reservationRow(r.data.reservation.id);
   assert.equal(row.status,'CARD_RESERVED');assert.equal(row.email,null);assert.equal(row.cart_snapshot,null,'pending details erased');
   assert.ok(row.token_ciphertext.startsWith('v1.'));assert.ok(!row.token_ciphertext.includes(page.token),'token stored only sealed');
   const member=(await f.db.query('SELECT * FROM group_members WHERE id=$1',[row.member_id])).rows[0];
   assert.equal(member.status,'PLEDGED');assert.equal(member.payment_status,'CARD_RESERVED');assert.equal(Number(member.approved_amount_agorot),25000);assert.ok(member.consent_at);
   // The browser receipt from reserve now works for the member read.
   const groupId=(await f.send('/api/v1/reservations/'+r.data.reservation.id,{},f.bearer(r.data.memberToken))).data.reservation.groupPublicId;
   const read=await f.send('/api/v1/groups/'+groupId+'/member',{},f.bearer(r.data.memberToken));
   assert.equal(read.status,200);assert.equal(read.data.member.status,'PLEDGED');assert.equal(read.data.member.payment.status,'CARD_RESERVED');
   assert.deepEqual(Object.keys(read.data.member.payment).sort(),['approvedAmountAgorot','card','pendingAmountAgorot','status']);
  });
  await t.test('5. spoofed webhooks cannot activate anything',async()=>{
   const r=await f.reserve();const page=f.cardcom.pageFor(r.data.reservation.id)!;
   // Cardcom says the page is still open: a webhook with a forged "success" payload changes nothing.
   assert.equal((await f.webhook(page.id,{ResponseCode:0,Token:'11111111-1111-4111-8111-111111111111',Operation:'CreateTokenOnly',ReturnValue:r.data.reservation.id})).status,200);
   assert.equal((await reservationRow(r.data.reservation.id)).status,'PENDING_RESERVATION');assert.equal(await memberCount(),0);
   // Unknown page ids are ignored without detail; malformed ids are refused.
   assert.equal((await f.webhook('22222222-2222-4222-8222-222222222222')).status,200);
   assert.equal((await f.webhook('not-a-guid')).status,400);
   // A success for another terminal, another operation or another ReturnValue never activates (and closes the reservation).
   for(const mode of ['wrong-terminal','wrong-operation','wrong-return'] as const){
    const x=await f.reserve();const p=f.cardcom.pageFor(x.data.reservation.id)!;p.state='success';f.cardcom.state.lpMode=mode;
    assert.equal((await f.webhook(p.id)).status,200);
    const row=await reservationRow(x.data.reservation.id);
    assert.equal(row.status,'RESERVATION_FAILED',mode);assert.equal(row.failure_code,'VERIFICATION_FAILED');assert.equal(row.token_ciphertext,null);
   }
   f.cardcom.state.lpMode='ok';
   assert.equal(await memberCount(),0);
   // Cardcom unreachable: 503 so that Cardcom retries; nothing changes.
   const y=await f.reserve();const q=f.cardcom.pageFor(y.data.reservation.id)!;q.state='success';f.cardcom.state.lpMode='down';
   assert.equal((await f.webhook(q.id)).status,503);assert.equal((await reservationRow(y.data.reservation.id)).status,'PENDING_RESERVATION');
   f.cardcom.state.lpMode='ok';
   assert.equal((await f.webhook(q.id)).status,200);assert.equal((await reservationRow(y.data.reservation.id)).status,'CARD_RESERVED','the retry activates');
  });
  await t.test('6. duplicate and concurrent webhooks are idempotent',async()=>{
   const r=await f.reserve();const page=f.cardcom.pageFor(r.data.reservation.id)!;page.state='success';
   const results=await Promise.all([f.webhook(page.id),f.webhook(page.id),f.send('/api/v1/reservations/'+r.data.reservation.id,{returned:'success'},f.bearer(r.data.memberToken))]);
   for(const res of results)assert.equal(res.status,200);
   assert.equal(await memberCount(),1,'one member');
   const calls=lpCalls();
   for(let i=0;i<3;i++)assert.equal((await f.webhook(page.id)).status,200);
   assert.equal(lpCalls(),calls,'a final reservation is not even re-checked');
   const group=(await f.db.query('SELECT * FROM delivery_groups')).rows;
   assert.equal(group.length,1);assert.equal(Number(group[0].pledged_total_agorot),25000,'pledge counted once');
  });
  await t.test('7. a failed token creation never joins the group and is reported as not charged',async()=>{
   const r=await f.reserve();const page=f.cardcom.pageFor(r.data.reservation.id)!;page.state='declined';
   assert.equal((await f.webhook(page.id)).status,200);
   const status=await f.send('/api/v1/reservations/'+r.data.reservation.id,{},f.bearer(r.data.memberToken));
   assert.equal(status.data.reservation.status,'RESERVATION_FAILED');assert.equal(status.data.reservation.reason,'DECLINED');
   assert.equal(await memberCount(),0);
   // Coming back through the failure page while Cardcom still shows the page as open also ends it.
   const x=await f.reserve();
   const back=await f.send('/api/v1/reservations/'+x.data.reservation.id,{returned:'failed'},f.bearer(x.data.memberToken));
   assert.equal(back.data.reservation.status,'RESERVATION_FAILED');assert.equal(back.data.reservation.reason,'NOT_COMPLETED');
   // A Cardcom outage while creating the page: 503, a failed reservation, nothing else.
   f.cardcom.state.createMode='down';
   const down=await f.reserve();assert.equal(down.status,503);assert.equal(down.data.code,'PAYMENT_UNAVAILABLE');
   assert.equal(await memberCount(),0);
  });
  await t.test('8. abandoned reservations expire, erase details and never block the same contact',async()=>{
   const who=f.person();
   const r=await f.reserve({who});
   await f.db.query("UPDATE group_payment_reservations SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1",[r.data.reservation.id]);
   const status=await f.send('/api/v1/reservations/'+r.data.reservation.id,{},f.bearer(r.data.memberToken));
   assert.equal(status.data.reservation.status,'EXPIRED');assert.equal(status.data.reservation.reason,'ABANDONED');
   const row=await reservationRow(r.data.reservation.id);assert.equal(row.email,null);assert.equal(row.phone,null);
   // A late Cardcom success for the expired page changes nothing.
   const page=f.cardcom.pageFor(r.data.reservation.id)!;page.state='success';
   assert.equal((await f.webhook(page.id)).status,200);assert.equal(await memberCount(),0);
   // The same details can reserve and join again.
   const again=await f.join({who});assert.equal(again.status.status,'CARD_RESERVED');
   // A newer reservation for the same details supersedes an older pending one.
   const first=await f.reserve({who:f.person()}),second=await f.reserve({who:{email:'card-new@example.test',phone:(await reservationRow(first.data.reservation.id)).phone}});
   assert.equal((await reservationRow(first.data.reservation.id)).status,'CANCELED');assert.equal((await reservationRow(second.data.reservation.id)).status,'PENDING_RESERVATION');
  });
  await t.test('9. reserved members count toward the threshold',async()=>{
   const a=await f.join({quantity:2}),b=await f.join({quantity:2});
   assert.equal(b.group.publicId,a.group.publicId,'same area group');
   assert.equal(b.group.pledgedTotalAgorot,50000);assert.equal(b.group.status,'THRESHOLD_REACHED');assert.equal(b.group.participantCount,2);
   assert.equal(b.group.cardReservation,true);
  });
  await t.test('10-12. cancel before approval removes the pledge, deletes the token, is idempotent and is never charged',async()=>{
   // c joins first: once a group reaches the threshold it no longer matches new area joins.
   const c=await f.join({quantity:1}),a=await f.join({quantity:2}),b=await f.join({quantity:2});
   const id=a.group.publicId;assert.equal(c.group.publicId,id);
   const withdraw=await f.send('/api/v1/groups/'+id+'/withdraw',{confirm:true},f.bearer(c.memberToken));
   assert.equal(withdraw.status,200);assert.equal(withdraw.data.member.status,'WITHDRAWN');assert.equal(withdraw.data.group.pledgedTotalAgorot,50000);
   const row=await reservationRow(c.reservationId);
   assert.equal(row.status,'CANCELED');assert.equal(row.token_ciphertext,null,'sealed token deleted');
   const member=(await f.db.query('SELECT * FROM group_members WHERE id=$1',[row.member_id])).rows[0];
   assert.equal(member.payment_status,'CANCELED');assert.equal(Number(member.pledged_total_agorot),0);
   // 12: twice is fine and changes nothing.
   const again=await f.send('/api/v1/groups/'+id+'/withdraw',{confirm:true},f.bearer(c.memberToken));
   assert.equal(again.status,200);assert.equal(again.data.member.status,'WITHDRAWN');assert.equal(again.data.group.pledgedTotalAgorot,50000);
   // 11: approval charges only the two active members.
   const session=await f.login();
   assert.equal((await f.adminPost(session,'/admin/api/groups/'+id+'/approve')).status,200);
   await f.payments.idle();
   assert.equal(charges().length,2);
   assert.ok(!charges().some(x=>x.body.Token===c.page.token),'the canceled member was not charged');
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM group_payment_charges WHERE member_id=$1',[row.member_id])).rows[0].n),0);
   void b;
  });
  await t.test('13-15. a higher cart needs new consent; only the approved amount is ever charged',async()=>{
   const a=await f.join({quantity:2}),id=a.group.publicId;// approved 250.00
   const up=await f.send('/api/v1/groups/'+id+'/update-pledge',{lines:f.cart(3)},f.bearer(a.memberToken));// 375.00
   assert.equal(up.status,200);assert.deepEqual(up.data.consentRequired,{approvedAmountAgorot:25000,newAmountAgorot:37500});
   assert.equal(up.data.group.pledgedTotalAgorot,25000,'the unapproved amount does not count');
   let read=(await f.send('/api/v1/groups/'+id+'/member',{},f.bearer(a.memberToken))).data.member;
   assert.equal(read.payment.status,'CONSENT_REQUIRED');assert.equal(read.payment.pendingAmountAgorot,37500);assert.equal(read.pledgedTotalAgorot,25000);
   // 14: confirming a different amount (old consent, stale page) is refused.
   const wrong=await f.send('/api/v1/groups/'+id+'/confirm-pledge',{confirm:true,amountAgorot:25000},f.bearer(a.memberToken));
   assert.equal(wrong.status,409);assert.equal(wrong.data.code,'PLEDGE_AMOUNT_CHANGED');assert.equal(wrong.data.details.newAmountAgorot,37500);
   const unconfirmed=await f.send('/api/v1/groups/'+id+'/confirm-pledge',{amountAgorot:37500},f.bearer(a.memberToken));
   assert.equal(unconfirmed.data.code,'CONSENT_REQUIRED');
   // Re-priced in Shopify before the shopper confirms: refused with the new amount, which is then confirmable.
   f.shopify.prices['1']='130.00';
   const repriced=await f.send('/api/v1/groups/'+id+'/confirm-pledge',{confirm:true,amountAgorot:37500},f.bearer(a.memberToken));
   assert.equal(repriced.data.code,'PLEDGE_AMOUNT_CHANGED');assert.equal(repriced.data.details.newAmountAgorot,39000);
   const ok=await f.send('/api/v1/groups/'+id+'/confirm-pledge',{confirm:true,amountAgorot:39000},f.bearer(a.memberToken));
   assert.equal(ok.status,200);assert.equal(ok.data.group.pledgedTotalAgorot,39000);
   read=(await f.send('/api/v1/groups/'+id+'/member',{},f.bearer(a.memberToken))).data.member;
   assert.equal(read.payment.status,'CARD_RESERVED');assert.equal(read.payment.approvedAmountAgorot,39000);
   // A lower cart applies directly (charging less than approved is within the consent).
   const down=await f.send('/api/v1/groups/'+id+'/update-pledge',{lines:f.cart(2)},f.bearer(a.memberToken));
   assert.equal(down.data.consentRequired,undefined);assert.equal(down.data.group.pledgedTotalAgorot,26000);
   // Now raise again without confirming, fill the group and approve: the member is charged the approved cart only.
   await f.send('/api/v1/groups/'+id+'/update-pledge',{lines:f.cart(4)},f.bearer(a.memberToken));
   const b=await f.join({quantity:2,amount:26000});
   assert.equal(b.group.status,'THRESHOLD_REACHED');
   const session=await f.login();
   assert.equal((await f.adminPost(session,'/admin/api/groups/'+id+'/approve')).status,200);
   await f.payments.idle();
   const mine=charges().find(x=>x.body.Token===a.page.token)!;
   assert.equal(mine.body.Amount,260,'charged the approved 260.00, not the unapproved 520.00');
   assert.equal(mine.body.CardExpirationMMYY,'0729');
   assert.ok(mine.body.ExternalUniqTranId.length<=25,'Cardcom limit');
   assert.equal(mine.body.ExternalUniqTranId,(await f.db.query('SELECT external_uniq_tran_id AS id FROM group_payment_charges WHERE member_id=(SELECT member_id FROM group_payment_reservations WHERE id=$1)',[a.reservationId])).rows[0].id);
   // DB guarantee: a card member can never count more than approved.
   await assert.rejects(f.db.query("UPDATE group_members SET pledged_total_agorot=approved_amount_agorot+1 WHERE payment_status IS NOT NULL AND status='PLEDGED'"));
  });
  await t.test('16-17. double approval and repeated processing never charge twice',async()=>{
   const a=await f.join({quantity:2}),b=await f.join({quantity:2}),id=a.group.publicId;
   const session=await f.login();
   const [first,second]=await Promise.all([f.adminPost(session,'/admin/api/groups/'+id+'/approve'),f.adminPost(session,'/admin/api/groups/'+id+'/approve')]);
   assert.deepEqual([first.status,second.status].sort(),[200,409]);
   await Promise.all([f.adminPost(session,'/admin/api/groups/'+id+'/charges/process'),f.adminPost(session,'/admin/api/groups/'+id+'/charges/process'),f.payments.processCharges(id)]);
   await f.payments.idle();
   assert.equal(charges().length,2,'one Cardcom transaction per member');
   assert.equal(new Set(charges().map(x=>x.body.ExternalUniqTranId)).size,2);
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM group_payment_charges')).rows[0].n),2);
   const g=await groupRow(id);
   assert.equal(g.payment_state,'PAID');assert.equal(Number(g.paid_total_agorot),50000);
   // Tokens are deleted once charged.
   for(const r of [a,b]){const row=await reservationRow(r.reservationId);assert.equal(row.status,'CONSUMED');assert.equal(row.token_ciphertext,null);}
   const read=(await f.send('/api/v1/groups/'+id+'/member',{},f.bearer(a.memberToken))).data.member;
   assert.equal(read.payment.status,'CHARGED');
   // A charged member cannot self-withdraw (the group is closed for changes after approval).
   assert.equal((await f.send('/api/v1/groups/'+id+'/withdraw',{confirm:true},f.bearer(a.memberToken))).data.code,'GROUP_CLOSED');
   // Re-processing after completion does nothing.
   await f.payments.processCharges(id);await f.payments.idle();assert.equal(charges().length,2);
  });
  await t.test('18-19. failed and unknown charges: correct member states, partial group, no automatic retry, reconciliation',async()=>{
   const ok=await f.join({quantity:1}),declined=await f.join({quantity:1}),lost=await f.join({quantity:1}),down=await f.join({quantity:1}),id=ok.group.publicId;
   f.cardcom.state.chargeModes.set(declined.page.token,'decline');
   f.cardcom.state.chargeModes.set(lost.page.token,'lost');// performed at Cardcom, answer lost
   f.cardcom.state.chargeModes.set(down.page.token,'network');// never reached Cardcom
   const session=await f.login();
   assert.equal((await f.adminPost(session,'/admin/api/groups/'+id+'/approve')).status,200);
   await f.payments.idle();
   const state=async(r:{reservationId:string})=>(await f.db.query('SELECT m.payment_status,c.status FROM group_payment_reservations r JOIN group_members m ON m.id=r.member_id JOIN group_payment_charges c ON c.member_id=m.id WHERE r.id=$1',[r.reservationId])).rows[0];
   assert.deepEqual(await state(ok),{payment_status:'CHARGED',status:'SUCCEEDED'});
   assert.deepEqual(await state(declined),{payment_status:'PAYMENT_FAILED',status:'FAILED'});
   assert.deepEqual(await state(lost),{payment_status:'CHARGE_PENDING',status:'UNKNOWN'});
   assert.deepEqual(await state(down),{payment_status:'CHARGE_PENDING',status:'UNKNOWN'});
   let summary=(await f.send('/admin/api/groups/'+id,undefined,{Cookie:session.cookie})).data.group.charges;
   assert.deepEqual(summary,{state:'PAYMENT_REVIEW_REQUIRED',members:4,succeeded:1,failed:1,unknown:2,pending:0,paidAgorot:12500,failedAgorot:12500,unknownAgorot:25000,pendingAgorot:0,ordersCreated:4,orderFailed:0,orderUnknown:0,syncRequired:0,cancelRequired:0,ordersCanceled:1});
   assert.equal(Number((await groupRow(id)).paid_total_agorot),12500,'only confirmed charges are paid');
   // No automatic retry: processing again sends nothing.
   const sent=charges().length;
   await f.payments.processCharges(id);await f.payments.idle();assert.equal(charges().length,sent);
   // Reconciliation finds the lost one at Cardcom (by our ExternalUniqTranId) and leaves the other unknown.
   const rec=await f.adminPost(session,'/admin/api/groups/'+id+'/charges/reconcile');
   assert.equal(rec.status,200);assert.equal(rec.data.resolved,1);
   assert.deepEqual(await state(lost),{payment_status:'CHARGED',status:'SUCCEEDED'});
   assert.deepEqual(await state(down),{payment_status:'CHARGE_PENDING',status:'UNKNOWN'});
   summary=rec.data.summary;
   assert.equal(summary.succeeded,2);assert.equal(summary.unknown,1);assert.equal(summary.state,'PAYMENT_REVIEW_REQUIRED');
   assert.equal(charges().length,sent,'reconciliation never charges');
   // The admin group page shows the review state with counts and sums, never a token.
   const html=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   assert.match(html,/נדרשת בדיקת חיובים/);assert.match(html,/לכל משתתף נוצרת הזמנה בשופיפיי/);
   for(const token of f.cardcom.state.tokens)assert.ok(!html.includes(token));
   // A restart during a charge: rows left IN_FLIGHT become UNKNOWN, never re-sent.
   await f.db.query("UPDATE group_payment_charges SET status='IN_FLIGHT',started_at=NOW()-INTERVAL '10 minutes' WHERE status='UNKNOWN'");
   await f.payments.processCharges(id);await f.payments.idle();
   assert.equal((await state(down)).status,'UNKNOWN');assert.equal(charges().length,sent);
  });
  await t.test('withdrawn card member renews with a new card and consent (same receipt)',async()=>{
   const a=await f.join({quantity:1}),id=a.group.publicId;
   await f.send('/api/v1/groups/'+id+'/withdraw',{confirm:true},f.bearer(a.memberToken));
   const update=await f.send('/api/v1/groups/'+id+'/update-pledge',{lines:f.cart(1)},f.bearer(a.memberToken));
   assert.equal(update.data.code,'CARD_RESERVATION_REQUIRED','no card, no pledge');
   const renewed=await f.join({group:id,quantity:2,token:a.memberToken});
   assert.equal(renewed.status.status,'CARD_RESERVED');assert.equal(renewed.group.pledgedTotalAgorot,25000);
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM group_members')).rows[0].n),1,'same membership row');
  });
  await t.test('activation re-checks admission: a closed group or duplicate details fail safely without a member',async()=>{
   const who=f.person();
   const first=await f.reserve({who}),second=await f.reserve({who:{...who,email:'other@example.test'}});// same phone
   assert.equal((await reservationRow(first.data.reservation.id)).status,'CANCELED','superseded');
   const third=await f.reserve({who:f.person()});
   const page=f.cardcom.pageFor(third.data.reservation.id)!;
   // The area group appears via someone else, then gets approved before this shopper finishes the Cardcom page.
   const a=await f.join({quantity:2}),b=await f.join({quantity:2});void b;
   const session=await f.login();await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve');await f.payments.idle();
   page.state='success';await f.webhook(page.id);
   const row=await reservationRow(third.data.reservation.id);
   // No open group in the area any more: a new card group is opened with this shopper as first member.
   assert.equal(row.status,'CARD_RESERVED');assert.notEqual(row.group_id,(await groupRow(a.group.publicId)).id);
   // A reservation pinned to a specific group that closed in the meantime fails with GROUP_CLOSED and keeps nothing.
   const c=await f.join({quantity:1}),pinned=await f.reserve({group:c.group.publicId});
   await f.db.query("UPDATE delivery_groups SET status='EXPIRED' WHERE public_id=$1",[c.group.publicId]);
   const p=f.cardcom.pageFor(pinned.data.reservation.id)!;p.state='success';await f.webhook(p.id);
   const failed=await reservationRow(pinned.data.reservation.id);
   assert.equal(failed.status,'RESERVATION_FAILED');assert.equal(failed.failure_code,'GROUP_CLOSED');assert.equal(failed.token_ciphertext,null);
   void second;
  });
  await t.test('23. raw PAN/CVV are refused by every public API and never stored',async()=>{
   for(const body of [{areaPublicId:AREA.ashdod,...f.person(),lines:f.cart(),cardNumber:'4580000000000000',consent:{accepted:true,amountAgorot:25000}},
    {areaPublicId:AREA.ashdod,...f.person(),lines:f.cart(),cvv:'123',consent:{accepted:true,amountAgorot:25000}},
    {areaPublicId:AREA.ashdod,email:'4580 0000 0000 0000',phone:'0501234567',lines:f.cart(),consent:{accepted:true,amountAgorot:25000}}]){
    const r=await f.send('/api/v1/groups/reserve',body);
    assert.equal(r.status,400);assert.equal(r.data.code,'CARD_DATA_NOT_ACCEPTED');
   }
   assert.equal((await f.send('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:f.cart(),card:{number:'4580000000000000'}})).data.code,'CARD_DATA_NOT_ACCEPTED');
   assert.equal(Number((await f.db.query('SELECT COUNT(*)::int AS n FROM group_payment_reservations')).rows[0].n),0);
   // Consent is mandatory and must match the server-validated amount.
   assert.equal((await f.send('/api/v1/groups/reserve',{areaPublicId:AREA.ashdod,...f.person(),lines:f.cart()})).data.code,'CONSENT_REQUIRED');
   const changed=await f.reserve({amount:20000});
   assert.equal(changed.status,409);assert.equal(changed.data.code,'PLEDGE_AMOUNT_CHANGED');assert.equal(changed.data.details.newAmountAgorot,25000);
  });
  await t.test('21-22. Cardcom tokens never appear in any response or log line',async()=>{
   // Exercise logging paths (failures) as well as successes.
   await f.join({quantity:1});
   const x=await f.reserve();f.cardcom.state.lpMode='down';const p=f.cardcom.pageFor(x.data.reservation.id)!;p.state='success';await f.webhook(p.id);f.cardcom.state.lpMode='ok';
   const all=[...f.bodies,...f.logs,...consoleLines].join('\n');
   assert.ok(f.cardcom.state.tokens.length>10);
   for(const token of f.cardcom.state.tokens)assert.ok(!all.includes(token),'token leaked');
   assert.ok(!all.includes('test-api-name-not-real'),'API name never echoed');
   assert.ok(f.logs.length>0);for(const line of f.logs)assert.match(line,/^Group delivery [^@]*$/);
   // Tokens are only stored sealed.
   const sealed=(await f.db.query('SELECT token_ciphertext FROM group_payment_reservations WHERE token_ciphertext IS NOT NULL')).rows;
   for(const row of sealed)for(const token of f.cardcom.state.tokens)assert.ok(!row.token_ciphertext.includes(token));
  });
 }finally{Object.assign(console,originalConsole);await f.close();}
});

test('20, 24-27. Cardcom enabled without an encryption key fails closed; Cardcom off keeps the existing flow',{timeout:120000},async t=>{
 const closed=await paymentsFixture({...CARDCOM_ENV,GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY:''});
 const off=await paymentsFixture({});
 try{
  await t.test('20. missing key: service runs, joins need a card, reservations answer 503, nothing reaches Cardcom',async()=>{
   assert.equal(closed.cfg.payments.state,'MISCONFIGURED');
   assert.equal((await closed.send('/health')).status,200);
   assert.equal((await closed.send('/api/v1/groups/join',{areaPublicId:AREA.ashdod,...closed.person(),lines:closed.cart()})).data.code,'CARD_RESERVATION_REQUIRED');
   const r=await closed.reserve();assert.equal(r.status,503);assert.equal(r.data.code,'PAYMENT_UNAVAILABLE');
   assert.equal(closed.cardcom.state.requests.length,0);
   assert.equal(Number((await closed.db.query('SELECT COUNT(*)::int AS n FROM group_payment_reservations')).rows[0].n),0);
  });
  await t.test('24-27. Cardcom off: free join, matching, totals, withdrawal and approval are unchanged',async()=>{
   assert.equal(off.cfg.payments.state,'DISABLED');
   const found=await off.send('/api/v1/groups/find',{areaPublicId:AREA.ashdod,lines:off.cart()});
   assert.equal(found.data.cardReservationRequired,undefined);assert.equal(found.data.group,null);
   const a=await off.send('/api/v1/groups/join',{areaPublicId:AREA.ashdod,...off.person(),lines:off.cart()});
   assert.equal(a.status,201);assert.equal(a.data.group.cardReservation,undefined);
   const b=await off.send('/api/v1/groups/join',{areaPublicId:AREA.ashdod,...off.person(),lines:off.cart()});
   assert.equal(b.data.group.publicId,a.data.group.publicId);assert.equal(b.data.group.status,'THRESHOLD_REACHED');
   // Another area never matches.
   const other=await off.send('/api/v1/groups/join',{areaPublicId:AREA.beerSheva,...off.person(),lines:off.cart()});
   assert.notEqual(other.data.group.publicId,a.data.group.publicId);
   assert.equal((await off.send('/api/v1/groups/reserve',{areaPublicId:AREA.ashdod,...off.person(),lines:off.cart(),consent:{accepted:true,amountAgorot:25000}})).status,409);
   const member=(await off.send('/api/v1/groups/'+a.data.group.publicId+'/member',{},off.bearer(a.data.memberToken))).data.member;
   assert.deepEqual(Object.keys(member).sort(),['cart','cartCheck','pledgedTotalAgorot','status'],'member read unchanged');
   const w=await off.send('/api/v1/groups/'+a.data.group.publicId+'/withdraw',{confirm:true},off.bearer(a.data.memberToken));
   assert.equal(w.data.member.status,'WITHDRAWN');assert.equal(w.data.group.status,'OPEN');
   const session=await off.login();
   const c=await off.send('/api/v1/groups/join',{areaPublicId:AREA.ashdod,...off.person(),lines:off.cart()});assert.equal(c.data.group.status,'THRESHOLD_REACHED');
   assert.equal((await off.adminPost(session,'/admin/api/groups/'+a.data.group.publicId+'/approve')).status,200);
   assert.equal(off.cardcom.state.requests.length,0,'no Cardcom call without cards');
   const g=(await off.db.query('SELECT payment_mode,payment_state,paid_total_agorot FROM delivery_groups WHERE public_id=$1',[a.data.group.publicId])).rows[0];
   assert.deepEqual({...g,paid_total_agorot:Number(g.paid_total_agorot)},{payment_mode:'NONE',payment_state:null,paid_total_agorot:0});
  });
  await t.test('27. groups and members from before Cardcom keep working after it is enabled',async()=>{
   // A NONE group created while Cardcom was off, then Cardcom is enabled (same database, new app config).
   const legacy=await off.send('/api/v1/groups/join',{areaPublicId:AREA.ashkelon,...off.person(),lines:off.cart()});
   const db=off.db;
   const {createApp}=await import('../src/server.js');const {config}=await import('../src/config.js');const {Shopify}=await import('../src/shopify.js');
   const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330',...CARDCOM_ENV});
   const validator=new Shopify(cfg,async(_i,o)=>{const body=JSON.parse(String(o?.body));return new Response(JSON.stringify({data:{nodes:body.variables.ids.map((id:string)=>({id,title:'Default Title',availableForSale:true,requiresComponents:false,quantityAvailable:100,price:{amount:'125.00',currencyCode:'ILS'},quantityRule:{minimum:1,increment:1,maximum:null},product:{title:'x',requiresSellingPlan:false}}))}}));});
   const app=createApp(db,cfg,validator,{cardcom:null});const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
   cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
   try{
    const post=(path:string,body:any,token?:string)=>fetch(cfg.origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:cfg.origin,...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json() as any}));
    const id=legacy.data.group.publicId;
    // The existing member updates and withdraws as before; no card is involved.
    assert.equal((await post('/api/v1/groups/'+id+'/update-pledge',{lines:[{variantId:'1',quantity:3}]},legacy.data.memberToken)).data.validatedPledgeAgorot,37500);
    assert.equal((await post('/api/v1/groups/'+id+'/withdraw',{confirm:true},legacy.data.memberToken)).data.member.status,'WITHDRAWN');
    // The old group takes no new members; the area search finds no card group yet.
    const found=await post('/api/v1/groups/find',{areaPublicId:AREA.ashkelon});
    assert.equal(found.data.group,null);assert.equal(found.data.cardReservationRequired,true);
   }finally{await new Promise<void>(r=>server.close(()=>r()));}
  });
 }finally{await closed.close();await off.close();}
});
