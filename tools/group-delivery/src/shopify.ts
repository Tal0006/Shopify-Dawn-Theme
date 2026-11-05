
import {agorot,ApiError,type Line} from './domain.js';
import type {Config} from './config.js';
export interface ValidatedCart {total:bigint;snapshot:{variantId:string;quantity:number;unitAgorot:string}[]}
export interface CartValidator {validate(lines:Line[]):Promise<ValidatedCart>}
export class Shopify implements CartValidator{
 constructor(private config:Pick<Config,'domain'|'version'|'token'>,private http:typeof fetch=fetch){}
 async validate(lines:Line[]):Promise<ValidatedCart>{
  const query=`query GroupPledge($ids:[ID!]!) @inContext(country:IL) {
   nodes(ids:$ids){... on ProductVariant{id availableForSale requiresComponents quantityAvailable price{amount currencyCode} quantityRule{minimum maximum increment} product{requiresSellingPlan}}}
  }`;
  let nodes:any[];
  try{
   const response=await this.http('https://'+this.config.domain+'/api/'+this.config.version+'/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','Shopify-Storefront-Private-Token':this.config.token},body:JSON.stringify({query,variables:{ids:lines.map(line=>line.variantId)}}),signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!response.ok)throw Error();
   const body=await response.json();if(body.errors?.length||!Array.isArray(body.data?.nodes))throw Error();nodes=body.data.nodes;
  }catch{throw new ApiError(503,'SHOPIFY_UNAVAILABLE','לא ניתן לאמת את הסל כרגע. נסו שוב מאוחר יותר.');}
  let total=0n;
  const snapshot=lines.map(line=>{
   const variant=nodes.find(node=>node?.id===line.variantId),rule=variant?.quantityRule;
   if(!variant||variant.availableForSale!==true||variant.requiresComponents!==false||variant.product?.requiresSellingPlan!==false||!Number.isInteger(rule?.minimum)||rule.minimum<1||!Number.isInteger(rule.increment)||rule.increment<1||line.quantity<rule.minimum||line.quantity%rule.increment!==rule.minimum%rule.increment||(rule.maximum!==null&&(!Number.isInteger(rule.maximum)||line.quantity>rule.maximum))||(variant.quantityAvailable!==null&&(!Number.isInteger(variant.quantityAvailable)||line.quantity>variant.quantityAvailable))||variant.price?.currencyCode!=='ILS')throw new ApiError(422,'CART_UNAVAILABLE','הסל כולל מוצר שאינו זמין או שאינו מתאים להתחייבות. יש לעדכן את הסל.');
   const unit=agorot(variant.price.amount);total+=unit*BigInt(line.quantity);
   return {...line,unitAgorot:unit.toString()};
  });
  if(total<=0n||total>100000000n)throw new ApiError(422,'INVALID_CART_TOTAL');
  return {total,snapshot};
 }
}
