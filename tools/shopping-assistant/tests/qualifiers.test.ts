import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {parseShoppingList} from '../src/shopping/parser.js';
import {distinctiveQualifiers,semanticScore} from '../src/shopping/hebrew-query.js';
import {variant} from './fixtures.js';
const matcher=new ProductMatcher(),soft='מקסימה סופר מרוכז מרכך בייבי';
const run=(rows:ReturnType<typeof variant>[],query='מרכך מקסימה בייבי')=>
 matcher.match(parseShoppingList(query)[0],{variants:rows,truncated:false});
test('Unavailable baby softeners are not made ambiguous by available Pure Love',()=>{
 const result=run([{...variant('1',soft),availableForSale:false},{...variant('2',soft+' היפואלרגני'),availableForSale:false},variant('3','מקסימה מרכך Pure Love')]);
 assert.equal(result.status,'unavailable');assert.equal(result.reason,'ALL_RELEVANT_MATCHES_UNAVAILABLE');
 assert.equal(result.candidates.length,2);assert.equal(result.bestMatch,undefined);
});
test('Two purchasable baby laundry gels remain ambiguous',()=>{
 const result=run([variant('1',"מקסימה בייבי ג'ל כביסה מרוכז"),variant('2',"מקסימה בייבי ג'ל כביסה היפואלרגני")],"ג'ל כביסה מקסימה בייבי");
 assert.equal(result.status,'ambiguous');assert.equal(result.candidates.length,2);
});
test('One unique qualifying available product matches',()=>{
 const result=run([variant('1',soft),variant('2','מקסימה מרכך Pure Love')]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('1').variantId);
});
for(const qualifier of ['לבנדר','לימון','Pure Love','Blue Blossom','מלון בוטיק','מלון חלומי','היפואלרגני','דוחה חרקים','ארומה חדשה מיוחדת']){
 test('Query-derived qualifier constraint: '+qualifier,()=>{
  const query='מרכך מקסימה '+qualifier;
  const result=run([{...variant('1','מקסימה מרכך סופר '+qualifier),availableForSale:false},variant('2','מקסימה מרכך בייבי')],query);
  assert.equal(result.status,'unavailable');assert.equal(result.candidates.length,1);
 });
}
test('All specified qualifier tokens must be present',()=>{
 assert.equal(semanticScore('מרכך מקסימה בייבי היפואלרגני',soft,'סנו','Default Title'),0);
 assert.deepEqual(distinctiveQualifiers('מרכך מקסימה בייבי היפואלרגני'),['בייבי','היפואלרגני']);
 assert.deepEqual(distinctiveQualifiers("ג'ל כביסה מקסימה Blue Blossom"),['blue','blossom']);
});
test('Manufacturer metadata cannot supply a missing product qualifier',()=>{
 assert.equal(semanticScore('מרכך מקסימה בייבי','מרכך מקסימה Pure Love','בייבי','Default Title'),0);
});
test('Variant title can supply the requested qualifier',()=>{
 assert.equal(run([{...variant('1','מקסימה מרכך סופר'),variantTitle:'בייבי'}]).status,'matched');
});
test('Exact title stays decisive before qualifier scoring',()=>{
 const result=run([variant('1','מרכך מקסימה בייבי'),variant('2',soft)]);
 assert.equal(result.status,'matched');assert.equal(result.reason,'EXACT_TITLE_MATCH');assert.equal(result.confidence,1);
});
test('Qualifier agreement cannot override a product intent conflict',()=>{
 assert.equal(semanticScore('מרכך מקסימה בייבי',"מקסימה בייבי ג'ל כביסה",'סנו','Default Title'),0);
});
