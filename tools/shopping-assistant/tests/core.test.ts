import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseShoppingList,normalize} from '../src/shopping/parser.js';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {multiply,sum} from '../src/shopping/money.js';
import {QuoteService} from '../src/shopping/quote-service.js';
import {CheckoutService} from '../src/shopping/checkout-service.js';
import {FakeShop,variant} from './fixtures.js';
const name='מרכך מקסימה בייבי';
for(const [text,count] of [[name,1],['2 '+name,2],['2x '+name,2],[name+' x2',2],['3 × '+name,3],[name+' 2',2],['שתי '+name,2]] as const){
 test('Parse quantity: '+text,()=>{const [item]=parseShoppingList(text);assert.equal(item.quantity,count);assert.equal(item.requestedName,name);assert.equal(item.originalText,text);});
}
test('Newlines and commas preserve every requested line',()=>{
 const items=parseShoppingList('2 מרכך מקסימה בייבי\nאקונומיקה סנו,3 נוזל רצפות לבנדר');
 assert.equal(items.length,3);assert.deepEqual(items.map(i=>i.quantity),[2,1,3]);
 assert.equal(normalize('  ג׳ל  כביסה! '),'גל כביסה');
});
for(const text of ['0 '+name,'-1 '+name,'1.5 '+name,'21 '+name,'x2','2x',name+' x-2',name+' x1.5','123',name+' x',' ', 'א'.repeat(4001)]){
 test('Malformed/oversized item rejected: '+text.slice(0,24),()=>assert.throws(()=>parseShoppingList(text)));
}
test('List and total-unit limits enforced',()=>{assert.throws(()=>parseShoppingList(Array(21).fill(name).join('\n')));assert.throws(()=>parseShoppingList(Array(6).fill('20 '+name).join('\n')));});
test('Decimal-safe totals including zero- and three-decimal currencies',()=>{
 assert.equal(multiply({amount:'15.90',currencyCode:'ILS'},2).amount,'31.80');
 assert.equal(sum([{amount:'0.10',currencyCode:'ILS'},{amount:'0.20',currencyCode:'ILS'}])?.amount,'0.30');
 assert.equal(multiply({amount:'123',currencyCode:'JPY'},2).amount,'246');
 assert.equal(multiply({amount:'1.123',currencyCode:'KWD'},3).amount,'3.369');
 assert.equal(sum([{amount:'1',currencyCode:'ILS'},{amount:'1',currencyCode:'USD'}]),null);
});
const matcher=new ProductMatcher(),item=parseShoppingList(name)[0];
test('Exact and close product match',()=>{assert.equal(matcher.match(item,{variants:[variant()],truncated:false}).status,'matched');assert.equal(matcher.match(parseShoppingList('מרכך מקסימה בייביי')[0],{variants:[variant()],truncated:false}).status,'matched');});
test('Multiple plausible scents are ambiguous; never prefer available substitute',()=>{
 const rows=[variant(),variant('2','מרכך מקסימה לבנדר')];
 assert.equal(matcher.match(parseShoppingList('מרכך מקסימה')[0],{variants:rows,truncated:false}).status,'ambiguous');
 rows[0].availableForSale=false;assert.equal(matcher.match(item,{variants:rows,truncated:false}).status,'unavailable');
});
test('Not found, unavailable, unsupported plans and truncated candidates',()=>{
 assert.equal(matcher.match(item,{variants:[],truncated:false}).status,'not_found');
 assert.equal(matcher.match(item,{variants:[{...variant(),availableForSale:false}],truncated:false}).status,'unavailable');
 assert.equal(matcher.match(item,{variants:[{...variant(),requiresSellingPlan:true}],truncated:false}).status,'unavailable');
 assert.equal(matcher.match(parseShoppingList('מרכך מקסימה')[0],{variants:[variant()],truncated:true}).status,'ambiguous');
});
const setup=()=>{const shop=new FakeShop(),quotes=new QuoteService(shop),checkout=new CheckoutService(shop,quotes);return {shop,quotes,checkout};};
const confirmation=(q:any)=>({quoteId:q.quoteId,revision:q.revision,confirmed:true,lines:q.resolvedItems.map((i:any)=>({variantId:i.variantId,quantity:i.quantity}))});
test('Quote calculates multiple products and never creates a cart',async()=>{
 const {shop,quotes}=setup();shop.rows.push(variant('2','אקונומיקה סנו','0.10'));
 const q=await quotes.create('2 '+name+'\n3 אקונומיקה סנו');assert.equal(q.subtotal?.amount,'32.10');assert.equal(q.canCheckout,true);assert.equal(shop.cartCalls,0);
});
test('Quote keeps ambiguous, unavailable and missing items and blocks checkout',async()=>{
 const {shop,quotes,checkout}=setup();shop.rows.push(variant('2','מרכך מקסימה לבנדר'));
 const q=await quotes.create('מרכך מקסימה\nמוצר אחר לחלוטין');assert.equal(q.ambiguousItems.length,1);assert.equal(q.notFoundItems.length,1);assert.equal(q.canCheckout,false);
 await assert.rejects(checkout.checkout({...confirmation(q),lines:[{variantId:shop.rows[0].variantId,quantity:1}]}),{code:'UNRESOLVED_QUOTE'});assert.equal(shop.cartCalls,0);
});
test('Resolve validates candidate membership and reads Shopify prices instead of client prices',async()=>{
 const {shop,quotes}=setup();shop.rows.push(variant('2','מרכך מקסימה לבנדר'));
 const q=await quotes.create('מרכך מקסימה');
 await assert.rejects(quotes.resolve({quoteId:q.quoteId,revision:1,itemIndex:0,variantId:'gid://shopify/ProductVariant/999'}),{code:'INVALID_SELECTION'});
 shop.rows[0].unitPrice.amount='19.90';
 const resolved=await quotes.resolve({quoteId:q.quoteId,revision:1,itemIndex:0,variantId:shop.rows[0].variantId,price:'0.01',title:'Fake'});
 assert.equal(resolved.subtotal?.amount,'19.90');assert.equal(resolved.revision,2);assert.equal(resolved.canCheckout,true);assert.equal(shop.readCalls,1);
});
test('Explicit checkout creates once and returns Shopify checkoutUrl; browser subtotal ignored',async()=>{
 const {shop,quotes,checkout}=setup(),q=await quotes.create('2 '+name);
 await assert.rejects(checkout.checkout({...confirmation(q),confirmed:false}),{code:'CONFIRMATION_REQUIRED'});
 for(const quantity of [0,-1,1.5,21,'2'])await assert.rejects(checkout.checkout({...confirmation(q),lines:[{variantId:shop.rows[0].variantId,quantity}]}),{code:'INVALID_QUANTITY'});
 const result=await checkout.checkout({...confirmation(q),subtotal:'0.01',title:'Fake'});
 assert.equal(shop.readCalls,1);assert.equal(shop.cartCalls,1);assert.equal(result.checkoutUrl,'https://checkout.example.com/from-shopify');
 await checkout.checkout(confirmation(q));assert.equal(shop.cartCalls,1);
});
test('Changed price needs a new confirmation, unavailable and deleted variants block creation',async()=>{
 for(const mode of ['price','unavailable','deleted']){
  const {shop,quotes,checkout}=setup(),q=await quotes.create(name);
  if(mode==='price')shop.rows[0].unitPrice.amount='20.00';if(mode==='unavailable')shop.rows[0].availableForSale=false;if(mode==='deleted')shop.rows=[];
  await assert.rejects(checkout.checkout(confirmation(q)),{code:'QUOTE_CHANGED'});assert.equal(shop.cartCalls,0);
  if(mode==='price'){const updated=quotes.get(q.quoteId).quote;assert.equal(updated.subtotal?.amount,'20.00');await checkout.checkout(confirmation(updated));assert.equal(shop.cartCalls,1);}
 }
});
test('Foreign variant and mismatched quantity are not accepted; duplicates aggregate safely',async()=>{
 const {shop,quotes,checkout}=setup(),q=await quotes.create(name+'\n'+name);
 await assert.rejects(checkout.checkout({...confirmation(q),lines:[{variantId:'gid://shopify/ProductVariant/999',quantity:2}]}),{code:'LINES_MISMATCH'});
 await checkout.checkout(confirmation(q));assert.deepEqual(shop.sentLines,[{variantId:shop.rows[0].variantId,quantity:2}]);
});
test('Expired quote and stale revision are rejected',async()=>{
 const shop=new FakeShop();let now=0;const quotes=new QuoteService(shop,matcher,()=>now),checkout=new CheckoutService(shop,quotes),q=await quotes.create(name);
 await assert.rejects(checkout.checkout({...confirmation(q),revision:9}),{code:'STALE_QUOTE'});
 now=900001;assert.throws(()=>quotes.get(q.quoteId),{code:'QUOTE_EXPIRED'});
});
test('A mutation timeout is not retried and client cannot mutate held quote state',async()=>{
 const {shop,quotes,checkout}=setup(),q=await quotes.create(name);q.items[0].bestMatch!.unitPrice.amount='0.01';
 assert.equal(quotes.get(q.quoteId).quote.subtotal?.amount,'15.90');
 shop.createCart=async()=>{shop.cartCalls++;throw Error('Timeout');};
 await assert.rejects(checkout.checkout(confirmation(q)));await assert.rejects(checkout.checkout(confirmation(q)),{code:'CHECKOUT_BUSY'});assert.equal(shop.cartCalls,1);
});

test('Concurrent confirmations are serialized per quote',async()=>{
 const {shop,quotes,checkout}=setup(),q=await quotes.create(name);
 const read=shop.variants.bind(shop);shop.variants=async(ids,buyer)=>{await new Promise(r=>setTimeout(r,20));return read(ids,buyer);};
 const results=await Promise.allSettled([checkout.checkout(confirmation(q)),checkout.checkout(confirmation(q))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(shop.cartCalls,1);
});
