import {memoize,normalize} from './text.js';
import {ALIAS_GROUPS,BRANDS,PHRASES,GENERIC_WORDS,SOFT_WORDS,SIZE_WORDS,PRODUCT_INTENTS,VOCABULARY,normalizeHebrewQuery,splitNegations} from './vocabulary.js';
import type {AliasGroup,ProductIntent} from './vocabulary.js';
import {detectQueryIntent,detectProductIntent,intentDefinition,intentRelation,satisfiesIntent} from './product-intent.js';
export {ALIAS_GROUPS,BRANDS,PHRASES,normalizeHebrewQuery};
export type {AliasGroup};

const GENERIC=new Set(GENERIC_WORDS.map(normalizeHebrewQuery));
const SOFT=new Set(SOFT_WORDS.map(normalizeHebrewQuery)),SIZE=new Set(SIZE_WORDS.map(normalizeHebrewQuery));
function replacePhrase(text:string,phrase:string,replacement:string):string {
 return (' '+text+' ').split(' '+phrase+' ').join(' '+replacement+' ').trim().replace(/\s+/g,' ');
}
// Canonical forms are pure: replacement tables and results are cached per alias-group list.
const canonicalizers=new WeakMap<readonly AliasGroup[],(text:string)=>string>();
export function canonicalQuery(text:string,groups:readonly AliasGroup[]=ALIAS_GROUPS):string {
 let run=canonicalizers.get(groups);
 if(!run){
  const replacements=groups.flatMap(g=>g.aliases.map(a=>({alias:normalizeHebrewQuery(a),canonical:g.canonical})))
   .sort((a,b)=>b.alias.length-a.alias.length);
  run=memoize(value=>{
   let result=normalizeHebrewQuery(value);
   for(const {alias,canonical} of replacements)result=replacePhrase(result,alias,canonical);
   for(const names of BRANDS)for(const name of names)result=replacePhrase(result,name,names[0]);
   return result;
  });
  canonicalizers.set(groups,run);
 }
 return run(text);
}
export const queryTokens=(text:string)=>[...new Set(canonicalQuery(text).split(' ').filter(Boolean))];
export const tokenWeight=(term:string)=>GENERIC.has(term)?0.25:BRANDS.some(b=>b[0]===term)?2.5:2;
const has=(text:string,phrase:string)=>(' '+text+' ').includes(' '+phrase+' ');
const requestedBrands=(normalized:string)=>BRANDS.filter(names=>names.some(n=>has(normalized,normalizeHebrewQuery(n))));

// Product-type vocabulary. Type words are never customer qualifiers, and when the request and
// the product have the same known type, the type's own words count as present ("ספוגים לכלים"
// is satisfied by "כרית ניקוי לכלים").
const intentWords=(aliases:readonly string[])=>new Set(aliases.flatMap(a=>queryTokens(a.replace(/\+/g,' '))));
const INTENT_TERMS=new Map(PRODUCT_INTENTS.map(d=>[d.intent,intentWords([...d.aliases,...(d.contextual||[]),...(d.search||[])])]));
const TYPE_TERMS=new Set([...INTENT_TERMS.values()].flatMap(terms=>[...terms]));
const BRAND_TERMS=new Set(BRANDS.flatMap(names=>names.flatMap(queryTokens)));

interface Analysis { positive:string; tokens:string[]; soft:string[]; size:string[]; negated:string[] }
const negatedTokens=(negated:string[])=>[...new Set(negated.flatMap(queryTokens))];
// Splits a request into required wording, soft preferences, size preferences and exclusions.
// Cached and shared: callers treat the returned arrays and sets as read-only.
const analyze=memoize((text:string):Analysis=>{
 const {positive,negated}=splitNegations(normalizeHebrewQuery(text)),all=queryTokens(positive);
 return {positive,tokens:all.filter(t=>!SOFT.has(t)&&!SIZE.has(t)),soft:all.filter(t=>SOFT.has(t)),size:all.filter(t=>SIZE.has(t)),
  negated:negatedTokens(negated)};
});
const candidateText=(title:string,variantTitle:string)=>title+' '+(variantTitle==='Default Title'?'':variantTitle);
const candidate=memoize((text:string)=>{
 const {positive,negated}=splitNegations(normalizeHebrewQuery(text));
 return {positive,tokens:new Set(queryTokens(positive)) as ReadonlySet<string>,negated:negatedTokens(negated)};
});
// Qualifiers are high-weight query terms left after removing type, brand and preference
// vocabulary. Their values come from the customer query, never a fragrance/descriptor allowlist.
export function distinctiveQualifiers(query:string):string[] {
 return analyze(query).tokens.filter(term=>tokenWeight(term)>=2&&!TYPE_TERMS.has(term)&&!BRAND_TERMS.has(term));
}
export function satisfiesDistinctiveQualifiers(query:string,title:string,variantTitle:string):boolean {
 const qualifiers=distinctiveQualifiers(query),target=candidate(candidateText(title,variantTitle));
 if(!qualifiers.every(term=>target.tokens.has(term)))return false;
 const wanted=analyze(query).positive;
 return PHRASES.filter(phrase=>queryTokens(phrase).every(term=>qualifiers.includes(term))&&has(wanted,phrase))
  .every(phrase=>has(target.positive,phrase));
}
// A product that explicitly says it does not contain what was requested ("ללא אקונומיקה")
// never matches it, and a product containing something the customer excluded never matches.
export function contradictsRequest(query:string,title:string,vendor:string,variantTitle:string):boolean {
 const wanted=analyze(query),target=candidate(candidateText(title,variantTitle)+' '+vendor);
 const core=wanted.tokens.filter(t=>!GENERIC.has(t));
 return target.negated.some(t=>core.includes(t))||wanted.negated.some(t=>target.tokens.has(t));
}
export function semanticScore(query:string,title:string,vendor:string,variantTitle:string,productType=''):number {
 if(contradictsRequest(query,title,vendor,variantTitle))return 0;
 const wantedIntent=detectQueryIntent(query),actualIntent=detectProductIntent({title,vendor,productType});
 const intent=intentRelation(wantedIntent,actualIntent,title);
 if(intent===0||!satisfiesDistinctiveQualifiers(query,title,variantTitle))return 0;
 const typeTerms=satisfiesIntent(wantedIntent,actualIntent,title)?INTENT_TERMS.get(wantedIntent as Exclude<ProductIntent,'UNKNOWN'>):undefined;
 const wanted=analyze(query).tokens,target=candidate(candidateText(title,variantTitle)+' '+vendor).tokens;
 const present=(t:string)=>target.has(t)||(!!typeTerms&&(typeTerms.has(t)||GENERIC.has(t)));
 // Soft and size wishes are excluded here: failing them never lowers relevance.
 const coverage=wanted.reduce((n,t)=>n+tokenWeight(t)*(present(t)?1:0),0)/
  Math.max(1,wanted.reduce((n,t)=>n+tokenWeight(t),0));
 const normalized=normalizeHebrewQuery(query),brandText=normalizeHebrewQuery(title+' '+vendor);
 if(requestedBrands(normalized).some(names=>!names.some(n=>has(brandText,normalizeHebrewQuery(n)))))return coverage*0.4*intent;
 const target2=normalizeHebrewQuery(title+' '+variantTitle);
 const phrases=PHRASES.filter(p=>normalized.includes(p));
 // A complete phrase is stronger than its scattered individual words.
 const phraseFactor=phrases.every(p=>target2.includes(p))?1:0.8;
 return Math.min(1,coverage*phraseFactor*intent);
}
// 0..1 share of the customer's soft wishes ("ריח חזק") and exclusions the product states.
// Used only to order otherwise comparable candidates.
export function preferenceScore(query:string,title:string,vendor:string,variantTitle:string):number {
 const wanted=analyze(query),target=candidate(candidateText(title,variantTitle)+' '+vendor);
 const wishes=[...wanted.soft,...wanted.size,...wanted.negated];
 if(!wishes.length)return 0;
 return wishes.filter(t=>target.tokens.has(t)||(wanted.negated.includes(t)&&target.negated.includes(t))).length/wishes.length;
}
export const sizePreferences=(query:string)=>analyze(query).size;
export const satisfiesSize=(query:string,title:string,variantTitle:string)=>{
 const target=candidate(candidateText(title,variantTitle)).tokens;
 return sizePreferences(query).every(t=>target.has(t));
};
// Retrieval forms for Shopify search, without soft wishes or filler words: the type in common
// catalog wording plus the requested brands and qualifiers ("מרכך כביסה עם ריח חזק" -> "מרכך כביסה").
export function coreQueries(text:string):string[] {
 const wanted=analyze(text),intent=detectQueryIntent(text),brands=requestedBrands(normalizeHebrewQuery(text)).map(names=>names[0]);
 const qualifiers=distinctiveQualifiers(text),terms=intentDefinition(intent)?.search||[];
 if(terms.length)return [...new Set(terms.map(term=>[normalize(term),...brands,...qualifiers].join(' ')))];
 const meaningful=wanted.tokens.filter(t=>!GENERIC.has(t));
 return meaningful.length?[meaningful.join(' ')]:[];
}
export function expandQueries(text:string,groups:readonly AliasGroup[]=ALIAS_GROUPS):string[] {
 const normalized=normalizeHebrewQuery(text),intent=detectQueryIntent(normalized),base=[...new Set([text,normalized])];
 const [primary,...secondary]=coreQueries(text),aliases:string[]=[];
 for(const group of groups){
  const alias=[...group.aliases].map(normalizeHebrewQuery).sort((a,b)=>b.length-a.length).find(a=>has(normalized,a));
  if(!alias)continue;
  for(const alternative of [group.canonical,...group.aliases]){
   const query=replacePhrase(normalized,alias,normalizeHebrewQuery(alternative));
   // An alias must not change the product type ("מרכך שיער" never becomes "מרכך כביסה שיער").
   if(detectQueryIntent(query)===intent)aliases.push(query);
  }
 }
 // Core retrieval forms first; configured alias rewrites of the full text fill any remaining budget.
 const extra=[...new Set([primary,...secondary,...aliases].filter(Boolean))].filter(q=>!base.includes(q));
 return [...base,...extra].slice(0,Math.max(base.length,4));
}
// Never send arbitrary customer text, numbers, email addresses or identifiers to logs.
export function safeQueryLog(text:string):string {
 return normalizeHebrewQuery(text).split(' ').map(t=>VOCABULARY.has(t)?t:'[redacted]').join(' ');
}
