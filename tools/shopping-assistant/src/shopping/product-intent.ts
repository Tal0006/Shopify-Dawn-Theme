import {BRAND_CONTEXT,PRODUCT_INTENTS,normalizeHebrewQuery,splitNegations} from './vocabulary.js';
import {memoize} from './text.js';
import type {IntentDefinition,KnownIntent,ProductIntent} from './vocabulary.js';
export {PRODUCT_INTENTS};
export type {IntentDefinition,KnownIntent,ProductIntent};

interface DetectOptions { contextual?:boolean }
function aliasMatches(alias:string,text:string,tokens:Set<string>):boolean {
 if(alias.includes('+'))return alias.split('+').every(part=>part.split(' ').every(t=>tokens.has(t)));
 return text.includes(' '+alias+' ');
}
// Normalized alias tables and detection results, cached per definitions list (pure functions).
interface AliasEntry { intent:KnownIntent; alias:string; contextual:boolean; specificity:number }
const tables=new WeakMap<readonly IntentDefinition[],{aliases:AliasEntry[];detect:Map<string,(text:string)=>ProductIntent>}>();
function table(definitions:readonly IntentDefinition[]) {
 let entry=tables.get(definitions);
 if(!entry){
  const aliases=definitions.flatMap(({intent,aliases,contextual})=>[
   ...aliases.map(alias=>({alias,contextual:false})),...(contextual||[]).map(alias=>({alias,contextual:true}))]
   .map(({alias,contextual})=>{const normalized=alias.split('+').map(normalizeHebrewQuery).join('+');
    return {intent,alias:normalized,contextual,specificity:normalized.split(/[\s+]/).length};}));
  entry={aliases,detect:new Map()};tables.set(definitions,entry);
 }
 return entry;
}
function detect(text:string,definitions:readonly IntentDefinition[],options:DetectOptions={}):ProductIntent {
 const cached=table(definitions),mode=options.contextual===false?'explicit':'all';
 let run=cached.detect.get(mode);
 if(!run){run=memoize(value=>detectUncached(value,definitions,cached.aliases,options.contextual!==false));cached.detect.set(mode,run);}
 return run(text);
}
function detectUncached(text:string,definitions:readonly IntentDefinition[],aliases:AliasEntry[],withContextual:boolean):ProductIntent {
 // Negated objects ("ללא אקונומיקה") describe what the product is not.
 const positive=splitNegations(normalizeHebrewQuery(text)).positive,normalized=' '+positive+' ';
 const tokens=new Set(positive.split(' '));
 const matches=aliases.filter(a=>(withContextual||!a.contextual)&&aliasMatches(a.alias,normalized,tokens));
 if(!matches.length)return 'UNKNOWN';
 // A specific functional phrase overrides a broad family name such as Ritzpaz.
 const specificity=Math.max(...matches.map(m=>m.specificity));
 const intents=new Set(matches.filter(m=>m.specificity===specificity).map(m=>m.intent));
 if(intents.size===1)return [...intents][0];
 // Equally specific parent and child signals mean the child ("floor wipes" are cleaning cloths).
 const children=[...intents].filter(intent=>definitions.some(d=>d.intent===intent&&d.parent&&intents.has(d.parent)));
 return children.length===1&&intents.size===2?children[0]:'UNKNOWN';
}
export const detectQueryIntent=(query:string,definitions=PRODUCT_INTENTS):ProductIntent=>detect(query,definitions);
// Recognition without context-dependent aliases: used to decide whether a list fragment
// is an independent product request.
export const standaloneIntent=(text:string,definitions=PRODUCT_INTENTS):ProductIntent=>detect(text,definitions,{contextual:false});
// A context-dependent alias is ambiguous for a product when another, unrelated type uses the same
// words ("מרכך" in "מרכך שיער"). "מטליות" is not: floor wipes are a kind of cleaning cloth.
function ambiguousForProducts(intent:ProductIntent,definitions:readonly IntentDefinition[]):boolean {
 const own=intentDefinition(intent,definitions);
 return (own?.contextual||[]).some(alias=>{
  const words=normalizeHebrewQuery(alias).split(' ');
  return definitions.some(other=>other.intent!==intent&&other.parent!==intent&&own?.parent!==other.intent&&
   other.aliases.some(a=>words.every(w=>normalizeHebrewQuery(a.replace(/\+/g,' ')).split(' ').includes(w))));
 });
}
const brandContext=(text:string)=>{
 const normalized=' '+normalizeHebrewQuery(text)+' ';
 return Object.entries(BRAND_CONTEXT).filter(([brand])=>normalized.includes(' '+normalizeHebrewQuery(brand)+' ')).map(([,context])=>context).join(' ');
};
export interface ProductSignals { title:string; productType?:string; vendor?:string }
// Product type from the title. A bare context-dependent word ("כיף מרכך לחות מוגברת") never decides
// the type alone: it is resolved by context words in the title, then Shopify productType metadata,
// then the brand's product family; otherwise the type stays UNKNOWN.
export function detectProductIntent(product:string|ProductSignals,definitions=PRODUCT_INTENTS):ProductIntent {
 const {title,productType='',vendor=''}=typeof product==='string'?{title:product}:product;
 const explicit=detect(title,definitions,{contextual:false});
 if(explicit!=='UNKNOWN')return explicit;
 const contextual=detect(title,definitions);
 if(contextual!=='UNKNOWN'&&!ambiguousForProducts(contextual,definitions))return contextual;
 for(const context of [productType,brandContext(title+' '+vendor)]){
  if(!context)continue;
  const resolved=detect(title+' '+context,definitions,{contextual:false});
  if(resolved!=='UNKNOWN')return resolved;
 }
 return productType?detect(productType,definitions,{contextual:false}):'UNKNOWN';
}
export const intentDefinition=(intent:ProductIntent,definitions=PRODUCT_INTENTS)=>definitions.find(d=>d.intent===intent);
// A specialized product of the requested type: a child type (floor wipes for cleaning cloths), or a
// type declared `variantOf` the request whose title also names the requested type on its own
// (toilet bleach gel for bleach). Context-dependent words never count ("כיף מרכך לשיער" is not a softener).
export function specializes(wanted:ProductIntent,actual:ProductIntent,title='',definitions=PRODUCT_INTENTS):boolean {
 if(wanted==='UNKNOWN'||actual==='UNKNOWN'||wanted===actual)return false;
 const definition=intentDefinition(actual,definitions);
 if(definition?.parent===wanted)return true;
 return !!definition?.variantOf?.includes(wanted)&&standaloneIntent(title,definitions.filter(d=>d.intent===wanted))===wanted;
}
// The product is the requested type or a specialization of it.
export const satisfiesIntent=(wanted:ProductIntent,actual:ProductIntent,title='',definitions=PRODUCT_INTENTS)=>
 wanted!=='UNKNOWN'&&(wanted===actual||specializes(wanted,actual,title,definitions));
// Specializations stay relevant (>= 0.65) but below automatic matching (0.85), and more than the
// availability margin below a same-type match, so stock never lifts them above a generic product.
export const SPECIALIZATION_FACTOR=0.8;
// 1: same type. 0.95: unknown, or the broader parent type. 0.8: a specialization, offered after
// the generic products. 0: a known conflicting type.
export function intentRelation(wanted:ProductIntent,actual:ProductIntent,title='',definitions=PRODUCT_INTENTS):number {
 if(wanted==='UNKNOWN'||wanted===actual)return 1;
 if(specializes(wanted,actual,title,definitions))return SPECIALIZATION_FACTOR;
 if(actual==='UNKNOWN'||intentDefinition(wanted,definitions)?.parent===actual)return 0.95;
 return 0;
}
export function intentFactor(query:string,title:string):number {
 return intentRelation(detectQueryIntent(query),detectProductIntent(title),title);
}
