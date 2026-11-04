import {normalize} from './parser.js';

export type ProductIntent='FABRIC_SOFTENER'|'LAUNDRY_DETERGENT'|'LAUNDRY_POWDER'|
 'BLEACH'|'FLOOR_CLEANER'|'FLOOR_WIPES'|'GLASS_CLEANER'|'UNKNOWN';
export interface IntentDefinition {intent:Exclude<ProductIntent,'UNKNOWN'>;aliases:readonly string[]}
export const PRODUCT_INTENTS:readonly IntentDefinition[]=[
 {intent:'FABRIC_SOFTENER',aliases:['מרכך','מרכך כביסה','fabric softener']},
 {intent:'LAUNDRY_DETERGENT',aliases:["ג'ל כביסה",'נוזל כביסה','laundry gel','liquid laundry detergent']},
 {intent:'LAUNDRY_POWDER',aliases:['אבקת כביסה','laundry powder','washing powder']},
 {intent:'BLEACH',aliases:['אקונומיקה','javel',"ג'אוול",'גאול','מלבין','bleach']},
 {intent:'FLOOR_CLEANER',aliases:['חומר רצפה','חומר רצפות','חומר לרצפה','נוזל רצפה','נוזל רצפות','ריצפז','שוטף רצפות','floor cleaner']},
 {intent:'FLOOR_WIPES',aliases:['מטליות רצפה','מטליות רצפות','מטליות לרצפה','מטליות לחות לרצפה','מטליות לחות רצפה','floor wipes']},
 {intent:'GLASS_CLEANER',aliases:['מנקה חלונות','סנו קליר','glass cleaner','window cleaner']},
];
function detect(text:string,definitions:readonly IntentDefinition[]):ProductIntent {
 const normalized=' '+normalize(text)+' ';
 const matches=definitions.flatMap(({intent,aliases})=>aliases
  .map(normalize).filter(a=>normalized.includes(' '+a+' '))
  .map(alias=>({intent,specificity:alias.split(' ').length})));
 if(!matches.length)return 'UNKNOWN';
 // A specific functional phrase overrides a broad family name such as Ritzpaz.
 const specificity=Math.max(...matches.map(m=>m.specificity));
 const intents=new Set(matches.filter(m=>m.specificity===specificity).map(m=>m.intent));
 return intents.size===1?[...intents][0]:'UNKNOWN';
}
export const detectQueryIntent=(query:string,definitions=PRODUCT_INTENTS):ProductIntent=>detect(query,definitions);
export function detectProductIntent(product:string|{title:string;productType?:string},definitions=PRODUCT_INTENTS):ProductIntent {
 if(typeof product==='string')return detect(product,definitions);
 const titleIntent=detect(product.title,definitions);
 return titleIntent!=='UNKNOWN'?titleIntent:detect(product.productType||'',definitions);
}
export function intentFactor(query:string,title:string):number {
 const wanted=detectQueryIntent(query),actual=detectProductIntent(title);
 if(wanted==='UNKNOWN')return 1;
 if(actual==='UNKNOWN')return 0.95;
 return wanted===actual?1:0;
}
