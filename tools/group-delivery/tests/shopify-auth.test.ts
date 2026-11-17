import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ShopifyAdminAuth,ShopifyAuthError} from '../src/shopify-auth.js';
import {ShopifyOrders,ShopifyOrderError} from '../src/shopify-orders.js';
import {paymentsConfig} from '../src/payments-config.js';
import {paymentsFixture,CARDCOM_ENV,TEST_CLIENT_SECRET} from './payments-fixture.js';

const SECRET='shpss_unit_secret_never_logged_0000';
const settings={domain:'example.myshopify.com',clientId:'unit-client-id',clientSecret:SECRET,version:'2026-10',test:false};
// Stub Shopify: token endpoint + GraphQL. Records every request in order; tokens can be revoked to force a 401.
function stub(options:{expiresIn?:number;scope?:string;tokenStatus?:number;always401?:boolean}={}){
 const log:{kind:'token'|'graphql';token?:string;form?:Record<string,string>}[]=[],valid=new Set<string>();let n=0;
 const http=(async(url:any,init:any)=>{
  if(String(url).endsWith('/admin/oauth/access_token')){
   const form=Object.fromEntries(new URLSearchParams(String(init.body)));log.push({kind:'token',form});
   await new Promise(r=>setTimeout(r,5));// lets concurrent callers overlap
   if(options.tokenStatus)return new Response(JSON.stringify({error:'invalid_client',error_description:'echo '+form.client_secret}),{status:options.tokenStatus});
   const token='shpat_unit_tok_'+(++n);valid.add(token);
   return new Response(JSON.stringify({access_token:token,scope:options.scope??'write_orders',expires_in:options.expiresIn??86399}),{status:200});
  }
  const token=init.headers['X-Shopify-Access-Token'];log.push({kind:'graphql',token});
  if(options.always401||!valid.has(token))return new Response(JSON.stringify({errors:'[API] Invalid API key or access token'}),{status:401});
  return new Response(JSON.stringify({data:{order:{id:'gid://shopify/Order/1',displayFinancialStatus:'PENDING',cancelledAt:null,totalOutstandingSet:{shopMoney:{amount:'10.00',currencyCode:'ILS'}}}}}),{status:200});
 }) as any;
 return {http,log,valid,tokens:()=>log.filter(e=>e.kind==='token').length,calls:()=>log.filter(e=>e.kind==='graphql').length};
}
const clock=()=>{let t=1_000_000;return {now:()=>t,advance:(seconds:number)=>{t+=seconds*1000;}};};
const client=(s:ReturnType<typeof stub>,c=clock())=>{const auth=new ShopifyAdminAuth(settings,s.http,1000,c.now);return {orders:new ShopifyOrders(settings,s.http,1000,auth),auth,clock:c};};

test('1. a token is acquired (client credentials grant) before the first Admin API call',async()=>{
 const s=stub(),{orders}=client(s);
 await orders.orderState('gid://shopify/Order/1');
 assert.deepEqual(s.log.map(e=>e.kind),['token','graphql']);
 assert.deepEqual(s.log[0].form,{grant_type:'client_credentials',client_id:'unit-client-id',client_secret:SECRET},'no scope parameter');
 assert.equal(s.log[1].token,'shpat_unit_tok_1');
});
test('2. the cached token is reused',async()=>{
 const s=stub(),{orders}=client(s);
 for(let i=0;i<5;i++)await orders.orderState('gid://shopify/Order/1');
 assert.equal(s.tokens(),1);assert.equal(s.calls(),5);
 assert.ok(s.log.filter(e=>e.kind==='graphql').every(e=>e.token==='shpat_unit_tok_1'));
});
test('3-4. expiry causes a refresh, timed from expires_in (never a fixed 24 hours)',async()=>{
 // expires_in 600 s: refreshed a tenth early (60 s) -> valid until 540 s.
 const short=stub({expiresIn:600}),a=client(short);
 await a.orders.orderState('gid://shopify/Order/1');
 a.clock.advance(539);await a.orders.orderState('gid://shopify/Order/1');assert.equal(short.tokens(),1,'still valid at 539 s');
 a.clock.advance(2);await a.orders.orderState('gid://shopify/Order/1');assert.equal(short.tokens(),2,'refreshed after 540 s');
 assert.equal(short.log.at(-1)!.token,'shpat_unit_tok_2');
 // expires_in 86399 s: refreshed 5 minutes early (cap), i.e. after 86099 s.
 const day=stub({expiresIn:86399}),b=client(day);
 await b.orders.orderState('gid://shopify/Order/1');
 b.clock.advance(86098);await b.orders.orderState('gid://shopify/Order/1');assert.equal(day.tokens(),1);
 b.clock.advance(2);await b.orders.orderState('gid://shopify/Order/1');assert.equal(day.tokens(),2);
 // expires_in 3600 s: a tenth would be 360 s, capped at 300 s -> valid until 3300 s.
 const hour=stub({expiresIn:3600}),c=client(hour);
 await c.orders.orderState('gid://shopify/Order/1');c.clock.advance(3299);await c.orders.orderState('gid://shopify/Order/1');assert.equal(hour.tokens(),1);
 c.clock.advance(2);await c.orders.orderState('gid://shopify/Order/1');assert.equal(hour.tokens(),2);
});
test('5. concurrent calls share one token request (single flight)',async()=>{
 const s=stub(),{orders}=client(s);
 await Promise.all(Array.from({length:12},()=>orders.orderState('gid://shopify/Order/1')));
 assert.equal(s.tokens(),1);assert.equal(s.calls(),12);
 // Also after expiry: many callers, one refresh.
 const c=clock(),x=stub({expiresIn:100}),y=client(x,c);
 await y.orders.orderState('gid://shopify/Order/1');c.advance(100);
 await Promise.all(Array.from({length:8},()=>y.orders.orderState('gid://shopify/Order/1')));
 assert.equal(x.tokens(),2);
});
test('6. a 401 invalidates the token, fetches one new token and retries once',async()=>{
 const s=stub(),{orders}=client(s);
 await orders.orderState('gid://shopify/Order/1');
 s.valid.clear();// Shopify revoked/expired tok_1 early
 const state=await orders.orderState('gid://shopify/Order/1');
 assert.equal(state.financialStatus,'PENDING');
 assert.deepEqual(s.log.map(e=>e.kind+(e.token?':'+e.token:'')),['token','graphql:shpat_unit_tok_1','graphql:shpat_unit_tok_1','token','graphql:shpat_unit_tok_2']);
});
test('7. a second 401 fails (AUTH) and does not loop',async()=>{
 const s=stub({always401:true}),{orders}=client(s);
 await assert.rejects(orders.orderState('gid://shopify/Order/1'),(e:any)=>e instanceof ShopifyOrderError&&e.kind==='AUTH'&&!e.ambiguous);
 assert.equal(s.calls(),2,'original + one retry');assert.equal(s.tokens(),2);
});
test('8. missing client ID or secret fails closed (no Shopify orders, so no charging); a static token is refused explicitly',()=>{
 const context={production:true,origin:'https://groups.example.test',storefrontOrigins:['https://store.example.test']};
 for(const missing of ['SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET']){
  const cfg=paymentsConfig({...CARDCOM_ENV,[missing]:''},context);
  assert.equal(cfg.orders,undefined,missing);assert.ok(cfg.chargingProblems.some(p=>p.startsWith(missing)));
 }
 const legacy=paymentsConfig({...CARDCOM_ENV,SHOPIFY_ADMIN_ACCESS_TOKEN:'shpat_legacy_token_0000000000'},context);
 assert.equal(legacy.orders,undefined,'never a silent fallback');
 assert.ok(legacy.chargingProblems.some(p=>p.includes('SHOPIFY_ADMIN_ACCESS_TOKEN is not supported')));
 const ok=paymentsConfig(CARDCOM_ENV,context);
 assert.deepEqual(Object.keys(ok.orders!).sort(),['clientId','clientSecret','test','version']);
 for(const problem of [...legacy.chargingProblems,...paymentsConfig({...CARDCOM_ENV,SHOPIFY_CLIENT_ID:''},context).chargingProblems])assert.ok(!problem.includes(TEST_CLIENT_SECRET)&&!problem.includes('shpat_legacy'));
});
test('9. missing write_orders fails closed before any Admin API call',async()=>{
 for(const scope of ['read_orders','read_products,write_products','']){
  const s=stub({scope}),{orders}=client(s);
  await assert.rejects(orders.orderState('gid://shopify/Order/1'),(e:any)=>e instanceof ShopifyOrderError&&e.kind==='AUTH');
  assert.equal(s.calls(),0,'no Admin API request: '+scope);
 }
 const s=stub({scope:'read_products,write_orders'}),{orders}=client(s);
 await orders.orderState('gid://shopify/Order/1');assert.equal(s.calls(),1,'comma-separated scope list');
 await assert.rejects(new ShopifyAdminAuth(settings,stub({scope:'read_orders'}).http,1000).accessToken(),(e:any)=>e instanceof ShopifyAuthError&&e.kind==='SCOPE_MISSING');
});
test('11 (unit). the client secret never appears in errors',async()=>{
 const errors:unknown[]=[];
 for(const status of [400,401,500]){
  try{await new ShopifyAdminAuth(settings,stub({tokenStatus:status}).http,1000).accessToken();}catch(error){errors.push(error);}
  try{await client(stub({tokenStatus:status})).orders.orderState('gid://shopify/Order/1');}catch(error){errors.push(error);}
 }
 assert.equal(errors.length,6);
 for(const error of errors)assert.ok(!String((error as Error).message).includes(SECRET)&&!JSON.stringify(error).includes(SECRET)&&!String((error as Error).stack).includes(SECRET));
});

test('10-11. Shopify authentication failure: no order and no Cardcom charge; secret never logged or returned',{timeout:300000},async t=>{
 const f=await paymentsFixture();
 const originalConsole={...console};const consoleLines:string[]=[];
 for(const level of ['log','info','warn','error','debug'] as const)(console as any)[level]=(...args:unknown[])=>{consoleLines.push(args.map(String).join(' '));};
 const charges=()=>f.cardcom.state.requests.filter(r=>r.path==='/api/v11/Transactions/Transaction').length;
 const creates=()=>f.shopifyAdmin.state.requests.filter(r=>r.operation==='GroupDeliveryOrderCreate').length;
 const rows=async()=>(await f.db.query('SELECT status,failure_code,shopify_order_id FROM group_payment_charges ORDER BY created_at')).rows;
 t.beforeEach(async()=>{
  await f.db.query('TRUNCATE group_payment_charges, group_payment_reservations, group_members, delivery_groups, request_limits, admin_sessions CASCADE');
  Object.assign(f.shopifyAdmin.state,{authMode:'ok',scope:'write_orders',createMode:'ok'});f.shopifyAdmin.state.requests.length=0;f.shopifyAdmin.state.tokenRequests.length=0;
  // Expire whatever token the service cached: the next Admin call gets a 401 and must obtain a new one.
  f.shopifyAdmin.state.validTokens.clear();
  f.cardcom.state.requests.length=0;
 });
 const approve=async()=>{
  const a=await f.join({quantity:2}),b=await f.join({quantity:2});void b;
  const session=await f.login();
  assert.equal((await f.adminPost(session,'/admin/api/groups/'+a.group.publicId+'/approve')).status,200);
  await f.payments.idle();
  return {id:a.group.publicId,session};
 };
 try{
  for(const [label,setup] of [['credentials rejected',()=>{f.shopifyAdmin.state.authMode='reject';}],['token endpoint down',()=>{f.shopifyAdmin.state.authMode='down';}],['write_orders not granted',()=>{f.shopifyAdmin.state.scope='read_orders';}]] as const){
   await t.test('10. '+label+': rows stay PENDING (SHOPIFY_AUTH_FAILED), no order, no Cardcom charge',async()=>{
    setup();
    const {id}=await approve();
    for(const row of await rows())assert.deepEqual({...row},{status:'PENDING',failure_code:'SHOPIFY_AUTH_FAILED',shopify_order_id:null});
    assert.equal(creates(),0,'no order');assert.equal(charges(),0,'no Cardcom charge');
    assert.ok(f.shopifyAdmin.state.tokenRequests.length>=1);
    // Fixed configuration: the next run creates the orders, then charges once each.
    Object.assign(f.shopifyAdmin.state,{authMode:'ok',scope:'write_orders'});
    await f.payments.processCharges(id);await f.payments.idle();
    for(const row of await rows())assert.equal(row.status,'SUCCEEDED');
    assert.equal(creates(),2);assert.equal(charges(),2);
   });
  }
  await t.test('a token revoked mid-run is replaced once and processing continues',async()=>{
   // A first approved group leaves a cached token in the service.
   await approve();
   const before=f.shopifyAdmin.state.tokenRequests.length;
   // Shopify invalidates that token; the next group's first Admin call gets a 401.
   f.shopifyAdmin.state.validTokens.clear();
   await approve();// the area's next group (the first one is approved and no longer open)
   assert.equal(f.shopifyAdmin.state.tokenRequests.length,before+1,'exactly one fresh token after the 401');
   for(const row of await rows())assert.equal(row.status,'SUCCEEDED');
   assert.equal(charges(),4);assert.equal(creates(),4);
  });
  await t.test('11. the client secret never appears in logs, responses or the admin page',async()=>{
   f.shopifyAdmin.state.authMode='reject';
   const {id,session}=await approve();
   const page=await(await fetch(f.cfg.origin+'/admin/groups/'+id,{headers:{Cookie:session.cookie}})).text();
   const system=await(await fetch(f.cfg.origin+'/admin/api/system',{headers:{Cookie:session.cookie}})).text();
   const all=[...f.logs,...consoleLines,...f.bodies,page,system].join('\n');
   assert.ok(f.logs.some(line=>line.includes('authentication failed')),'safe configuration error logged');
   assert.ok(!all.includes(TEST_CLIENT_SECRET),'client secret leaked');
   for(const token of f.shopifyAdmin.state.validTokens)assert.ok(!all.includes(token),'access token leaked');
   // The secret only ever travels in the token request body.
   assert.ok(f.shopifyAdmin.state.requests.every(r=>!JSON.stringify(r).includes(TEST_CLIENT_SECRET)));
  });
 }finally{Object.assign(console,originalConsole);await f.close();}
});
