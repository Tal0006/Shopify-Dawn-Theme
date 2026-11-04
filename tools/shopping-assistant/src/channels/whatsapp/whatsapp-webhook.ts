import {createHmac,timingSafeEqual} from 'node:crypto';
import {Router,raw} from 'express';
import type {WhatsAppConfig,InboundMessage} from './whatsapp-types.js';
import type {WhatsAppAdapter} from './whatsapp-adapter.js';
const equal=(a:string,b:string)=>{
 const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);
};
export function verifySignature(body:Buffer,header:string|undefined,secret:string):boolean {
 if(!header||!/^sha256=[a-f0-9]{64}$/.test(header))return false;
 return equal(header,'sha256='+createHmac('sha256',secret).update(body).digest('hex'));
}
export function incomingMessages(payload:any,phoneNumberId:string,now=Date.now()):InboundMessage[]{
 if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return [];
 const messages:InboundMessage[]=[];
 for(const entry of payload.entry){
  if(!Array.isArray(entry?.changes))continue;
  for(const change of entry.changes){
   const value=change?.value;
   if(change?.field!=='messages'||value?.metadata?.phone_number_id!==phoneNumberId||!Array.isArray(value.messages))continue;
   for(const m of value.messages){
    if(messages.length>=100)return messages;
    const timestamp=Number(m?.timestamp)*1000;
    if(typeof m?.from!=='string'||!/^\d{7,20}$/.test(m.from)||typeof m.id!=='string'||!m.id||m.id.length>200||
      !Number.isFinite(timestamp)||timestamp<now-86400000||timestamp>now+300000)continue;
    if(m.type==='text'&&typeof m.text?.body==='string'&&m.text.body.length<=4096)
     messages.push({from:m.from,id:m.id,timestamp,text:m.text.body});
    else if(m.type==='interactive'){
     const type=m.interactive?.type;
     const reply=type==='button_reply'?m.interactive.button_reply:type==='list_reply'?m.interactive.list_reply:null;
     if(typeof reply?.id==='string'&&reply.id.length<=200)messages.push({from:m.from,id:m.id,timestamp,replyId:reply.id});
    }
   }
  }
 }
 return messages;
}
export function whatsappWebhook(config:WhatsAppConfig,adapter:WhatsAppAdapter){
 const router=Router();
 router.get('/',(req,res)=>{
  const token=req.query['hub.verify_token'],challenge=req.query['hub.challenge'];
  if(req.query['hub.mode']!=='subscribe'||typeof token!=='string'||!equal(token,config.verifyToken)||
    typeof challenge!=='string'||!/^\d{1,100}$/.test(challenge))return res.status(403).json({error:'Verification failed'});
  return res.type('text/plain').send(challenge);
 });
 router.post('/',raw({type:'application/json',limit:'256kb',inflate:false}),(req,res)=>{
  if(!Buffer.isBuffer(req.body)||!verifySignature(req.body,req.get('x-hub-signature-256'),config.appSecret))
   return res.status(401).json({error:'Invalid signature'});
  let payload:unknown;try{payload=JSON.parse(req.body.toString('utf8'));}catch{return res.status(400).json({error:'Invalid payload'});}
  for(const message of incomingMessages(payload,config.phoneNumberId)){
   if(!adapter.enqueue(message))return res.status(503).json({error:'Temporarily unavailable'});
  }
  return res.sendStatus(200);
 });
 return router;
}
