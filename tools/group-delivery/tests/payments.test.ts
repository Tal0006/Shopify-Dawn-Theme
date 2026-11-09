// Payment foundation: verification gate on Join; merchant approval opens a frozen, time-boxed approval window;
// member approval is consent only; execution revalidates with Shopify, then authorizes and captures (or the
// direct-charge fallback) once approved value covers the target; privacy, admin aggregates and fail-closed config.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Groups} from '../src/groups.js';
import {config} from '../src/config.js';
import {ApiError,hash} from '../src/domain.js';
import {migrate,type Database,type Connection} from '../src/db.js';
import {MockPaymentProvider,UnavailablePaymentProvider} from '../src/payments.js';
// Every scheduled-maintenance subtest calls service.maintain() directly; no page visit is involved.
const ASHDOD='6f1a2c00-0002-4a00-8000-0000000000a2',ASHKELON='6f1a2c00-0003-4a00-8000-0000000000a3';
const ENV={PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'};
function harness(dir:string){
 const state={engine:new PGlite(dir)};
 const query=async(sql:string,values?:any[]):Promise<any>=>values?state.engine.query(sql,values):(await state.engine.exec(sql)).at(-1)||{rows:[]};
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const db:Database={
  async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},
  async connect(){const release=await acquire();return {query,release} as Connection;}
 };
 return {state,db};
}
const cleanup=async(dir:string)=>{if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-pay-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});};

test('configuration fails closed, the simulator needs an explicit opt-in, the approval window is bounded',()=>{
 assert.equal(config(ENV).paymentProvider,'none','no provider by default');
 assert.equal(config(ENV).paymentApprovalHours,24,'24 hour approval window by default');
 assert.equal(config({...ENV,PAYMENT_APPROVAL_HOURS:'48'}).paymentApprovalHours,48);
 for(const hours of ['0','169','1.5','x'])assert.throws(()=>config({...ENV,PAYMENT_APPROVAL_HOURS:hours}),/PAYMENT_APPROVAL_HOURS/);
 assert.equal(config({...ENV,PAYMENT_PROVIDER:'mock',ALLOW_MOCK_PAYMENTS:'true'}).paymentProvider,'mock');
 assert.throws(()=>config({...ENV,PAYMENT_PROVIDER:'mock'}),/ALLOW_MOCK_PAYMENTS/);
 assert.throws(()=>config({...ENV,PAYMENT_PROVIDER:'mock',ALLOW_MOCK_PAYMENTS:'1'}),/ALLOW_MOCK_PAYMENTS/);
 assert.throws(()=>config({...ENV,NODE_ENV:'production',APP_ORIGIN:'https://groups.example.test',PAYMENT_PROVIDER:'mock'}),/ALLOW_MOCK_PAYMENTS/);
 assert.throws(()=>config({...ENV,PAYMENT_PROVIDER:'payplus'}),/Invalid PAYMENT_PROVIDER/,'unknown providers are refused, not ignored');
 assert.equal(config(ENV).paymentExecutionPolicy,'require_authorization','authorize/capture required by default');
 assert.equal(config({...ENV,PAYMENT_EXECUTION_POLICY:'allow_direct_charge'}).paymentExecutionPolicy,'allow_direct_charge');
 assert.throws(()=>config({...ENV,PAYMENT_EXECUTION_POLICY:'charge'}),/PAYMENT_EXECUTION_POLICY/);
 assert.throws(()=>config({...ENV,NODE_ENV:'production',APP_ORIGIN:'https://groups.example.test',PAYMENT_EXECUTION_POLICY:'allow_direct_charge'}),/not approved for production/);
 assert.equal(config(ENV).maintenanceToken,undefined);assert.throws(()=>config({...ENV,MAINTENANCE_TOKEN:'short'}),/MAINTENANCE_TOKEN/);
});

test('Group Delivery payment foundation',{timeout:300000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-pay-db-'));const {state,db}=harness(dir);
 const cfg=config({...ENV,PAYMENT_PROVIDER:'mock',ALLOW_MOCK_PAYMENTS:'true'});
 // Shopify stand-in: unit price, an unavailable quantity and an outage switch; every call is logged in `events`.
 const shop={unit:12500n,down:false,unavailableQuantity:0};
 const events:string[]=[];let shopifyCalls=0;
 const validator={validate:async(items:{variantId:string;quantity:number}[])=>{
  shopifyCalls++;events.push('shopify');
  if(shop.down)throw new ApiError(503,'SHOPIFY_UNAVAILABLE');
  if(items.some(item=>item.quantity===shop.unavailableQuantity))throw new ApiError(422,'CART_UNAVAILABLE');
  return {total:items.reduce((sum,item)=>sum+shop.unit*BigInt(item.quantity),0n),snapshot:items.map(item=>({...item,unitAgorot:shop.unit.toString()}))};
 }};
 // Mock provider with a call log and optional per-call outcome queues.
 const mock=new MockPaymentProvider(),requests:{kind:string;input:any}[]=[];
 const queues:Record<string,string[]>={createCharge:[],authorize:[],capture:[]};let voidFailures=0;
 const outcomeField:Record<string,'chargeOutcome'|'authorizationOutcome'|'captureOutcome'>={createCharge:'chargeOutcome',authorize:'authorizationOutcome',capture:'captureOutcome'};
 for(const kind of ['createCharge','authorize','capture','voidAuthorization'] as const){
  const original=(mock as any)[kind].bind(mock);
  (mock as any)[kind]=async(input:any)=>{if(kind==='voidAuthorization'&&voidFailures>0){voidFailures--;throw Error('simulated void outage');}requests.push({kind,input});events.push(kind);const next=queues[kind]?.shift();if(next)(mock as any)[outcomeField[kind]]=next;return original(input);};
 }
 const service=new Groups(db,cfg,validator,undefined,mock),app=createApp(db,cfg,validator,mock);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 const printed:string[]=[],consoleBackup={info:console.info,warn:console.warn,error:console.error,log:console.log,debug:console.debug};
 for(const level of ['info','warn','error','log','debug'] as const)console[level]=(...args:any[])=>{printed.push(args.map(String).join(' '));};
 let index=0;const person=()=>({email:'pay'+(++index)+'@example.test',phone:'+972502'+String(index).padStart(6,'0')});
 const line=(quantity=2)=>[{variantId:'1',quantity}];
 const http=(method:string,path:string,body?:any,headers:Record<string,string>={})=>fetch(cfg.origin+path,{method,headers:{Origin:cfg.origin,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{}),redirect:'manual'});
 const json=async(response:Response)=>({status:response.status,body:await response.json() as any});
 const bearer=(token:string)=>({Authorization:'Bearer '+token});
 const verify=async(who:{email:string;phone:string},outcome:'verified'|'failed'|'cancelled'='verified')=>{
  const created=await json(await http('POST','/api/v1/payment-verifications',who));
  assert.equal(created.status,201);
  const result=await json(await http('POST','/api/v1/payment-verifications/'+created.body.verification.id+'/mock-result',{outcome},bearer(created.body.verificationToken)));
  assert.equal(result.status,200);
  return {verificationId:created.body.verification.id as string,verificationToken:created.body.verificationToken as string,status:result.body.verification.status as string};
 };
 const fields=({verificationId,verificationToken}:{verificationId:string;verificationToken:string})=>({verificationId,verificationToken});
 const joinArea=async(who=person(),quantity=2,area=ASHDOD)=>{const v=await verify(who);return json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:area,lines:line(quantity)}));};
 const approve=async(groupId:string,token:string,body:any)=>json(await http('POST','/api/v1/groups/'+groupId+'/payment-approval',body,bearer(token)));
 const membership=async(groupId:string,token:string)=>json(await http('GET','/api/v1/groups/'+groupId+'/membership',undefined,bearer(token)));
 const consent=async(groupId:string,token:string)=>{const state=(await membership(groupId,token)).body.member;return approve(groupId,token,{decision:'approve',approvalNonce:state.approval.nonce,amountAgorot:state.approval.amountAgorot});};
 const count=async(sql:string,values:any[]=[])=>Number((await db.query(sql,values)).rows[0].n);
 const memberRow=async(token:string)=>(await db.query('SELECT * FROM group_members WHERE token_hash=$1',[hash(token)])).rows[0];
 const groupRow=async(id:string)=>(await db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[id])).rows[0];
 const pastDeadline=(id:string)=>db.query("UPDATE delivery_groups SET approval_deadline=NOW()-INTERVAL '1 second' WHERE public_id=$1",[id]);
 const kinds=(kind:string)=>requests.filter(request=>request.kind===kind);
 // Members of 250 ILS each (quantity 2 × 125.00); the default target is 500 ILS.
 // Members after the first join that group directly (area search offers only OPEN groups).
 const joinGroup=async(id:string,who=person(),quantity=2)=>{const v=await verify(who);return json(await http('POST','/api/v1/groups/'+id+'/join',{...who,...fields(v),areaPublicId:ASHDOD,lines:line(quantity)}));};
 const group=async(size=2,quantities:number[]=[])=>{
  const first=await joinArea(person(),quantities[0]??2);assert.equal(first.status,201);
  const id=first.body.group.publicId as string,members=[first.body.memberToken as string];
  for(let i=1;i<size;i++){const reply=await joinGroup(id,person(),quantities[i]??2);assert.equal(reply.status,201);members.push(reply.body.memberToken as string);}
  return {id,members};
 };
 const opened=async(size=2,quantities:number[]=[])=>{const g=await group(size,quantities);assert.equal((await service.approve(g.id)).status,'PAYMENT_OPEN');return g;};
 t.beforeEach(async()=>{
  Object.assign(shop,{unit:12500n,down:false,unavailableQuantity:0});voidFailures=0;cfg.paymentExecutionPolicy='require_authorization';cfg.maintenanceToken=undefined;events.length=0;requests.length=0;for(const key in queues)queues[key].length=0;
  Object.assign(mock,{supportsAuthorization:true,chargeOutcome:'succeed',authorizationOutcome:'succeed',captureOutcome:'succeed',chargeCount:0,authorizationCount:0,voidCount:0});
  await db.query('TRUNCATE group_members, delivery_groups, payment_verifications, request_limits, admin_sessions CASCADE');
 });
 try{
  await migrate(db);
  await t.test('Join without a verified payment method is rejected on both join routes and creates nothing',async()=>{
   const who=person();
   for(const body of [{...who,areaPublicId:ASHDOD,lines:line()},{...who,areaPublicId:ASHDOD,lines:line(),verified:true,paymentVerified:true,verificationStatus:'VERIFIED'}]){
    const reply=await json(await http('POST','/api/v1/groups/join',body));
    assert.equal(reply.status,403);assert.equal(reply.body.code,'PAYMENT_VERIFICATION_REQUIRED');
   }
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM delivery_groups'),0,'no group without a verified first member');
   const created=(await joinArea()).body.group.publicId;
   const direct=await json(await http('POST','/api/v1/groups/'+created+'/join',{...who,areaPublicId:ASHDOD,lines:line(),verified:true}));
   assert.equal(direct.status,403);assert.equal(direct.body.code,'PAYMENT_VERIFICATION_REQUIRED');
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM group_members'),1);
  });
  await t.test('A verified method allows Join once; the verification is consumed and cannot be reused',async()=>{
   const who=person(),v=await verify(who);assert.equal(v.status,'VERIFIED');
   const joined=await json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHDOD,lines:line()}));
   assert.equal(joined.status,201);assert.equal(joined.body.member.paymentMethod,'VERIFIED');assert.equal(joined.body.member.approval.status,'NOT_REQUIRED');
   assert.equal(joined.body.member.charge.status,'NOT_STARTED');
   assert.equal((await json(await http('GET','/api/v1/payment-verifications/'+v.verificationId,undefined,bearer(v.verificationToken)))).body.verification.status,'USED');
   const reuse=await json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHKELON,lines:line()}));
   assert.equal(reuse.status,403);assert.equal(reuse.body.code,'PAYMENT_VERIFICATION_REQUIRED');
   assert.equal(mock.chargeCount,0,'verification never charges');assert.equal(requests.length,0);
  });
  await t.test('Failed and cancelled verifications never allow Join and cannot be flipped afterwards',async()=>{
   for(const outcome of ['failed','cancelled'] as const){
    const who=person(),v=await verify(who,outcome);
    assert.equal(v.status,outcome==='failed'?'FAILED':'CANCELLED');
    const again=await json(await http('POST','/api/v1/payment-verifications/'+v.verificationId+'/mock-result',{outcome:'verified'},bearer(v.verificationToken)));
    assert.equal(again.body.verification.status,v.status,'a finished attempt stays finished');
    const reply=await json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHDOD,lines:line()}));
    assert.equal(reply.status,403);assert.equal(reply.body.code,'PAYMENT_VERIFICATION_REQUIRED');
   }
   const pending=await json(await http('POST','/api/v1/payment-verifications',person()));
   assert.equal(pending.body.verification.status,'PENDING');assert.deepEqual(pending.body.next,{type:'mock'});
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM group_members'),0);
  });
  await t.test('Forged ids or secrets, another shopper\'s verification and expired verifications are rejected',async()=>{
   const owner=person(),v=await verify(owner),other=person();
   const tries=[
    {...other,verificationId:v.verificationId,verificationToken:v.verificationToken},
    {...owner,verificationId:v.verificationId,verificationToken:'f'.repeat(64)},
    {...owner,verificationId:'00000000-0000-4000-8000-000000000000',verificationToken:v.verificationToken},
    {...owner,verificationId:v.verificationId},{...owner,verificationId:v.verificationId,verificationToken:42},
    {...owner,email:owner.email,phone:'+972509999999',...fields(v)}
   ];
   for(const body of tries){const reply=await json(await http('POST','/api/v1/groups/join',{...body,areaPublicId:ASHDOD,lines:line()}));assert.equal(reply.status,403,JSON.stringify(Object.keys(body)));assert.equal(reply.body.code,'PAYMENT_VERIFICATION_REQUIRED');}
   assert.equal((await http('GET','/api/v1/payment-verifications/'+v.verificationId,undefined,bearer('e'.repeat(64)))).status,403);
   assert.equal((await http('POST','/api/v1/payment-verifications/'+v.verificationId+'/mock-result',{outcome:'verified'},bearer('e'.repeat(64)))).status,403);
   assert.equal((await json(await http('POST','/api/v1/groups/join',{...owner,...fields(v),areaPublicId:ASHDOD,lines:line()}))).status,201,'failed attempts consumed nothing');
   const late=person(),expiring=await verify(late);
   await db.query("UPDATE payment_verifications SET expires_at=NOW()-INTERVAL '1 second' WHERE public_id=$1",[expiring.verificationId]);
   const expired=await json(await http('POST','/api/v1/groups/join',{...late,...fields(expiring),areaPublicId:ASHDOD,lines:line()}));
   assert.equal(expired.status,403);assert.equal(expired.body.code,'PAYMENT_VERIFICATION_REQUIRED');
  });
  await t.test('A join rejected for another reason keeps the verification; contact normalization still binds it',async()=>{
   const who=person(),first=await joinArea(who);assert.equal(first.status,201);
   const v=await verify({email:who.email.toUpperCase(),phone:'0'+who.phone.slice(4)});
   assert.equal((await json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHDOD,lines:line()}))).body.code,'ALREADY_JOINED');
   assert.equal((await json(await http('GET','/api/v1/payment-verifications/'+v.verificationId,undefined,bearer(v.verificationToken)))).body.verification.status,'VERIFIED','not consumed');
   assert.equal((await json(await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHKELON,lines:line()}))).status,201,'normalized contact matches');
  });
  await t.test('Reaching the threshold alone opens no payment approvals and keeps pledges editable',async()=>{
   const {id,members:[a,b]}=await group();
   const reached=(await json(await http('GET','/api/v1/groups/'+id))).body.group;
   assert.equal(reached.status,'THRESHOLD_REACHED');assert.deepEqual(reached.approvals,{approved:0,waiting:0,approvedPledgeTotalAgorot:0,ready:false,deadline:null});
   const view=(await membership(id,a)).body.member;
   assert.equal(view.approval.status,'NOT_REQUIRED');assert.equal(view.approval.nonce,null);assert.deepEqual(view.actions,{approve:false,decline:false});
   const early=await approve(id,a,{decision:'approve',approvalNonce:'0'.repeat(32),amountAgorot:25000});
   assert.equal(early.status,409);assert.equal(early.body.code,'PAYMENT_APPROVAL_NOT_AVAILABLE');
   assert.equal((await json(await http('POST','/api/v1/groups/'+id+'/update-pledge',{lines:line(3)},bearer(b)))).status,200,'pledges still editable');
   assert.equal(requests.length,0);assert.equal(mock.chargeCount,0);
  });
  await t.test('Merchant approval opens PAYMENT_OPEN with a fixed deadline and freezes the group immediately',async()=>{
   const {id,members:[a,b]}=await group();
   const before=Date.now(),opened=await service.approve(id);
   assert.equal(opened.status,'PAYMENT_OPEN');
   const deadline=Date.parse(opened.approvals.deadline);
   assert.ok(Math.abs(deadline-before-24*3600000)<120000,'deadline is 24 hours after opening');
   for(const token of [a,b]){
    const view=(await membership(id,token)).body.member;
    assert.equal(view.approval.status,'REQUIRED');assert.equal(view.approval.amountAgorot,25000);assert.match(view.approval.nonce,/^[a-f0-9]{32}$/);
    assert.deepEqual(view.actions,{approve:true,decline:true});
   }
   // Frozen before anyone approves.
   assert.equal((await json(await http('POST','/api/v1/groups/'+id+'/update-pledge',{lines:line(3)},bearer(b)))).body.code,'GROUP_CLOSED');
   const late=person(),lv=await verify(late);
   assert.equal((await json(await http('POST','/api/v1/groups/'+id+'/join',{...late,...fields(lv),areaPublicId:ASHDOD,lines:line()}))).body.code,'GROUP_CLOSED');
   await assert.rejects(()=>service.approve(id),(e:any)=>e.code==='APPROVAL_NOT_ALLOWED','approval is one-shot');
   assert.equal((await groupRow(id)).approval_deadline.getTime(),deadline,'deadline never moves');
   assert.equal(requests.length,0);
  });
  await t.test('Customer approval records consent for the exact amount and creates zero charges',async()=>{
   const {id,members:[a]}=await opened();
   const reply=await consent(id,a);
   assert.equal(reply.status,200);assert.equal(reply.body.member.approval.status,'APPROVED');assert.equal(reply.body.member.charge.status,'NOT_STARTED');
   assert.deepEqual(reply.body.group.approvals,{approved:1,waiting:1,approvedPledgeTotalAgorot:25000,ready:false,deadline:reply.body.group.approvals.deadline});
   const repeat=await approve(id,a,{decision:'approve',approvalNonce:'1'.repeat(32),amountAgorot:1});
   assert.equal(repeat.status,200,'repeat approval is idempotent');assert.equal(repeat.body.member.approval.status,'APPROVED');
   assert.ok((await memberRow(a)).approved_at);
   assert.equal(requests.length,0,'no provider call');assert.equal(mock.chargeCount,0);assert.equal(mock.authorizationCount,0);
  });
  await t.test('Only approved value counts; declined members are excluded; enough approval executes after revalidation',async()=>{
   const {id,members:[a,b,c]}=await opened(3);
   await consent(id,a);
   const declined=await approve(id,b,{decision:'decline'});
   assert.equal(declined.body.member.approval.status,'DECLINED');assert.equal(declined.body.group.approvals.approvedPledgeTotalAgorot,25000);
   assert.equal(declined.body.group.approvals.ready,false);assert.equal(requests.length,0);
   events.length=0;
   const last=await consent(id,c);
   assert.equal(last.body.group.status,'CONFIRMED');
   // Shopify revalidation of both approved members happened before any provider call; the decliner was not touched.
   assert.deepEqual(events,['shopify','shopify','authorize','authorize','capture','capture']);
   assert.equal(mock.authorizationCount,2);assert.equal(mock.chargeCount,2);
   assert.deepEqual(kinds('authorize').map(r=>r.input.amountAgorot),[25000n,25000n]);
   assert.equal((await memberRow(b)).charge_status,'NOT_STARTED','declined member never charged');
   assert.equal((await membership(id,a)).body.member.charge.status,'SUCCEEDED');
   assert.equal(String((await groupRow(id)).paid_total_agorot),'50000');
  });
  await t.test('Deadline passes before enough approval: zero charges, the group expires, audit state is kept',async()=>{
   const {id,members:[a,b]}=await opened();
   await consent(id,a);await pastDeadline(id);
   const view=await membership(id,b);
   assert.equal(view.body.group.status,'EXPIRED');assert.equal(view.body.member.approval.status,'EXPIRED');assert.deepEqual(view.body.member.actions,{approve:false,decline:false});
   const row=await groupRow(id);assert.equal(row.closed_reason,'APPROVAL_DEADLINE');assert.ok(row.closed_at);
   assert.equal((await memberRow(a)).approval_status,'APPROVED','consent kept for audit');assert.equal((await memberRow(a)).charge_status,'NOT_STARTED');
   assert.equal((await consent(id,b)).body.code,'PAYMENT_APPROVAL_NOT_AVAILABLE');
   assert.equal(requests.length,0);assert.equal(mock.chargeCount,0);assert.equal(shopifyCalls>0,true);
  });
  await t.test('Enough approval but members still waiting: execution waits for the deadline, then late requests expire',async()=>{
   const {id,members:[a,b,c]}=await opened(3);
   await consent(id,a);const ready=await consent(id,b);
   assert.equal(ready.body.group.approvals.ready,true);assert.equal(ready.body.group.status,'PAYMENT_OPEN');
   assert.equal(requests.length,0,'waits while someone can still answer');
   await pastDeadline(id);
   const done=await membership(id,a);
   assert.equal(done.body.group.status,'CONFIRMED');assert.equal(done.body.member.charge.status,'SUCCEEDED');
   assert.equal((await memberRow(c)).approval_status,'EXPIRED');assert.equal((await memberRow(c)).charge_status,'NOT_STARTED');
   assert.equal(mock.chargeCount,2);
  });
  await t.test('Merchant can execute early once approved value covers the target; late approvals still execute',async()=>{
   const {id,members:[a,b,c]}=await opened(3);
   await consent(id,a);
   await assert.rejects(()=>service.execute(id),(e:any)=>e.code==='APPROVAL_NOT_ALLOWED','not ready yet');
   await consent(id,b);
   const executed=await service.execute(id);
   assert.equal(executed.status,'PAYMENT_OPEN','still open for the waiting member');assert.equal(mock.chargeCount,2);
   const late=await consent(id,c);
   assert.equal(late.body.member.charge.status,'SUCCEEDED');assert.equal(late.body.group.status,'CONFIRMED');assert.equal(mock.chargeCount,3);
  });
  await t.test('Shopify revalidation: a changed price voids the approval, asks for a new one and charges nothing',async()=>{
   const {id,members:[a,b]}=await opened();
   const oldNonce=(await membership(id,a)).body.member.approval.nonce;
   await consent(id,a);shop.unit=13000n;
   const after=await consent(id,b);
   assert.equal(requests.length,0,'nothing reached the provider');assert.equal(after.body.group.status,'PAYMENT_OPEN');
   const view=(await membership(id,a)).body.member;
   assert.equal(view.approval.status,'REQUIRED');assert.equal(view.approval.review,'CART_CHANGED');assert.equal(view.approval.amountAgorot,26000);assert.notEqual(view.approval.nonce,oldNonce);
   assert.equal(Number((await groupRow(id)).pledged_total_agorot),52000);
   assert.equal((await approve(id,a,{decision:'approve',approvalNonce:oldNonce,amountAgorot:25000})).body.code,'PAYMENT_AMOUNT_CHANGED','the old amount can no longer be approved');
   await consent(id,a);const done=await consent(id,b);
   assert.equal(done.body.group.status,'CONFIRMED');
   assert.deepEqual(kinds('authorize').map(r=>r.input.amountAgorot),[26000n,26000n]);assert.deepEqual(kinds('capture').map(r=>r.input.amountAgorot),[26000n,26000n]);
  });
  await t.test('Unavailable inventory invalidates without charging; an unreachable target cancels with zero charges',async()=>{
   const {id,members:[a,b]}=await opened(2,[3,2]);// 375 + 250 ILS
   shop.unavailableQuantity=3;
   await consent(id,a);const after=await consent(id,b);
   assert.equal(after.body.group.status,'CANCELLED');assert.equal((await groupRow(id)).closed_reason,'INSUFFICIENT_PAYMENTS');
   const view=(await membership(id,a)).body.member;
   assert.equal(view.approval.status,'INVALIDATED');assert.equal(view.approval.review,'CART_UNAVAILABLE');assert.equal(view.charge.status,'NOT_STARTED');
   assert.equal(requests.length,0,'the remaining approved member alone could not reach the target, so nothing was submitted');
   assert.equal((await groupRow(id)).refund_required,false);
  });
  await t.test('Shopify outage during execution changes nothing and retries on the next run',async()=>{
   const {id,members:[a,b]}=await opened();
   shop.down=true;await consent(id,a);const blocked=await consent(id,b);
   assert.equal(blocked.body.group.status,'PAYMENT_OPEN');assert.equal(blocked.body.member.approval.status,'APPROVED');assert.equal(requests.length,0);
   shop.down=false;
   assert.equal((await membership(id,a)).body.group.status,'CONFIRMED');assert.equal(mock.chargeCount,2);
  });
  await t.test('Browser amount tampering is refused and charges use the stored pledge, exact to the agora',async()=>{
   shop.unit=1990n;// 19.90 ILS × 13 = 258.70 ILS each
   const {id,members:[a,b]}=await opened(2,[13,13]);
   const state=(await membership(id,a)).body.member.approval;
   assert.equal(state.amountAgorot,25870);
   for(const amountAgorot of [1,25869,25871,999999,'25870',undefined])assert.equal((await approve(id,a,{decision:'approve',approvalNonce:state.nonce,amountAgorot})).body.code,'PAYMENT_AMOUNT_CHANGED',String(amountAgorot));
   await approve(id,a,{decision:'approve',approvalNonce:state.nonce,amountAgorot:25870,lines:line(99),pledgedTotalAgorot:1});
   await consent(id,b);
   assert.deepEqual(kinds('capture').map(r=>r.input.amountAgorot),[25870n,25870n]);
   assert.equal(String((await groupRow(id)).paid_total_agorot),'51740');
   // An inconsistent stored snapshot can never be approved.
   shop.unit=12500n;const other=await opened();
   await db.query("UPDATE group_members SET cart_snapshot='[{\"variantId\":\"gid://shopify/ProductVariant/1\",\"quantity\":1,\"unitAgorot\":\"12500\"}]'::jsonb WHERE token_hash=$1",[hash(other.members[0])]);
   assert.equal((await consent(other.id,other.members[0])).body.code,'PAYMENT_AMOUNT_CHANGED');
  });
  await t.test('Double clicks and concurrent approvals never duplicate a payment',async()=>{
   const {id,members:[a,b]}=await opened();
   const body=async(token:string)=>{const s=(await membership(id,token)).body.member.approval;return {decision:'approve',approvalNonce:s.nonce,amountAgorot:s.amountAgorot};};
   const [ba,bb]=[await body(a),await body(b)];
   const replies=await Promise.all([approve(id,a,ba),approve(id,a,ba),approve(id,b,bb),approve(id,b,bb),approve(id,a,ba)]);
   // Requests that arrive after the group confirmed are refused (409); none of them pays again.
   assert.ok(replies.every(reply=>reply.status===200||reply.body.code==='PAYMENT_APPROVAL_NOT_AVAILABLE'));
   await membership(id,a);
   assert.equal(mock.authorizationCount,2);assert.equal(mock.chargeCount,2);assert.equal(kinds('authorize').length,2,'one submission per member');
   for(const token of [a,b])assert.equal((await memberRow(token)).charge_attempts,1);
   assert.equal((await groupRow(id)).status,'CONFIRMED');
  });
  await t.test('Authorization failure: retry before the deadline succeeds; otherwise holds are voided and nobody is charged',async()=>{
   let g=await opened();
   queues.authorize.push('decline','succeed');
   await consent(g.id,g.members[0]);const first=await consent(g.id,g.members[1]);
   assert.equal(first.body.group.status,'PAYMENT_OPEN');assert.equal(mock.chargeCount,0,'no capture below the target');
   const failed=(await membership(g.id,g.members[0])).body.member;
   assert.equal(failed.charge.status,'FAILED');assert.equal(failed.charge.failure,'DECLINED');assert.equal(failed.actions.approve,true,'retry offered');
   assert.equal((await membership(g.id,g.members[1])).body.member.charge.status,'AUTHORIZED');
   const retried=await consent(g.id,g.members[0]);
   assert.equal(retried.body.group.status,'CONFIRMED');assert.equal(mock.chargeCount,2);assert.equal((await memberRow(g.members[0])).charge_attempts,2);
   // Same failure, but the deadline passes: the hold is released and nothing is captured.
   g=await opened();Object.assign(mock,{chargeCount:0,voidCount:0});
   queues.authorize.push('decline','succeed');
   await consent(g.id,g.members[0]);await consent(g.id,g.members[1]);
   await pastDeadline(g.id);
   assert.equal((await membership(g.id,g.members[1])).body.group.status,'CANCELLED');
   assert.equal((await memberRow(g.members[1])).charge_status,'VOIDED');assert.equal(mock.voidCount,1);assert.equal(mock.chargeCount,0);
   assert.equal((await groupRow(g.id)).refund_required,false);
  });
  await t.test('Unknown provider outcomes are re-submitted with the same key and never double charge',async()=>{
   const {id,members:[a,b]}=await opened();
   mock.authorizationOutcome='error';
   await consent(id,a);const pending=await consent(id,b);
   assert.equal(pending.body.member.charge.status,'PENDING');assert.equal(pending.body.group.status,'PAYMENT_OPEN');
   mock.authorizationOutcome='lost-response';
   await membership(id,a);// re-submission is recorded by the provider, but the reply is lost again
   assert.equal(mock.authorizationCount,2);assert.equal((await memberRow(a)).charge_status,'PENDING');
   mock.authorizationOutcome='succeed';mock.captureOutcome='error';
   await membership(id,a);
   assert.equal(mock.authorizationCount,2,'the repeats returned the recorded authorizations');
   assert.equal((await memberRow(a)).charge_status,'CAPTURING');assert.equal(mock.chargeCount,0);
   mock.captureOutcome='succeed';
   assert.equal((await membership(id,a)).body.group.status,'CONFIRMED');
   const keys=kinds('authorize').map(r=>r.input.idempotencyKey);
   assert.equal(new Set(keys).size,2,'only two keys ever used');assert.equal(mock.chargeCount,2);
  });
  await t.test('Direct-charge fallback: charges only after revalidation; a shortfall cancels and flags refunds',async()=>{
   cfg.paymentExecutionPolicy='allow_direct_charge';mock.supportsAuthorization=false;
   let g=await opened();
   await consent(g.id,g.members[0]);const done=await consent(g.id,g.members[1]);
   assert.equal(done.body.group.status,'CONFIRMED');assert.equal(kinds('createCharge').length,2);assert.equal(kinds('authorize').length,0);
   assert.deepEqual(events.filter(e=>e!=='shopify'||true).slice(-4),['shopify','shopify','createCharge','createCharge']);
   g=await opened();
   queues.createCharge.push('decline','succeed');
   await consent(g.id,g.members[0]);await consent(g.id,g.members[1]);
   await pastDeadline(g.id);
   assert.equal((await membership(g.id,g.members[0])).body.group.status,'CANCELLED');
   const row=await groupRow(g.id);assert.equal(row.refund_required,true,'the one successful charge must be refunded manually');
  });
  await t.test('Maintenance applies deadlines without any page visit and is idempotent when run twice',async()=>{
   // Below the target at the deadline: expires, zero provider calls.
   const short=await opened();await consent(short.id,short.members[0]);
   // Enough approved value but one member still answering: waits, then executes at the deadline.
   const due=await opened(3);await consent(due.id,due.members[0]);await consent(due.id,due.members[1]);
   assert.equal(requests.length,0,'execution waits while a member can still answer');
   assert.deepEqual(await service.maintain(),{checked:2,executionRuns:0,confirmed:0,cancelled:0,expired:0,holdsReleased:0,blocked:0,attention:0},'nothing is due yet');
   assert.equal(requests.length,0);
   await pastDeadline(short.id);await pastDeadline(due.id);
   const first=await service.maintain();
   assert.deepEqual(first,{checked:2,executionRuns:1,confirmed:1,cancelled:0,expired:1,holdsReleased:0,blocked:0,attention:0});
   assert.equal((await groupRow(short.id)).status,'EXPIRED');assert.equal((await groupRow(short.id)).closed_reason,'APPROVAL_DEADLINE');
   assert.equal((await groupRow(due.id)).status,'CONFIRMED');assert.equal((await memberRow(due.members[2])).approval_status,'EXPIRED');
   assert.equal(mock.authorizationCount,2);assert.equal(mock.chargeCount,2);
   const calls=requests.length;
   assert.deepEqual(await service.maintain(),{checked:0,executionRuns:0,confirmed:0,cancelled:0,expired:0,holdsReleased:0,blocked:0,attention:0},'second run finds nothing due');
   assert.equal(requests.length,calls,'no duplicate provider calls');
  });
  await t.test('Maintenance executes once everyone answered, never below the target',async()=>{
   const all=await opened(3);
   await consent(all.id,all.members[0]);await approve(all.id,all.members[1],{decision:'decline'});
   // Two answered, one waiting, 250 approved: nothing runs, even at the target time.
   await service.maintain();assert.equal(requests.length,0);
   await approve(all.id,all.members[2],{decision:'decline'});
   // Everyone answered but approved value (250) is below the target (500): never executes.
   await service.maintain();assert.equal(requests.length,0);assert.equal((await groupRow(all.id)).status,'PAYMENT_OPEN');
   await pastDeadline(all.id);await service.maintain();
   assert.equal((await groupRow(all.id)).status,'EXPIRED');assert.equal(requests.length,0);
   // Everyone answered and the target is covered: executes without waiting for the deadline.
   const covered=await opened(3);
   await consent(covered.id,covered.members[0]);await consent(covered.id,covered.members[1]);await approve(covered.id,covered.members[2],{decision:'decline'});
   await service.maintain();
   assert.equal((await groupRow(covered.id)).status,'CONFIRMED');assert.equal(mock.chargeCount,2);
  });
  await t.test('Maintenance reconciles unknown outcomes with the same keys and never duplicates an authorization',async()=>{
   const {id,members:[a,b]}=await opened();
   mock.authorizationOutcome='lost-response';
   await consent(id,a);await consent(id,b);
   assert.equal((await memberRow(a)).charge_status,'PENDING');assert.equal(mock.authorizationCount,2);
   mock.authorizationOutcome='succeed';
   const summary=await service.maintain();
   assert.equal(summary.confirmed,1);assert.equal((await groupRow(id)).status,'CONFIRMED');
   assert.equal(mock.authorizationCount,2,'re-submissions returned the recorded authorizations');assert.equal(mock.chargeCount,2);
   assert.equal(new Set(kinds('authorize').map(r=>r.input.idempotencyKey)).size,2);
  });
  await t.test('Maintenance voids holds when a group cannot continue, retrying a failed void, and reports attention',async()=>{
   const {id,members:[a,b]}=await opened();
   queues.authorize.push('decline','succeed');voidFailures=2;// both void attempts of the first run fail
   await consent(id,a);await consent(id,b);
   await pastDeadline(id);
   const first=await service.maintain();
   assert.equal(first.cancelled,1);assert.equal(first.holdsReleased,0);assert.equal(first.attention,1,'an open hold on a closed group needs attention');
   assert.equal((await memberRow(b)).charge_status,'AUTHORIZED');
   const second=await service.maintain();
   assert.equal(second.holdsReleased,1);assert.equal(second.attention,0);assert.equal((await memberRow(b)).charge_status,'VOIDED');
   assert.equal(mock.chargeCount,0,'nothing was captured');
   const third=await service.maintain();assert.equal(third.checked,0);assert.equal(mock.voidCount,1);
  });
  await t.test('Price change: the old approval is voided with an audit trail and the new amount needs its own consent',async()=>{
   const {id,members:[a,b,c]}=await opened(3);
   const old=(await membership(id,a)).body.member.approval;
   await consent(id,a);await consent(id,b);shop.unit=13000n;await consent(id,c);
   assert.equal(requests.length,0,'no authorization for any changed amount');
   const row=await memberRow(a);
   assert.equal(row.approval_status,'REQUIRED');assert.equal(String(row.previous_approval_amount_agorot),'25000');assert.ok(row.approval_invalidated_at);assert.equal(row.approval_revision,1);
   const view=(await membership(id,a)).body.member.approval;
   assert.equal(view.previousAmountAgorot,25000);assert.equal(view.amountAgorot,26000);assert.notEqual(view.nonce,old.nonce);
   assert.equal((await approve(id,a,{decision:'approve',approvalNonce:old.nonce,amountAgorot:25000})).body.code,'PAYMENT_AMOUNT_CHANGED','the old approval cannot authorize');
   assert.equal((await approve(id,a,{decision:'approve',approvalNonce:old.nonce,amountAgorot:26000})).body.code,'PAYMENT_AMOUNT_CHANGED','the old nonce cannot approve the new amount');
   // a and b re-approve the new amount; c does not before the deadline and is excluded.
   await consent(id,a);await consent(id,b);
   assert.equal(requests.length,0,'c can still answer');
   await pastDeadline(id);await service.maintain();
   assert.equal((await groupRow(id)).status,'CONFIRMED');
   assert.deepEqual(kinds('authorize').map(r=>r.input.amountAgorot),[26000n,26000n]);
   assert.equal((await memberRow(c)).approval_status,'EXPIRED');assert.equal((await memberRow(c)).charge_status,'NOT_STARTED');
  });
  await t.test('Unavailable carts: zero provider calls, clear review state for admin and shopper',async()=>{
   const {id,members:[a,b,c]}=await opened(3,[3,2,2]);
   shop.unavailableQuantity=3;
   await consent(id,a);await consent(id,b);await consent(id,c);
   assert.equal((await membership(id,a)).body.member.approval.review,'CART_UNAVAILABLE');
   // b + c (500) still cover the target, so they proceed; a is never submitted.
   assert.equal((await groupRow(id)).status,'CONFIRMED');
   assert.ok(!kinds('authorize').some(r=>r.input.amountAgorot===37500n),'no provider call for the unavailable cart');
   assert.equal((await memberRow(a)).charge_status,'NOT_STARTED');assert.ok((await memberRow(a)).approval_invalidated_at);
  });
  await t.test('Legacy groups and members are never charged or moved into the payment flow',async()=>{
   const phaseOne='66666666-0000-4000-8000-000000000001',textOnly='66666666-0000-4000-8000-000000000002';
   const approvedId=(await db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,status,expires_at) VALUES(gen_random_uuid(),$1,'אשדוד','אשדוד',50000,50000,'APPROVED',NOW()+INTERVAL '3 days') RETURNING id",[phaseOne])).rows[0].id;
   const legacyId=(await db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,status,expires_at) VALUES(gen_random_uuid(),$1,'תל אביב','תל אביב',50000,50000,'THRESHOLD_REACHED',NOW()+INTERVAL '3 days') RETURNING id",[textOnly])).rows[0].id;
   for(const [groupId,token] of [[approvedId,'7'.repeat(64)],[legacyId,'8'.repeat(64)]])await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,$2,$3,'x','[{\"variantId\":\"gid://shopify/ProductVariant/1\",\"quantity\":4,\"unitAgorot\":\"12500\"}]'::jsonb,50000,$4)",[groupId,token.slice(0,3)+'@example.test','+97250'+token.slice(0,7),hash(token)]);
   await assert.rejects(()=>service.approve(phaseOne),(e:any)=>e.code==='APPROVAL_NOT_ALLOWED','phase-one approved groups never enter payment');
   await assert.rejects(()=>service.approve(textOnly),(e:any)=>e.code==='APPROVAL_NOT_ALLOWED','no payment-capable pledges');
   assert.deepEqual((await service.maintain()).checked,0);
   assert.equal((await membership(textOnly,'8'.repeat(64))).body.member.paymentMethod,'NOT_STARTED');
   assert.equal((await json(await http('POST','/api/v1/groups/'+textOnly+'/update-pledge',{lines:line(4)},bearer('8'.repeat(64))))).status,200,'receipts keep updating where allowed');
   assert.equal((await json(await http('POST','/api/v1/groups/'+phaseOne+'/update-pledge',{lines:line(4)},bearer('7'.repeat(64))))).body.code,'GROUP_CLOSED');
   assert.equal(await count('SELECT COUNT(*)::int AS n FROM payment_verifications'),0,'no verification generated on their behalf');
   assert.equal(requests.length,0);
  });
  await t.test('Refund-required groups stay flagged and are never treated as resolved',async()=>{
   cfg.paymentExecutionPolicy='allow_direct_charge';mock.supportsAuthorization=false;
   const {id,members:[a,b]}=await opened();
   queues.createCharge.push('decline','succeed');
   await consent(id,a);await consent(id,b);await pastDeadline(id);
   const summary=await service.maintain();
   assert.equal(summary.cancelled,1);assert.equal(summary.attention,1);
   for(let i=0;i<2;i++){const again=await service.maintain();assert.equal(again.attention,1,'still needs attention');}
   const row=await groupRow(id);assert.equal(row.status,'CANCELLED');assert.equal(row.refund_required,true);
   const login=await fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password:cfg.password})});
   const cookie=login.headers.get('set-cookie')!.split(';')[0];
   const page=await (await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   assert.match(page,/קבוצות דורשות טיפול ידני/);assert.match(page,/נדרש החזר כספי ידני/);assert.match(page,/מצב טיפול: דורשת טיפול/);
   const listed=(await (await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).json() as any).groups;
   assert.equal(listed[0].publicId,id,'refund-required groups are listed first');assert.equal(listed[0].payment.resolved,false);
   assert.equal((await membership(id,b)).body.member.charge.status,'SUCCEEDED');
  });
  await t.test('Authorization/capture required: an unsupported provider fails closed before any money moves',async()=>{
   const pending=await opened();// opened while the provider supported authorization
   mock.supportsAuthorization=false;// policy stays require_authorization (the default)
   const fresh=await group();
   await assert.rejects(()=>service.approve(fresh.id),(e:any)=>e.code==='PAYMENTS_UNAVAILABLE','cannot open a phase that could never execute');
   assert.equal((await groupRow(fresh.id)).status,'THRESHOLD_REACHED');
   await consent(pending.id,pending.members[0]);await consent(pending.id,pending.members[1]);
   const summary=await service.maintain();
   assert.equal(summary.blocked,1);assert.equal(summary.executionRuns,0);
   assert.equal(requests.length,0,'no direct charge as a silent fallback');
   assert.equal((await groupRow(pending.id)).status,'PAYMENT_OPEN');
  });
  await t.test('Internal maintenance route exists only with a token and requires it',async()=>{
   assert.equal((await http('POST','/internal/payment-maintenance',{})).status,404,'absent without MAINTENANCE_TOKEN');
   cfg.maintenanceToken='m'.repeat(40);
   assert.equal((await http('POST','/internal/payment-maintenance',{})).status,401);
   assert.equal((await http('POST','/internal/payment-maintenance',{},bearer('x'.repeat(40)))).status,401);
   assert.equal((await fetch(cfg.origin+'/internal/payment-maintenance?token='+'m'.repeat(40),{method:'POST'})).status,401,'never a query-string token');
   const ok=await json(await http('POST','/internal/payment-maintenance',{},bearer('m'.repeat(40))));
   assert.equal(ok.status,200);assert.deepEqual(Object.keys(ok.body.maintenance).sort(),['attention','blocked','cancelled','checked','confirmed','executionRuns','expired','holdsReleased']);
   assert.equal((await fetch(cfg.origin+'/internal/payment-maintenance',{headers:bearer('m'.repeat(40))})).status,404,'POST only');
  });
  await t.test('Legacy members are never charged and cannot make a group payment-ready',async()=>{
   const first=await joinArea();const id=first.body.group.publicId,groupId=(await groupRow(id)).id,legacy='9'.repeat(64);
   await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,'legacy@example.test','+972501110000','אשדוד','[{\"variantId\":\"gid://shopify/ProductVariant/1\",\"quantity\":3,\"unitAgorot\":\"12500\"}]'::jsonb,37500,$2)",[groupId,hash(legacy)]);
   await http('POST','/api/v1/groups/'+id+'/update-pledge',{lines:line(2)},bearer(first.body.memberToken));
   assert.equal((await groupRow(id)).status,'THRESHOLD_REACHED');
   await assert.rejects(()=>service.approve(id),(e:any)=>e.code==='APPROVAL_NOT_ALLOWED','payment-capable pledges alone must reach the target');
   const second=await joinGroup(id);assert.equal(second.status,201);
   await service.approve(id);
   const legacyView=(await membership(id,legacy)).body.member;
   assert.equal(legacyView.paymentMethod,'NOT_STARTED');assert.equal(legacyView.approval.status,'NOT_REQUIRED');assert.deepEqual(legacyView.actions,{approve:false,decline:false});
   assert.equal((await approve(id,legacy,{decision:'approve',approvalNonce:'a'.repeat(32),amountAgorot:37500})).body.code,'PAYMENT_METHOD_REQUIRED');
   await consent(id,first.body.memberToken);const done=await consent(id,second.body.memberToken);
   assert.equal(done.body.group.status,'CONFIRMED');assert.equal(mock.chargeCount,2);
   assert.equal((await memberRow(legacy)).charge_status,'NOT_STARTED');assert.equal(await count('SELECT COUNT(*)::int AS n FROM payment_verifications WHERE id=(SELECT payment_verification_id FROM group_members WHERE token_hash=$1)',[hash(legacy)]),0,'no fake verification');
  });
  await t.test('Admin shows the payment section with aggregates only; auth and CSRF guard approve and execute',async()=>{
   const paid=await opened();await consent(paid.id,paid.members[0]);await consent(paid.id,paid.members[1]);
   const waiting=await opened(3);await consent(waiting.id,waiting.members[0]);await approve(waiting.id,waiting.members[1],{decision:'decline'});
   const fresh=await group();
   assert.equal((await fetch(cfg.origin+'/admin/api/groups')).status,401);
   const login=await fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password:cfg.password})});
   const cookie=login.headers.get('set-cookie')!.split(';')[0];
   const page=await (await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
   for(const label of ['סך ההתחייבויות','יעד לאישור','סך התחייבויות מאושרות','מוכנה לביצוע תשלום','מועד אחרון לאישור','ממתינים לאישור','סירבו / פג תוקף','חיובים שהצליחו','הרשאות/חיובים שנכשלו','משתתפים ללא אמצעי תשלום (ותיקים)','אישור הקבוצה ופתיחת אישורי תשלום'])assert.ok(page.includes(label),label);
   const api=(await (await fetch(cfg.origin+'/admin/api/groups',{headers:{Cookie:cookie}})).json() as any).groups;
   const p=api.find((g:any)=>g.publicId===paid.id).payment,w=api.find((g:any)=>g.publicId===waiting.id).payment;
   assert.equal(p.chargedTotalAgorot,50000);assert.equal(p.charged,2);assert.equal(api.find((g:any)=>g.publicId===paid.id).status,'CONFIRMED');
   assert.deepEqual({approved:w.approved,approvedPledgeTotalAgorot:w.approvedPledgeTotalAgorot,waiting:w.waiting,declined:w.declined,ready:w.ready,charged:w.charged},{approved:1,approvedPledgeTotalAgorot:25000,waiting:1,declined:1,ready:false,charged:0});
   assert.ok(Date.parse(w.deadline)>Date.now());
   const csrf=page.match(/name="csrf" value="([^"]+)"/)![1];
   for(const path of ['approve','execute']){
    assert.equal((await http('POST','/admin/api/groups/'+fresh.id+'/'+path,{},{Cookie:cookie,'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await http('POST','/admin/api/groups/'+fresh.id+'/'+path,{},{Cookie:cookie,'X-CSRF-Token':csrf,Origin:'https://evil.example'})).status,403);
    assert.equal((await http('POST','/admin/api/groups/'+fresh.id+'/'+path,{})).status,401);
   }
   const approved=await http('POST','/admin/api/groups/'+fresh.id+'/approve',{},{Cookie:cookie,'X-CSRF-Token':csrf});
   assert.equal(approved.status,200);assert.equal(((await approved.json()) as any).group.status,'PAYMENT_OPEN');
   for(const text of [page,JSON.stringify(api)])for(const forbidden of ['mock_pm_','mock_ch_','mock_vs_','mock_au_','gdc_','@example.test','+9725'])assert.ok(!text.includes(forbidden),'admin exposes '+forbidden);
  });
  await t.test('Provider references and secrets never appear in public responses, member responses or logs',async()=>{
   printed.length=0;
   const who=person(),v=await verify(who);
   const joinedText=await (await http('POST','/api/v1/groups/join',{...who,...fields(v),areaPublicId:ASHDOD,lines:line()})).text(),joinedBody=JSON.parse(joinedText);
   const second=await joinArea(person(),2);
   const id=joinedBody.group.publicId,token=joinedBody.memberToken;
   await service.approve(id);
   const approvedText=JSON.stringify((await consent(id,token)).body)+JSON.stringify((await consent(id,second.body.memberToken)).body);
   const rows=(await db.query('SELECT v.provider_session_ref,v.payment_method_ref,m.charge_ref,m.authorization_ref,m.charge_idempotency_key FROM group_members m JOIN payment_verifications v ON v.id=m.payment_verification_id WHERE m.token_hash=$1',[hash(token)])).rows[0];
   const secrets=Object.values(rows) as string[];assert.ok(secrets.every(Boolean));
   const publicTexts=[await (await http('GET','/api/v1/groups/'+id)).text(),await (await http('POST','/api/v1/groups/find',{areaPublicId:ASHDOD})).text()];
   const memberTexts=[joinedText,approvedText,await (await http('GET','/api/v1/groups/'+id+'/membership',undefined,bearer(second.body.memberToken))).text(),await (await http('GET','/api/v1/payment-verifications/'+v.verificationId,undefined,bearer(v.verificationToken))).text()];
   for(const text of [...publicTexts,...memberTexts,...printed])for(const secret of [...secrets,'mock_pm_','mock_ch_','mock_vs_','mock_au_','gdc_'])assert.ok(!text.includes(secret),'leaked provider reference');
   for(const text of publicTexts)for(const forbidden of [token,v.verificationToken,'nonce','charge','paymentMethod'])assert.ok(!text.includes(forbidden),'public response exposes '+forbidden);
   for(const text of printed)for(const forbidden of [token,v.verificationToken,who.email])assert.ok(!text.includes(forbidden),'logged '+forbidden);
   assert.deepEqual(Object.keys(JSON.parse(publicTexts[0]).group.approvals).sort(),['approved','approvedPledgeTotalAgorot','deadline','ready','waiting']);
   assert.deepEqual(Object.keys(joinedBody.member).sort(),['actions','active','approval','charge','paymentMethod','pledgedAgorot']);
  });
  await t.test('Payment routes keep Origin, JSON and their own rate limit',async()=>{
   const who=person();
   assert.equal((await http('POST','/api/v1/payment-verifications',who,{Origin:'https://evil.example'})).status,403);
   assert.equal((await fetch(cfg.origin+'/api/v1/payment-verifications',{method:'POST',headers:{Origin:cfg.origin,'Content-Type':'text/plain'},body:JSON.stringify(who)})).status,403);
   const {id,members:[a]}=await opened();
   assert.equal((await http('POST','/api/v1/groups/'+id+'/payment-approval',{decision:'approve'},{...bearer(a),Origin:'https://evil.example'})).status,403);
   assert.equal((await approve(id,'0'.repeat(64),{decision:'approve'})).status,401,'wrong receipt');
   assert.equal((await json(await http('POST','/api/v1/payment-verifications',{email:'nope',phone:'0501234567'}))).body.code,'INVALID_CONTACT');
   await db.query('TRUNCATE request_limits');
   for(let i=0;i<15;i++)assert.equal((await http('POST','/api/v1/payment-verifications',person())).status,201);
   assert.equal((await http('POST','/api/v1/payment-verifications',person())).status,429);
   assert.equal((await http('POST','/api/v1/groups/find',{areaPublicId:ASHDOD})).status,200,'search budget separate');
  });
 }finally{
  Object.assign(console,consoleBackup);
  await new Promise<void>(r=>server.close(()=>r()));await state.engine.close();await cleanup(dir);
 }
});

test('No provider configured: verification, Join and merchant payment opening fail closed; members keep updating',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-pay-db-'));const {state,db}=harness(dir);
 const cfg=config(ENV);let shopifyCalls=0;
 const validator={validate:async()=>{shopifyCalls++;return {total:25000n,snapshot:[{variantId:'gid://shopify/ProductVariant/1',quantity:2,unitAgorot:'12500'}]};}};
 const app=createApp(db,cfg,validator),server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 const post=(path:string,body:any,headers:Record<string,string>={})=>fetch(cfg.origin+path,{method:'POST',headers:{Origin:cfg.origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  await migrate(db);
  const who={email:'none@example.test',phone:'+972501234567'};
  const created=await post('/api/v1/payment-verifications',who);
  assert.equal(created.status,503);assert.equal(((await created.json()) as any).code,'PAYMENTS_UNAVAILABLE');
  assert.equal((await post('/api/v1/payment-verifications/00000000-0000-4000-8000-000000000000/mock-result',{outcome:'verified'},{Authorization:'Bearer '+'a'.repeat(64)})).status,404,'no simulator without the mock provider');
  const joined=await post('/api/v1/groups/join',{...who,areaPublicId:ASHDOD,lines:[{variantId:'1',quantity:2}],verificationId:'00000000-0000-4000-8000-000000000000',verificationToken:'a'.repeat(64)});
  assert.equal(joined.status,503);assert.equal(((await joined.json()) as any).code,'PAYMENTS_UNAVAILABLE');
  assert.equal(shopifyCalls,0,'fails before any Shopify request');
  // A pre-payment member keeps their receipt working; the merchant cannot open payment without a provider.
  const groupId=(await db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,expires_at,area_id) SELECT gen_random_uuid(),'44444444-0000-4000-8000-000000000001',name,slug,25000,NOW()+INTERVAL '3 days',id FROM delivery_areas WHERE public_id=$1 RETURNING id",[ASHDOD])).rows[0].id;
  const token='4'.repeat(64);
  await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,'old@example.test','+972507770000','אשדוד','[]'::jsonb,12500,$2)",[groupId,hash(token)]);
  const update=await post('/api/v1/groups/44444444-0000-4000-8000-000000000001/update-pledge',{lines:[{variantId:'1',quantity:2}]},{Authorization:'Bearer '+token});
  assert.equal(update.status,200);const body=(await update.json()) as any;assert.equal(body.member.paymentMethod,'NOT_STARTED');assert.equal(body.group.status,'THRESHOLD_REACHED');
  const service=new Groups(db,cfg,validator);
  await assert.rejects(()=>service.approve('44444444-0000-4000-8000-000000000001'),(e:any)=>e.code==='PAYMENTS_UNAVAILABLE');
  assert.equal(new UnavailablePaymentProvider().supportsAuthorization,false);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await state.engine.close();await cleanup(dir);}
});

test('Payment migrations are additive: existing members get safe defaults and nothing is rewritten',{timeout:120000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fankee-pay-db-'));const {state,db}=harness(dir);
 try{
  await db.query('CREATE TABLE schema_migrations (name text PRIMARY KEY)');
  for(const name of ['001_initial.sql','002_delivery_areas.sql']){await db.query(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  const groupId=(await db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,status,expires_at) VALUES(gen_random_uuid(),'55555555-0000-4000-8000-000000000001','אשדוד','אשדוד',50000,50000,'THRESHOLD_REACHED',NOW()+INTERVAL '3 days') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash) VALUES(gen_random_uuid(),$1,'before@example.test','+972501212121','אשדוד','[]'::jsonb,50000,'before-token')",[groupId]);
  const before=(await db.query('SELECT status,pledged_total_agorot,paid_total_agorot FROM delivery_groups')).rows;
  await migrate(db);await migrate(db);
  assert.deepEqual((await db.query('SELECT status,pledged_total_agorot,paid_total_agorot FROM delivery_groups')).rows,before,'groups untouched, including a group already at threshold');
  assert.deepEqual((await db.query('SELECT approval_deadline,closed_reason,refund_required FROM delivery_groups')).rows[0],{approval_deadline:null,closed_reason:null,refund_required:false});
  const member=(await db.query('SELECT payment_method_status,approval_status,charge_status,payment_verification_id,charge_attempts,approval_review_reason,authorization_ref FROM group_members')).rows[0];
  assert.deepEqual(member,{payment_method_status:'NOT_STARTED',approval_status:'NOT_REQUIRED',charge_status:'NOT_STARTED',payment_verification_id:null,charge_attempts:0,approval_review_reason:null,authorization_ref:null});
  await assert.rejects(()=>db.query("UPDATE group_members SET charge_status='SUCCEEDED'"),'a charge needs an approval');
  await assert.rejects(()=>db.query("UPDATE group_members SET approval_status='REQUIRED'"),'approval needs an amount and nonce');
  await assert.rejects(()=>db.query("UPDATE delivery_groups SET status='PAYMENT_OPEN'"),'the payment phase needs a deadline');
  await db.query('UPDATE delivery_groups SET paid_total_agorot=100');
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('group_members','payment_verifications')")).rows.map((row:any)=>row.column_name as string);
  for(const forbidden of ['card','pan','cvv','cvc','expiry','exp_month','cardholder'])assert.ok(!columns.some(column=>column.split('_').includes(forbidden)),'stores '+forbidden);
 }finally{await state.engine.close();await cleanup(dir);}
});
