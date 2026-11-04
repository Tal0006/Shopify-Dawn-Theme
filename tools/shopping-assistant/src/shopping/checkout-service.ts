import type {BuyerContext,CartLine,CartResult,StorefrontGateway} from '../domain/types.js';
import {ApiError} from '../middleware/errors.js';
import {QuoteService} from './quote-service.js';
import {matched,purchasable} from './matcher.js';
import {minor} from './money.js';
import {invalid,quantity,variantId,MAX_ITEMS,MAX_TOTAL_QUANTITY} from './validation.js';
function lines(value:unknown):CartLine[]{
 if(!Array.isArray(value)||!value.length||value.length>MAX_ITEMS)throw invalid();
 const counts=new Map<string,number>();
 for(const row of value){const id=variantId(row?.variantId),q=quantity(row?.quantity);counts.set(id,(counts.get(id)||0)+q);}
 const result=[...counts].map(([variantId,q])=>({variantId,quantity:quantity(q)})).sort((a,b)=>a.variantId.localeCompare(b.variantId));
 if(result.reduce((s,l)=>s+l.quantity,0)>MAX_TOTAL_QUANTITY)throw invalid('TOO_MANY_UNITS');return result;
}
export class CheckoutService{
 constructor(private shop:StorefrontGateway,private quotes:QuoteService){}
 async checkout(input:any,buyer?:BuyerContext):Promise<CartResult>{
  if(input?.confirmed!==true)throw invalid('CONFIRMATION_REQUIRED','יש לאשר במפורש לפני יצירת סל.');
  const selected=lines(input.lines),r=this.quotes.get(input.quoteId);
  if(input.revision!==r.quote.revision)throw new ApiError(409,'STALE_QUOTE','יש לאשר את הגרסה העדכנית.');
  if(!r.quote.canCheckout)throw new ApiError(409,'UNRESOLVED_QUOTE','יש לפתור את כל הפריטים לפני יצירת סל.');
  const expected=lines(r.quote.resolvedItems);
  if(JSON.stringify(selected)!==JSON.stringify(expected))throw invalid('LINES_MISMATCH');
  if(r.state==='complete')return structuredClone(r.cart!);
  if(r.state!=='open')throw new ApiError(409,'CHECKOUT_BUSY','יש להמתין או לשלוח רשימה חדשה.');
  r.state='pending';let mutation=false;
  try{
   const current=await this.shop.variants(expected.map(l=>l.variantId),buyer),byId=new Map(current.map(v=>[v.variantId,v]));
   const changed=r.quote.resolvedItems.some(row=>{
    const v=byId.get(row.variantId),q=expected.find(l=>l.variantId===row.variantId)!.quantity;
    return !v||!purchasable(v,q)||v.unitPrice.currencyCode!==row.unitPrice.currencyCode||minor(v.unitPrice)!==minor(row.unitPrice);
   });
   if(changed){
    const items=r.quote.items.map(item=>{
     const v=byId.get(item.bestMatch!.variantId);
     if(!v)return {...item,status:'not_found' as const,bestMatch:undefined,candidates:[],reason:'VARIANT_REMOVED'};
     const bestMatch=matched(v,item.requested.quantity),q=expected.find(l=>l.variantId===v.variantId)!.quantity;
     return {...item,bestMatch,candidates:[bestMatch],status:purchasable(v,q)?'matched' as const:'unavailable' as const,reason:'SHOPIFY_REVALIDATED'};
    });
    r.quote=this.quotes.summarize(r.quote.quoteId,r.quote.revision+1,r.quote.expiresAt,items);
    throw new ApiError(409,'QUOTE_CHANGED','מחיר או זמינות השתנו. יש לבדוק ולאשר מחדש.',structuredClone(r.quote));
   }
   mutation=true;r.cart=await this.shop.createCart(expected,buyer);r.state='complete';return structuredClone(r.cart);
  }catch(error){r.state=mutation?'uncertain':'open';throw error;}
 }
}
