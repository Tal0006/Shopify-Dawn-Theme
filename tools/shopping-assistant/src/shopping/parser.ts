import type {ParsedShoppingItem} from '../domain/types.js';
import {invalid,MAX_ITEMS,MAX_TOTAL_QUANTITY,quantity} from './validation.js';
export function normalize(value:string):string {
  return value.normalize('NFKC').replace(/\p{M}/gu,'').replace(/[״׳"'‘’“”]/g,'').replace(/[^\p{L}\p{N}\s.]/gu,' ').replace(/\s+/g,' ').trim().toLowerCase();
}
const words:Record<string,number>={'אחד':1,'אחת':1,'שני':2,'שתי':2,'שניים':2,'שתיים':2,'שלוש':3,'שלושה':3,'ארבע':4,'ארבעה':4,'חמש':5,'חמישה':5};
export function parseShoppingList(message:unknown):ParsedShoppingItem[] {
  if(typeof message!=='string'||!message.trim()||message.length>4000)throw invalid('INVALID_MESSAGE','יש להזין רשימה באורך של עד 4000 תווים.');
  const lines=message.split(/[\n,;]+/).map(line=>line.trim()).filter(Boolean);
  if(!lines.length||lines.length>MAX_ITEMS)throw invalid('TOO_MANY_ITEMS','ניתן לבקש עד 20 פריטים ברשימה.');
  const items=lines.map(originalText=>{
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
  });
  if(items.reduce((n,item)=>n+item.quantity,0)>MAX_TOTAL_QUANTITY)throw invalid('TOO_MANY_UNITS','ניתן לבקש עד 100 יחידות ברשימה.');
  return items;
}
