
import {agorot} from './domain.js';
export interface Config {port:number;production:boolean;origin:string;storefrontOrigins:string[];databaseUrl:string;username:string;password:string;secret:string;domain:string;version:string;token:string;standardRadius:number;clusterRadius:number;threshold:bigint;expiryDays:number;proxyHops:number;storeLocation?:{lat:number;lng:number}}
export function config(env:NodeJS.ProcessEnv=process.env):Config{
 const required=(key:string)=>{const value=env[key]?.trim();if(!value)throw Error('Configure '+key);return value;};
 const integer=(key:string,fallback:number,min:number,max:number)=>{const value=Number(env[key]?.trim()||fallback);if(!Number.isInteger(value)||value<min||value>max)throw Error('Invalid '+key);return value;};
 const production=env.NODE_ENV==='production',port=integer('PORT',4330,1,65535);
 const origin=(value:string)=>{const u=new URL(value);if(u.origin!==value||u.username||u.password||(production?u.protocol!=='https:':!['http:','https:'].includes(u.protocol)))throw Error('Invalid origin configuration');return u.origin;};
 const appOrigin=origin(env.APP_ORIGIN?.trim()||env.RENDER_EXTERNAL_URL?.trim()||'http://127.0.0.1:'+port);
 const domain=required('SHOPIFY_STORE_DOMAIN');if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain))throw Error('Invalid Shopify domain');
 const version=env.SHOPIFY_STOREFRONT_API_VERSION?.trim()||'2026-10';if(!/^20\d\d-(01|04|07|10)$/.test(version))throw Error('Invalid API version');
 const password=required('ADMIN_PASSWORD'),secret=required('SESSION_SECRET');
 if(password.length<16||secret.length<32)throw Error('ADMIN_PASSWORD needs 16+ characters; SESSION_SECRET needs 32+ characters');
 const threshold=agorot(env.GROUP_THRESHOLD_ILS?.trim()||'500');if(threshold<100n||threshold>100000000n)throw Error('Invalid group threshold');
 let storeLocation:Config['storeLocation'];
 if(env.STORE_LATITUDE||env.STORE_LONGITUDE){const lat=Number(required('STORE_LATITUDE')),lng=Number(required('STORE_LONGITUDE'));if(!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180)throw Error('Invalid store coordinates');storeLocation={lat,lng};}
 return {port,production,origin:appOrigin,storefrontOrigins:(env.STOREFRONT_ORIGINS||'').split(',').map(v=>v.trim()).filter(Boolean).map(origin),databaseUrl:required('DATABASE_URL'),username:required('ADMIN_USERNAME'),password,secret,domain,version,token:required('SHOPIFY_STOREFRONT_PRIVATE_TOKEN'),standardRadius:integer('STANDARD_DELIVERY_RADIUS_KM',20,1,200),clusterRadius:integer('GROUP_CLUSTER_RADIUS_KM',7,1,50),threshold,expiryDays:integer('GROUP_EXPIRY_DAYS',7,1,30),proxyHops:integer('TRUST_PROXY_HOPS',production?1:0,0,2),storeLocation};
}
