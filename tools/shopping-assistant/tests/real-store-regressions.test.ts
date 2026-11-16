// Regressions from a real-store stress test of the shopping assistant. Catalog titles below are
// realistic fixtures, not live store data; searches are mocked (external HTTP is blocked).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProductMatcher} from '../src/shopping/matcher.js';
import {parseShoppingList} from '../src/shopping/parser.js';
import {QuoteService} from '../src/shopping/quote-service.js';
import {coreQueries,distinctiveQualifiers,expandQueries,normalizeHebrewQuery,semanticScore} from '../src/shopping/hebrew-query.js';
import {detectProductIntent,detectQueryIntent,standaloneIntent} from '../src/shopping/product-intent.js';
import {splitNegations} from '../src/shopping/vocabulary.js';
import {FakeShop,variant} from './fixtures.js';
import type {CatalogVariant,SearchResults} from '../src/domain/types.js';

const matcher=new ProductMatcher();
const score=(query:string,title:string)=>semanticScore(query,title,'',"Default Title");
const match=(query:string,rows:CatalogVariant[],truncated=false)=>matcher.match(parseShoppingList(query)[0],{variants:rows,truncated});
const off=(row:CatalogVariant)=>({...row,availableForSale:false});

// 1. Explicit negative phrases
test('A product that says it does not contain the requested product never matches it',()=>{
 assert.equal(score('אקונומיקה',"אוקסיג'ן מסיר כתמים ללא אקונומיקה"),0);
 const result=match('אקונומיקה',[variant('1','סנו אקונומיקה 4 ליטר'),variant('2',"אוקסיג'ן מסיר כתמים ללא אקונומיקה")]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.title,'סנו אקונומיקה 4 ליטר');
 assert.ok(result.candidates.every(c=>!c.title.includes('ללא')));
});
for(const negation of ['ללא','בלי','אינו מכיל','אינה מכילה','וללא','לא מכיל']){
 test('Generic negation pattern excludes the requested core: '+negation,()=>{
  // Unknown product types: exclusion comes from the negation itself, not from a type conflict.
  assert.equal(score('אקונומיקה','תרסיס רב שימושי '+negation+' אקונומיקה'),0);
  assert.equal(score('אלכוהול','מגבונים לחים '+negation+' אלכוהול'),0);
  assert.equal(score('גאוול','תרסיס רב שימושי '+negation+' אקונומיקה'),0,'aliases of the negated product also count');
 });
}
test('Negating something else keeps the product relevant',()=>{
 assert.ok(score('אקונומיקה','סנו אקונומיקה ללא ריח')>=0.85);
 assert.ok(score('מרכך כביסה','מקסימה מרכך כביסה ללא בושם')>=0.85);
});
test('Negated objects do not decide the product type',()=>{
 assert.equal(detectProductIntent("אוקסיג'ן מסיר כתמים ללא אקונומיקה"),'UNKNOWN');
 assert.deepEqual(splitNegations(normalizeHebrewQuery('מגבונים ללא נוזל כלים ובלי בושם')),{positive:'מגבונים',negated:['נוזל כלים','בושם']});
});
test('A customer exclusion removes products containing it and prefers products stating it',()=>{
 const result=match('מסיר כתמים ללא אקונומיקה',[variant('1','מסיר כתמים עם אקונומיקה'),variant('2',"אוקסיג'ן מסיר כתמים ללא אקונומיקה")]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('2').variantId);
});

// 2. Core intent versus soft preferences
test('Soft scent wishes are not mandatory title words',()=>{
 assert.deepEqual(distinctiveQualifiers('מרכך כביסה עם ריח חזק'),[]);
 assert.deepEqual(distinctiveQualifiers('חומר לניקוי רצפה בריח נעים'),[]);
 assert.deepEqual(distinctiveQualifiers('סבון ידיים ריח טוב'),[]);
 assert.ok(score('מרכך כביסה עם ריח חזק','מקסימה מרכך כביסה לבנדר')>=0.85);
 assert.ok(score('חומר לניקוי רצפה בריח נעים','ריצפז פרש הום בניחוח לבנדר')>=0.85);
});
test('A unique relevant product matches although it does not mention the soft wish',()=>{
 const result=match('מרכך כביסה עם ריח חזק',[variant('1','מקסימה מרכך כביסה לבנדר'),variant('2','כיף מרכך לשיער יבש')]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('1').variantId);
 const floor=match('חומר לניקוי רצפה בריח נעים',[variant('1','ריצפז פרש הום בניחוח לבנדר'),variant('2','ריצפז מטליות לחות לרצפה בייבי')]);
 assert.equal(floor.status,'matched');assert.equal(floor.bestMatch?.variantId,variant('1').variantId);
});
test('Soft wishes only order comparable products',()=>{
 const result=match('מרכך כביסה עם ריח חזק',[variant('1','מקסימה מרכך כביסה לבנדר'),variant('2','מקסימה מרכך כביסה ריח חזק במיוחד')]);
 assert.equal(result.status,'ambiguous');assert.equal(result.candidates[0].variantId,variant('2').variantId);
 assert.equal(result.candidates.length,2);
});
test('Meaningful qualifiers and brands keep their existing weight next to soft wishes',()=>{
 assert.equal(score('מרכך כביסה לבנדר עם ריח חזק','מקסימה מרכך כביסה פריחת אביב'),0);
 assert.ok(score('מרכך כביסה מקסימה עם ריח נעים','מרכך כביסה אחר לבנדר')<0.65);
});
test('A stated size narrows only when a relevant product states it',()=>{
 const bags=[variant('1',"שקיות אשפה ענק 75X90"),variant('2',"אשפתונים עם שרוך")];
 assert.equal(match('שקיות אשפה גדולות',bags).status,'ambiguous');
 const sized=match('שקיות אשפה גדולות',[...bags,variant('3','שקיות אשפה גדולות 50 יח')]);
 assert.equal(sized.status,'matched');assert.equal(sized.bestMatch?.variantId,variant('3').variantId);
 const product={...variant('4','ריצפז פרש הום בניחוח לבנדר'),variantTitle:'קטן'};
 const variants=[product,{...product,variantId:'gid://shopify/ProductVariant/5',variantTitle:'גדול'}];
 // Several meaningful variants still require selection (existing rule); the wish narrows the choice.
 assert.deepEqual(match('ריצפז לבנדר גדול',variants).candidates.map(c=>c.variantTitle),['גדול']);
});

// 3. Natural Hebrew aliases
const ALIASES:Record<string,string[]>={
 GLASS_CLEANER:['מנקה חלונות','חומר לחלונות','מנקה זכוכיות','ספריי חלונות','ספריי לניקוי חלונות'],
 PAPER_TOWELS:['נייר סופג','מגבות נייר','גליל מטבח','גלילי מטבח','מגבות נייר למטבח'],
 TRASH_BAGS:['שקיות אשפה','שקיות זבל','שקיות לפח','אשפתונים','שקיות אשפה גדולות'],
 HAND_SOAP:['סבון ידיים','סבון לידיים','סבון נוזלי','סבון נוזלי לידיים'],
 DISH_SPONGE:['ספוג לכלים','ספוג כלים','ספוגי כלים',"סקוץ'","סקוצ'",'כרית ניקוי','כריות ניקוי','ספוגים לכלים'],
 DEGREASER:['מסיר שומנים','מסיר שומנים למטבח','חומר מסיר שומנים','מנקה שומנים','חומר לניקוי שומנים'],
};
for(const [intent,aliases] of Object.entries(ALIASES))test('Hebrew aliases are one concept: '+intent,()=>{
 for(const alias of aliases)assert.equal(detectQueryIntent(alias),intent,alias);
});
const TITLES:[string,string][]=[
 ['ספריי לניקוי חלונות','סנו קליר מנקה חלונות וזכוכית'],['מגבות נייר למטבח','לילי נייר סופג 6 גלילים'],
 ['שקיות אשפה גדולות',"שקיות זבל ענק 75X90"],['סבון ידיים','כיף סבון נוזלי לידיים אלוורה'],
 ['ספוגים לכלים',"סקוץ' ברייט כרית ניקוי"],['מסיר שומנים למטבח','סנו מסיר שומן'],['חומר לניקוי אסלות','סנו מנקה אסלות ג׳ל'],
];
for(const [query,title] of TITLES)test('Customer wording matches catalog wording: '+query,()=>{
 const result=match(query,[variant('1',title)]);
 assert.equal(result.status,'matched');assert.ok(result.confidence>=0.85);
});
test('Aliases keep related product types apart and the thresholds unchanged',()=>{
 assert.equal(score('נייר טואלט','לילי נייר סופג 6 גלילים'),0);
 assert.equal(score('מגבות נייר למטבח','לילי נייר טואלט 32 גלילים'),0);
 assert.equal(score('סבון ידיים','פיירי נוזל כלים לימון'),0);
 assert.equal(score('ספוגים לכלים','פיירי נוזל כלים לימון'),0);
 // A different kind of sponge is not made relevant by the alias work.
 assert.equal(match('ספוגים לכלים',[variant('1','ספוג קסם גדול')]).status,'not_found');
 assert.equal(match('שקיות אשפה',[variant('1','מגבונים לחים')]).status,'not_found');
});

// 4. Hair conditioner versus fabric softener
test('Hair conditioner and fabric softener are separate intents',()=>{
 for(const text of ['מרכך שיער','מרכך שיער כיף','מרכך לשיער','קונדישינר','כיף מרכך לשיער יבש ופגום'])assert.equal(detectQueryIntent(text),'HAIR_CONDITIONER',text);
 for(const text of ['מרכך כביסה','מרכך','מרכך לבגדים','מקסימה סופר מרוכז מרכך בייבי'])assert.equal(detectQueryIntent(text),'FABRIC_SOFTENER',text);
 assert.equal(detectQueryIntent('שמפו כיף'),'SHAMPOO');assert.equal(detectQueryIntent('תחליב רחצה כיף'),'BODY_WASH');
});
test('Kef hair conditioner matches and laundry softener never does',()=>{
 const rows=[variant('1','מקסימה מרכך כביסה לבנדר'),variant('2','כיף מרכך לשיער יבש ופגום'),variant('3','מקסימה סופר מרוכז מרכך בייבי'),variant('4','כיף שמפו לשיער יבש ופגום')];
 const result=match('מרכך שיער כיף',rows);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.variantId,variant('2').variantId);
 for(const title of ['מקסימה מרכך כביסה לבנדר','מקסימה סופר מרוכז מרכך בייבי'])assert.equal(score('מרכך שיער כיף',title),0);
 assert.equal(score('מרכך כביסה','כיף מרכך לשיער יבש ופגום'),0);
 assert.equal(match('שמפו כיף',rows).bestMatch?.variantId,variant('4').variantId);
});
test('Alias expansion never turns a hair request into a laundry search',()=>{
 const queries=expandQueries('מרכך שיער כיף');
 assert.ok(queries.includes('מרכך כיף'));assert.ok(queries.every(q=>!q.includes('כביסה')&&!q.includes('fabric')),queries.join(' | '));
});

// 5. Compound shopping-list items
const names=(text:string)=>parseShoppingList(text).map(i=>i.requestedName);
test('A shared modifier with two independent products becomes two items',()=>{
 for(const text of ['חד פעמי – כוסות וצלחות','חד פעמי: כוסות, צלחות','חד פעמי - כוסות וצלחות'])
  assert.deepEqual(names(text),['כוסות חד פעמי','צלחות חד פעמי'],text);
 const items=parseShoppingList('2 חד פעמי – כוסות וצלחות');
 assert.deepEqual(items.map(i=>[i.originalText,i.quantity]),[['2 כוסות חד פעמי',2],['2 צלחות חד פעמי',2]]);
});
test('Coordinated nouns split only when both sides are independent products',()=>{
 assert.deepEqual(names('כוסות וצלחות'),['כוסות','צלחות']);
 assert.deepEqual(names('מרכך כביסה ואבקת כביסה'),['מרכך כביסה','אבקת כביסה']);
 assert.deepEqual(parseShoppingList('2 כוסות ו3 צלחות').map(i=>[i.requestedName,i.quantity]),[['כוסות',2],['צלחות',3]]);
 for(const text of ['שמפו לשיער יבש ופגום','שמפו וניל','שמפו ומרכך','מנקה חלונות וזכוכיות','סבון ידיים וגוף'])
  assert.equal(parseShoppingList(text).length,1,text);
 assert.equal(standaloneIntent('מרכך'),'UNKNOWN');
});
test('List labels and product-scent headers keep the previous parsing',()=>{
 assert.deepEqual(names('ניקיון: אקונומיקה, ריצפז'),['ניקיון אקונומיקה','ריצפז']);
 assert.deepEqual(names('ריצפז - לבנדר'),['ריצפז לבנדר']);
 assert.deepEqual(names('ג׳ל-כביסה בייבי'),['גל כביסה בייבי']);
});
test('Split items rebuild into the same list after edit or removal',()=>{
 const items=parseShoppingList('חד פעמי – כוסות וצלחות\nאקונומיקה');
 assert.deepEqual(parseShoppingList(items.map(i=>i.originalText).join('\n')),items);
 assert.deepEqual(names(items.filter((_,i)=>i!==0).map(i=>i.originalText).join('\n')),['צלחות חד פעמי','אקונומיקה']);
 assert.throws(()=>parseShoppingList(Array(10).fill('כוסות וצלחות').concat('אקונומיקה').join('\n')),{code:'TOO_MANY_ITEMS'});
});

// 6. Availability-aware ranking
test('Among comparable products the purchasable one ranks first',()=>{
 const result=match('מטליות לניקוי',[off(variant('1','מטליות ניקוי מיקרופייבר')),off(variant('2','מטליות לניקוי כללי לחות')),
  off(variant('3','מטליות ניקוי לחות')),variant('4','מטליות ניקוי רב שימושיות')]);
 assert.equal(result.status,'ambiguous');assert.equal(result.candidates[0].variantId,variant('4').variantId);
 assert.equal(result.candidates.length,4);assert.equal(result.bestMatch,undefined);
});
test('Availability decides near-equal relevance, not large relevance gaps',()=>{
 // UNKNOWN intent: plain coverage, 1.0 for the full title.
 const near=match('חומר נוזל alpha',[off(variant('1','alpha חומר נוזל')),variant('2','alpha חומר')]);
 assert.equal(near.candidates[0].variantId,variant('2').variantId);
 const far=match('חומר נוזל alpha',[off(variant('1','alpha חומר נוזל')),variant('2','alpha')]);
 assert.equal(far.candidates[0].variantId,variant('1').variantId);
});
test('No available relevant product keeps the all-unavailable state; irrelevant stock is never chosen',()=>{
 const result=match('אקונומיקה',[off(variant('1','סנו אקונומיקה 4 ליטר')),off(variant('2','סנו אקונומיקה לימון')),variant('3','ריצפז פרש הום בניחוח לבנדר')]);
 assert.equal(result.status,'unavailable');assert.equal(result.reason,'ALL_RELEVANT_MATCHES_UNAVAILABLE');
 assert.ok(result.candidates.every(c=>c.title.includes('אקונומיקה')));
});

// Specializations: relevant, but after generic products of the requested type.
const toiletBleach="סנו אקונומיקה ג'ל לאסלה";
test('Toilet-specific bleach is a specialization of bleach, not a conflict',()=>{
 const special=score('אקונומיקה',toiletBleach),generic=score('אקונומיקה','סנו אקונומיקה 4 ליטר');
 assert.ok(special>=0.65&&special<0.85,'relevant but never an automatic match: '+special);
 assert.ok(generic-special>0.1,'gap exceeds the availability margin');
 assert.equal(score('אקונומיקה',"אוקסיג'ן מסיר כתמים ללא אקונומיקה"),0,'negation stays a hard conflict');
 // The specialization still serves toilet requests normally.
 assert.ok(score('חומר לניקוי אסלות',toiletBleach)>=0.85);
 assert.equal(match('אקונומיקה לאסלה',[variant('1','סנו אקונומיקה 4 ליטר'),variant('2',toiletBleach)]).bestMatch?.title,toiletBleach);
 // A toilet cleaner that does not name bleach is still a different product.
 assert.equal(score('אקונומיקה','סנו מנקה אסלות ג׳ל אורן'),0);
});
test('Generic bleach ranks above toilet bleach, even when only the toilet bleach is in stock',()=>{
 const generic=[variant('1','סנו אקונומיקה 4 ליטר'),variant('2','סנו אקונומיקה לימון')];
 for(const rows of [[variant('3',toiletBleach),...generic],[variant('3',toiletBleach),...generic.map(off)]]){
  const result=match('אקונומיקה',rows);
  assert.equal(result.status,'ambiguous');
  assert.deepEqual(result.candidates.map(c=>c.title).slice(0,2).sort(),generic.map(g=>g.title).sort());
  assert.equal(result.candidates.at(-1)?.title,toiletBleach);
 }
});
test('Without generic bleach a toilet bleach is offered for selection, not chosen automatically',()=>{
 const result=match('אקונומיקה',[variant('1',toiletBleach),variant('2','ריצפז פרש הום בניחוח לבנדר')]);
 assert.equal(result.status,'ambiguous');assert.equal(result.bestMatch,undefined);
 assert.deepEqual(result.candidates.map(c=>c.title),[toiletBleach]);
});
test('General cleaning cloths rank above floor wipes; wipes stay valid broader candidates',()=>{
 const wipes=variant('1','ריצפז מטליות לחות לרצפה בייבי'),cloth=variant('2','מטליות ניקוי רב שימושיות');
 for(const rows of [[wipes,cloth],[wipes,off(cloth)]]){
  const result=match('מטליות לניקוי',rows);
  assert.deepEqual(result.candidates.map(c=>c.title),[cloth.title,wipes.title]);
 }
 const only=match('מטליות לניקוי',[wipes]);
 assert.equal(only.status,'ambiguous');assert.deepEqual(only.candidates.map(c=>c.title),[wipes.title]);
 // Floor-wipe requests are unaffected.
 assert.equal(match('מטליות לרצפה',[wipes]).status,'matched');
});

// 7. Shopify candidate retrieval
test('Retrieval forms drop soft wishes and filler and use catalog type wording',()=>{
 assert.deepEqual(coreQueries('מרכך כביסה עם ריח חזק'),['מרכך כביסה','מרכך']);
 assert.deepEqual(coreQueries('חומר לניקוי רצפה בריח נעים'),['ריצפז','נוזל רצפות']);
 assert.deepEqual(coreQueries('מרכך שיער כיף'),['מרכך שיער כיף','מרכך כיף']);
 assert.equal(coreQueries('שקיות אשפה גדולות')[0],'שקיות אשפה');
 assert.equal(coreQueries('מרכך מקסימה בייבי')[0],'מרכך כביסה מקסימה בייבי');
 for(const query of ['מרכך כביסה עם ריח חזק','ספריי לניקוי חלונות','ספוגים לכלים','מגבות נייר למטבח']){
  const queries=expandQueries(query);assert.ok(queries.length<=4);assert.equal(new Set(queries).size,queries.length);
  assert.ok(queries.includes(coreQueries(query)[0]),query);
 }
});
// Shopify-like search: every term must prefix a title or vendor word; 8 products per page.
class CatalogShop extends FakeShop {
 seen:string[]=[];
 constructor(private catalog:CatalogVariant[]){super();this.rows=catalog;}
 override async search(name:string):Promise<SearchResults>{
  this.seen.push(name);
  const words=(s:string)=>s.normalize('NFKC').replace(/[״׳"']/g,'').replace(/[^\p{L}\p{N}\s]/gu,' ').toLowerCase().split(/\s+/).filter(Boolean);
  const terms=words(name),hits=this.catalog.filter(v=>terms.every(t=>words(v.title+' '+v.vendor).some(w=>w.startsWith(t))));
  return {variants:hits.slice(0,8),truncated:hits.length>8};
 }
}
const CATALOG=[
 ["מקסימה בייבי ג'ל כביסה",true],["מקסימה בייבי ג'ל כביסה היפואלרגני",false],['מקסימה סופר מרוכז מרכך בייבי',true],
 ['מקסימה מרכך כביסה לבנדר',true],['מקסימה מרכך כביסה פריחת אביב',false],['סנו אקונומיקה 4 ליטר',true],['סנו אקונומיקה ג׳ל לימון',false],
 ["אוקסיג'ן מסיר כתמים ללא אקונומיקה",true],['סנו קליר מנקה חלונות וזכוכית',true],['ריצפז פרש הום בניחוח לבנדר',true],
 ['ריצפז פרש הום בניחוח מלון בוטיק',true],['ריצפז מטליות לחות לרצפה בייבי',true],['לילי נייר טואלט 32 גלילים',true],['לילי נייר סופג 6 גלילים',true],
 ["שקיות אשפה ענק 75X90 20 יח'",true],["אשפתונים עם שרוך 30 יח'",true],['כיף סבון נוזלי לידיים אלוורה',true],['כיף שמפו לשיער יבש ופגום',true],
 ['כיף מרכך לשיער יבש ופגום',true],['כיף תחליב רחצה אלוורה',true],["סקוץ' ברייט ספוג לכלים 3 יח'",true],["כריות ניקוי לכלים 10 יח'",false],
 ["מטליות ניקוי מיקרופייבר 3 יח'",false],['מטליות לניקוי כללי לחות',false],["מטליות ניקוי רב שימושיות 5 יח'",true],
 ["כוסות חד פעמיות שקופות 50 יח'",true],["צלחות חד פעמיות גדולות 20 יח'",true],['סנו מנקה אסלות ג׳ל אורן',true],['סנו מסיר שומנים למטבח',true],
].map(([title,available],i)=>({...variant(String(i+1),title as string),availableForSale:available as boolean}));
const EXPECTED:[string,string,string?][]=[
 ['ג׳ל כביסה מקסימה בייבי','ambiguous',"מקסימה בייבי ג'ל כביסה"],['מרכך כביסה עם ריח חזק','ambiguous'],['אקונומיקה','ambiguous','סנו אקונומיקה 4 ליטר'],
 ['ספריי לניקוי חלונות','matched','סנו קליר מנקה חלונות וזכוכית'],['חומר לניקוי רצפה בריח נעים','ambiguous'],['נייר טואלט','matched','לילי נייר טואלט 32 גלילים'],
 ['מגבות נייר למטבח','matched','לילי נייר סופג 6 גלילים'],['שקיות אשפה גדולות','matched',"שקיות אשפה ענק 75X90 20 יח'"],
 ['סבון ידיים','matched','כיף סבון נוזלי לידיים אלוורה'],['שמפו כיף','matched','כיף שמפו לשיער יבש ופגום'],['מרכך שיער כיף','matched','כיף מרכך לשיער יבש ופגום'],
 ['תחליב רחצה כיף','matched','כיף תחליב רחצה אלוורה'],['ספוגים לכלים','matched',"סקוץ' ברייט ספוג לכלים 3 יח'"],
 ['מטליות לניקוי','ambiguous',"מטליות ניקוי רב שימושיות 5 יח'"],['חומר לניקוי אסלות','matched','סנו מנקה אסלות ג׳ל אורן'],['מסיר שומנים למטבח','matched','סנו מסיר שומנים למטבח'],
];
for(const [query,status,first] of EXPECTED)test('Catalog regression: '+query,async()=>{
 const shop=new CatalogShop(CATALOG),quote=await new QuoteService(shop).create(query),[item]=quote.items;
 assert.equal(quote.items.length,1);assert.equal(item.status,status,query+': '+item.reason);
 if(first)assert.equal((item.bestMatch||item.candidates[0]).title,first);
 assert.ok(shop.seen.length<=4);
 assert.ok(item.candidates.every(c=>!c.title.includes('ללא אקונומיקה')&&!(query.includes('שיער')&&c.title.includes('כביסה'))));
 // Ambiguous candidate lists put purchasable products before unavailable ones of equal relevance.
 if(status==='ambiguous')assert.equal(item.candidates[0].availableForSale,true);
});
test('Catalog regression: חד פעמי – כוסות וצלחות',async()=>{
 const quote=await new QuoteService(new CatalogShop(CATALOG)).create('חד פעמי – כוסות וצלחות');
 assert.deepEqual(quote.items.map(i=>[i.requested.originalText,i.status,i.bestMatch?.title]),[
  ['כוסות חד פעמי','matched',"כוסות חד פעמיות שקופות 50 יח'"],['צלחות חד פעמי','matched',"צלחות חד פעמיות גדולות 20 יח'"]]);
});
test('A non-exact unavailable result keeps searching; an exactly named product stops',async()=>{
 const shop=new CatalogShop(CATALOG),quote=await new QuoteService(shop).create('מטליות לניקוי');
 assert.ok(shop.seen.length>1);assert.ok(quote.items[0].candidates.some(c=>c.availableForSale));
 const exact=new CatalogShop(CATALOG);await new QuoteService(exact).create('מטליות לניקוי כללי לחות');
 assert.equal(exact.seen.length,1);
});
test('Debug diagnostics separate never-retrieved from retrieved-but-scored-out candidates',async()=>{
 const logs:any[]=[],original=console.info;console.info=(...args:unknown[])=>{logs.push(args);};
 try{await new QuoteService(new CatalogShop(CATALOG),undefined,Date.now,true).create('אקונומיקה');}finally{console.info=original;}
 const entry=logs[0][1];
 assert.ok(Array.isArray(entry.searches)&&entry.searches.every((s:any)=>typeof s.variants==='number'));
 const excluded=entry.candidates.find((c:any)=>c.score===0);
 assert.equal(excluded.retrievedBy,0);assert.equal(typeof excluded.available,'boolean');
});

// Real-catalog regression 1: bare "מרכך" titles are not fabric softeners by default.
const KEF_CONDITIONER='כיף מרכך לחות מוגברת אפרסק וחמאת מורומורו',NEKA_CONDITIONER='מרכך עם שמני הזנה נקה 7';
const LAUNDRY_SOFTENER='מרכך מרוכז מתאים למכונת כביסה פריחת האביב';
const scored=(query:string,title:string,productType?:string)=>semanticScore(query,title,'','Default Title',productType);
test('Bare "מרכך" titles are classified from title context, product type or brand family, never by default',()=>{
 assert.equal(detectProductIntent(KEF_CONDITIONER),'HAIR_CONDITIONER','brand family is the last signal');
 assert.equal(detectProductIntent(NEKA_CONDITIONER),'UNKNOWN','no signal: unknown, not fabric softener');
 assert.equal(detectProductIntent({title:NEKA_CONDITIONER,productType:'מרכך שיער'}),'HAIR_CONDITIONER');
 assert.equal(detectProductIntent({title:NEKA_CONDITIONER,productType:'Hair conditioner'}),'HAIR_CONDITIONER');
 assert.equal(detectProductIntent({title:KEF_CONDITIONER,productType:'מרכך כביסה'}),'FABRIC_SOFTENER','metadata outranks brand family');
 assert.equal(detectProductIntent(LAUNDRY_SOFTENER),'FABRIC_SOFTENER');
 assert.equal(detectProductIntent('מקסימה סופר מרוכז מרכך בייבי'),'FABRIC_SOFTENER');
});
test('A laundry softener request excludes real-catalog hair conditioners',()=>{
 assert.equal(scored('מרכך כביסה עם ריח חזק',KEF_CONDITIONER),0);
 assert.ok(scored('מרכך כביסה עם ריח חזק',NEKA_CONDITIONER)<0.65,'unknown type no longer covers the laundry wording');
 assert.equal(scored('מרכך כביסה עם ריח חזק',NEKA_CONDITIONER,'מרכך שיער'),0);
 assert.ok(scored('מרכך כביסה עם ריח חזק',LAUNDRY_SOFTENER)>=0.85);
 const result=match('מרכך כביסה עם ריח חזק',[variant('1',KEF_CONDITIONER),variant('2',NEKA_CONDITIONER),variant('3',LAUNDRY_SOFTENER)]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.title,LAUNDRY_SOFTENER);
});
test('A hair conditioner request matches the real-catalog Kef conditioner and never laundry softener',()=>{
 assert.ok(scored('מרכך שיער כיף',KEF_CONDITIONER)>=0.85);
 assert.equal(scored('מרכך שיער כיף',LAUNDRY_SOFTENER),0);
 assert.equal(scored('מרכך שיער',LAUNDRY_SOFTENER,'מרכך כביסה'),0);
 const result=match('מרכך שיער כיף',[variant('1',KEF_CONDITIONER),variant('2',LAUNDRY_SOFTENER)]);
 assert.equal(result.status,'matched');assert.equal(result.bestMatch?.title,KEF_CONDITIONER);
});

// Real-catalog regression 3: sponge word forms with dish context are one dish-sponge family.
test('ספוג / ספוגים / ספוגית / ספוגיות with dish context are dish sponges',()=>{
 for(const title of ['ספוגיות לניקוי כלים','ספוגית לניקוי כלים','ספוג לכלים','ספוגים לכלים'])
  assert.equal(detectProductIntent({title,productType:'ניקוי כלים'}),'DISH_SPONGE',title);
 assert.equal(scored('ספוגים לכלים','ספוגיות לניקוי כלים','ניקוי כלים'),1);
 assert.equal(scored('ספוג לכלים','ספוגית לניקוי כלים','ניקוי כלים'),1);
});
test('The real unavailable dish sponge is reported as unavailable, not rejected',()=>{
 const result=match('ספוגים לכלים',[off({...variant('1','ספוגיות לניקוי כלים'),productType:'ניקוי כלים'})]);
 assert.equal(result.status,'unavailable');assert.equal(result.reason,'ALL_RELEVANT_MATCHES_UNAVAILABLE');
 assert.equal(result.candidates[0].title,'ספוגיות לניקוי כלים');
});
test('The shared "ניקוי כלים" product type does not make other dish products sponges',()=>{
 const liquid={title:'פיירי נוזל לניקוי כלים לימון',productType:'ניקוי כלים'};
 const capsules={title:'קפסולות למדיח כלים הכל באחד 40 יח',productType:'ניקוי כלים'};
 assert.equal(detectProductIntent(liquid),'DISH_SOAP');assert.equal(detectProductIntent(capsules),'UNKNOWN');
 for(const p of [liquid,capsules])assert.ok(scored('ספוגים לכלים',p.title,p.productType)<0.65,p.title);
 const result=match('ספוגים לכלים',[{...variant('1',liquid.title),productType:liquid.productType},{...variant('2',capsules.title),productType:capsules.productType}]);
 assert.equal(result.status,'not_found');
});
test('Personal-care sponges are not dish sponges',()=>{
 for(const title of ['בוב ספוג ספוג רחצה לילדים','ספוג רחצה בוב ספוג','בוב ספוג שמפו לילדים']){
  assert.notEqual(detectProductIntent(title),'DISH_SPONGE',title);
  assert.ok(scored('ספוגים לכלים',title)<0.65,title);
 }
 assert.equal(match('ספוגים לכלים',[variant('1','בוב ספוג ספוג רחצה לילדים')]).status,'not_found');
});

test('Generic and body אל-סבון products are not hand soap; explicit hand soap still is',()=>{
 for(const title of ['אל-סבון נוזלי לגוף','כיף אל סבון','כיף סבון רחצה אלוורה']){
  assert.notEqual(detectProductIntent(title),'HAND_SOAP',title);
  assert.ok(scored('סבון ידיים',title)<0.65,title);
 }
 assert.equal(detectProductIntent('כיף סבון נוזלי לידיים אלוורה'),'HAND_SOAP');
 assert.equal(detectQueryIntent('סבון נוזלי'),'HAND_SOAP');
});

// Real-catalog regression 2: availability ordering must not hide unavailable exact matches.
// Shopify-like search: products matching any term, more matched terms first, eight per page;
// availableFirst lists unavailable products last (unavailableProducts: LAST).
class RankedShop extends FakeShop {
 calls:{query:string;availableFirst:boolean}[]=[];
 constructor(private catalog:CatalogVariant[]){super();this.rows=catalog;}
 override async search(name:string,_buyer?:unknown,options:{availableFirst?:boolean}={}):Promise<SearchResults>{
  this.calls.push({query:name,availableFirst:!!options.availableFirst});
  const words=(s:string)=>normalizeHebrewQuery(s).split(' ');
  const terms=words(name),hits=this.catalog.map(v=>({v,n:terms.filter(t=>words(v.title).some(w=>w.startsWith(t))).length}))
   .filter(h=>h.n>0).sort((a,b)=>b.n-a.n).map(h=>h.v);
  const ordered=options.availableFirst?[...hits.filter(v=>v.availableForSale),...hits.filter(v=>!v.availableForSale)]:hits;
  return {variants:ordered.slice(0,8),truncated:ordered.length>8};
 }
}
const kefOthers=['כיף מרכך לשיער יבש','כיף מרכך לחות מוגברת','כיף תחליב רחצה אלוורה','כיף תחליב רחצה וניל','כיף סבון נוזלי לידיים',
 'כיף סבון רחצה','כיף ג׳ל רחצה לגבר','כיף מרכך לשיער רגיל'].map((title,i)=>variant(String(i+1),title));
const kefShampoos=['כיף שמפו לשיער יבש ופגום','כיף שמפו לשיער רגיל'].map((title,i)=>off(variant(String(i+20),title)));
test('Eight available same-brand products of other types do not hide unavailable exact shampoos',async()=>{
 const shop=new RankedShop([...kefOthers,...kefShampoos]);
 // The failure mode: with unavailable products last, the first page has no shampoo at all.
 assert.ok((await shop.search('שמפו כיף',undefined,{availableFirst:true})).variants.every(v=>!v.title.includes('שמפו')));
 shop.calls=[];
 const [item]=(await new QuoteService(shop).create('שמפו כיף')).items;
 assert.equal(item.status,'unavailable');assert.equal(item.reason,'ALL_RELEVANT_MATCHES_UNAVAILABLE');
 assert.deepEqual(item.candidates.map(c=>c.title).sort(),kefShampoos.map(v=>v.title).sort());
 assert.equal(shop.calls[0].availableFirst,false,'semantic retrieval keeps relevance order');
 assert.ok(shop.calls.length<=5,'bounded: four relevance searches plus at most one availability probe');
});
test('When every relevant result is unavailable and cut off, one probe finds an available relevant product',async()=>{
 const unavailable=Array.from({length:9},(_,i)=>off(variant(String(i+40),'שמפו כיף לשיער גרסה '+(i+1))));
 const available=variant('60','שמפו לשיער כיף רגיל');
 const shop=new RankedShop([...unavailable,available,...kefOthers]);
 const original=shop.search.bind(shop);
 // Relevance order puts the available shampoo after the nine unavailable ones.
 shop.search=async(name,buyer,options={})=>{
  const result=await original(name,buyer,options);
  return options.availableFirst?result:{...result,variants:result.variants.filter(v=>v.variantId!==available.variantId)};
 };
 const [item]=(await new QuoteService(shop).create('שמפו כיף')).items;
 assert.equal(item.status,'ambiguous');assert.equal(item.candidates[0].variantId,available.variantId);
 assert.equal(shop.calls.filter(c=>c.availableFirst).length,1);
 assert.ok(item.candidates.every(c=>c.title.includes('שמפו')),'the probe adds no irrelevant products');
});

// Local diagnostics: raw catalog titles only with an explicit local opt-in.
test('Raw product titles are logged only when explicitly enabled outside production',async()=>{
 const {configFromEnv}=await import('../src/config.js');
 const base={SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPPING_ASSISTANT_DEBUG:'true',SHOPPING_ASSISTANT_DEBUG_RAW_PRODUCT_TITLES:'true'};
 assert.equal(configFromEnv({...base,NODE_ENV:'development'}).debugRawProductTitles,true);
 assert.equal(configFromEnv({...base,NODE_ENV:'production',ALLOWED_ORIGINS:'https://fanakee.com'}).debugRawProductTitles,false);
 assert.equal(configFromEnv({...base,NODE_ENV:'development',SHOPPING_ASSISTANT_DEBUG:'false'}).debugRawProductTitles,false);
 assert.equal(configFromEnv({...base,NODE_ENV:'development',SHOPPING_ASSISTANT_DEBUG_RAW_PRODUCT_TITLES:undefined}).debugRawProductTitles,false);
 const run=async(raw:boolean)=>{
  const logs:unknown[]=[],original=console.info;console.info=(...args:unknown[])=>{logs.push(args);};
  try{
   const quote=await new QuoteService(new CatalogShop(CATALOG),undefined,()=>0,true,{rawProductTitles:raw}).create('ספוגים לכלים\nשמפו alice@example.com 0541234567 test');
   return {logs:JSON.stringify(logs),quote:{...quote,quoteId:'x'}};
  }finally{console.info=original;}
 };
 const redacted=await run(false),raw=await run(true);
 const fullTitle="סקוץ' ברייט ספוג לכלים 3 יח'";
 assert.ok(raw.logs.includes(fullTitle));assert.ok(!redacted.logs.includes(fullTitle)&&redacted.logs.includes('[redacted]'));
 for(const logs of [raw.logs,redacted.logs]){
  assert.ok(!logs.includes('alice')&&!logs.includes('0541234567'),'customer text keeps its redaction');
  assert.ok(!logs.includes('gid://')&&!logs.includes('https://'),'no IDs or URLs');
 }
 assert.deepEqual(raw.quote,redacted.quote,'API response is unchanged');
});
