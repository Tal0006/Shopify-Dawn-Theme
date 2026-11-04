import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {parseShoppingList} from '../src/shopping/parser.js';
import {QuoteService} from '../src/shopping/quote-service.js';
import {FakeShop,variant} from './fixtures.js';
import {expandQueries,normalizeHebrewQuery,canonicalQuery,semanticScore,safeQueryLog} from '../src/shopping/hebrew-query.js';
const matcher=new ProductMatcher();
const floor='ריצפז פרש הום בניחוח מלון בוטיק';
const match=(query:string,rows= [variant('1',floor)])=>matcher.match(parseShoppingList(query)[0],{variants:rows,truncated:false});
test('Natural floor-cleaner boutique-hotel request matches uniquely',()=>{
 const result=match('חומר רצפה מלון בוטיק');
 assert.equal(result.status,'matched');assert.equal(result.reason,'SEMANTIC_UNIQUE_MATCH');
});
test('Baby floor cleaner matches uniquely',()=>assert.equal(match('נוזל רצפות בייבי',[variant('1','ריצפז פרש הום בניחוח בייבי')]).status,'matched'));
test('Generic Ritzpaz with three fragrances is ambiguous',()=>{
 assert.equal(match('ריצפז',[variant('1',floor),variant('2','ריצפז בייבי'),variant('3','ריצפז מלון חלומי')]).status,'ambiguous');
});
test('Hebrew bleach and Sano brand match English Sano Javel',()=>{
 assert.equal(match('אקונומיקה סנו',[{...variant('1','Sano Javel'),vendor:'unreliable'}]).status,'matched');
});
test('Multiple Javel products require selection',()=>{
 assert.equal(match('אקונומיקה',[variant('1','Sano Javel baby'),variant('2','Sano Javel lemon')]).status,'ambiguous');
});
test('Explicit missing brand strongly reduces score',()=>{
 const score=(title:string)=>semanticScore('אקונומיקה סנו',title,'unreliable','Default Title');
 assert.ok(score('Other Javel')<score('Sano Javel'));
 assert.ok(score('Other Javel')<0.65);
});
test('Exact title retains priority and reason',()=>assert.equal(match(floor).reason,'EXACT_TITLE_MATCH'));
test('Unknown natural-language request is not found',()=>assert.equal(match('מזון לחתולים טונה').status,'not_found'));
test('Strong unavailable match is not replaced by a different fragrance',()=>{
 const result=match('חומר רצפה מלון בוטיק',[{...variant('1',floor),availableForSale:false},variant('2','ריצפז בייבי')]);
 assert.equal(result.status,'unavailable');assert.equal(result.bestMatch?.variantId,variant('1').variantId);
});
test('Meaningful phrases outrank scattered phrase words',()=>{
 assert.ok(semanticScore('חומר רצפה מלון בוטיק',floor,'','Default Title')>
 semanticScore('חומר רצפה מלון בוטיק','ריצפז מלון בניחוח בוטיק','','Default Title'));
});
test('Reusable normalization preserves original input and canonicalizes punctuation and spellings',()=>{
 const text='  ג׳ל-כביסה בייביי! ';
 assert.equal(normalizeHebrewQuery(text),'גל כביסה בייבי');
 assert.equal(canonicalQuery(text),'גל כביסה בייבי');
 assert.equal(parseShoppingList(text)[0].originalText,text.trim());
 assert.equal(canonicalQuery('מנקה חלונות'),canonicalQuery('סנו קליר'));
});
test('Custom alias groups are configurable independently of matcher',()=>{
 const groups=[{canonical:'חדש',aliases:['ביטוי חדש']}];
 assert.equal(canonicalQuery('ביטוי חדש',groups),'חדש');
 assert.ok(expandQueries('ביטוי חדש',groups).includes('חדש'));
});
test('Query expansion is bounded, unique, and retains distinctive terms',()=>{
 const queries=expandQueries('חומר רצפה מלון בוטיק');
 assert.ok(queries.includes('ריצפז מלון בוטיק'));assert.ok(queries.includes('נוזל רצפות מלון בוטיק'));
 assert.ok(queries.length<=4);assert.equal(new Set(queries).size,queries.length);
 assert.ok(queries.every(q=>q.includes('מלון בוטיק')));
});
test('Synonym retrieval merges duplicate IDs and preserves ambiguity',async()=>{
 const shop=new FakeShop(),seen:string[]=[];
 shop.search=async(name)=>{seen.push(name);return {variants:seen.length===1?[]:[variant('1',floor),variant('1',floor),variant('2','ריצפז מלון בוטיק גדול')],truncated:false};};
 const quote=await new QuoteService(shop).create('חומר רצפה מלון בוטיק');
 assert.equal(quote.items[0].status,'ambiguous');assert.equal(quote.items[0].candidates.length,2);
 assert.ok(seen.length<=4);assert.equal(new Set(seen).size,seen.length);
});
test('Decisive synonym match stops retrieval early',async()=>{
 const shop=new FakeShop(),seen:string[]=[];
 shop.search=async(name)=>{seen.push(name);return {variants:name.startsWith('ריצפז')?[variant('1',floor)]:[],truncated:false};};
 const quote=await new QuoteService(shop).create('חומר רצפה מלון בוטיק');
 assert.equal(quote.items[0].status,'matched');assert.equal(seen.length,3);assert.ok(seen.at(-1)!.startsWith('ריצפז'));
});
test('Exact match uses only one Shopify search',async()=>{
 const shop=new FakeShop();await new QuoteService(shop).create('מרכך מקסימה בייבי');assert.equal(shop.searchCalls,1);
});
test('Redaction excludes arbitrary PII and credential-like strings',()=>{
 const text=safeQueryLog('ריצפז secret-token alice@example.com 0541234567 ישראל ישראלי');
 assert.ok(text.includes('ריצפז'));assert.ok(!text.includes('alice'));assert.ok(!text.includes('054'));assert.ok(!text.includes('secret'));assert.ok(!text.includes('ישראלי'));
});

test('Laundry gel aliases preserve form rather than automatically choosing powder',()=>{
 assert.equal(match("ג'ל כביסה בייבי",[variant('1','נוזל כביסה בייבי')]).status,'matched');
 assert.notEqual(match("ג'ל כביסה בייבי",[variant('1','אבקת כביסה בייבי')]).status,'matched');
});
test('Debug diagnostics include scores and reasons but redact customer identifiers',async()=>{
 const shop=new FakeShop(),logs:unknown[][]=[],original=console.info;
 console.info=(...args:unknown[])=>{logs.push(args);};
 try{
  await new QuoteService(shop,undefined,Date.now,true).create('מרכך מקסימה בייבי alice@example.com 0541234567 test-person');
 }finally{console.info=original;}
 const serialized=JSON.stringify(logs);
 assert.ok(serialized.includes('originalQuery'));assert.ok(serialized.includes('normalizedQuery'));
 assert.ok(serialized.includes('searchVariants'));assert.ok(serialized.includes('score'));assert.ok(serialized.includes('reason'));
 assert.ok(!serialized.includes('alice'));assert.ok(!serialized.includes('0541234567'));assert.ok(!serialized.includes('test-person'));
});
