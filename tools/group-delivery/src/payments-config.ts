import {parseEncryptionKey} from './vault.js';
// Cardcom card reservation configuration. Off by default: without CARDCOM_ENABLED=true nothing changes and groups work
// as before (no card). With CARDCOM_ENABLED=true and a missing or invalid value the feature fails closed: new joins
// still require a card reservation, the reservation endpoints answer 503 PAYMENT_UNAVAILABLE and no group can be
// approved for charging, while the rest of the service starts normally. Problems name variables, never values.
export const CARDCOM_API_ORIGIN='https://secure.cardcom.solutions';
export const CARDCOM_WEBHOOK_PATH='/webhooks/cardcom/low-profile';
export interface CardcomSettings {terminalNumber:number;apiName:string}
export interface PaymentsConfig {
 state:'DISABLED'|'ENABLED'|'MISCONFIGURED';
 problems:string[];
 // Present only when state is ENABLED.
 cardcom?:CardcomSettings;
 encryptionKey?:Buffer;
 webhookUrl?:string;
 successUrl?:string;
 failedUrl?:string;
 reservationTtlMinutes:number;
 // Shopify orders (GraphQL Admin; Dev Dashboard app, client credentials grant, scope write_orders). Required for
 // charging: no Cardcom charge is ever made without its Shopify order. Without it, card reservations still work but
 // card groups cannot be approved. The client secret stays here and in the token request only.
 orders?:{clientId:string;clientSecret:string;version:string;test:boolean};
 chargingProblems:string[];
}
export function paymentsConfig(env:NodeJS.ProcessEnv,context:{production:boolean;origin:string;storefrontOrigins:string[]}):PaymentsConfig{
 const flag=env.CARDCOM_ENABLED?.trim().toLowerCase();
 const ttlText=env.CARDCOM_RESERVATION_TTL_MINUTES?.trim(),ttl=ttlText?Number(ttlText):30;
 const problems:string[]=[];
 const reservationTtlMinutes=Number.isInteger(ttl)&&ttl>=10&&ttl<=120?ttl:(problems.push('CARDCOM_RESERVATION_TTL_MINUTES must be an integer between 10 and 120.'),30);
 const clientId=env.SHOPIFY_CLIENT_ID?.trim()||'',clientSecret=env.SHOPIFY_CLIENT_SECRET?.trim()||'';
 const version=env.SHOPIFY_ADMIN_API_VERSION?.trim()||'2026-10',testText=env.SHOPIFY_ORDERS_TEST?.trim().toLowerCase();
 const chargingProblems:string[]=[];
 if(!/^[A-Za-z0-9_-]{8,100}$/.test(clientId))chargingProblems.push('SHOPIFY_CLIENT_ID (Dev Dashboard app client ID) is missing or invalid.');
 if(clientSecret.length<16||clientSecret.length>200||/\s/.test(clientSecret))chargingProblems.push('SHOPIFY_CLIENT_SECRET (Dev Dashboard app client secret) is missing or invalid.');
 // No static Admin token: new Dev Dashboard apps use the client credentials grant. A leftover token is refused
 // explicitly (never used, never a silent fallback) so the deployment is fixed rather than half-configured.
 if(env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim())chargingProblems.push('SHOPIFY_ADMIN_ACCESS_TOKEN is not supported; remove it and configure SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.');
 if(!/^20\d\d-(01|04|07|10)$/.test(version))chargingProblems.push('SHOPIFY_ADMIN_API_VERSION is invalid.');
 if(testText&&!['true','false'].includes(testText))chargingProblems.push('SHOPIFY_ORDERS_TEST must be true or false.');
 const orders=chargingProblems.length?undefined:{clientId,clientSecret,version,test:testText==='true'};
 if(!flag||['false','0','off','no'].includes(flag))return {state:'DISABLED',problems:[],reservationTtlMinutes,chargingProblems:[]};
 if(!['true','1','on','yes'].includes(flag))return {state:'MISCONFIGURED',problems:['CARDCOM_ENABLED must be true or false.'],reservationTtlMinutes,chargingProblems};
 const terminalText=env.CARDCOM_TERMINAL_NUMBER?.trim()||'',terminalNumber=Number(terminalText);
 if(!/^[1-9]\d{0,9}$/.test(terminalText)||!Number.isSafeInteger(terminalNumber)||terminalNumber>2147483647)problems.push('CARDCOM_TERMINAL_NUMBER is missing or invalid.');
 const apiName=env.CARDCOM_API_NAME?.trim()||'';
 if(!apiName||apiName.length>100||/\s/.test(apiName))problems.push('CARDCOM_API_NAME is missing or invalid.');
 const encryptionKey=parseEncryptionKey(env.GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY);
 if(!encryptionKey)problems.push('GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY is missing or is not 32 bytes (64 hex or base64).');
 const secure=(value:string)=>{try{const u=new URL(value);return !u.username&&!u.password&&!u.hash&&(context.production?u.protocol==='https:':['https:','http:'].includes(u.protocol))?u:null;}catch{return null;}};
 // The webhook must reach this service: same origin as APP_ORIGIN, at the fixed webhook path.
 const webhook=secure(env.CARDCOM_WEBHOOK_URL?.trim()||context.origin+CARDCOM_WEBHOOK_PATH);
 if(!webhook||webhook.origin!==context.origin||webhook.pathname!==CARDCOM_WEBHOOK_PATH||webhook.search)problems.push('CARDCOM_WEBHOOK_URL must be '+'APP_ORIGIN'+CARDCOM_WEBHOOK_PATH+'.');
 // The shopper returns to a storefront page (the page that renders the Group Delivery section). Its origin must be one
 // of STOREFRONT_ORIGINS, so a misconfiguration can never send shoppers to an unrelated site.
 const allowed=new Set([context.origin,...context.storefrontOrigins]);
 const page=(key:string,fallback?:string)=>{const raw=env[key]?.trim()||fallback;const u=raw?secure(raw):null;if(!u||!allowed.has(u.origin)){problems.push(key+' must be a storefront page URL on one of STOREFRONT_ORIGINS.');return undefined;}return u.href;};
 const successUrl=page('CARDCOM_SUCCESS_URL'),failedUrl=page('CARDCOM_ERROR_URL',env.CARDCOM_SUCCESS_URL?.trim());
 if(problems.length)return {state:'MISCONFIGURED',problems,reservationTtlMinutes,chargingProblems};
 return {state:'ENABLED',problems:[],cardcom:{terminalNumber,apiName},encryptionKey:encryptionKey!,webhookUrl:webhook!.href,successUrl,failedUrl,reservationTtlMinutes,orders,chargingProblems};
}
