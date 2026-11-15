// Transactional email for membership recovery. The recovery logic depends only on EmailProvider; Resend is one
// implementation. Errors never carry the provider's response, the API key, the recipient or the code.
export interface RecoveryCodeMessage {to:string;code:string;expiresInMinutes:number;idempotencyKey?:string}
export interface EmailProvider {readonly name:string;sendRecoveryCode(message:RecoveryCodeMessage):Promise<void>}
export class EmailDeliveryError extends Error {constructor(){super('Recovery email could not be delivered');this.name='EmailDeliveryError';}}

export const RECOVERY_SUBJECT='קוד אימות לשחזור ההצטרפות שלך בפאנקי';
// Hebrew, right-to-left, no marketing, no token, no cart or customer details. The code is the only variable and is
// always 6 ASCII digits (checked), so nothing needs HTML escaping.
export function recoveryEmail(code:string,expiresInMinutes:number){
 if(!/^\d{6}$/.test(code)||!Number.isInteger(expiresInMinutes)||expiresInMinutes<1||expiresInMinutes>60)throw new EmailDeliveryError();
 const text=['שלום,','','ביקשת לשחזר את הגישה למשלוח הקבוצתי שלך בפאנקי.','','קוד האימות שלך:','',code,'',
  'הקוד תקף ל-'+expiresInMinutes+' דקות.','','אם לא ביקשת לשחזר את ההצטרפות, אפשר להתעלם מהמייל.','','פאנקי'].join('\n');
 const html='<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
  '<meta name="color-scheme" content="light"><title>'+RECOVERY_SUBJECT+'</title></head>'+
  '<body style="margin:0;padding:0;background:#f3f8f9;font-family:Arial,Helvetica,sans-serif;color:#10343b;">'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f8f9;padding:24px 12px;"><tr><td align="center">'+
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #d5e8ec;border-radius:14px;">'+
  '<tr><td dir="rtl" style="padding:28px 24px;text-align:right;font-size:16px;line-height:1.7;">'+
  '<p style="margin:0 0 18px;font-size:20px;font-weight:bold;color:#086b7b;">פאנקי</p>'+
  '<p style="margin:0 0 12px;">שלום,</p>'+
  '<p style="margin:0 0 20px;">ביקשת לשחזר את הגישה למשלוח הקבוצתי שלך בפאנקי.</p>'+
  '<p style="margin:0 0 8px;">קוד האימות שלך:</p>'+
  '<p dir="ltr" style="margin:0 0 20px;padding:14px 10px;background:#edf8fa;border:1px solid #bfe3e8;border-radius:10px;text-align:center;font-family:\'Courier New\',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:8px;color:#0a3f47;">'+code+'</p>'+
  '<p style="margin:0 0 12px;">הקוד תקף ל-'+expiresInMinutes+' דקות.</p>'+
  '<p style="margin:0;color:#536975;font-size:14px;">אם לא ביקשת לשחזר את ההצטרפות, אפשר להתעלם מהמייל.</p>'+
  '</td></tr></table></td></tr></table></body></html>';
 return {subject:RECOVERY_SUBJECT,text,html};
}

// https://resend.com/docs/api-reference/emails/send-email. The API key is sent only in the Authorization header.
export class ResendEmailProvider implements EmailProvider {
 readonly name='resend';
 constructor(private options:{apiKey:string;from:string;replyTo?:string|null;timeoutMs?:number},private request:(url:string,init:RequestInit)=>Promise<Response>=fetch){}
 async sendRecoveryCode({to,code,expiresInMinutes,idempotencyKey}:RecoveryCodeMessage){
  const message=recoveryEmail(code,expiresInMinutes);
  let response:Response;
  try{
   response=await this.request('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(this.options.timeoutMs??10000),
    headers:{Authorization:'Bearer '+this.options.apiKey,'Content-Type':'application/json',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
    body:JSON.stringify({from:this.options.from,to:[to],subject:message.subject,html:message.html,text:message.text,...(this.options.replyTo?{reply_to:this.options.replyTo}:{})})});
  }catch{throw new EmailDeliveryError();}
  // The body is drained but never read into errors or logs.
  await response.arrayBuffer().catch(()=>undefined);
  if(!response.ok)throw new EmailDeliveryError();
 }
}

// Development and tests only (refused in production by recoveryConfig): keeps messages in memory, sends nothing.
export class MemoryEmailProvider implements EmailProvider {
 readonly name='memory';
 readonly sent:{to:string;code:string;expiresInMinutes:number;subject:string;text:string;html:string}[]=[];
 fail:false|'once'|'always'=false;
 async sendRecoveryCode({to,code,expiresInMinutes}:RecoveryCodeMessage){
  if(this.fail){if(this.fail==='once')this.fail=false;throw new EmailDeliveryError();}
  this.sent.push({to,code,expiresInMinutes,...recoveryEmail(code,expiresInMinutes)});
 }
 last(to?:string){return [...this.sent].reverse().find(message=>!to||message.to===to);}
}

export type RecoveryEmailState='ENABLED'|'DISABLED'|'MISCONFIGURED';
export interface RecoveryConfig {state:RecoveryEmailState;provider:'resend'|'memory'|null;apiKey:string|null;from:string|null;replyTo:string|null;senderDomain:string|null;problems:string[]}
const ADDRESS=/^[^\s@<>"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// "Name <address>" or a bare address; the display name may be Hebrew but never contains <, > or quotes.
export function sender(value:string):{address:string}|null{
 const named=/^([^<>"\r\n]{1,60})\s<([^<>\s]+)>$/.exec(value.trim()),address=(named?named[2]:value.trim()).toLowerCase();
 return ADDRESS.test(address)&&address.length<=254?{address}:null;
}
// RECOVERY_EMAIL_PROVIDER: unset/off -> recovery disabled; resend -> needs RESEND_API_KEY and RECOVERY_EMAIL_FROM;
// memory -> development/tests only. Any problem makes recovery MISCONFIGURED, which fails closed (no code is ever
// generated or sent) without stopping the rest of the service. Problems name variables, never their values.
export function recoveryConfig(env:NodeJS.ProcessEnv,production:boolean):RecoveryConfig{
 const provider=(env.RECOVERY_EMAIL_PROVIDER?.trim()||'off').toLowerCase(),problems:string[]=[];
 const base={apiKey:null,from:null,replyTo:null,senderDomain:null};
 if(provider==='off')return {state:'DISABLED',provider:null,...base,problems};
 if(provider==='memory'){
  if(production)return {state:'MISCONFIGURED',provider:null,...base,problems:['RECOVERY_EMAIL_PROVIDER: memory is for development and tests only.']};
  return {state:'ENABLED',provider:'memory',...base,from:'dev@localhost',senderDomain:'localhost',problems};
 }
 if(provider!=='resend')return {state:'MISCONFIGURED',provider:null,...base,problems:['RECOVERY_EMAIL_PROVIDER: expected resend, memory or off.']};
 const apiKey=env.RESEND_API_KEY?.trim()||'',from=env.RECOVERY_EMAIL_FROM?.trim()||'',replyTo=env.RECOVERY_EMAIL_REPLY_TO?.trim()||'';
 if(!apiKey||/\s/.test(apiKey)||apiKey.length>200)problems.push('RESEND_API_KEY: required.');
 const parsed=from?sender(from):null;
 if(!parsed)problems.push('RECOVERY_EMAIL_FROM: required, e.g. פאנקי <no-reply@mail.fanakee.com>.');
 if(replyTo&&!sender(replyTo))problems.push('RECOVERY_EMAIL_REPLY_TO: not a valid address.');
 if(problems.length)return {state:'MISCONFIGURED',provider:'resend',...base,problems};
 return {state:'ENABLED',provider:'resend',apiKey,from,replyTo:replyTo||null,senderDomain:parsed!.address.split('@')[1],problems};
}
export function emailProvider(config:RecoveryConfig):EmailProvider|null{
 if(config.state!=='ENABLED')return null;
 if(config.provider==='memory')return new MemoryEmailProvider();
 return new ResendEmailProvider({apiKey:config.apiKey!,from:config.from!,replyTo:config.replyTo});
}
