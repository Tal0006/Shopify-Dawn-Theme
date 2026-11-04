import type {CatalogVariant,StorefrontGateway,BuyerContext,CartLine,CartResult,SearchResults} from '../src/domain/types.js';
export const variant=(id='1',title='מרכך מקסימה בייבי',amount='15.90'):CatalogVariant=>({
 productId:'gid://shopify/Product/'+id,variantId:'gid://shopify/ProductVariant/'+id,handle:'product-'+id,title,variantTitle:'Default Title',vendor:'סנו',
 unitPrice:{amount,currencyCode:'ILS'},availableForSale:true,minimum:1,maximum:null,increment:1,requiresSellingPlan:false,requiresComponents:false
});
export class FakeShop implements StorefrontGateway{
 rows=[variant()];searchCalls=0;readCalls=0;cartCalls=0;buyer?:BuyerContext;sentLines?:CartLine[];error?:Error;
 async search(_name:string,buyer?:BuyerContext):Promise<SearchResults>{this.buyer=buyer;this.searchCalls++;if(this.error)throw this.error;return {variants:this.rows,truncated:false};}
 async variants(ids:string[],buyer?:BuyerContext){this.buyer=buyer;this.readCalls++;return this.rows.filter(row=>ids.includes(row.variantId));}
 async createCart(lines:CartLine[],buyer?:BuyerContext):Promise<CartResult>{this.buyer=buyer;this.cartCalls++;this.sentLines=lines;return {cartId:'gid://shopify/Cart/from-shopify',checkoutUrl:'https://checkout.example.com/from-shopify',subtotal:{amount:'31.80',currencyCode:'ILS'},total:{amount:'31.80',currencyCode:'ILS'},warnings:[]};}
}
