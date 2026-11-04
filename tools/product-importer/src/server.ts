import express from 'express';
import { fileURLToPath } from 'node:url';
import { CheapersalProductCatalogProvider } from './catalog.js';
import { ShopifyAdmin } from './shopify.js';
import { createProductImageProvider } from './images.js';
import { Importer } from './importer.js';
import { AppError } from './validation.js';
import { authConfig, createAuth, loginPage, sameSecret } from './auth.js';

export function createApp(importer: Importer, port:number, env:NodeJS.ProcessEnv=process.env) {
  const app=express(), config=authConfig(env,port), auth=createAuth(config);
  const origin=new URL(config.origin);
  // Reasons are fixed application strings: never log headers, cookies, bodies, or credentials.
  function reject(req:express.Request,res:express.Response,reason:string,status=403) {
    if(!config.production)console.warn((req.path==='/login'?'Login':'Request')+' rejected: '+reason);
    return res.status(status).json({error:'הגישה אינה מורשית'});
  }
  const secrets=Object.entries(env).filter(([key,value])=>/SECRET|TOKEN|PASSWORD|API_?KEY/i.test(key)&&value)
    .flatMap(([,value])=>[value!,encodeURIComponent(value!)]);
  // Defense in depth against accidental provider echoes. Never serialize credentials/configuration.
  app.set('json replacer',(key:string,value:unknown)=>{
    if(/secret|password|api_?key|access_?token|authorization/i.test(key))return undefined;
    if(typeof value==='string')for(const secret of secrets)value=(value as string).split(secret).join('[REDACTED]');
    return value;
  });
  app.disable('x-powered-by');
  if(config.production)app.set('trust proxy',1); // Render's ingress terminates TLS.
  app.use((_req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if(config.production)res.set('Strict-Transport-Security','max-age=31536000');
    next();
  });
  app.get('/health',(_req,res)=>res.json({status:'ok'}));
  app.use((req,res,next)=>{
    if(req.headers.host!==origin.host)return reject(req,res,'invalid host');
    if(req.headers.origin && req.headers.origin!==config.origin)
      return reject(req,res,req.headers.origin==='null'?'invalid origin (null)':'invalid origin');
    if(req.headers['sec-fetch-site']==='cross-site')return reject(req,res,'cross-site request');
    if(config.production && !req.secure)return reject(req,res,'HTTPS required',400);
    next();
  });
  app.get('/login', (req,res)=>{
    // no-referrer turns native form POST Origin into "null". Preserve the same-origin
    // browser context on this page only, rather than accepting opaque origins.
    res.set('Referrer-Policy','same-origin');
    return auth.session(req)?res.redirect(303,'/'):res.type('html').send(loginPage());
  });
  app.get('/login.css',(_req,res)=>res.sendFile(fileURLToPath(new URL('../public/style.css',import.meta.url))));
  app.post('/login',express.urlencoded({extended:false,limit:'4kb'}),(req,res)=>{
    if(req.headers.origin!==config.origin)return reject(req,res,req.headers.origin?'invalid origin':'missing origin');
    if(!req.is('application/x-www-form-urlencoded'))return reject(req,res,'invalid login content type');
    auth.login(req,res);
  });
  app.use(auth.require);
  app.use(express.json({limit:'4kb'}));
  app.get('/api/session',(req,res)=>res.json({csrf:auth.session(req)!.csrf}));
  app.use('/api',(req,res,next)=>{
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    if(req.headers.origin!==config.origin)return reject(req,res,req.headers.origin?'invalid origin':'missing origin');
    if(!req.is('application/json'))return reject(req,res,'invalid API content type');
    if(!req.headers['x-csrf-token'])return reject(req,res,'missing CSRF token');
    if(!sameSecret(req.headers['x-csrf-token'],auth.session(req)!.csrf))return reject(req,res,'invalid CSRF token');
    next();
  });
  app.post('/api/logout',auth.logout);
  app.post('/api/preview',async(req,res)=>res.json(await importer.preview(req.body?.barcode,req.body?.price,req.body?.manualImageUrl)));
  app.post('/api/image-selection',async(req,res)=>res.json(await importer.selectImage(req.body?.previewId,req.body?.candidateIndex)));
  app.post('/api/import',async(req,res)=>res.json(await importer.confirm(req.body?.previewId)));
  app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url)),{etag:false,dotfiles:'deny'}));
  app.use((_req,res)=>res.status(404).json({error:'העמוד לא נמצא'}));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    const status=error instanceof AppError?error.status:(error as {status?:number})?.status===400?400:(error as {status?:number})?.status===413?413:500;
    res.status(status).json({error:error instanceof AppError?error.message:'לא ניתן להשלים את הבקשה'});
  });
  return app;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const PORT=Number(process.env.PORT || 4310);
  try {
    if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw Error('Invalid PORT');
    const app=createApp(new Importer(new CheapersalProductCatalogProvider(process.env.CHEAPERSAL_API_KEY || ''),
      new ShopifyAdmin({domain:process.env.SHOPIFY_STORE_DOMAIN || '',token:process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        clientId:process.env.SHOPIFY_CLIENT_ID,clientSecret:process.env.SHOPIFY_CLIENT_SECRET,
        trackInventory:process.env.SHOPIFY_TRACK_INVENTORY==='true'}),createProductImageProvider(process.env)),PORT);
    const server=app.listen(PORT,'0.0.0.0',()=>console.log('Product importer listening on port '+PORT));
    server.on('error',()=>{console.error('Importer failed to listen');process.exitCode=1;});
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  } catch {console.error('Importer configuration failed. Check server environment settings.');process.exitCode=1;}
}
