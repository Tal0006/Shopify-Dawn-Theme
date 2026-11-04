import express from 'express';
import {fileURLToPath} from 'node:url';
import {configFromEnv,type Config} from './config.js';
import type {StorefrontGateway} from './domain/types.js';
import {ShopifyStorefrontClient} from './shopify/storefront-client.js';
import {QuoteService} from './shopping/quote-service.js';
import {CheckoutService} from './shopping/checkout-service.js';
import {errorHandler} from './middleware/errors.js';
import {rateLimit,concurrencyLimit} from './middleware/rate-limit.js';
import {shoppingListRoutes} from './routes/shopping-list.js';
import {WhatsAppClient} from './channels/whatsapp/whatsapp-client.js';
import {MemoryWhatsAppSessionStore} from './channels/whatsapp/whatsapp-session.js';
import {WhatsAppAdapter} from './channels/whatsapp/whatsapp-adapter.js';
import {whatsappWebhook} from './channels/whatsapp/whatsapp-webhook.js';
import type {WhatsAppTransport,WhatsAppSessionStore} from './channels/whatsapp/whatsapp-types.js';
export function createApp(config:Config,shop:StorefrontGateway=new ShopifyStorefrontClient(config),whatsappDependencies:{client?:WhatsAppTransport;sessions?:WhatsAppSessionStore}={}){
 const app=express(),quotes=new QuoteService(shop,undefined,Date.now,config.debug),checkout=new CheckoutService(shop,quotes);
 app.disable('x-powered-by');app.set('trust proxy',config.trustProxy);
 app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"});next();});
 app.get('/health',(_req,res)=>res.json({status:'ok'}));
 if(config.whatsapp){
  const adapter=new WhatsAppAdapter(quotes,checkout,whatsappDependencies.client||new WhatsAppClient(config.whatsapp),
   whatsappDependencies.sessions||new MemoryWhatsAppSessionStore());
  app.use('/webhooks/whatsapp',whatsappWebhook(config.whatsapp,adapter));
 }
 app.use((req,res,next)=>{
  const origin=req.headers.origin;res.vary('Origin');
  if(origin&&!config.allowedOrigins.includes(origin))return res.status(403).json({code:'ORIGIN_DENIED',message:'מקור הבקשה אינו מורשה.'});
  if(origin)res.set('Access-Control-Allow-Origin',origin);
  if(req.method==='OPTIONS'){res.set({'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'});return res.status(204).end();}
  next();
 });
 app.use('/api',rateLimit(),concurrencyLimit());
 app.use('/api',(req,res,next)=>req.method==='POST'&&!req.is('application/json')?res.status(415).json({code:'JSON_REQUIRED',message:'יש לשלוח JSON.'}):next());
 app.use(express.json({limit:'12kb',strict:true}));
 app.use('/api/v1/shopping-list',shoppingListRoutes(quotes,checkout));
 app.use((_req,res)=>res.status(404).json({code:'NOT_FOUND',message:'הכתובת אינה קיימת.'}));
 app.use(errorHandler(config.debug));return app;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 try{
  const config=configFromEnv(),server=createApp(config).listen(config.port,'0.0.0.0',()=>console.log('Shopping assistant listening on port '+config.port));
  server.on('error',()=>{console.error('Shopping assistant could not listen');process.exitCode=1;});
  process.on('SIGTERM',()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),12000).unref();});
 }catch{console.error('Shopping assistant configuration failed. Check environment variable names in README.');process.exitCode=1;}
}
