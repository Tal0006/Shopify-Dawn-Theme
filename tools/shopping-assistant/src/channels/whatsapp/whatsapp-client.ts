import type {WhatsAppConfig,WhatsAppTransport,ReplyButton,ListRow} from './whatsapp-types.js';
export class WhatsAppClient implements WhatsAppTransport {
 constructor(private config:WhatsAppConfig,private http:typeof fetch=fetch){}
 private async send(to:string,message:Record<string,unknown>):Promise<void>{
  if(!/^\d{7,20}$/.test(to))throw Error('WHATSAPP_RECIPIENT_INVALID');
  try{
   const result=await this.http('https://graph.facebook.com/'+this.config.graphVersion+'/'+this.config.phoneNumberId+'/messages',{
    method:'POST',headers:{Authorization:'Bearer '+this.config.accessToken,'Content-Type':'application/json'},
    body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to,...message}),
    redirect:'error',signal:AbortSignal.timeout(12000)
   });
   if(!result.ok)throw Error('WHATSAPP_SEND_FAILED');
   // No automatic retries: the send may already have succeeded.
  }catch{throw Error('WHATSAPP_SEND_FAILED');}
 }
 async sendText(to:string,text:string){
  // Preserve line boundaries where possible, and cap each message below Meta's limit.
  let remaining=text;
  while(remaining.length){
   let end=Math.min(3500,remaining.length);
   if(end<remaining.length){const newline=remaining.lastIndexOf('\n',end);if(newline>0)end=newline;}
   await this.send(to,{type:'text',text:{preview_url:false,body:remaining.slice(0,end)}});
   remaining=remaining.slice(end).replace(/^\n/,'');
  }
 }
 async sendReplyButtons(to:string,text:string,buttons:ReplyButton[]){
  if(!buttons.length||buttons.length>3||buttons.some(b=>b.title.length>20||b.id.length>200))throw Error('WHATSAPP_BUTTON_INVALID');
  await this.send(to,{type:'interactive',interactive:{type:'button',body:{text:text.slice(0,900)},action:{
   buttons:buttons.map(b=>({type:'reply',reply:b}))
  }}});
 }
 async sendListMessage(to:string,text:string,button:string,rows:ListRow[]){
  if(!rows.length||rows.length>10)throw Error('WHATSAPP_LIST_INVALID');
  await this.send(to,{type:'interactive',interactive:{type:'list',body:{text:text.slice(0,900)},action:{
   button:button.slice(0,20),sections:[{rows:rows.map(r=>({id:r.id,title:r.title.slice(0,24),...(r.description?{description:r.description.slice(0,72)}:{})}))}]
  }}});
 }
}
