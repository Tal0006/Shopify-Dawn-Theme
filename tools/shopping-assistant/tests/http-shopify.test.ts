import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server.js';
import {configFromEnv} from '../src/config.js';
import {ShopifyStorefrontClient} from '../src/shopify/storefront-client.js';
import {FakeShop,variant} from './fixtures.js';
const env={SHOPIFY_STORE_DOMAIN:'example.myshopify.com',ALLOWED_ORIGINS:'https://fanakee.com,https://www.fanakee.com'};
const path='/api/v1/shopping-list/';
const json=(body:unknown):RequestInit=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function serve(run:(base:string,shop:FakeShop)=>Promise<void>,shop=new FakeShop()){
 const server=createApp(configFromEnv({...env,NODE_ENV:'production'}),shop).listen(0,'127.0.0.1');
 await new Promise<void>(r=>server.once('listening',r));
 try{await run('http://127.0.0.1:'+(server.address() as AddressInfo).port,shop);}finally{await new Promise<void>(r=>server.close(()=>r()));}
}
test('Public health, configured CORS, denied arbitrary origins, and preflight',async()=>{
 await serve(async base=>{
  assert.deepEqual(await(await fetch(base+'/health')).json(),{status:'ok'});
  const options=await fetch(base+path+'quote',{method:'OPTIONS',headers:{Origin:'https://fanakee.com','Access-Control-Request-Method':'POST'}});
  assert.equal(options.status,204);assert.equal(options.headers.get('access-control-allow-origin'),'https://fanakee.com');
  assert.equal(options.headers.get('access-control-allow-credentials'),null);
  assert.equal((await fetch(base+path+'quote',{...json({message:'מרכך מקסימה בייבי'}),headers:{'Content-Type':'application/json',Origin:'https://evil.example'}})).status,403);
 });
});
test('HTTP quote-to-checkout is explicit, server-priced and channel independent',async()=>{
 await serve(async(base,shop)=>{
  const quote=await(await fetch(base+path+'quote',json({message:'2 מרכך מקסימה בייבי'}))).json();
  assert.equal(quote.canCheckout,true);assert.equal(quote.subtotal.amount,'31.80');assert.equal(shop.cartCalls,0);
  const response=await fetch(base+path+'checkout',json({quoteId:quote.quoteId,revision:quote.revision,confirmed:true,lines:[{variantId:shop.rows[0].variantId,quantity:2}],subtotal:'0.01'}));
  assert.equal(response.status,200);assert.equal((await response.json()).checkoutUrl,'https://checkout.example.com/from-shopify');assert.equal(shop.cartCalls,1);
 });
});
test('Ambiguity is HTTP 200, resolve rejects foreign IDs and accepts only Shopify variants',async()=>{
 const shop=new FakeShop();shop.rows.push(variant('2','מרכך מקסימה לבנדר'));
 await serve(async base=>{
  const q=await(await fetch(base+path+'quote',json({message:'מרכך מקסימה'}))).json();
  assert.equal(q.canCheckout,false);assert.equal(q.ambiguousItems.length,1);
  assert.equal((await fetch(base+path+'resolve',json({quoteId:q.quoteId,revision:1,itemIndex:0,variantId:'gid://shopify/ProductVariant/999'}))).status,400);
  const response=await fetch(base+path+'resolve',json({quoteId:q.quoteId,revision:1,itemIndex:0,variantId:shop.rows[1].variantId,price:'0.01'}));
  assert.equal(response.status,200);assert.equal((await response.json()).canCheckout,true);
 },shop);
});
test('Oversized message, body, invalid JSON and invalid content type are rejected',async()=>{
 await serve(async base=>{
  assert.equal((await fetch(base+path+'quote',json({message:'א'.repeat(4001)}))).status,400);
  assert.equal((await fetch(base+path+'quote',json({message:'א'.repeat(15000)}))).status,413);
  assert.equal((await fetch(base+path+'quote',{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'})).status,400);
  assert.equal((await fetch(base+path+'quote',{method:'POST',body:'plain'})).status,415);
 });
});
test('Rate limiting and untrusted proxy IP spoofing are handled',async()=>{
 await serve(async(base,shop)=>{
  for(let i=0;i<30;i++)assert.equal((await fetch(base+path+'quote',{...json({message:'מרכך מקסימה בייבי'}),headers:{'Content-Type':'application/json','X-Forwarded-For':'203.0.113.'+(i+1)}})).status,200);
  assert.equal(shop.buyer?.ip,'127.0.0.1');
  const response=await fetch(base+path+'quote',json({message:'מרכך מקסימה בייבי'}));assert.equal(response.status,429);assert.ok(response.headers.get('retry-after'));
 });
});
test('Production errors contain no exception or credentials',async()=>{
 const shop=new FakeShop();shop.error=Error('private-secret-sentinel stack access-token');
 await serve(async base=>{
  const response=await fetch(base+path+'quote',json({message:'מרכך מקסימה בייבי'}));
  assert.equal(response.status,500);const body=await response.text();assert.ok(!body.includes('sentinel'));assert.ok(!body.includes('stack'));
 },shop);
});
const raw=(v=variant())=>({id:v.variantId,title:v.variantTitle,availableForSale:v.availableForSale,requiresComponents:false,price:v.unitPrice,quantityRule:{minimum:1,maximum:null,increment:1},product:{id:v.productId,handle:v.handle,title:v.title,vendor:v.vendor,requiresSellingPlan:false}});
test('Storefront client tokenless and private modes use correct endpoint and trusted buyer headers',async()=>{
 for(const privateToken of [undefined,'private-test-token']){
  let request:any;
  const http:typeof fetch=async(url,options)=>{request={url:String(url),options};return new Response(JSON.stringify({data:{nodes:[raw()]}}));};
  const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10',privateToken},http);
  assert.equal((await client.variants([variant().variantId],{ip:'127.0.0.1'})).length,1);
  assert.equal(request.url,'https://example.myshopify.com/api/2026-10/graphql.json');
  assert.equal(request.options.headers['Shopify-Storefront-Private-Token'],privateToken);
  assert.equal(request.options.headers['Shopify-Storefront-Buyer-IP'],'127.0.0.1');
  assert.equal(request.options.headers['X-Shopify-Access-Token'],undefined);
 }
});
test('Search limits requests and flags truncated products/variants',async()=>{
 const node=raw();let variables:any;
 const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10'},async(_url,options)=>{
  const body=JSON.parse(options!.body as string);variables=body.variables;assert.match(body.query,/first:8/);assert.match(body.query,/first:20/);
  return new Response(JSON.stringify({data:{search:{pageInfo:{hasNextPage:false},nodes:[{...node.product,variants:{pageInfo:{hasNextPage:true},nodes:[node]}}]}}}));
 });
 const result=await client.search('מרכך מקסימה');assert.equal(result.truncated,true);assert.equal(result.variants.length,1);assert.deepEqual(variables,{query:'מרכך מקסימה'});
});
test('Upstream network, HTTP, GraphQL and rate-limit errors are sanitized',async()=>{
 for(const response of [new Response('secret',{status:500}),new Response('secret',{status:429}),new Response(JSON.stringify({errors:[{message:'secret'}]}))]){
  const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10'},async()=>response);
  await assert.rejects(client.variants([variant().variantId]),(error:any)=>[429,502].includes(error.status)&&!error.message.includes('secret'));
 }
 const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10'},async()=>{throw Error('secret');});
 await assert.rejects(client.variants([variant().variantId]),{code:'SHOPIFY_UNAVAILABLE'});
});
test('cartCreate sends only merchandise IDs/quantities and returns actual Shopify cost and URL',async()=>{
 let sent:any;
 const cart={id:'gid://shopify/Cart/example',checkoutUrl:'https://checkout.example.com/real',cost:{subtotalAmount:{amount:'15.90',currencyCode:'ILS'},totalAmount:{amount:'15.90',currencyCode:'ILS'}},lines:{nodes:[{quantity:1,merchandise:{id:variant().variantId}}]}};
 const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10'},async(_url,options)=>{
  sent=JSON.parse(options!.body as string);return new Response(JSON.stringify({data:{cartCreate:{cart,userErrors:[],warnings:[]}}}));
 });
 const result=await client.createCart([{variantId:variant().variantId,quantity:1}]);
 assert.deepEqual(sent.variables.input,{lines:[{merchandiseId:variant().variantId,quantity:1}]});
 assert.equal(result.checkoutUrl,cart.checkoutUrl);assert.equal(result.subtotal.amount,'15.90');
});
test('Changed Shopify cart lines and cart user errors are refused',async()=>{
 for(const payload of [{cart:null,userErrors:[{code:'INVALID'}]},{cart:{id:'cart',checkoutUrl:'https://checkout.example.com',lines:{nodes:[]}},userErrors:[]}]){
  const client=new ShopifyStorefrontClient({domain:'example.myshopify.com',version:'2026-10'},async()=>new Response(JSON.stringify({data:{cartCreate:payload}})));
  await assert.rejects(client.createCart([{variantId:variant().variantId,quantity:1}]),(error:any)=>error.status===409);
 }
});
test('Production CORS rejects wildcard origins and defaults to no browser origins',()=>{
 assert.throws(()=>configFromEnv({...env,ALLOWED_ORIGINS:'*'}));
 assert.throws(()=>configFromEnv({...env,NODE_ENV:'production',ALLOWED_ORIGINS:'http://fanakee.com'}));
 assert.deepEqual(configFromEnv({SHOPIFY_STORE_DOMAIN:'example.myshopify.com',NODE_ENV:'production'}).allowedOrigins,[]);
});
