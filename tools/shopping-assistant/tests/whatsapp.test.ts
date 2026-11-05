import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server.js';
import {configFromEnv} from '../src/config.js';
import {QuoteService} from '../src/shopping/quote-service.js';
import {CheckoutService} from '../src/shopping/checkout-service.js';
import {WhatsAppAdapter} from '../src/channels/whatsapp/whatsapp-adapter.js';
import {MemoryWhatsAppSessionStore} from '../src/channels/whatsapp/whatsapp-session.js';
import {WhatsAppClient} from '../src/channels/whatsapp/whatsapp-client.js';
import {verifySignature,incomingMessages} from '../src/channels/whatsapp/whatsapp-webhook.js';
import type {WhatsAppTransport,WhatsAppConfig,ReplyButton,ListRow} from '../src/channels/whatsapp/whatsapp-types.js';
import {FakeShop,variant} from './fixtures.js';
const wa:WhatsAppConfig={phoneNumberId:'12345678901',accessToken:'test-access-secret',verifyToken:'test-verify-secret',appSecret:'test-app-secret',graphVersion:'v99.0'};
const env={SHOPIFY_STORE_DOMAIN:'example.myshopify.com',WHATSAPP_ENABLED:'true',WHATSAPP_PHONE_NUMBER_ID:wa.phoneNumberId,
 WHATSAPP_ACCESS_TOKEN:wa.accessToken,WHATSAPP_VERIFY_TOKEN:wa.verifyToken,META_APP_SECRET:wa.appSecret,META_GRAPH_API_VERSION:wa.graphVersion};
class FakeMeta implements WhatsAppTransport{
 sent:{to:string;text:string;buttons?:ReplyButton[];rows?:ListRow[]}[]=[];
 async sendText(to:string,text:string){this.sent.push({to,text});}
 async sendReplyButtons(to:string,text:string,buttons:ReplyButton[]){this.sent.push({to,text,buttons});}
 async sendListMessage(to:string,text:string,_button:string,rows:ListRow[]){this.sent.push({to,text,rows});}
}
function setup(){
 const shop=new FakeShop(),meta=new FakeMeta(),sessions=new MemoryWhatsAppSessionStore(),quotes=new QuoteService(shop);
 const adapter=new WhatsAppAdapter(quotes,new CheckoutService(shop,quotes),meta,sessions);
 let n=0;
 const send=async(text:string,extra:Record<string,unknown>={})=>{adapter.enqueue({from:'12345678902',id:'m'+(++n),timestamp:Date.now(),text,...extra});await adapter.idle();};
 return {shop,meta,sessions,quotes,adapter,send};
}
const user='12345678902',name='מרכך מקסימה בייבי';
function payload(text='שלום',id='webhook1'){
 return {object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{metadata:{phone_number_id:wa.phoneNumberId},messages:[
  {from:user,id,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}
 ]}}]}]};
}
const sign=(raw:string)=>'sha256='+createHmac('sha256',wa.appSecret).update(raw).digest('hex');
async function serve(run:(url:string,shop:FakeShop,meta:FakeMeta)=>Promise<void>,enabled=true){
 const shop=new FakeShop(),meta=new FakeMeta();
 const app=createApp(configFromEnv({...env,WHATSAPP_ENABLED:String(enabled)}),shop,{client:meta});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 try{await run('http://127.0.0.1:'+(server.address() as AddressInfo).port,shop,meta);}
 finally{await new Promise<void>(r=>server.close(()=>r()));}
}
test('Webhook verification succeeds only for matching token and subscribe mode',async()=>{
 await serve(async base=>{
  const query='?hub.mode=subscribe&hub.verify_token='+wa.verifyToken+'&hub.challenge=12345';
  const good=await fetch(base+'/webhooks/whatsapp'+query);assert.equal(good.status,200);assert.equal(await good.text(),'12345');
  assert.equal((await fetch(base+'/webhooks/whatsapp'+query.replace(wa.verifyToken,'wrong'))).status,403);
  assert.equal((await fetch(base+'/webhooks/whatsapp'+query.replace('subscribe','other'))).status,403);
 });
});
test('Raw signed webhook validates bytes, rejects invalid signatures and ignores status-only events',async()=>{
 await serve(async(base,_shop,meta)=>{
  const body=JSON.stringify(payload());
  const good=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':sign(body)},body});
  assert.equal(good.status,200);
  const bad=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':sign(body)},body:body+' '});
  assert.equal(bad.status,401);
  assert.equal(verifySignature(Buffer.from(body),undefined,wa.appSecret),false);
  assert.deepEqual(incomingMessages({object:'whatsapp_business_account',entry:[null,{changes:[null]}]},wa.phoneNumberId),[]);
  for(let i=0;i<100&&!meta.sent.length;i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(meta.sent[0].text.includes('עוזר הקניות'));
 });
});
test('Webhook ACK does not await a blocked Shopify search',async()=>{
 await serve(async(base,shop)=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),original=shop.search.bind(shop);
  shop.search=async(...args)=>{await gate;return original(...args);};
  const body=JSON.stringify(payload(name));
  try{
   const response=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':sign(body)},body,signal:AbortSignal.timeout(2000)});
   assert.equal(response.status,200);assert.equal(shop.searchCalls,0);
  }finally{release();}
 });
});
test('Duplicate IDs are ignored and greetings never call Shopify',async()=>{
 const s=setup();await s.send('שלום',{id:'duplicate'});const count=s.meta.sent.length;
 await s.send('שלום',{id:'duplicate'});assert.equal(s.meta.sent.length,count);assert.equal(s.shop.searchCalls,0);
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_LIST');
});
test('New shopping list uses shared engine and matched rows contain backend prices/totals',async()=>{
 const s=setup();await s.send('2 '+name);
 assert.equal(s.shop.searchCalls,1);assert.equal(s.shop.cartCalls,0);
 const rendered=s.meta.sent.map(m=>m.text).join('\n');assert.ok(rendered.includes('כמות: 2'));assert.ok(rendered.includes('15.90'));assert.ok(rendered.includes('31.80'));
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_CONFIRMATION');
 assert.ok(!JSON.stringify(s.meta.sent).includes('gid://'));
});
test('Ambiguity offers opaque selectable IDs; resolve uses trusted server-side candidate',async()=>{
 const s=setup();s.shop.rows.push(variant('2','מרכך מקסימה לבנדר'));await s.send('מרכך מקסימה');
 const row=s.meta.sent.find(m=>m.rows)?.rows?.[0];assert.ok(row);assert.ok(!row.id.includes('gid'));
 await s.send('',{replyId:row.id});assert.equal(s.sessions.get(user)?.revision,2);
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_CONFIRMATION');assert.equal(s.shop.cartCalls,0);
});
test('Unavailable products cannot enter checkout and can be removed',async()=>{
 const s=setup();s.shop.rows[0].availableForSale=false;await s.send(name);
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_RESOLUTION');await s.send('אישור');assert.equal(s.shop.cartCalls,0);
 await s.send('הסר מהרשימה');assert.equal(s.sessions.get(user),undefined);
});
test('Explicit text and interactive confirmation create checkout and return backend URL',async()=>{
 for(const interactive of [false,true]){
  const s=setup();await s.send('2 '+name);
  const confirm=s.meta.sent.find(m=>m.buttons)?.buttons?.find(b=>b.title==='אישור');assert.ok(confirm);
  await s.send(interactive?'':'אישור',interactive?{replyId:confirm.id}:{});
  assert.equal(s.shop.cartCalls,1);assert.equal(s.sessions.get(user)?.state,'CHECKOUT_READY');
  assert.ok(s.meta.sent.at(-1)?.text.includes('https://checkout.example.com/from-shopify'));
  await s.send('אישור');assert.equal(s.shop.cartCalls,1);
 }
});
test('Price changes force an updated quote and a second explicit confirmation',async()=>{
 const s=setup();await s.send(name);s.shop.rows[0].unitPrice.amount='20.00';await s.send('אישור');
 assert.equal(s.shop.cartCalls,0);assert.equal(s.sessions.get(user)?.revision,2);
 assert.ok(s.meta.sent.some(m=>m.text.includes('צריך אישור מחדש')));
 await s.send('אישור');assert.equal(s.shop.cartCalls,1);
});
test('Cancel resets session; edit invalidates old confirmation choices',async()=>{
 const s=setup();await s.send(name);
 const id=s.meta.sent.find(m=>m.buttons)!.buttons![0].id;
 await s.send('שינוי');await s.send('',{replyId:id});assert.equal(s.shop.cartCalls,0);
 await s.send('ביטול');assert.equal(s.sessions.get(user),undefined);
});

test('Missing or foreign interactive IDs never resolve another customer quote',async()=>{
 const s=setup();await s.send(name);const id=s.meta.sent.find(m=>m.buttons)!.buttons![0].id;
 await s.send('',{from:'12345678903',replyId:id});assert.equal(s.shop.cartCalls,0);
 assert.ok(s.meta.sent.at(-1)?.text.includes('אינה עדכנית'));
});
test('Not-found items ask for correction; maximum list length still enforced by shared parser',async()=>{
 const s=setup();s.shop.rows=[];await s.send('מוצר לא מוכר');
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_RESOLUTION');
 assert.ok(s.meta.sent.some(m=>m.text.includes('לא הצלחתי למצוא')));
 await s.send('שינוי');await s.send('א'.repeat(4001));assert.equal(s.shop.cartCalls,0);
});
test('Failed cart mutation locks confirmation instead of blindly retrying',async()=>{
 const s=setup();s.shop.createCart=async()=>{s.shop.cartCalls++;throw Error('private-upstream-error');};
 await s.send(name);await s.send('אישור');await s.send('אישור');
 assert.equal(s.shop.cartCalls,1);assert.equal(s.sessions.get(user)?.state,'CHECKOUT_UNCERTAIN');
});
test('Concurrent messages from a customer are serialized and duplicate confirmation creates one cart',async()=>{
 const s=setup();
 s.adapter.enqueue({from:user,id:'first',timestamp:Date.now(),text:name});
 s.adapter.enqueue({from:user,id:'second',timestamp:Date.now(),text:'אישור'});
 s.adapter.enqueue({from:user,id:'third',timestamp:Date.now(),text:'אישור'});
 await s.adapter.idle();assert.equal(s.shop.cartCalls,1);
});
test('Successful checkout state survives outbound send failure',async()=>{
 const s=setup();await s.send(name);
 const original=s.meta.sendText.bind(s.meta);
 let failed=false;s.meta.sendText=async(to,text)=>{if(text.includes('checkout.example')&&!failed){failed=true;throw Error('Meta timeout');}await original(to,text);};
 await s.send('אישור');assert.equal(s.sessions.get(user)?.state,'CHECKOUT_READY');
 await s.send('אישור');assert.equal(s.shop.cartCalls,1);assert.ok(s.meta.sent.at(-1)?.text.includes('checkout.example'));
});
test('Client uses configurable Graph version, bearer server credential and constrained interactive payloads',async()=>{
 const requests:any[]=[];
 const client=new WhatsAppClient(wa,async(url,options)=>{
  requests.push({url,options,body:JSON.parse(options!.body as string)});return new Response('{}',{status:200});
 });
 await client.sendText(user,'hello');
 await client.sendReplyButtons(user,'confirm',[{id:'opaque',title:'אישור'}]);
 await client.sendListMessage(user,'choose','בחירה',[{id:'opaque-choice',title:'מוצר',description:'תיאור'}]);
 assert.equal(requests[0].url,'https://graph.facebook.com/v99.0/12345678901/messages');
 assert.equal(requests[0].options.headers.Authorization,'Bearer '+wa.accessToken);
 assert.equal(requests[1].body.interactive.action.buttons[0].reply.id,'opaque');
 assert.equal(requests[2].body.interactive.action.sections[0].rows[0].id,'opaque-choice');
 assert.ok(!JSON.stringify(requests.map(r=>r.body)).includes(wa.accessToken));
 await assert.rejects(client.sendReplyButtons(user,'x',Array.from({length:4},(_,i)=>({id:String(i),title:'x'}))));
});
test('Transport errors and processing logs never expose tokens, customer identifiers or exception data',async()=>{
 const client=new WhatsAppClient(wa,async()=>{throw Error(wa.accessToken+' '+wa.appSecret);});
 await assert.rejects(client.sendText(user,'x'),{message:'WHATSAPP_SEND_FAILED'});
 const s=setup(),logs:unknown[][]=[],original=console.warn;
 console.warn=(...args)=>{logs.push(args);};
 s.meta.sendText=async()=>{throw Error(wa.accessToken+' '+user);};
 try{await s.send('שלום');}finally{console.warn=original;}
 assert.ok(logs.length>0);
 const serialized=JSON.stringify(logs);
 for(const secret of [wa.accessToken,wa.appSecret,wa.verifyToken,user])assert.ok(!serialized.includes(secret));
});
test('Signed extractor ignores wrong business number, stale messages and forged interactive titles',()=>{
 const p=payload(name);p.entry[0].changes[0].value.metadata.phone_number_id='other';
 assert.deepEqual(incomingMessages(p,wa.phoneNumberId),[]);
 const old=payload(name);old.entry[0].changes[0].value.messages[0].timestamp='1';
 assert.deepEqual(incomingMessages(old,wa.phoneNumberId),[]);
 const data:any=payload();data.entry[0].changes[0].value.messages[0]={from:user,id:'interactive',timestamp:String(Math.floor(Date.now()/1000)),type:'interactive',interactive:{type:'list_reply',list_reply:{id:'opaque',title:'forged-price'}}};
 const extracted=incomingMessages(data,wa.phoneNumberId);
 assert.equal(extracted[0].replyId,'opaque');assert.equal(extracted[0].text,undefined);
});
test('Sessions/dedup expire, state is cloned and per-customer abuse is limited',()=>{
 let now=1000;const store=new MemoryWhatsAppSessionStore(()=>now);
 const session={state:'WAITING_FOR_LIST' as const,unresolvedItems:[],expiresAt:2000,actions:{}};
 store.set(user,session);store.get(user)!.state='IDLE';assert.equal(store.get(user)?.state,'WAITING_FOR_LIST');
 assert.equal(store.claimMessage('one'),true);assert.equal(store.claimMessage('one'),false);
 for(let i=0;i<10;i++)assert.equal(store.allow(user),true);
 assert.equal(store.allow(user),false);now=86402000;
 assert.equal(store.get(user),undefined);assert.equal(store.claimMessage('one'),true);assert.equal(store.allow(user),true);
});
test('WhatsApp disabled permits normal startup, public health and unchanged website quote/checkout APIs',async()=>{
 await serve(async(base,shop)=>{
  assert.deepEqual(await(await fetch(base+'/health')).json(),{status:'ok'});
  assert.equal((await fetch(base+'/webhooks/whatsapp')).status,404);
  const response=await fetch(base+'/api/v1/shopping-list/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:name})});
  assert.equal(response.status,200);const quote=await response.json();assert.equal(quote.canCheckout,true);
  const checkout=await fetch(base+'/api/v1/shopping-list/checkout',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({quoteId:quote.quoteId,revision:quote.revision,confirmed:true,lines:[{variantId:shop.rows[0].variantId,quantity:1}]})});
  assert.equal(checkout.status,200);
 },false);
 const config=configFromEnv({SHOPIFY_STORE_DOMAIN:'example.myshopify.com',WHATSAPP_ENABLED:'false',META_GRAPH_API_VERSION:'bad'});
 assert.equal(config.whatsapp,undefined);
 assert.throws(()=>configFromEnv({SHOPIFY_STORE_DOMAIN:'example.myshopify.com',WHATSAPP_ENABLED:'true'}));
});

test('A failed updated summary cannot enable confirmation for unseen prices',async()=>{
 const s=setup();await s.send(name);s.shop.rows[0].unitPrice.amount='20.00';
 const original=s.meta.sendText.bind(s.meta);
 s.meta.sendText=async(to,text)=>{if(text.startsWith('🛒'))throw Error('delivery failed');await original(to,text);};
 await s.send('אישור');assert.equal(s.shop.cartCalls,0);
 assert.equal(s.sessions.get(user)?.state,'WAITING_FOR_RESOLUTION');
 await s.send('אישור');assert.equal(s.shop.cartCalls,0);
});
test('Webhook content is private and disabled channel does not require credentials',()=>{
 const p=payload();const raw=JSON.stringify(p);
 assert.equal(verifySignature(Buffer.from(raw),sign(raw),wa.appSecret),true);
 assert.equal(verifySignature(Buffer.from(raw),sign(raw),'incorrect'),false);
 assert.equal(configFromEnv({SHOPIFY_STORE_DOMAIN:'example.myshopify.com'}).whatsapp,undefined);
});

test('Webhook lifecycle logs contain only fixed events and extracted counts, never sensitive request data',async()=>{
 const logs:unknown[][]=[],info=console.info,warn=console.warn;
 console.info=(...args)=>{logs.push(args);};console.warn=(...args)=>{logs.push(args);};
 try{
  await serve(async(base,shop)=>{
   const received=['WhatsApp webhook: POST received'],parsed=['WhatsApp webhook: payload parsed'],
    acknowledged=['WhatsApp webhook: acknowledged HTTP 200'];
   const post=async(body:string,signature=sign(body))=>{
    logs.length=0;
    return fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{
     'Content-Type':'application/json','x-hub-signature-256':signature
    },body});
   };
   const body=JSON.stringify(payload('שלום','private-message-id-sentinel'));
   const good=await post(body);assert.equal(good.status,200);
   assert.deepEqual(logs,[received,parsed,['WhatsApp webhook: accepted inbound messages extracted',1],acknowledged]);
   const serialized=JSON.stringify(logs);
   for(const privateValue of [body,user,wa.phoneNumberId,wa.accessToken,wa.verifyToken,wa.appSecret,sign(body),'שלום','private-message-id-sentinel'])
    assert.ok(!serialized.includes(privateValue));
   const ignored=await post(JSON.stringify({object:'whatsapp_business_account',entry:[]}));
   assert.equal(ignored.status,200);
   assert.deepEqual(logs,[received,parsed,['WhatsApp webhook: accepted inbound messages extracted',0],acknowledged]);
   const invalid=await post(body,'sha256='+'0'.repeat(64));assert.equal(invalid.status,401);
   assert.deepEqual(logs,[received,['WhatsApp webhook: signature verification failed']]);
   const malformed=await post('{');assert.equal(malformed.status,400);
   assert.deepEqual(logs,[received]);
   assert.equal(shop.searchCalls,0);assert.equal(shop.cartCalls,0);
  });
 }finally{console.info=info;console.warn=warn;}
});
