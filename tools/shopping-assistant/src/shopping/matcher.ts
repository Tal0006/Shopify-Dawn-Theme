import type {CatalogVariant,MatchResult,ParsedShoppingItem,SearchResults,MatchedProduct} from '../domain/types.js';
import {normalize} from './text.js';
import {multiply} from './money.js';
import {preferenceScore,satisfiesSize,semanticScore,sizePreferences} from './hebrew-query.js';
import {detectQueryIntent,detectProductIntent,satisfiesIntent} from './product-intent.js';
export function purchasable(variant:CatalogVariant,count:number) {
  return variant.availableForSale&&!variant.requiresSellingPlan&&!variant.requiresComponents&&count>=variant.minimum&&
    (variant.maximum===null||count<=variant.maximum)&&(count-variant.minimum)%variant.increment===0;
}
// Availability reorders candidates only within this relevance distance, never across larger gaps.
export const AVAILABILITY_RANK_MARGIN=0.1;
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
    const query=requested.requestedName;
    let ranked=results.variants.map(variant=>({
      variant,score:semanticScore(query,variant.title,variant.vendor,variant.variantTitle,variant.productType),
      preference:preferenceScore(query,variant.title,variant.vendor,variant.variantTitle),
      available:purchasable(variant,requested.quantity)
    })).filter(row=>row.score>=0.65);
    // A requested size narrows the results only when some relevant product states it.
    if(sizePreferences(query).length){
      const sized=ranked.filter(row=>satisfiesSize(query,row.variant.title,row.variant.variantTitle));
      if(sized.length)ranked=sized;
    }
    // Relevance first. Purchasable candidates rank ahead of unavailable ones that are equally or
    // nearly equally relevant; soft wishes ("ריח חזק") then break the remaining ties.
    const rank=(row:typeof ranked[number])=>row.score-(row.available?0:AVAILABILITY_RANK_MARGIN);
    const order=(a:number,b:number)=>Math.abs(a-b)<1e-9?0:b-a;
    ranked.sort((a,b)=>order(rank(a),rank(b))||Number(b.available)-Number(a.available)||order(a.score,b.score)||
      b.preference-a.preference||a.variant.variantId.localeCompare(b.variant.variantId));
    const relevant=ranked;
    const candidates=relevant.slice(0,10).map(row=>matched(row.variant,requested.quantity));
    const base={requested,candidates,confidence:Math.max(0,...ranked.map(row=>row.score))};
    if(!ranked.length)return {...base,status:'not_found',reason:'NO_RELEVANT_PRODUCT'};
    const queryIntent=detectQueryIntent(query);
    const strongSameIntent=ranked.filter(row=>row.score>=0.85&&satisfiesIntent(queryIntent,detectProductIntent(row.variant),row.variant.title));
    // Report stock state without asking the customer to choose an unbuyable item.
    // Do not claim a unique bestMatch when several products are involved.
    if(strongSameIntent.length&&ranked.every(row=>!purchasable(row.variant,requested.quantity)))
      return {...base,...(ranked.length===1?{bestMatch:candidates[0]}:{}),status:'unavailable',reason:'ALL_RELEVANT_MATCHES_UNAVAILABLE'};
    if(candidates.length!==1||results.truncated||base.confidence<0.85)return {...base,status:'ambiguous',reason:results.truncated||relevant.length>10?'RESULTS_TRUNCATED':'CUSTOMER_SELECTION_REQUIRED'};
    if(results.truncatedVariantProductIds?.includes(candidates[0].productId)||
      results.variants.filter(v=>v.productId===candidates[0].productId&&normalize(v.variantTitle)!=='default title').length>1)
      return {...base,status:'ambiguous',reason:'CUSTOMER_SELECTION_REQUIRED'};
    const bestMatch=candidates[0];
    return {...base,bestMatch,status:purchasable(bestMatch,requested.quantity)?'matched':'unavailable',reason:purchasable(bestMatch,requested.quantity)?'SEMANTIC_UNIQUE_MATCH':'NOT_PURCHASABLE'};
  }
}
