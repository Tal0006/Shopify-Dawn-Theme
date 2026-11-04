import type {WhatsAppConfig} from './channels/whatsapp/whatsapp-types.js';
export interface Config { domain:string; version:string; privateToken?:string; port:number; production:boolean; allowedOrigins:string[]; trustProxy:number; debug:boolean; whatsapp?:WhatsAppConfig }
export function configFromEnv(env:NodeJS.ProcessEnv=process.env):Config {
  const domain=env.SHOPIFY_STORE_DOMAIN?.trim() || '';
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))throw Error('Configure SHOPIFY_STORE_DOMAIN');
  const version=env.SHOPIFY_STOREFRONT_API_VERSION?.trim() || '2026-10';
  if(!/^20\d{2}-(01|04|07|10)$/.test(version))throw Error('Invalid Storefront API version');
  const port=Number(env.PORT || 4320),production=env.NODE_ENV==='production';
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');
  const allowedOrigins=(env.ALLOWED_ORIGINS || (production?'':'http://127.0.0.1:4320,http://localhost:4320')).split(',').map(value=>value.trim()).filter(Boolean);
  for(const value of allowedOrigins){const url=new URL(value);if(url.origin!==value||url.username||url.password||!['http:','https:'].includes(url.protocol)||(production&&url.protocol!=='https:'))throw Error('Invalid ALLOWED_ORIGINS');}
  const trustProxy=Number(env.TRUST_PROXY_HOPS || (env.RENDER==='true'?'1':'0'));
  if(!Number.isInteger(trustProxy)||trustProxy<0||trustProxy>2)throw Error('Invalid TRUST_PROXY_HOPS');
  let whatsapp:WhatsAppConfig|undefined;
  if(env.WHATSAPP_ENABLED==='true'){
    const required=(name:string)=>{const value=env[name]?.trim();if(!value)throw Error('Configure '+name);return value;};
    whatsapp={phoneNumberId:required('WHATSAPP_PHONE_NUMBER_ID'),accessToken:required('WHATSAPP_ACCESS_TOKEN'),
      verifyToken:required('WHATSAPP_VERIFY_TOKEN'),appSecret:required('META_APP_SECRET'),graphVersion:required('META_GRAPH_API_VERSION')};
    if(!/^\d{5,30}$/.test(whatsapp.phoneNumberId)||!/^v\d{1,3}\.0$/.test(whatsapp.graphVersion))throw Error('Invalid WhatsApp configuration');
  }
  return {whatsapp,domain,version,port,production,allowedOrigins,trustProxy,privateToken:env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN || undefined,debug:!production&&env.SHOPPING_ASSISTANT_DEBUG==='true'};
}
