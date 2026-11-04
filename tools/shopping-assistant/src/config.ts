export interface Config { domain:string; version:string; privateToken?:string; port:number; production:boolean; allowedOrigins:string[]; trustProxy:number; debug:boolean }
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
  return {domain,version,port,production,allowedOrigins,trustProxy,privateToken:env.SHOPIFY_STOREFRONT_PRIVATE_TOKEN || undefined,debug:!production&&env.SHOPPING_ASSISTANT_DEBUG==='true'};
}
