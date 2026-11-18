import {ShopifyAdminAuth,ShopifyAuthError} from './shopify-auth.js';
// The single Shopify GraphQL Admin boundary for Group Delivery orders (Dev Dashboard app, client credentials grant,
// scope write_orders; see shopify-auth.ts).
// Every Cardcom charge of a group member is preceded by exactly one Shopify order that represents the explicitly
// approved pledge; after Cardcom succeeds, the payment is recorded on that order (it shows as Paid).
//
// Mutations used (Admin GraphQL, version SHOPIFY_ADMIN_API_VERSION, default 2026-10):
//  - orderCreate(order: OrderCreateOrderInput!, options: OrderCreateOptionsInput)        create the unpaid order
//  - orderCreateManualPayment(id, paymentMethodName, processedAt)                      record the Cardcom payment
//  - tagsAdd(id, tags)                                                                  Cardcom transaction reference
//  - orderCancel(orderId, reason: DECLINED, restock: true, notifyCustomer: false)        release stock after a FAILED charge
// Queries: orders(first:1, query:"tag:...") to find an order whose creation answer was lost; order(id) for its status.
// Nothing here ever receives a Cardcom token, card data or Cardcom credentials. Errors are fixed and contain no bodies.
export interface ShopifyAdminSettings {domain:string;clientId:string;clientSecret:string;version:string;test:boolean}
// AUTH: no usable access token (credentials rejected, missing write_orders, token endpoint down, or a request still
// rejected with 401 after one fresh token). Nothing was executed; the caller fails closed (no order, no charge).
export type OrderErrorKind='TIMEOUT'|'NETWORK'|'HTTP'|'INVALID_RESPONSE'|'NOT_EXECUTED'|'AUTH';
// Ambiguous (Shopify may or may not have acted): TIMEOUT, NETWORK, HTTP 5xx, INVALID_RESPONSE.
// NOT_EXECUTED (HTTP 429 or a top-level GraphQL error such as throttling or access denied): the request was not executed and may be retried later.
export class ShopifyOrderError extends Error {
 constructor(public kind:OrderErrorKind,public operation:string){super('Shopify '+operation+' '+kind);this.name='ShopifyOrderError';}
 get ambiguous(){return this.kind!=='NOT_EXECUTED'&&this.kind!=='AUTH';}
}
export interface OrderLine {variantId:string;quantity:number;unitAgorot:bigint}
export interface OrderDraft {
 /** Our charge reference (the Cardcom ExternalUniqTranId); also a unique tag used to find the order again. */
 reference:string;
 groupPublicId:string;areaName:string;
 // No customer contact data: the store plan (Basic) has no Level 2 protected customer data access, and the order does
 // not need it. Email and phone stay in the Group Delivery database only.
 lines:OrderLine[];
 totalAgorot:bigint;
}
export type CreatedOrder={id:string;name:string;createdAt:string;totalAgorot:bigint;currency:string};
export type OrderState={financialStatus:string;outstandingAgorot:bigint;cancelledAt:string|null};
export type OrderCreateOutcome={state:'CREATED';order:CreatedOrder}|{state:'REJECTED';code:string};
export interface OrderGateway {
 createOrder(draft:OrderDraft):Promise<OrderCreateOutcome>;
 findOrderByReference(reference:string):Promise<CreatedOrder|null>;
 orderState(orderId:string):Promise<OrderState>;
 cancelOrder(orderId:string):Promise<void>;
 recordExternalPayment(orderId:string,processedAt:Date):Promise<void>;
 addTags(orderId:string,tags:string[]):Promise<void>;
}
export const ORDER_TAGS=(groupPublicId:string,reference:string)=>['group-delivery','group:'+groupPublicId,referenceTag(reference)];
export const referenceTag=(reference:string)=>'gd-charge-'+reference;
export const PAYMENT_METHOD_NAME='Cardcom (Group Delivery)';
const ORDER_ID=/^gid:\/\/shopify\/Order\/[1-9]\d{0,19}$/;
const money=(agorot:bigint)=>(agorot/100n).toString()+'.'+(agorot%100n).toString().padStart(2,'0');
const agorotOf=(amount:unknown)=>{
 if(typeof amount!=='string'||!/^\d{1,9}(\.\d{1,2})?$/.test(amount))return null;
 const [whole,fraction='']=amount.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
};
const ORDER_FIELDS='id name createdAt totalPriceSet{shopMoney{amount currencyCode}}';
const CREATE=`mutation GroupDeliveryOrderCreate($order:OrderCreateOrderInput!,$options:OrderCreateOptionsInput){orderCreate(order:$order,options:$options){order{${ORDER_FIELDS} displayFinancialStatus} userErrors{field message code}}}`;
const FIND=`query GroupDeliveryOrderByReference($query:String!){orders(first:2,query:$query){nodes{${ORDER_FIELDS} tags}}}`;
const STATUS=`query GroupDeliveryOrderStatus($id:ID!){order(id:$id){id displayFinancialStatus cancelledAt totalOutstandingSet{shopMoney{amount currencyCode}}}}`;
// No refund argument: nothing was paid (the Cardcom charge failed). refund is deprecated; refundMethod is omitted.
const CANCEL=`mutation GroupDeliveryOrderCancel($orderId:ID!,$staffNote:String){orderCancel(orderId:$orderId,reason:DECLINED,restock:true,notifyCustomer:false,staffNote:$staffNote){job{id done} orderCancelUserErrors{field message code}}}`;
const PAY=`mutation GroupDeliveryOrderPaid($id:ID!,$paymentMethodName:String,$processedAt:DateTime){orderCreateManualPayment(id:$id,paymentMethodName:$paymentMethodName,processedAt:$processedAt){order{id displayFinancialStatus} userErrors{field message}}}`;
const TAGS=`mutation GroupDeliveryOrderTags($id:ID!,$tags:[String!]!){tagsAdd(id:$id,tags:$tags){node{id} userErrors{field message}}}`;
export class ShopifyOrders implements OrderGateway {
 private auth:ShopifyAdminAuth;
 constructor(private settings:ShopifyAdminSettings,private http:typeof fetch=fetch,private timeoutMs=15000,auth?:ShopifyAdminAuth){
  this.auth=auth??new ShopifyAdminAuth({domain:settings.domain,clientId:settings.clientId,clientSecret:settings.clientSecret},http,timeoutMs);
 }
 private async token(operation:string){
  try{return await this.auth.accessToken();}
  catch(error){if(error instanceof ShopifyAuthError)throw new ShopifyOrderError('AUTH',operation);throw error;}
 }
 // A 401 means the token was not accepted (e.g. expired early): drop it, get one fresh token and retry once. A second
 // 401 fails (AUTH) instead of looping. A 401 request is never executed, so the retry cannot duplicate anything.
 private async graphql(operation:string,query:string,variables:Record<string,unknown>,retried=false):Promise<any>{
  const token=await this.token(operation);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  let response:Response;
  try{
   response=await this.http('https://'+this.settings.domain+'/admin/api/'+this.settings.version+'/graphql.json',{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/json',Accept:'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables})});
  }catch{clearTimeout(timer);throw new ShopifyOrderError(controller.signal.aborted?'TIMEOUT':'NETWORK',operation);}
  if(response.status===401){
   clearTimeout(timer);this.auth.invalidate(token);
   if(retried)throw new ShopifyOrderError('AUTH',operation);
   return this.graphql(operation,query,variables,true);
  }
  try{
   if(response.status===429)throw new ShopifyOrderError('NOT_EXECUTED',operation);
   if(!response.ok)throw new ShopifyOrderError('HTTP',operation);
   let body:any;try{body=await response.json();}catch{throw new ShopifyOrderError(controller.signal.aborted?'TIMEOUT':'INVALID_RESPONSE',operation);}
   // Top-level GraphQL errors (throttling, access denied, invalid query) mean the operation was not executed.
   if(Array.isArray(body?.errors)&&body.errors.length)throw new ShopifyOrderError('NOT_EXECUTED',operation);
   if(!body?.data||typeof body.data!=='object')throw new ShopifyOrderError('INVALID_RESPONSE',operation);
   return body.data;
  }finally{clearTimeout(timer);}
 }
 private order(node:any,operation:string):CreatedOrder{
  const total=agorotOf(node?.totalPriceSet?.shopMoney?.amount),currency=node?.totalPriceSet?.shopMoney?.currencyCode;
  if(typeof node?.id!=='string'||!ORDER_ID.test(node.id)||typeof node.name!=='string'||!node.name||node.name.length>40||typeof node.createdAt!=='string'||total===null||typeof currency!=='string')
   throw new ShopifyOrderError('INVALID_RESPONSE',operation);
  return {id:node.id,name:node.name,createdAt:node.createdAt,totalAgorot:total,currency};
 }
 async createOrder(draft:OrderDraft):Promise<OrderCreateOutcome>{
  const data=await this.graphql('orderCreate',CREATE,{
   order:{
    // Business data only: no email, phone, name, shipping or billing address (and none in note, tags or attributes).
    currency:'ILS',
    // The approved pledge, priced with the stored (approved) unit prices; never prices from a browser.
    lineItems:draft.lines.map(line=>({variantId:line.variantId,quantity:line.quantity,requiresShipping:true,priceSet:{shopMoney:{amount:money(line.unitAgorot),currencyCode:'ILS'}}})),
    // Unpaid until the Cardcom charge succeeds and is recorded with orderCreateManualPayment.
    financialStatus:'PENDING',
    // Storefront prices are VAT-inclusive (ILS); the order total must equal the approved pledge exactly.
    taxesIncluded:true,
    tags:ORDER_TAGS(draft.groupPublicId,draft.reference),
    note:'משלוח קבוצתי · '+draft.areaName+' · קבוצה '+draft.groupPublicId,
    customAttributes:[{key:'group_delivery_group',value:draft.groupPublicId},{key:'group_delivery_area',value:draft.areaName},{key:'group_delivery_charge_reference',value:draft.reference}],
    sourceIdentifier:draft.reference,
    // No shipping line: Group Delivery defines no shipping price (the store arranges the group delivery), and no
    // shipping address is collected (only the delivery area, kept in the note and attributes).
    ...(this.settings.test?{test:true}:{})
   },
   // Inventory is claimed following each product's policy; an item that cannot be sold any more fails the order,
   // so nobody is charged for it. Customer emails are not sent by Shopify for these orders.
   options:{inventoryBehaviour:'DECREMENT_OBEYING_POLICY',sendReceipt:false,sendFulfillmentReceipt:false}
  });
  const payload=data.orderCreate;
  if(!payload||!Array.isArray(payload.userErrors))throw new ShopifyOrderError('INVALID_RESPONSE','orderCreate');
  if(payload.userErrors.length){
   const code=String(payload.userErrors[0]?.code||'ORDER_REJECTED').toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,40)||'ORDER_REJECTED';
   return {state:'REJECTED',code};
  }
  return {state:'CREATED',order:this.order(payload.order,'orderCreate')};
 }
 async findOrderByReference(reference:string):Promise<CreatedOrder|null>{
  const tag=referenceTag(reference);
  const data=await this.graphql('orders',FIND,{query:"tag:'"+tag+"'"});
  const nodes=data.orders?.nodes;
  if(!Array.isArray(nodes))throw new ShopifyOrderError('INVALID_RESPONSE','orders');
  const matches=nodes.filter((node:any)=>Array.isArray(node?.tags)&&node.tags.includes(tag));
  if(matches.length>1)throw new ShopifyOrderError('INVALID_RESPONSE','orders');
  return matches.length?this.order(matches[0],'orders'):null;
 }
 async orderState(orderId:string):Promise<OrderState>{
  if(!ORDER_ID.test(orderId))throw Error('Invalid order id');
  const data=await this.graphql('order',STATUS,{id:orderId});
  const order=data.order,status=order?.displayFinancialStatus,outstanding=agorotOf(order?.totalOutstandingSet?.shopMoney?.amount);
  if(typeof status!=='string'||outstanding===null||(order.cancelledAt!==null&&typeof order.cancelledAt!=='string'))throw new ShopifyOrderError('INVALID_RESPONSE','order');
  return {financialStatus:status,outstandingAgorot:outstanding,cancelledAt:order.cancelledAt};
 }
 // Cancels an unpaid order and restocks its items. Shopify cancels asynchronously (a job); callers confirm completion
 // with orderState().cancelledAt. Any user error (e.g. already canceled, not cancelable) is reported as an error.
 async cancelOrder(orderId:string){
  if(!ORDER_ID.test(orderId))throw Error('Invalid order id');
  const data=await this.graphql('orderCancel',CANCEL,{orderId,staffNote:'Group Delivery: Cardcom charge failed; nothing was charged.'});
  const payload=data.orderCancel;
  if(!payload||!Array.isArray(payload.orderCancelUserErrors)||payload.orderCancelUserErrors.length)throw new ShopifyOrderError('INVALID_RESPONSE','orderCancel');
 }
 async recordExternalPayment(orderId:string,processedAt:Date){
  if(!ORDER_ID.test(orderId))throw Error('Invalid order id');
  const data=await this.graphql('orderCreateManualPayment',PAY,{id:orderId,paymentMethodName:PAYMENT_METHOD_NAME,processedAt:processedAt.toISOString()});
  const payload=data.orderCreateManualPayment;
  if(!payload||!Array.isArray(payload.userErrors)||payload.userErrors.length)throw new ShopifyOrderError('INVALID_RESPONSE','orderCreateManualPayment');
 }
 async addTags(orderId:string,tags:string[]){
  if(!ORDER_ID.test(orderId))throw Error('Invalid order id');
  const data=await this.graphql('tagsAdd',TAGS,{id:orderId,tags});
  const payload=data.tagsAdd;
  if(!payload||!Array.isArray(payload.userErrors)||payload.userErrors.length)throw new ShopifyOrderError('INVALID_RESPONSE','tagsAdd');
 }
}
