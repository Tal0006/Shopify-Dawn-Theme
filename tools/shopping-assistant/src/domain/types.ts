export interface Money { amount:string; currencyCode:string }
export interface ParsedShoppingItem { originalText:string; requestedName:string; quantity:number }
export interface CatalogVariant {
  productId:string; variantId:string; handle:string; title:string; variantTitle:string; vendor:string;
  imageUrl?:string; unitPrice:Money; availableForSale:boolean;
  minimum:number; increment:number; maximum:number|null; requiresSellingPlan:boolean; requiresComponents:boolean;
}
export interface SearchResults { variants:CatalogVariant[]; truncated:boolean; truncatedVariantProductIds?:string[] }
export interface MatchedProduct extends CatalogVariant { quantity:number; lineTotal:Money }
export interface MatchResult {
  status:'matched'|'ambiguous'|'not_found'|'unavailable';
  requested:ParsedShoppingItem; bestMatch?:MatchedProduct; candidates:MatchedProduct[];
  confidence:number; reason:string;
}
export interface ShoppingQuote {
  quoteId:string; revision:number; expiresAt:string; items:MatchResult[]; resolvedItems:MatchedProduct[];
  ambiguousItems:MatchResult[]; notFoundItems:MatchResult[]; unavailableItems:MatchResult[];
  subtotal:Money|null; currencyCode:string|null; subtotalLabel:string; canCheckout:boolean;
}
export interface CartLine { variantId:string; quantity:number }
export interface CartResult { cartId:string; checkoutUrl:string; subtotal:Money; total:Money; warnings:string[] }
export interface BuyerContext { ip?:string }
export interface StorefrontGateway {
  search(name:string,buyer?:BuyerContext):Promise<SearchResults>;
  variants(ids:string[],buyer?:BuyerContext):Promise<CatalogVariant[]>;
  createCart(lines:CartLine[],buyer?:BuyerContext):Promise<CartResult>;
}
export interface QuoteRecord { quote:ShoppingQuote; state:'open'|'pending'|'complete'|'uncertain'; cart?:CartResult }
