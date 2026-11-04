import {isIP} from 'node:net';
import type {BuyerContext,CartLine,CartResult,CatalogVariant,SearchResults,StorefrontGateway} from '../domain/types.js';
import type {Config} from '../config.js';
import {ApiError,unavailable} from '../middleware/errors.js';
import {SEARCH,VARIANTS,CART_CREATE} from './queries.js';
import {minor} from '../shopping/money.js';
const id=(value:unknown,type:string)=>typeof value==='string'&&new RegExp('^gid://shopify/'+type+'/[1-9]\\d*$').test(value);
function variant(raw:any,product:any):CatalogVariant {
  if(!id(raw?.id,'ProductVariant')||!id(product?.id,'Product')||typeof product.title!=='string'||typeof product.handle!=='string'||
    typeof product.vendor!=='string'||typeof product.requiresSellingPlan!=='boolean'||typeof raw.title!=='string'||
    typeof raw.availableForSale!=='boolean'||typeof raw.requiresComponents!=='boolean'||
    typeof raw.price?.amount!=='string'||typeof raw.price?.currencyCode!=='string')throw unavailable();
  minor(raw.price);
  const rule=raw.quantityRule;
  if(!Number.isInteger(rule?.minimum)||rule.minimum<1||!Number.isInteger(rule.increment)||rule.increment<1||
     !(rule.maximum===null||(Number.isInteger(rule.maximum)&&rule.maximum>=rule.minimum)))throw unavailable();
  const image=raw.image?.url || product.featuredImage?.url;
  return {productId:product.id,variantId:raw.id,handle:product.handle,title:product.title,variantTitle:raw.title,
    vendor:product.vendor,imageUrl:typeof image==='string'&&image.startsWith('https://')?image:undefined,
    unitPrice:{amount:raw.price.amount,currencyCode:raw.price.currencyCode},availableForSale:raw.availableForSale,
    minimum:rule.minimum,maximum:rule.maximum,increment:rule.increment,requiresSellingPlan:product.requiresSellingPlan,requiresComponents:raw.requiresComponents};
}
export class ShopifyStorefrontClient implements StorefrontGateway {
  constructor(private config:Pick<Config,'domain'|'version'|'privateToken'>,private http:typeof fetch=fetch){}
  private async graphql(query:string,variables:Record<string,unknown>,buyer:BuyerContext={}):Promise<any>{
    const headers:Record<string,string>={'Content-Type':'application/json',Accept:'application/json'};
    if(this.config.privateToken)headers['Shopify-Storefront-Private-Token']=this.config.privateToken;
    if(buyer.ip&&isIP(buyer.ip))headers['Shopify-Storefront-Buyer-IP']=buyer.ip;
    try{
      const response=await this.http('https://'+this.config.domain+'/api/'+this.config.version+'/graphql.json',{
        method:'POST',headers,body:JSON.stringify({query,variables}),redirect:'error',signal:AbortSignal.timeout(12000)});
      if(response.status===429)throw new ApiError(429,'SHOPIFY_RATE_LIMITED','יש לנסות שוב בעוד רגע.');
      if(!response.ok)throw unavailable();
      const body=await response.json();
      if(body.errors?.length||!body.data)throw unavailable();
      return body.data;
    }catch(error){if(error instanceof ApiError)throw error;throw unavailable();}
  }
  async search(name:string,buyer?:BuyerContext):Promise<SearchResults>{
    // Strip search operators from customer text; use GraphQL variables, never interpolation.
    const query=name.replace(/[^\p{L}\p{N}\s.]/gu,' ').trim();
    const data=await this.graphql(SEARCH,{query},buyer),result=data.search;
    if(!Array.isArray(result?.nodes)||typeof result?.pageInfo?.hasNextPage!=='boolean')throw unavailable();
    const rows:CatalogVariant[]=[],truncatedVariantProductIds:string[]=[];let truncated=result.pageInfo.hasNextPage;
    for(const product of result.nodes){
      if(!Array.isArray(product?.variants?.nodes)||typeof product.variants.pageInfo?.hasNextPage!=='boolean')throw unavailable();
      truncated ||= product.variants.pageInfo.hasNextPage;
      if(product.variants.pageInfo.hasNextPage)truncatedVariantProductIds.push(product.id);
      for(const row of product.variants.nodes)rows.push(variant(row,product));
    }
    return {variants:rows,truncated,truncatedVariantProductIds};
  }
  async variants(ids:string[],buyer?:BuyerContext):Promise<CatalogVariant[]>{
    const data=await this.graphql(VARIANTS,{ids},buyer);
    if(!Array.isArray(data.nodes))throw unavailable();
    return data.nodes.filter((row:any)=>row!==null).map((row:any)=>variant(row,row.product));
  }
  async createCart(lines:CartLine[],buyer?:BuyerContext):Promise<CartResult>{
    // No retries: a timed-out mutation might already have created a cart.
    const data=await this.graphql(CART_CREATE,{input:{lines:lines.map(line=>({merchandiseId:line.variantId,quantity:line.quantity}))}},buyer);
    const result=data.cartCreate,cart=result?.cart;
    if(result?.userErrors?.length||!cart)throw new ApiError(409,'CART_REJECTED','Shopify לא אישר את הסל. יש לבדוק את הרשימה מחדש.');
    let checkout:URL;try{checkout=new URL(cart.checkoutUrl);}catch{throw unavailable();}
    if(checkout.protocol!=='https:'||checkout.username||checkout.password||typeof cart.id!=='string')throw unavailable();
    const actual=cart.lines?.nodes;
    if(!Array.isArray(actual)||actual.length!==lines.length||actual.some((row:any)=>!lines.some(line=>line.variantId===row.merchandise?.id&&line.quantity===row.quantity)))
      throw new ApiError(409,'CART_CHANGED','הרכב הסל השתנה. יש לבדוק שוב לפני התשלום.');
    if(!cart.cost?.subtotalAmount||!cart.cost?.totalAmount)throw unavailable();
    minor(cart.cost.subtotalAmount);minor(cart.cost.totalAmount);
    return {cartId:cart.id,checkoutUrl:cart.checkoutUrl,subtotal:cart.cost.subtotalAmount,total:cart.cost.totalAmount,
      warnings:(result.warnings || []).map((warning:any)=>String(warning.code))};
  }
}
