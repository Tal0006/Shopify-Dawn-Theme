import {normalize} from './parser.js';
import {PRODUCT_INTENTS,intentFactor} from './product-intent.js';

// Each group is a concept, not a declaration that every product is interchangeable.
export interface AliasGroup { canonical:string; aliases:readonly string[] }
export const ALIAS_GROUPS:readonly AliasGroup[]=[
 {canonical:'ריצפז',aliases:['ריצפז','נוזל רצפות','שוטף רצפות','חומר רצפה','חומר לרצפה','חומר רצפות','נוזל רצפה']},
 {canonical:'אקונומיקה',aliases:['אקונומיקה','javel','גאוול','גאול','מלבין','bleach']},
 {canonical:'מרכך',aliases:['מרכך כביסה','מרכך','fabric softener']},
 {canonical:'גל כביסה',aliases:['גל כביסה','נוזל כביסה','laundry gel']},
 {canonical:'מטליות רצפה',aliases:['מטליות רצפה','מטליות לרצפה','מטליות לחות לרצפה','מטליות לחות רצפה','floor wipes']},
 {canonical:'חלונות',aliases:['מנקה חלונות','סנו קליר','חלונות']},
];
export const BRANDS:readonly (readonly string[])[]=[['סנו','sano'],['מקסימה','maxima'],['ריצפז','ritzpaz']];
export const PHRASES=['מלון בוטיק','פרש הום','סנו קליר'] as const;
const GENERIC=new Set(['חומר','נוזל','מוצר','ניקוי','בניחוח','בריח','עם','של','לניקוי']);
const SPELLINGS:Record<string,string>={'רצפה':'רצפות','בבי':'בייבי','בייביי':'בייבי','גאוולל':'גאוול'};
export function normalizeHebrewQuery(text:string):string {
 return normalize(text).replace(/\./g,' ').split(/\s+/).map(t=>SPELLINGS[t]||t).join(' ').trim();
}
function replacePhrase(text:string,phrase:string,replacement:string):string {
 return (' '+text+' ').split(' '+phrase+' ').join(' '+replacement+' ').trim().replace(/\s+/g,' ');
}
export function canonicalQuery(text:string,groups:readonly AliasGroup[]=ALIAS_GROUPS):string {
 let result=normalizeHebrewQuery(text);
 const replacements=groups.flatMap(g=>g.aliases.map(a=>({alias:normalizeHebrewQuery(a),canonical:g.canonical})))
  .sort((a,b)=>b.alias.length-a.alias.length);
 for(const {alias,canonical} of replacements)result=replacePhrase(result,alias,canonical);
 for(const names of BRANDS)for(const name of names)result=replacePhrase(result,name,names[0]);
 return result;
}
export function expandQueries(text:string,groups:readonly AliasGroup[]=ALIAS_GROUPS):string[] {
 const normalized=normalizeHebrewQuery(text),queries=[text,normalized];
 for(const group of groups){
  const alias=[...group.aliases].map(normalizeHebrewQuery).sort((a,b)=>b.length-a.length)
   .find(a=>(' '+normalized+' ').includes(' '+a+' '));
  if(!alias)continue;
  for(const alternative of [group.canonical,...group.aliases]){
   queries.push(replacePhrase(normalized,alias,normalizeHebrewQuery(alternative)));
  }
 }
 const base=[...new Set([text,normalized])];
 return [...base,...[...new Set(queries)].filter(q=>!base.includes(q)).slice(0,2)];
}
export const queryTokens=(text:string)=>[...new Set(canonicalQuery(text).split(' ').filter(Boolean))];
export const tokenWeight=(term:string)=>GENERIC.has(term)?0.25:BRANDS.some(b=>b[0]===term)?2.5:2;
// Qualifiers are high-weight query terms left after removing type and brand vocabulary.
// Their values come from the customer query, never a fragrance/descriptor allowlist.
const TYPE_TERMS=new Set(PRODUCT_INTENTS.flatMap(group=>group.aliases.flatMap(queryTokens)));
const BRAND_TERMS=new Set(BRANDS.flatMap(names=>names.flatMap(queryTokens)));
export function distinctiveQualifiers(query:string):string[] {
 return queryTokens(query).filter(term=>tokenWeight(term)>=2&&!TYPE_TERMS.has(term)&&!BRAND_TERMS.has(term));
}
export function satisfiesDistinctiveQualifiers(query:string,title:string,variantTitle:string):boolean {
 const qualifiers=distinctiveQualifiers(query);
 const text=title+' '+(variantTitle==='Default Title'?'':variantTitle),terms=queryTokens(text);
 if(!qualifiers.every(term=>terms.includes(term)))return false;
 return PHRASES.filter(phrase=>queryTokens(phrase).every(term=>qualifiers.includes(term))&&
  (' '+normalizeHebrewQuery(query)+' ').includes(' '+phrase+' '))
  .every(phrase=>(' '+normalizeHebrewQuery(text)+' ').includes(' '+phrase+' '));
}
export function semanticScore(query:string,title:string,vendor:string,variantTitle:string):number {
 const intent=intentFactor(query,title);
 if(intent===0||!satisfiesDistinctiveQualifiers(query,title,variantTitle))return 0;
 const wanted=queryTokens(query),candidate=queryTokens(title+' '+vendor+' '+(variantTitle==='Default Title'?'':variantTitle));
 const coverage=wanted.reduce((n,t)=>n+tokenWeight(t)*(candidate.includes(t)?1:0),0)/
  Math.max(1,wanted.reduce((n,t)=>n+tokenWeight(t),0));
 const requestedBrands=BRANDS.filter(names=>names.some(n=>(' '+normalizeHebrewQuery(query)+' ').includes(' '+n+' ')));
 if(requestedBrands.some(names=>!names.some(n=>(' '+normalizeHebrewQuery(title+' '+vendor)+' ').includes(' '+n+' '))))return coverage*0.4*intent;
 const normalized=normalizeHebrewQuery(query),target=normalizeHebrewQuery(title+' '+variantTitle);
 const phrases=PHRASES.filter(p=>normalized.includes(p));
 // A complete phrase is stronger than its scattered individual words.
 const phraseFactor=phrases.every(p=>target.includes(p))?1:0.8;
 return Math.min(1,coverage*phraseFactor*intent);
}
const SAFE_WORDS=new Set([...ALIAS_GROUPS.flatMap(g=>[g.canonical,...g.aliases]),...BRANDS.flat(),...PHRASES,
 'בייבי','לבנדר','לימון','מלון חלומי','פרש','הום','בניחוח','מרוכז','כביסה','ניקוי','חומר','נוזל','מוצר']
 .flatMap(s=>normalizeHebrewQuery(s).split(' ')));
// Never send arbitrary customer text, numbers, email addresses or identifiers to logs.
export function safeQueryLog(text:string):string {
 return normalizeHebrewQuery(text).split(' ').map(t=>SAFE_WORDS.has(t)?t:'[redacted]').join(' ');
}
