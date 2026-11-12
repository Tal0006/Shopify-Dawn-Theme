import {agorot,ApiError,type Line} from './domain.js';
import type {Config} from './config.js';
export interface ValidatedCart {total:bigint;snapshot:{variantId:string;quantity:number;unitAgorot:string}[]}
// One stored snapshot line re-checked against Shopify now. The stored price is for comparison only; any restore uses
// Shopify's current price because the shopper's cart is priced by Shopify at checkout.
export interface InspectedLine {
 variantId:string;title:string|null;quantity:number;storedUnitAgorot:number;currentUnitAgorot:number|null;
 available:boolean;restorableQuantity:number;maxAvailableQuantity:number|null;priceChanged:boolean;
 reason:'AVAILABLE'|'QUANTITY_REDUCED'|'UNAVAILABLE';
}
export interface SnapshotLine {variantId:string;quantity:number;unitAgorot:string}
export interface CartValidator {
 validate(lines:Line[]):Promise<ValidatedCart>;
 // Optional so lightweight validators (tests, legacy callers) keep working; without it, restore is unavailable.
 inspect?(snapshot:SnapshotLine[]):Promise<InspectedLine[]>;
}
const QUERY=`query GroupPledge($ids:[ID!]!) @inContext(country:IL) {
   nodes(ids:$ids){... on ProductVariant{id title availableForSale requiresComponents quantityAvailable price{amount currencyCode} quantityRule{minimum maximum increment} product{title requiresSellingPlan}}}
  }`;
const numericId=(gid:string)=>gid.replace('gid://shopify/ProductVariant/','');
export class Shopify implements CartValidator{
 constructor(private config:Pick<Config,'domain'|'version'|'token'>,private http:typeof fetch=fetch){}
 private async variants(ids:string[]):Promise<any[]>{
  try{
   const response=await this.http('https://'+this.config.domain+'/api/'+this.config.version+'/graphql.json',{method:'POST',headers:{'Content-Type':'application/json','Shopify-Storefront-Private-Token':this.config.token},body:JSON.stringify({query:QUERY,variables:{ids}}),signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!response.ok)throw Error();
   const body=await response.json();if(body.errors?.length||!Array.isArray(body.data?.nodes))throw Error();return body.data.nodes;
  }catch{throw new ApiError(503,'SHOPIFY_UNAVAILABLE','לא ניתן לאמת את הסל כרגע. נסו שוב מאוחר יותר.');}
 }
 async validate(lines:Line[]):Promise<ValidatedCart>{
  const nodes=await this.variants(lines.map(line=>line.variantId));
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
 // Same Shopify checks as validate(), per line and without throwing: the largest quantity up to the stored one that
 // Shopify would accept now (stock, maximum, minimum and increment), the current price and whether it changed.
 async inspect(snapshot:SnapshotLine[]):Promise<InspectedLine[]>{
  const lines=snapshot.filter(line=>typeof line?.variantId==='string'&&/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/.test(line.variantId)&&Number.isInteger(line.quantity)&&line.quantity>0);
  if(!lines.length)return [];
  const nodes=await this.variants(lines.map(line=>line.variantId));
  return lines.map(line=>{
   const variant=nodes.find(node=>node?.id===line.variantId),rule=variant?.quantityRule;
   const stored=/^\d{1,12}$/.test(String(line.unitAgorot))?Number(line.unitAgorot):0;
   let current:number|null=null;
   try{if(variant?.price?.currencyCode==='ILS')current=Number(agorot(variant.price.amount));}catch{current=null;}
   const sellable=!!variant&&variant.availableForSale===true&&variant.requiresComponents===false&&variant.product?.requiresSellingPlan===false&&current!==null&&current>0&&
    Number.isInteger(rule?.minimum)&&rule.minimum>=1&&Number.isInteger(rule.increment)&&rule.increment>=1&&(rule.maximum===null||Number.isInteger(rule.maximum))&&
    (variant.quantityAvailable===null||Number.isInteger(variant.quantityAvailable));
   let restorable=0;
   if(sellable){
    let max=line.quantity;
    if(rule.maximum!==null)max=Math.min(max,rule.maximum);
    if(variant.quantityAvailable!==null)max=Math.min(max,variant.quantityAvailable);
    restorable=max<rule.minimum?0:rule.minimum+Math.floor((max-rule.minimum)/rule.increment)*rule.increment;
   }
   const title=variant?[variant.product?.title,variant.title&&variant.title!=='Default Title'?variant.title:null].filter(Boolean).join(' – ')||null:null;
   return {
    variantId:numericId(line.variantId),title,quantity:line.quantity,storedUnitAgorot:stored,currentUnitAgorot:current,
    available:restorable>0,restorableQuantity:restorable,
    maxAvailableQuantity:sellable&&variant.quantityAvailable!==null?variant.quantityAvailable:null,
    priceChanged:current!==null&&current!==stored,
    reason:restorable<=0?'UNAVAILABLE':restorable<line.quantity?'QUANTITY_REDUCED':'AVAILABLE'
   };
  });
 }
}
