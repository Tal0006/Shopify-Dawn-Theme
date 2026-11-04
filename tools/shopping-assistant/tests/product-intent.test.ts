import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {parseShoppingList} from '../src/shopping/parser.js';
import {semanticScore} from '../src/shopping/hebrew-query.js';
import {detectQueryIntent,detectProductIntent} from '../src/shopping/product-intent.js';
import {variant} from './fixtures.js';
import type {CatalogVariant} from '../src/domain/types.js';
const soft='מקסימה סופר מרוכז מרכך בייבי',gel="מקסימה בייבי ג'ל כביסה";
const matcher=new ProductMatcher();
const match=(query:string,rows:CatalogVariant[],truncated=false)=>matcher.match(parseShoppingList(query)[0],{variants:rows,truncated});
test('Softener request excludes laundry gel despite identical brand and fragrance',()=>{
 const result=match('מרכך מקסימה בייבי',[variant('1',soft),variant('2',soft+' היפואלרגני'),variant('3',gel)]);
 assert.equal(result.status,'ambiguous');assert.equal(result.candidates.length,2);
 assert.ok(result.candidates.every(c=>c.variantId!==variant('3').variantId));
 assert.equal(semanticScore('מרכך מקסימה בייבי',gel,'סנו','Default Title'),0);
});
test('Laundry detergent request matches laundry gel and excludes softener',()=>{
 const result=match("ג'ל כביסה מקסימה בייבי",[variant('1',soft),variant('2',gel)]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.title,gel);
});
test('Two matching unavailable Javel products report unavailable even with pagination',()=>{
 for(const truncated of [false,true]){
  const result=match('אקונומיקה סנו',[{...variant('1','Sano Javel lemon'),availableForSale:false},{...variant('2','Sano Javel baby'),availableForSale:false}],truncated);
  assert.equal(result.status,'unavailable');assert.equal(result.reason,'ALL_RELEVANT_MATCHES_UNAVAILABLE');
  assert.equal(result.candidates.length,2);assert.equal(result.bestMatch,undefined);
 }
});
test('Unavailable strong softener never substitutes an available laundry gel',()=>{
 const result=match('מרכך מקסימה בייבי',[{...variant('1',soft),availableForSale:false},variant('2',gel)]);
 assert.equal(result.status,'unavailable');assert.equal(result.bestMatch?.title,soft);
 assert.equal(result.candidates.length,1);
});
test('Explicit floor liquid excludes Ritzpaz wipes',()=>{
 const result=match('נוזל רצפות',[variant('1','ריצפז נוזל רצפות בייבי'),variant('2','ריצפז מטליות לחות לרצפה בייבי')]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('1').variantId);
});
test('Floor wipe request excludes liquid cleaner',()=>{
 const result=match('מטליות לרצפה',[variant('1','ריצפז נוזל רצפות בייבי'),variant('2','ריצפז מטליות רצפה בייבי')]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('2').variantId);
});
test('Exact-title priority remains unchanged',()=>{
 const result=match(soft,[variant('1',soft),variant('2',gel)],true);
 assert.equal(result.status,'matched');assert.equal(result.reason,'EXACT_TITLE_MATCH');assert.equal(result.confidence,1);
});
test('Unknown query intent keeps semantic fallback',()=>{
 assert.equal(detectQueryIntent('ספוג קסם'),'UNKNOWN');
 assert.equal(match('ספוג קסם',[variant('1','ספוג קסם גדול')]).status,'matched');
});
test('Multiple purchasable same-intent candidates stay ambiguous',()=>{
 assert.equal(match('מרכך מקסימה',[variant('1',soft),variant('2',soft+' לבנדר'),variant('3',soft+' לימון')]).status,'ambiguous');
 assert.equal(match('ריצפז',[variant('1','ריצפז בייבי'),variant('2','ריצפז לבנדר')]).status,'ambiguous');
});
test('A purchasable plausible product prevents the all-unavailable business state',()=>{
 const result=match('אקונומיקה סנו',[{...variant('1','Sano Javel baby'),availableForSale:false},variant('2','Sano Javel lemon')],true);
 assert.equal(result.status,'ambiguous');
});
test('Unknown candidate has only a small penalty; explicit conflicts score zero',()=>{
 assert.ok(semanticScore('מרכך מקסימה בייבי','מקסימה בייבי','סנו','Default Title')>0);
 assert.equal(semanticScore('נוזל רצפות','מטליות רצפה','סנו','Default Title'),0);
});
test('Intent aliases, specificity, optional metadata and custom definitions',()=>{
 assert.equal(detectQueryIntent('מרכך כביסה'),'FABRIC_SOFTENER');
 assert.equal(detectQueryIntent("ג׳ל-כביסה"),'LAUNDRY_DETERGENT');
 assert.equal(detectQueryIntent('אבקת כביסה'),'LAUNDRY_POWDER');
 assert.equal(detectQueryIntent("ג'אוול"),'BLEACH');
 assert.equal(detectProductIntent('ריצפז מטליות לחות לרצפה'),'FLOOR_WIPES');
 assert.equal(detectProductIntent('סנו קליר'),'GLASS_CLEANER');
 assert.equal(detectProductIntent({title:'שם לא ידוע',productType:'אבקת כביסה'}),'LAUNDRY_POWDER');
 assert.equal(detectProductIntent({title:'מרכך',productType:'אבקת כביסה'}),'FABRIC_SOFTENER');
 assert.equal(detectQueryIntent('כינוי חדש',[{intent:'BLEACH',aliases:['כינוי חדש']}]),'BLEACH');
});
