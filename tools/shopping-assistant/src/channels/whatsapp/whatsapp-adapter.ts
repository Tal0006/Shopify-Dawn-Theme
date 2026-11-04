import {randomUUID} from 'node:crypto';
import type {ShoppingQuote} from '../../domain/types.js';
import {ApiError} from '../../middleware/errors.js';
import {normalize} from '../../shopping/parser.js';
import {purchasable} from '../../shopping/matcher.js';
import type {QuoteService} from '../../shopping/quote-service.js';
import type {CheckoutService} from '../../shopping/checkout-service.js';
import type {InboundMessage,WhatsAppSessionStore,WhatsAppSession,SessionAction,WhatsAppTransport,ListRow} from './whatsapp-types.js';
import {intro,renderQuote,productLabel,money,clean} from './whatsapp-renderer.js';

export class WhatsAppAdapter {
 private queue:InboundMessage[]=[];private active=new Set<string>();private workers=0;
 constructor(private quotes:QuoteService,private checkout:CheckoutService,private client:WhatsAppTransport,
  private sessions:WhatsAppSessionStore,private now=Date.now){}
 enqueue(message:InboundMessage):boolean {
  if(this.queue.length>=100)return false;
  try{
   if(!this.sessions.claimMessage(message.id))return true;
   if(!this.sessions.allow(message.from))return true;
   this.queue.push(message);setImmediate(()=>this.pump());return true;
  }catch{return false;}
 }
 private pump(){
  while(this.workers<4){
   const index=this.queue.findIndex(m=>!this.active.has(m.from));if(index<0)return;
   const message=this.queue.splice(index,1)[0];this.active.add(message.from);this.workers++;
   void this.handle(message).catch(()=>{
    // Deliberately exclude error objects, customer identifiers, bodies and credentials.
    console.warn('WhatsApp processing failed');
   }).finally(()=>{this.active.delete(message.from);this.workers--;this.pump();});
  }
 }
 async idle():Promise<void>{
  while(this.queue.length||this.workers)await new Promise<void>(resolve=>setTimeout(resolve,5));
 }
 private fresh(message:InboundMessage):WhatsAppSession {
  return {state:'WAITING_FOR_LIST',unresolvedItems:[],lastProcessedMessageId:message.id,
   expiresAt:this.now()+900000,actions:{}};
 }
 private action(s:WhatsAppSession,kind:SessionAction['kind'],extra:Partial<SessionAction>={}){
  const id=randomUUID();
  s.actions[id]={kind,quoteId:s.quoteId!,revision:s.revision!,...extra};return id;
 }
 private async show(to:string,s:WhatsAppSession,quote:ShoppingQuote){
  s.quoteId=quote.quoteId;s.revision=quote.revision;s.expiresAt=Date.parse(quote.expiresAt);s.actions={};
  s.unresolvedItems=quote.items.flatMap((item,i)=>item.status==='matched'?[]:[i]);
  const nextState=quote.canCheckout?'WAITING_FOR_CONFIRMATION':'WAITING_FOR_RESOLUTION';
  // Confirm only after the current summary and controls have been delivered.
  s.state='WAITING_FOR_RESOLUTION';
  const buttons=quote.canCheckout?[
   {id:this.action(s,'confirm'),title:'אישור'},
   {id:this.action(s,'edit'),title:'שינוי הרשימה'},
   {id:this.action(s,'cancel'),title:'ביטול'}
  ]:null;
  const index=s.unresolvedItems[0],item=quote.items[index];
  let rows:ListRow[]=[];
  if(item){
   if(item.status==='ambiguous')rows=item.candidates.filter(p=>purchasable(p,p.quantity)).slice(0,9).map((p,i)=>({
    id:this.action(s,'resolve',{itemIndex:index,variantId:p.variantId}),
    title:(i+1)+'. '+productLabel(p).slice(0,20),description:(money(p.unitPrice)+' — '+productLabel(p)).slice(0,72)
   }));
   rows.push({id:this.action(s,'remove',{itemIndex:index}),title:'הסר מהרשימה'});
  }
  this.sessions.set(to,s);
  await this.client.sendText(to,renderQuote(quote));
  if(buttons)await this.client.sendReplyButtons(to,'רשימת הקניות מוכנה. לא ייווצר סל לפני אישור מפורש.',buttons);
  else if(item){
   await this.client.sendListMessage(to,(item.status==='ambiguous'?'לאיזה מוצר התכוונת? ':'טיפול בפריט: ')+clean(item.requested.originalText),'בחירת אפשרות',rows);
   await this.client.sendText(to,'אפשר גם לשלוח "שינוי" ורשימה מעודכנת, או "ביטול".');
  }
  s.state=nextState;this.sessions.set(to,s);
 }
 private async confirm(to:string,s:WhatsAppSession){
  if(s.state==='CHECKOUT_READY'&&s.checkoutUrl){
   await this.client.sendText(to,'ההזמנה מוכנה 🎉\nלתשלום מאובטח ב-Shopify:\n'+s.checkoutUrl);return;
  }
  if(s.state!=='WAITING_FOR_CONFIRMATION'||!s.quoteId)return this.client.sendText(to,'יש להשלים את הרשימה לפני אישור. אפשר לשלוח "שינוי".');
  const quote=this.quotes.get(s.quoteId).quote;
  if(quote.revision!==s.revision||!quote.canCheckout)throw new ApiError(409,'STALE_QUOTE','');
  let url:string;
  try{
   const cart=await this.checkout.checkout({quoteId:s.quoteId,revision:s.revision,confirmed:true,
    lines:quote.resolvedItems.map(p=>({variantId:p.variantId,quantity:p.quantity}))});
   const parsed=new URL(cart.checkoutUrl);
   if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('INVALID_CHECKOUT');
   url=parsed.href;
  }catch(error){
   if(error instanceof ApiError&&error.code==='QUOTE_CHANGED'&&error.quote){
    await this.client.sendText(to,'המחיר או הזמינות השתנו מאז שהכנו את הרשימה.\nעדכנתי את הרשימה — צריך אישור מחדש.');
    await this.show(to,s,error.quote as ShoppingQuote);return;
   }
   s.state='CHECKOUT_UNCERTAIN';s.actions={};this.sessions.set(to,s);
   await this.client.sendText(to,'לא ניתן לוודא אם נוצר סל. אין לנסות שוב את אותו אישור. שלחו "שינוי" להכנת רשימה חדשה.');return;
  }
  // Save success before delivery: a failed outbound send must not recreate the cart.
  s.state='CHECKOUT_READY';s.checkoutUrl=url;s.actions={};this.sessions.set(to,s);
  await this.client.sendText(to,'ההזמנה מוכנה 🎉\n\nלתשלום מאובטח ב-Shopify:\n'+url);
 }
 private async handle(message:InboundMessage){
  const to=message.from,text=normalize(message.text||'');
  let s=this.sessions.get(to)||this.fresh(message);s.lastProcessedMessageId=message.id;this.sessions.set(to,s);
  try{
   if(['ביטול','❌ ביטול'].includes(text)){
    this.sessions.delete(to);await this.client.sendText(to,'הרשימה בוטלה. שלחו "התחלה" להזמנה חדשה.');return;
   }
   if(['היי','שלום','תפריט','הזמנה','התחלה'].includes(text)){
    s=this.fresh(message);this.sessions.set(to,s);await this.client.sendText(to,intro);return;
   }
   if(['שינוי','שינוי הרשימה'].includes(text)){
    s=this.fresh(message);this.sessions.set(to,s);await this.client.sendText(to,'שלחו את רשימת הקניות המעודכנת במלואה, כל מוצר בשורה נפרדת.');return;
   }
   if(message.replyId){
    const action=Object.hasOwn(s.actions,message.replyId)?s.actions[message.replyId]:undefined;
    if(!action||action.quoteId!==s.quoteId||action.revision!==s.revision){
     await this.client.sendText(to,'הבחירה אינה עדכנית. השתמשו באפשרויות האחרונות או שלחו "שינוי".');return;
    }
    if(action.kind==='cancel'){this.sessions.delete(to);await this.client.sendText(to,'הרשימה בוטלה.');return;}
    if(action.kind==='edit'){s=this.fresh(message);this.sessions.set(to,s);await this.client.sendText(to,'שלחו רשימה מעודכנת במלואה.');return;}
    if(action.kind==='confirm'){await this.confirm(to,s);return;}
    const quote=this.quotes.get(s.quoteId).quote;
    if(quote.revision!==s.revision)throw new ApiError(409,'STALE_QUOTE','');
    if(action.kind==='resolve'){
     await this.show(to,s,await this.quotes.resolve({quoteId:s.quoteId,revision:s.revision,itemIndex:action.itemIndex,variantId:action.variantId}));return;
    }
    if(action.kind==='remove'){await this.remove(to,s,action.itemIndex!);return;}
   }
   if(text==='אישור'){await this.confirm(to,s);return;}
   if(text==='הסר מהרשימה'){
    if(s.unresolvedItems.length)await this.remove(to,s,s.unresolvedItems[0]);
    else await this.client.sendText(to,'אין פריט מסומן להסרה. שלחו "שינוי" לעריכת הרשימה.');
    return;
   }
   if(!message.text||!text){this.sessions.set(to,s);await this.client.sendText(to,intro);return;}
   if(s.state!=='WAITING_FOR_LIST'){
    await this.client.sendText(to,'לעריכת הרשימה שלחו "שינוי". לבחירה השתמשו באפשרויות האחרונות.');return;
   }
   await this.show(to,s,await this.quotes.create(message.text));
  }catch(error){
   if(error instanceof ApiError&&['QUOTE_EXPIRED','STALE_QUOTE'].includes(error.code)){
    this.sessions.set(to,this.fresh(message));await this.client.sendText(to,'הרשימה פגה או השתנתה. שלחו רשימה חדשה.');return;
   }
   // Validation/search failures leave the conversation recoverable; no exception data is sent.
   await this.client.sendText(to,'לא הצלחנו להכין את הרשימה כרגע. שלחו "שינוי" ונסו שוב בעוד רגע.');
  }
 }
 private async remove(to:string,s:WhatsAppSession,index:number){
  const quote=this.quotes.get(s.quoteId).quote;
  if(quote.revision!==s.revision)throw new ApiError(409,'STALE_QUOTE','');
  const lines=quote.items.filter((_,i)=>i!==index).map(i=>i.requested.originalText);
  if(!lines.length){this.sessions.delete(to);await this.client.sendText(to,'הרשימה ריקה. שלחו רשימת קניות חדשה.');return;}
  await this.show(to,s,await this.quotes.create(lines.join('\n')));
 }
}
