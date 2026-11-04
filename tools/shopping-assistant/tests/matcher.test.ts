import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {parseShoppingList} from '../src/shopping/parser.js';
import {variant} from './fixtures.js';
import type {CatalogVariant,SearchResults} from '../src/domain/types.js';

const matcher=new ProductMatcher();
const title='ריצפז פרש הום בניחוח מלון בוטיק';
const product=()=>variant('1',title);
const match=(rows:CatalogVariant[],query=title,extra:Partial<SearchResults>={})=>
  matcher.match(parseShoppingList(query)[0],{variants:rows,truncated:true,...extra});

test('Exact normalized title outranks hasNextPage with unrelated candidates',()=>{
 const result=match([product(),variant('2',title+' גדול')],'  '+title+'! ');
 assert.equal(result.status,'matched');assert.equal(result.confidence,1);
 assert.equal(result.reason,'EXACT_TITLE_MATCH');assert.equal(result.bestMatch?.variantId,product().variantId);
});
test('Exact title with sole Default Title variant is decisive',()=>{
 const result=match([product()]);
 assert.equal(result.status,'matched');assert.equal(result.reason,'EXACT_TITLE_MATCH');
});
test('Two purchasable products with identical exact titles remain ambiguous',()=>{
 const result=match([product(),variant('2',title)]);
 assert.equal(result.status,'ambiguous');assert.equal(result.bestMatch,undefined);
 assert.equal(result.candidates.length,2);
});
test('Partial query with multiple scents and paginated results remains ambiguous',()=>{
 const result=match([variant(),variant('2','מרכך מקסימה לבנדר')],'מרכך מקסימה');
 assert.equal(result.status,'ambiguous');assert.equal(result.reason,'RESULTS_TRUNCATED');
});
test('Weak single candidate cannot override pagination uncertainty',()=>{
 const result=match([variant('1','alpha other')],'חומר נוזל מוצר ניקוי alpha');
 assert.ok(result.confidence>=0.65&&result.confidence<0.85);
 assert.equal(result.status,'ambiguous');assert.equal(result.reason,'RESULTS_TRUNCATED');
});
test('Exact unavailable title is unavailable despite paginated results',()=>{
 const result=match([{...product(),availableForSale:false}]);
 assert.equal(result.status,'unavailable');assert.equal(result.confidence,1);
});
const sizes=()=>[
 {...product(),variantTitle:'קטן'},
 {...product(),variantId:'gid://shopify/ProductVariant/2',variantTitle:'גדול'}
];
test('Exact product title with unspecified meaningful variants remains ambiguous',()=>{
 assert.equal(match(sizes()).status,'ambiguous');
 assert.equal(match([sizes()[0],{...sizes()[1],availableForSale:false}]).status,'ambiguous');
});
test('Exact title plus specified variant outranks product pagination',()=>{
 const result=match(sizes(),title+' גדול');
 assert.equal(result.status,'matched');assert.equal(result.confidence,1);
 assert.equal(result.reason,'EXACT_TITLE_MATCH');assert.equal(result.bestMatch?.variantTitle,'גדול');
});
test('Requested exact unavailable variant does not select an available alternative',()=>{
 const rows=sizes();rows[1].availableForSale=false;
 assert.equal(match(rows,title+' גדול').status,'unavailable');
});
test('Incomplete variants of an exact product prevent automatic matching',()=>{
 const result=match([product()],title,{truncatedVariantProductIds:[product().productId]});
 assert.equal(result.status,'ambiguous');assert.equal(result.bestMatch,undefined);
});
test('Incomplete variants on an unrelated product do not block a decisive exact title',()=>{
 assert.equal(match([product(),variant('2','other')],title,{truncatedVariantProductIds:['gid://shopify/Product/2']}).status,'matched');
});
