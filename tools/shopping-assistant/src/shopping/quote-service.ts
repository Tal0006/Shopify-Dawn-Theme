import {randomUUID} from 'node:crypto';
import type {BuyerContext,MatchResult,QuoteRecord,ShoppingQuote,StorefrontGateway} from '../domain/types.js';
import {ApiError} from '../middleware/errors.js';
import {parseShoppingList} from './parser.js';
import {ProductMatcher,matched,purchasable} from './matcher.js';
import {sum} from './money.js';
import {expandQueries,normalizeHebrewQuery,safeQueryLog,semanticScore} from './hebrew-query.js';
import type {SearchResults} from '../domain/types.js';
import {invalid,variantId} from './validation.js';
export class QuoteService {
 private records=new Map<string,QuoteRecord>();
 constructor(private shop:StorefrontGateway,private matcher=new ProductMatcher(),private now=Date.now,private debug=false){}
 private prune(){for(const [id,r] of this.records)if(Date.parse(r.quote.expiresAt)<=this.now())this.records.delete(id);}
 get(id:unknown):QuoteRecord{this.prune();if(typeof id!=='string'||!this.records.has(id))throw new ApiError(404,'QUOTE_EXPIRED','הרשימה פגה. יש לשלוח רשימה חדשה.');return this.records.get(id)!;}
 summarize(quoteId:string,revision:number,expiresAt:string,items:MatchResult[]):ShoppingQuote{
  const resolvedItems=items.filter(i=>i.status==='matched').map(i=>i.bestMatch!);
  const subtotal=sum(resolvedItems.map(i=>i.lineTotal)),counts=new Map<string,number>();
  for(const i of resolvedItems)counts.set(i.variantId,(counts.get(i.variantId)||0)+i.quantity);
  const valid=resolvedItems.every(i=>counts.get(i.variantId)!<=20&&purchasable(i,counts.get(i.variantId)!));
  return {quoteId,revision,expiresAt,items,resolvedItems,ambiguousItems:items.filter(i=>i.status==='ambiguous'),
   notFoundItems:items.filter(i=>i.status==='not_found'),unavailableItems:items.filter(i=>i.status==='unavailable'),
   subtotal,currencyCode:subtotal?.currencyCode||null,subtotalLabel:'סה״כ מוצרים',
   canCheckout:!!items.length&&items.every(i=>i.status==='matched')&&!!subtotal&&valid};
 }
 async create(message:unknown,buyer?:BuyerContext):Promise<ShoppingQuote>{
  const items=parseShoppingList(message),results:MatchResult[]=[];
  this.prune();if(this.records.size>=500)throw new ApiError(429,'QUOTE_CAPACITY','יש לנסות מאוחר יותר.');
  const searches=new Map<string,ReturnType<StorefrontGateway['search']>>();
  for(let n=0;n<items.length;n+=4)results.push(...await Promise.all(items.slice(n,n+4).map(async i=>{
   const generated=expandQueries(i.requestedName),merged:SearchResults={variants:[],truncated:false,truncatedVariantProductIds:[]};
   let result:MatchResult|undefined;
   for(const query of generated){
    if(!searches.has(query))searches.set(query,this.shop.search(query,buyer));
    const response=await searches.get(query)!;
    merged.variants=[...new Map([...merged.variants,...response.variants].map(v=>[v.variantId,v])).values()];
    merged.truncated ||= response.truncated;
    merged.truncatedVariantProductIds=[...new Set([...merged.truncatedVariantProductIds!,...(response.truncatedVariantProductIds||[])])];
    result=this.matcher.match(i,merged);
    if(result.status==='matched'||result.status==='unavailable')break;
   }
   if(this.debug)console.info('Shopping match', {
    originalQuery:safeQueryLog(i.originalText),normalizedQuery:safeQueryLog(normalizeHebrewQuery(i.requestedName)),
    searchVariants:generated.map(safeQueryLog),
    candidates:merged.variants.map(v=>({title:safeQueryLog(v.title),score:semanticScore(i.requestedName,v.title,v.vendor,v.variantTitle)})),
    reason:result!.reason
   });
   return result!;

  })));
  if(this.records.size>=500)throw new ApiError(429,'QUOTE_CAPACITY','יש לנסות מאוחר יותר.');
  const quote=this.summarize(randomUUID(),1,new Date(this.now()+900000).toISOString(),results);
  this.records.set(quote.quoteId,{quote,state:'open'});return structuredClone(quote);
 }
 async resolve(input:any,buyer?:BuyerContext):Promise<ShoppingQuote>{
  const r=this.get(input?.quoteId);
  if(r.state!=='open')throw new ApiError(409,'QUOTE_BUSY','הרשימה בתהליך אישור.');
  if(input.revision!==r.quote.revision)throw new ApiError(409,'STALE_QUOTE','יש להשתמש בגרסה העדכנית.');
  if(!Number.isInteger(input.itemIndex)||!r.quote.items[input.itemIndex])throw invalid();
  const item=r.quote.items[input.itemIndex],id=variantId(input.variantId);
  if(item.status!=='ambiguous'||!item.candidates.some(c=>c.variantId===id))throw invalid('INVALID_SELECTION','יש לבחור מהאפשרויות שהוצגו.');
  r.state='pending';
  try{
   const current=(await this.shop.variants([id],buyer)).find(v=>v.variantId===id);
   if(!current)throw invalid('INVALID_VARIANT');
   const bestMatch=matched(current,item.requested.quantity),items=structuredClone(r.quote.items);
   items[input.itemIndex]={requested:item.requested,bestMatch,candidates:[bestMatch],confidence:1,
    status:purchasable(current,item.requested.quantity)?'matched':'unavailable',reason:'CUSTOMER_SELECTED_SHOPIFY_VARIANT'};
   r.quote=this.summarize(r.quote.quoteId,r.quote.revision+1,r.quote.expiresAt,items);return structuredClone(r.quote);
  }finally{r.state='open';}
 }
}
