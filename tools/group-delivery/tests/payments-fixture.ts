// Card reservation fixture: on-disk PGlite with the real migrations, the real Express app, a mocked Shopify Storefront
// API and a fake Cardcom JSON API v11 at the HTTP level (the real CardcomService builds and validates every request).
// No request ever leaves the process; no real terminal, card or charge is involved.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Shopify} from '../src/shopify.js';
import {config} from '../src/config.js';
import {CardcomService} from '../src/cardcom.js';
import {ShopifyOrders} from '../src/shopify-orders.js';
import {migrate,type Database,type Connection} from '../src/db.js';
export const AREA={beerSheva:'6f1a2c00-0001-4a00-8000-0000000000a1',ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3'};
export const TEST_KEY='9f1c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8';
export const CARDCOM_ENV={CARDCOM_ENABLED:'true',CARDCOM_TERMINAL_NUMBER:'1000',CARDCOM_API_NAME:'test-api-name-not-real',GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY:TEST_KEY,
 STOREFRONT_ORIGINS:'https://store.example.test',CARDCOM_SUCCESS_URL:'https://store.example.test/pages/group-delivery',
 SHOPIFY_CLIENT_ID:'gd-client-id-test',SHOPIFY_CLIENT_SECRET:'shpss_test_client_secret_not_real_0000'};
export const TEST_CLIENT_SECRET='shpss_test_client_secret_not_real_0000';
// Ordered record of external effects across Shopify and Cardcom (e.g. 'shopify:orderCreate', 'cardcom:charge').
export const timeline:string[]=[];
type Page={id:string;returnValue:string;amount:number;operation:string;jValidate:unknown;state:'pending'|'success'|'declined';token:string;terminal:number;body:any};
type ChargeMode='ok'|'decline'|'network'|'lost'|'http500';
// Fake Cardcom: LowProfile/Create, GetLpResult, Transactions/Transaction (608 on a repeated ExternalUniqTranId) and
// GetTransactionByExternalUniqTran. Every request body is recorded for assertions.
export function fakeCardcom(){
 const state={
  requests:[] as {path:string;body:any}[],pages:new Map<string,Page>(),tokens:[] as string[],
  transactions:new Map<string,{id:number;amount:number;token:string}>(),
  chargeModes:new Map<string,ChargeMode>(),// by token
  createMode:'ok' as 'ok'|'down',lpMode:'ok' as 'ok'|'down'|'wrong-terminal'|'wrong-operation'|'wrong-return'|'top-701'|'tran-701'|'top-700'|'tran-700'|'jparam-5'|'jparam-0'|'year-2digit',
  nextTx:5000,
 };
 const json=(status:number,body:any)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 const http=async(input:any,init?:RequestInit)=>{
  const url=new URL(String(input)),body=JSON.parse(String(init?.body||'{}'));
  state.requests.push({path:url.pathname,body});
  if(url.origin!=='https://secure.cardcom.solutions')throw TypeError('unexpected host');
  if(body.TerminalNumber!==1000||body.ApiName!=='test-api-name-not-real')return json(401,{ResponseCode:401,Description:'Invalid username'});
  if(url.pathname==='/api/v11/LowProfile/Create'){
   if(state.createMode==='down')throw TypeError('fetch failed');
   const id=randomUUID(),token=randomUUID();state.tokens.push(token);
   state.pages.set(id,{id,returnValue:body.ReturnValue,amount:body.Amount,operation:body.Operation,jValidate:body.AdvancedDefinition?.JValidateType,state:'pending',token,terminal:body.TerminalNumber,body});
   return json(200,{ResponseCode:0,Description:'OK',LowProfileId:id,Url:'https://secure.cardcom.solutions/EA/LPC6/'+id});
  }
  if(url.pathname==='/api/v11/LowProfile/GetLpResult'){
   if(state.lpMode==='down')throw TypeError('fetch failed');
   const page=state.pages.get(body.LowProfileId);
   if(!page)return json(200,{ResponseCode:5100,Description:'not found'});
   if(page.state==='pending')return json(200,{ResponseCode:5118,Description:'pending',LowProfileId:page.id,TerminalNumber:1000});
   if(page.state==='declined')return json(200,{ResponseCode:5005,Description:'declined',LowProfileId:page.id,TerminalNumber:1000});
   const m=state.lpMode;
   const tran=m==='tran-701'?{ResponseCode:701,JParameter:'2',TranzactionId:0}:m==='tran-700'?{ResponseCode:700,JParameter:'5',TranzactionId:9}:m==='jparam-5'?{ResponseCode:0,JParameter:'5'}:m==='jparam-0'?{ResponseCode:0,JParameter:'0',TranzactionId:77}:null;
   return json(200,{ResponseCode:m==='top-701'?701:m==='top-700'?700:0,Description:'OK',LowProfileId:page.id,TerminalNumber:m==='wrong-terminal'?2000:1000,
    ReturnValue:state.lpMode==='wrong-return'?randomUUID():page.returnValue,Operation:state.lpMode==='wrong-operation'?'ChargeOnly':'CreateTokenOnly',
    TokenInfo:{Token:page.token,TokenExDate:'20300131',CardYear:m==='year-2digit'?29:2029,CardMonth:7,TokenApprovalNumber:'0000000',CardOwnerIdentityNumber:'000000000'},
    UIValues:{CardOwnerEmail:'holder@example.test',CardOwnerName:'Card Holder',CardOwnerPhone:'0500000000',CardYear:2029,CardMonth:7},TranzactionInfo:tran});
  }
  if(url.pathname==='/api/v11/Transactions/Transaction'){
   timeline.push('cardcom:charge:'+body.ExternalUniqTranId);
   const mode=state.chargeModes.get(body.Token)||'ok';
   if(state.transactions.has(body.ExternalUniqTranId))return json(200,{ResponseCode:608,Description:'duplicate'});
   if(mode==='network')throw TypeError('fetch failed');
   if(mode==='http500')return json(500,{ResponseCode:500});
   if(mode==='decline')return json(200,{ResponseCode:5005,Description:'declined',TranzactionId:0});
   const tx={id:state.nextTx++,amount:body.Amount,token:body.Token};state.transactions.set(body.ExternalUniqTranId,tx);
   if(mode==='lost')throw TypeError('socket hang up');// performed at Cardcom, answer lost
   return json(200,{ResponseCode:0,Description:'OK',TranzactionId:tx.id,Amount:body.Amount,Token:body.Token,Last4CardDigitsString:'1234'});
  }
  if(url.pathname==='/api/v11/Transactions/GetTransactionByExternalUniqTran'){
   const tx=state.transactions.get(body.ExternalUniqTranId);
   return json(200,tx?{ResponseCode:0,TranzactionId:tx.id,Amount:tx.amount}:{ResponseCode:5100,Description:'not found'});
  }
  return json(404,{ResponseCode:404});
 };
 const pageFor=(reservationId:string)=>[...state.pages.values()].find(page=>page.returnValue===reservationId);
 return {state,http,pageFor};
}
type ShopifyMode='ok'|'rejected'|'network'|'lost'|'not-executed'|'wrong-total';
// Fake Shopify GraphQL Admin: orderCreate, orders(query:tag), order(id), orderCreateManualPayment, tagsAdd, orderCancel.
export function fakeShopifyAdmin(){
 const state={requests:[] as {operation:string;variables:any;headers:any}[],orders:new Map<string,{id:string;name:string;createdAt:string;tags:string[];financial:string;total:string;outstanding:string;cancelledAt:string|null;restocked:boolean;input:any}>(),
  createMode:'ok' as ShopifyMode,payMode:'ok' as 'ok'|'network'|'lost'|'rejected'|'partial'|'paid-outstanding',
  // async: orderCancel is accepted; the job completes only when a test calls completeCancels().
  cancelMode:'ok' as 'ok'|'network'|'rejected'|'async',pendingCancels:new Set<string>(),next:1001,
  // Token endpoint (client credentials grant): mode, granted scope, issued and currently valid tokens.
  authMode:'ok' as 'ok'|'reject'|'down',scope:'write_orders',tokenRequests:[] as Record<string,string>[],validTokens:new Set<string>(),issued:0,expiresIn:86399};
 const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 const view=(o:any)=>({id:o.id,name:o.name,createdAt:o.createdAt,tags:o.tags,displayFinancialStatus:o.financial,totalPriceSet:{shopMoney:{amount:o.total,currencyCode:'ILS'}}});
 const http=async(input:any,init?:RequestInit)=>{
  const url=new URL(String(input));
  if(url.href==='https://example.myshopify.com/admin/oauth/access_token'){
   const form=Object.fromEntries(new URLSearchParams(String(init?.body)));state.tokenRequests.push(form);
   if(state.authMode==='down')throw TypeError('fetch failed');
   if(state.authMode==='reject'||form.grant_type!=='client_credentials'||form.client_id!=='gd-client-id-test'||form.client_secret!=='shpss_test_client_secret_not_real_0000')return json({error:'invalid_client'},401);
   const token='shpat_cc_'+(++state.issued);state.validTokens.add(token);
   return json({access_token:token,scope:state.scope,expires_in:state.expiresIn});
  }
  if(url.href!=='https://example.myshopify.com/admin/api/2026-10/graphql.json')throw TypeError('unexpected Shopify URL');
  const body=JSON.parse(String(init?.body)),headers=init?.headers as any;
  if(!state.validTokens.has(headers['X-Shopify-Access-Token']))return json({errors:'[API] Invalid API key or access token (unrecognized login or wrong password)'},401);
  const operation=String(body.query.match(/(?:mutation|query) (\w+)/)?.[1]);
  state.requests.push({operation,variables:body.variables,headers});
  if(operation==='GroupDeliveryOrderCreate'){
   timeline.push('shopify:orderCreate:'+body.variables.order.sourceIdentifier);
   if(state.createMode==='network')throw TypeError('fetch failed');
   if(state.createMode==='not-executed')return json({errors:[{message:'Throttled',extensions:{code:'THROTTLED'}}]});
   if(state.createMode==='rejected')return json({data:{orderCreate:{order:null,userErrors:[{field:['order','lineItems'],message:'not enough stock',code:'INVENTORY_NOT_AVAILABLE'}]}}});
   const total=body.variables.order.lineItems.reduce((sum:number,l:any)=>sum+Math.round(Number(l.priceSet.shopMoney.amount)*100)*l.quantity,0);
   const order={id:'gid://shopify/Order/'+state.next,name:'#'+state.next++,createdAt:new Date().toISOString(),tags:body.variables.order.tags,financial:'PENDING',
    total:((state.createMode==='wrong-total'?total+1170:total)/100).toFixed(2),outstanding:'',cancelledAt:null as string|null,restocked:false,input:body.variables};
   order.outstanding=order.total;
   state.orders.set(order.id,order);
   if(state.createMode==='lost')throw TypeError('socket hang up');
   return json({data:{orderCreate:{order:view(order),userErrors:[]}}});
  }
  if(operation==='GroupDeliveryOrderByReference'){
   const tag=String(body.variables.query).match(/^tag:'([^']+)'$/)?.[1];
   return json({data:{orders:{nodes:[...state.orders.values()].filter(o=>o.tags.includes(tag!)).map(view)}}});
  }
  if(operation==='GroupDeliveryOrderStatus'){
   const o=state.orders.get(body.variables.id);
   return json({data:{order:o?{id:o.id,displayFinancialStatus:o.financial,cancelledAt:o.cancelledAt,totalOutstandingSet:{shopMoney:{amount:o.outstanding,currencyCode:'ILS'}}}:null}});
  }
  if(operation==='GroupDeliveryOrderCancel'){
   timeline.push('shopify:cancel:'+body.variables.orderId);
   const o=state.orders.get(body.variables.orderId)!;
   if(state.cancelMode==='network')throw TypeError('fetch failed');
   if(state.cancelMode==='rejected'||o.cancelledAt||state.pendingCancels.has(o.id))return json({data:{orderCancel:{job:null,orderCancelUserErrors:[{field:['orderId'],message:'Order cannot be canceled.',code:'INVALID'}]}}});
   if(state.cancelMode==='async')state.pendingCancels.add(o.id);
   else{o.cancelledAt=new Date().toISOString();o.restocked=true;}
   return json({data:{orderCancel:{job:{id:'gid://shopify/Job/1',done:state.cancelMode!=='async'},orderCancelUserErrors:[]}}});
  }
  if(operation==='GroupDeliveryOrderPaid'){
   timeline.push('shopify:paid:'+body.variables.id);
   const o=state.orders.get(body.variables.id)!;
   if(state.payMode==='network')throw TypeError('fetch failed');
   if(state.payMode==='rejected'||o.financial==='PAID')return json({data:{orderCreateManualPayment:{order:null,userErrors:[{field:['id'],message:'Order cannot be paid.'}]}}});
   o.financial=state.payMode==='partial'?'PARTIALLY_PAID':'PAID';o.outstanding=state.payMode==='partial'||state.payMode==='paid-outstanding'?'1.00':'0.00';
   if(state.payMode==='lost')throw TypeError('socket hang up');
   return json({data:{orderCreateManualPayment:{order:{id:o.id,displayFinancialStatus:'PAID'},userErrors:[]}}});
  }
  if(operation==='GroupDeliveryOrderTags'){const o=state.orders.get(body.variables.id)!;for(const t of body.variables.tags)if(!o.tags.includes(t))o.tags.push(t);return json({data:{tagsAdd:{node:{id:o.id},userErrors:[]}}});}
  return json({errors:[{message:'unknown operation'}]});
 };
 const completeCancels=()=>{for(const id of state.pendingCancels){const o=state.orders.get(id)!;o.cancelledAt=new Date().toISOString();o.restocked=true;}state.pendingCancels.clear();};
 return {state,http,completeCancels};
}
export async function paymentsFixture(env:Record<string,string>=CARDCOM_ENV){
 const dir=await mkdtemp(join(tmpdir(),'fankee-pay-db-'));
 const engine=new PGlite(dir);
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const query=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 const db:Database={async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},async connect(){const release=await acquire();return {query,release} as Connection;}};
 const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330',...env});
 const shopify={prices:{} as Record<string,string>,soldOut:[] as string[]};
 const validator=new Shopify(cfg,async(_input,options)=>{
  const body=JSON.parse(String(options?.body));
  return new Response(JSON.stringify({data:{nodes:body.variables.ids.map((id:string)=>{const n=id.split('/').pop()!;return {id,title:'Default Title',availableForSale:!shopify.soldOut.includes(n),requiresComponents:false,quantityAvailable:100,price:{amount:shopify.prices[n]||'125.00',currencyCode:'ILS'},quantityRule:{minimum:1,increment:1,maximum:null},product:{title:'מוצר '+n,requiresSellingPlan:false}};})}}));
 });
 const cardcom=fakeCardcom(),shopifyAdmin=fakeShopifyAdmin(),logs:string[]=[];
 const gateway=cfg.payments.state==='ENABLED'?new CardcomService(cfg.payments.cardcom!,cardcom.http as typeof fetch,2000):null;
 const orders=cfg.payments.orders?new ShopifyOrders({domain:cfg.domain,...cfg.payments.orders},shopifyAdmin.http as typeof fetch,2000):null;
 await migrate(db);
 const app=createApp(db,cfg,validator,{cardcom:gateway,orders,paymentsLog:line=>logs.push(line)});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 // Every response body the service sends, for "no token ever leaves the server" assertions.
 const bodies:string[]=[];
 const send=async(path:string,body?:any,headers:Record<string,string>={})=>{
  const response=await fetch(cfg.origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{...(body===undefined?{}:{'Content-Type':'application/json',Origin:cfg.origin}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();bodies.push(text);
  let data:any=null;try{data=JSON.parse(text);}catch{}
  return {status:response.status,data,text};
 };
 const bearer=(token:string)=>({Authorization:'Bearer '+token});
 let n=0;
 const person=()=>{n++;return {email:'card'+n+'@example.test',phone:'05'+String(30000000+n).padStart(8,'0')};};
 const cart=(quantity=2,variant='1')=>[{variantId:variant,quantity}];
 const reserve=async(options:{area?:string;group?:string;quantity?:number;who?:{email:string;phone:string};amount?:number;token?:string}={})=>{
  const quantity=options.quantity??2,who=options.who??person();
  const path=options.group?'/api/v1/groups/'+options.group+'/reserve':'/api/v1/groups/reserve';
  return send(path,{areaPublicId:options.area??AREA.ashdod,...(options.token?{}:who),lines:cart(quantity),consent:{accepted:true,amountAgorot:options.amount??quantity*12500}},options.token?bearer(options.token):{});
 };
 const webhook=(lowProfileId:string,extra:Record<string,unknown>={})=>fetch(cfg.origin+'/webhooks/cardcom/low-profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({LowProfileId:lowProfileId,...extra})});
 // The full happy path: reserve, the shopper completes Cardcom's page, Cardcom calls the webhook.
 const join_=async(options:Parameters<typeof reserve>[0]={})=>{
  const r=await reserve(options);
  if(r.status!==201)throw Error('reserve failed '+r.status+' '+r.text);
  const page=cardcom.pageFor(r.data.reservation.id)!;page.state='success';
  const hook=await webhook(page.id);if(hook.status!==200)throw Error('webhook '+hook.status);
  const status=await send('/api/v1/reservations/'+r.data.reservation.id,{},bearer(options.token??r.data.memberToken));
  return {reservationId:r.data.reservation.id as string,memberToken:(options.token??r.data.memberToken) as string,group:status.data.group,status:status.data.reservation,page};
 };
 const login=async()=>{
  const response=await fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password:cfg.password})});
  const cookie=response.headers.get('set-cookie')?.split(';')[0]||'';
  const page=await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text();
  return {cookie,csrf:page.match(/name="csrf" value="([^"]+)"/)?.[1]||''};
 };
 const adminPost=async(session:{cookie:string;csrf:string},path:string,body:any={})=>{
  const response=await fetch(cfg.origin+path,{method:'POST',redirect:'manual',headers:{Cookie:session.cookie,Origin:cfg.origin,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify(body)});
  const text=await response.text();bodies.push(text);let data:any=null;try{data=JSON.parse(text);}catch{}
  return {status:response.status,data,text};
 };
 const payments=app.locals.payments as import('../src/payments.js').Payments;
 const close=async()=>{
  await payments.idle();
  await new Promise<void>(r=>server.close(()=>r()));await engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-pay-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 };
 return {db,cfg,shopify,shopifyAdmin,cardcom,logs,bodies,send,bearer,person,cart,reserve,webhook,join:join_,login,adminPost,payments,close};
}
