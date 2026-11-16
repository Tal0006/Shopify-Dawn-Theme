import {memoize,normalize} from './text.js';

// Configuration for natural Hebrew matching. Data only plus the normalization that
// depends on it; product-intent.ts and hebrew-query.ts build their logic on top.

export type ProductIntent='FABRIC_SOFTENER'|'HAIR_CONDITIONER'|'SHAMPOO'|'BODY_WASH'|'HAND_SOAP'|'DISH_SOAP'|
 'LAUNDRY_DETERGENT'|'LAUNDRY_POWDER'|'BLEACH'|'FLOOR_CLEANER'|'FLOOR_WIPES'|'CLEANING_CLOTHS'|'GLASS_CLEANER'|
 'TOILET_CLEANER'|'DEGREASER'|'DISH_SPONGE'|'PAPER_TOWELS'|'TOILET_PAPER'|'TRASH_BAGS'|'CUPS'|'PLATES'|'UNKNOWN';
export type KnownIntent=Exclude<ProductIntent,'UNKNOWN'>;
export interface IntentDefinition {
 intent:KnownIntent;
 // Contiguous phrases. "a+b" means every word anywhere in the text (context words).
 aliases:readonly string[];
 // Aliases that need context to be reliable (bare "מרכך" is laundry or hair). They count
 // for detection, but do not make a list fragment an independent item on their own.
 contextual?:readonly string[];
 // Short retrieval phrases in common catalog wording, most useful first.
 search?:readonly string[];
 // A generic request for the parent also accepts this more specific type.
 parent?:KnownIntent;
 // A product of this type that also names one of these types as a product ("אקונומיקה ג'ל
 // לאסלה") is a specialized product of that type, not a conflicting one.
 variantOf?:readonly KnownIntent[];
}
export const PRODUCT_INTENTS:readonly IntentDefinition[]=[
 {intent:'FABRIC_SOFTENER',aliases:['מרכך כביסה','מרכך+כביסה','מרכך+בגדים','fabric softener'],contextual:['מרכך'],search:['מרכך כביסה','מרכך']},
 {intent:'HAIR_CONDITIONER',aliases:['מרכך שיער','מרכך+שיער','מרכך+שמפו','קונדישינר','conditioner','hair conditioner'],search:['מרכך שיער','מרכך']},
 {intent:'SHAMPOO',aliases:['שמפו','shampoo'],search:['שמפו']},
 {intent:'BODY_WASH',aliases:['תחליב רחצה','גל רחצה','סבון רחצה','סבון+גוף','body wash','shower gel'],search:['תחליב רחצה','גל רחצה']},
 {intent:'HAND_SOAP',aliases:['סבון ידיים','סבון+ידיים','סבון נוזלי','hand soap'],search:['סבון ידיים','סבון נוזלי']},
 {intent:'DISH_SOAP',aliases:['נוזל כלים','סבון כלים','נוזל+כלים','סבון+כלים','dish soap'],search:['נוזל כלים']},
 {intent:'LAUNDRY_DETERGENT',aliases:["ג'ל כביסה",'נוזל כביסה','laundry gel','liquid laundry detergent'],search:["ג'ל כביסה",'נוזל כביסה']},
 {intent:'LAUNDRY_POWDER',aliases:['אבקת כביסה','laundry powder','washing powder'],search:['אבקת כביסה']},
 {intent:'BLEACH',aliases:['אקונומיקה','javel',"ג'אוול",'גאול','מלבין','bleach'],search:['אקונומיקה']},
 {intent:'FLOOR_CLEANER',aliases:['חומר רצפה','חומר רצפות','חומר לרצפה','נוזל רצפה','נוזל רצפות','ריצפז','שוטף רצפות',
  'ניקוי רצפות','ניקוי+רצפות','מנקה רצפות','floor cleaner'],search:['ריצפז','נוזל רצפות']},
 {intent:'FLOOR_WIPES',aliases:['מטליות רצפה','מטליות רצפות','מטליות לרצפה','מטליות לחות לרצפה','מטליות לחות רצפה','floor wipes'],
  search:['מטליות רצפה'],parent:'CLEANING_CLOTHS'},
 {intent:'CLEANING_CLOTHS',aliases:['מטליות ניקוי','מטליות+ניקוי','סמרטוט','cleaning cloths'],contextual:['מטליות'],search:['מטליות ניקוי','מטליות']},
 {intent:'GLASS_CLEANER',aliases:['מנקה חלונות','מנקה זכוכית','חומר חלונות','ספריי חלונות','ניקוי חלונות','ניקוי+חלונות','סנו קליר',
  'glass cleaner','window cleaner'],search:['מנקה חלונות','חלונות']},
 {intent:'TOILET_CLEANER',aliases:['מנקה אסלות','ניקוי אסלות','ניקוי+אסלות',"ג'ל אסלות",'אקונומיקה+אסלות','toilet cleaner'],search:['מנקה אסלות','אסלות'],variantOf:['BLEACH']},
 {intent:'DEGREASER',aliases:['מסיר שומנים','מנקה שומנים','ניקוי שומנים','ניקוי+שומנים','מסיר שומנים מטבח','degreaser'],search:['מסיר שומנים']},
 {intent:'DISH_SPONGE',aliases:['ספוג כלים','ספוג+כלים','סקוץ','סקוץ ברייט','כרית ניקוי','scotch brite'],search:['ספוג כלים','ספוג','סקוץ']},
 {intent:'PAPER_TOWELS',aliases:['מגבות נייר','נייר סופג','גליל מטבח','נייר מטבח','paper towels','kitchen paper'],search:['נייר סופג','מגבות נייר']},
 {intent:'TOILET_PAPER',aliases:['נייר טואלט','toilet paper'],search:['נייר טואלט']},
 {intent:'TRASH_BAGS',aliases:['שקיות אשפה','שקיות זבל','שקיות פח','אשפתונים','trash bags','garbage bags'],search:['שקיות אשפה','אשפתונים']},
 {intent:'CUPS',aliases:['כוסות','cups'],search:['כוסות']},
 {intent:'PLATES',aliases:['צלחות','plates'],search:['צלחות']},
];

// Each group is a concept, not a declaration that every product is interchangeable.
export interface AliasGroup { canonical:string; aliases:readonly string[] }
export const ALIAS_GROUPS:readonly AliasGroup[]=[
 {canonical:'ריצפז',aliases:['ריצפז','נוזל רצפות','שוטף רצפות','חומר רצפה','חומר לרצפה','חומר רצפות','נוזל רצפה']},
 {canonical:'אקונומיקה',aliases:['אקונומיקה','javel','גאוול','גאול','מלבין','bleach']},
 // "מרכך כביסה" keeps its laundry word: collapsing it to a bare "מרכך" let any conditioner cover it.
 {canonical:'מרכך כביסה',aliases:['מרכך כביסה','fabric softener']},
 {canonical:'גל כביסה',aliases:['גל כביסה','נוזל כביסה','laundry gel']},
 {canonical:'מטליות רצפה',aliases:['מטליות רצפה','מטליות לרצפה','מטליות לחות לרצפה','מטליות לחות רצפה','floor wipes']},
 {canonical:'חלונות',aliases:['מנקה חלונות','סנו קליר','חלונות']},
];
export const BRANDS:readonly (readonly string[])[]=[['סנו','sano'],['מקסימה','maxima'],['ריצפז','ritzpaz'],['כיף','kef','keff']];
// Product families of a brand, as context words. Used only as the last signal for a product whose
// title has a type word that needs context (a bare "מרכך"), after the title itself and Shopify
// productType metadata.
export const BRAND_CONTEXT:Readonly<Record<string,string>>={'מקסימה':'כביסה','כיף':'שיער'};
export const PHRASES=['מלון בוטיק','פרש הום','סנו קליר'] as const;
// Words that describe the request without identifying a product.
export const GENERIC_WORDS=['חומר','נוזל','מוצר','ניקוי','ריח','ניחוח','עם','של','מאוד','במיוחד'];
// Subjective wishes: they rank candidates, never exclude them.
export const SOFT_WORDS=['חזק','נעים','טוב','עדין','ריחני','איכותי','זול','מומלץ','מטבח'];
// Size wishes: they narrow results only when some relevant candidate states the size.
export const SIZE_WORDS=['גדול','קטן','ענק'];
export const SPELLINGS:Record<string,string>={
 'רצפה':'רצפות','בבי':'בייבי','בייביי':'בייבי','גאוולל':'גאוול',
 'ספוגים':'ספוג','ספוגי':'ספוג','ספוגית':'ספוג','ספוגיות':'ספוג','סקוצ':'סקוץ','סקוטש':'סקוץ','כריות':'כרית','שקית':'שקיות','מגבת':'מגבות','גלילי':'גליל',
 'זכוכיות':'זכוכית','שומן':'שומנים','אסלה':'אסלות','כוס':'כוסות','צלחת':'צלחות','מטלית':'מטליות','אשפתון':'אשפתונים',
 'ידים':'ידיים','קונדישנר':'קונדישינר','פעמיות':'פעמי','פעמיים':'פעמי','פעמית':'פעמי',
 'חזקה':'חזק','נעימה':'נעים','טובה':'טוב','עדינה':'עדין','ריחנית':'ריחני','איכותית':'איכותי','זולה':'זול','מומלצת':'מומלץ',
 'גדולה':'גדול','גדולים':'גדול','גדולות':'גדול','קטנה':'קטן','קטנים':'קטן','קטנות':'קטן',
};
// Explicit negation: "ללא X", "בלי X", "אינו מכיל X"... X is what the product does NOT contain.
export const NEGATORS=['ללא תוספת','אינו מכיל','אינה מכילה','אינם מכילים','אינן מכילות','לא מכיל','לא מכילה','לא מכילים',
 'ללא','בלי','נטול','נטולת','נטולי'] as const;

const spell=(token:string)=>SPELLINGS[token]||token;
const words=(text:string)=>normalize(text).replace(/\./g,' ').split(/[\s+]+/).filter(Boolean).map(spell);
// Hebrew attaches ו/ה/ב/ל/מ/ש/כ to words ("לשיער", "וצלחות"). A prefix is removed only when
// the remainder is known product vocabulary, so ordinary words such as "לבנדר" stay intact.
// Shortest prefix first: "וללא" is "ו" + "ללא", while "ולשיער" falls through to "ול" + "שיער".
const PREFIXES=['ו','ה','ב','ל','מ','ש','כ','וה','וב','ול','ומ','וכ','שה','שב','של','שמ'];
const NEGATOR_WORDS=new Set(NEGATORS.flatMap(words));
const RAW_VOCABULARY=new Set([
 ...PRODUCT_INTENTS.flatMap(d=>[...d.aliases,...(d.contextual||[]),...(d.search||[])]),
 ...ALIAS_GROUPS.flatMap(g=>[g.canonical,...g.aliases]),...BRANDS.flat(),...PHRASES,...GENERIC_WORDS,...SOFT_WORDS,...SIZE_WORDS,
 'בייבי','לבנדר','לימון','מלון חלומי','פרש','הום','מרוכז','כביסה','בגדים','שיער','חד פעמי',
].flatMap(words));
const stripped=(token:string,known:Set<string>)=>{
 for(const prefix of PREFIXES)if(token.startsWith(prefix)&&token.length-prefix.length>=2){
  const rest=spell(token.slice(prefix.length));if(known.has(rest))return rest;
 }
 return null;
};
// Prefixed spellings inside configured phrases ("מטליות לרצפה") are not vocabulary of their own.
export const VOCABULARY:ReadonlySet<string>=new Set([...RAW_VOCABULARY].filter(t=>NEGATOR_WORDS.has(t)||!stripped(t,RAW_VOCABULARY)));
for(const word of NEGATOR_WORDS)(VOCABULARY as Set<string>).add(word);
export function stemToken(token:string):string {
 const spelled=spell(token);
 if(VOCABULARY.has(spelled)||!/^\p{Script=Hebrew}/u.test(token))return spelled;
 return stripped(token,VOCABULARY as Set<string>)||spelled;
}
export const normalizeHebrewQuery=memoize((text:string):string=>
 normalize(text).replace(/\./g,' ').split(/\s+/).filter(Boolean).map(stemToken).join(' ').trim());
const NEGATOR_PHRASES=NEGATORS.map(n=>normalizeHebrewQuery(n).split(' ')).sort((a,b)=>b.length-a.length);
const TWO_WORD_PHRASES=new Set([
 ...PRODUCT_INTENTS.flatMap(d=>[...d.aliases,...(d.contextual||[])]),...ALIAS_GROUPS.flatMap(g=>g.aliases),...PHRASES,
].filter(p=>!p.includes('+')).map(normalizeHebrewQuery).filter(p=>p.split(' ').length===2));
export interface NegationSplit { positive:string; negated:string[] }
// Separates negated objects from the rest of a normalized text. The object is the next word,
// or the next two words when they form a configured product phrase ("ללא נוזל כלים").
export function splitNegations(normalizedText:string):NegationSplit {
 const tokens=normalizedText.split(' ').filter(Boolean),positive:string[]=[],negated:string[]=[];
 for(let i=0;i<tokens.length;){
  const negator=NEGATOR_PHRASES.find(n=>n.every((t,k)=>tokens[i+k]===t));
  if(!negator||i+negator.length>=tokens.length){positive.push(tokens[i]);i++;continue;}
  const start=i+negator.length,pair=tokens.slice(start,start+2).join(' ');
  const size=TWO_WORD_PHRASES.has(pair)?2:1;
  negated.push(tokens.slice(start,start+size).join(' '));
  i=start+size;
 }
 return {positive:positive.join(' '),negated};
}
