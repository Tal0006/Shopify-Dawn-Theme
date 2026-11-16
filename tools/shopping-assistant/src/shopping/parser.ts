import type {ParsedShoppingItem} from '../domain/types.js';
import {invalid,MAX_ITEMS,MAX_TOTAL_QUANTITY,quantity} from './validation.js';
import {normalize} from './text.js';
import {standaloneIntent} from './product-intent.js';
import {VOCABULARY,normalizeHebrewQuery} from './vocabulary.js';
export {normalize};
const words:Record<string,number>={'אחד':1,'אחת':1,'שני':2,'שתי':2,'שניים':2,'שתיים':2,'שלוש':3,'שלושה':3,'ארבע':4,'ארבעה':4,'חמש':5,'חמישה':5};

// A list fragment is an independent item only when it names a product type by itself
// (context-dependent words such as a bare "מרכך" are not enough).
const withoutQuantity=(text:string)=>text.replace(/^\s*\d+\s*[x×]?\s*/i,'').replace(/\s*[x×]?\s*\d+\s*$/i,'');
const independent=(text:string)=>standaloneIntent(withoutQuantity(text))!=='UNKNOWN';
// "כוסות וצלחות" -> two items, but only when both sides are independent product requests:
// "שמפו לשיער יבש ופגום" stays one item. `context` is a shared modifier applied to each side.
function splitCoordinated(text:string,context=''):string[] {
 const tokens=text.trim().split(/\s+/);
 for(let i=1;i<tokens.length;i++){
  if(!/^ו\S/.test(tokens[i]))continue;
  const left=tokens.slice(0,i).join(' ');
  if(!independent((left+' '+context).trim()))continue;
  const rest=splitCoordinated([tokens[i].slice(1),...tokens.slice(i+1)].join(' '),context);
  if(independent((rest[0]+' '+context).trim()))return [left,...rest];
 }
 return [text.trim()];
}
// "חד פעמי – כוסות וצלחות": a leading modifier before a dash or colon distributes to every
// item after it, but only when it consists of product vocabulary (not a list label such as
// "ניקיון:") and the rest really lists several independent products.
function splitLine(line:string):string[] {
 const clean=line.replace(/^[-•]\s+/,'').trim();
 const header=clean.match(/^(.+?)\s*[:–—]\s*(.+)$/)||clean.match(/^(.+?)\s+-\s+(.+)$/);
 if(header){
  const [,modifier,rest]=header,quantityPrefix=modifier.match(/^(\d+\s*[x×]?)\s+(.+)$/i);
  const shared=quantityPrefix?quantityPrefix[2]:modifier;
  const parts=rest.split(/[,;]+/).map(p=>p.trim()).filter(Boolean).flatMap(p=>splitCoordinated(p,shared));
  if(normalizeHebrewQuery(shared).split(' ').every(t=>VOCABULARY.has(t))&&parts.length>1&&parts.every(p=>independent(p+' '+shared)))
   return parts.map(p=>(quantityPrefix&&!/^\d/.test(p)?quantityPrefix[1]+' ':'')+p+' '+shared);
 }
 return line.split(/[,;]+/).map(p=>p.trim()).filter(Boolean).flatMap(segment=>splitCoordinated(segment));
}
function parseItem(originalText:string):ParsedShoppingItem {
 let name=originalText.replace(/^[-•]\s+/,'').trim(),count=1;
 const prefix=name.match(/^(\d+)\s*[x×]\s*(.+)$/i) || name.match(/^(\d+)\s+(.+)$/);
 const suffix=name.match(/^(.+?)\s*[x×]\s*(\d+)$/i);
 if(prefix){count=Number(prefix[1]);name=prefix[2];}
 else if(suffix){name=suffix[1];count=Number(suffix[2]);}
 else {
  const trailing=name.match(/^(.+?)\s+(\d+)$/);
  const first=name.split(/\s+/)[0];
  if(words[first]){count=words[first];name=name.slice(first.length).trim();}
  else if(trailing){name=trailing[1];count=Number(trailing[2]);}
 }
 if(/^(?:\d+\s*[x×]|[x×]\s*\d+)$/i.test(name)||/^(?:[+\-]?\d+(?:[.,]\d+)?|[x×])(?:\s|$)/i.test(name)||/\s[x×]\s*$/i.test(name))throw invalid('INVALID_ITEM','לא ניתן להבין אחד מהפריטים ברשימה.');
 if(/[x×]\s*[+-]?(?:\d+(?:\.\d+)?)\s*$/i.test(name))throw invalid('INVALID_QUANTITY','כמות הפריט אינה תקינה.');
 name=normalize(name);
 if(!/\p{L}/u.test(name)||name.length>180)throw invalid('INVALID_ITEM','יש לציין שם מוצר תקין לכל פריט.');
 return {originalText,requestedName:name,quantity:quantity(count)};
}
export function parseShoppingList(message:unknown):ParsedShoppingItem[] {
 if(typeof message!=='string'||!message.trim()||message.length>4000)throw invalid('INVALID_MESSAGE','יש להזין רשימה באורך של עד 4000 תווים.');
 const lines=message.split(/[\n,;]+/).map(line=>line.trim()).filter(Boolean);
 if(!lines.length||lines.length>MAX_ITEMS)throw invalid('TOO_MANY_ITEMS','ניתן לבקש עד 20 פריטים ברשימה.');
 // Split items carry their own text, so editing or removing one item rebuilds a valid list.
 const segments=message.split('\n').map(line=>line.trim()).filter(Boolean).flatMap(splitLine);
 if(segments.length>MAX_ITEMS)throw invalid('TOO_MANY_ITEMS','ניתן לבקש עד 20 פריטים ברשימה.');
 const items=segments.map(parseItem);
 if(items.reduce((n,item)=>n+item.quantity,0)>MAX_TOTAL_QUANTITY)throw invalid('TOO_MANY_UNITS','ניתן לבקש עד 100 יחידות ברשימה.');
 return items;
}
