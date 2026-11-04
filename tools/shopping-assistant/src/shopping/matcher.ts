import type {CatalogVariant,MatchResult,ParsedShoppingItem,SearchResults,MatchedProduct} from '../domain/types.js';
import {normalize} from './parser.js';
import {multiply} from './money.js';
import {semanticScore} from './hebrew-query.js';
import {detectQueryIntent,detectProductIntent} from './product-intent.js';
export function purchasable(variant:CatalogVariant,count:number) {
  return variant.availableForSale&&!variant.requiresSellingPlan&&!variant.requiresComponents&&count>=variant.minimum&&
    (variant.maximum===null||count<=variant.maximum)&&(count-variant.minimum)%variant.increment===0;
}
export const matched=(variant:CatalogVariant,quantity:number):MatchedProduct=>({...structuredClone(variant),quantity,lineTotal:multiply(variant.unitPrice,quantity)});
export class ProductMatcher {
  match(requested:ParsedShoppingItem,results:SearchResults):MatchResult {
    const normalizedName=normalize(requested.requestedName);
    const meaningfulVariant=(v:CatalogVariant)=>normalize(v.variantTitle)!=='default title'&&normalize(v.variantTitle)!=='';
    // Exact identities outrank search pagination; missing variants still require selection.
    const exactTitle=results.variants.filter(v=>normalize(v.title)===normalizedName);
    const exact=exactTitle.length?exactTitle:results.variants.filter(v=>
      meaningfulVariant(v)&&normalize(v.title+' '+v.variantTitle)===normalizedName);
    if(exact.length){
      const candidates=exact.slice(0,10).map(v=>matched(v,requested.quantity));
      const base={requested,candidates,confidence:1};
      const products=new Set(exact.map(v=>v.productId));
      if(products.size!==1||exact.some(v=>results.truncatedVariantProductIds?.includes(v.productId)))
        return {...base,status:'ambiguous',reason:'CUSTOMER_SELECTION_REQUIRED'};
      const available=exact.filter(v=>purchasable(v,requested.quantity));
      // Multiple meaningful choices must never be hidden by choosing the first row.
      const meaningful=exact.filter(meaningfulVariant);
      if(available.length>1||meaningful.length>1||(!available.length&&exact.length>1))
        return {...base,status:'ambiguous',reason:'CUSTOMER_SELECTION_REQUIRED'};
      const bestMatch=matched(available[0] || exact[0],requested.quantity);
      return {...base,bestMatch,status:available.length?'matched':'unavailable',
        reason:available.length?'EXACT_TITLE_MATCH':'NOT_PURCHASABLE'};
    }
    const ranked=results.variants.map(variant=>({
      variant,score:semanticScore(requested.requestedName,variant.title,variant.vendor,variant.variantTitle)
    })).filter(row=>row.score>=0.65).sort((a,b)=>b.score-a.score||a.variant.variantId.localeCompare(b.variant.variantId));
    const relevant=ranked;
    const candidates=relevant.slice(0,10).map(row=>matched(row.variant,requested.quantity));
    const base={requested,candidates,confidence:ranked[0]?.score || 0};
    if(!ranked.length)return {...base,status:'not_found',reason:'NO_RELEVANT_PRODUCT'};
    const queryIntent=detectQueryIntent(requested.requestedName);
    const strongSameIntent=ranked.filter(row=>row.score>=0.85&&queryIntent!=='UNKNOWN'&&detectProductIntent(row.variant.title)===queryIntent);
    // Report stock state without asking the customer to choose an unbuyable item.
    // Do not claim a unique bestMatch when several products are involved.
    if(strongSameIntent.length&&ranked.every(row=>!purchasable(row.variant,requested.quantity)))
      return {...base,...(ranked.length===1?{bestMatch:candidates[0]}:{}),status:'unavailable',reason:'ALL_RELEVANT_MATCHES_UNAVAILABLE'};
    if(candidates.length!==1||results.truncated||ranked[0].score<0.85)return {...base,status:'ambiguous',reason:results.truncated||relevant.length>10?'RESULTS_TRUNCATED':'CUSTOMER_SELECTION_REQUIRED'};
    if(results.truncatedVariantProductIds?.includes(candidates[0].productId)||
      results.variants.filter(v=>v.productId===candidates[0].productId&&normalize(v.variantTitle)!=='default title').length>1)
      return {...base,status:'ambiguous',reason:'CUSTOMER_SELECTION_REQUIRED'};
    const bestMatch=candidates[0];
    return {...base,bestMatch,status:purchasable(bestMatch,requested.quantity)?'matched':'unavailable',reason:purchasable(bestMatch,requested.quantity)?'SEMANTIC_UNIQUE_MATCH':'NOT_PURCHASABLE'};
  }
}
