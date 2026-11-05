
import express from 'express';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {config,type Config} from './config.js';
import {database,migrate,type Database} from './db.js';
import {Groups} from './groups.js';
import {Shopify,type CartValidator} from './shopify.js';
import {Auth,same} from './auth.js';
import {adminPage,loginPage,adminCSS} from './admin.js';
import {ApiError} from './domain.js';
export function createApp(db:Database,cfg:Config,validator:CartValidator=new Shopify(cfg)){
 const app=express(),groups=new Groups(db,cfg,validator),auth=new Auth(db,cfg);
 app.disable('x-powered-by');app.set('trust proxy',cfg.proxyHops);
 app.use((_req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  if(cfg.production)res.set('Strict-Transport-Security','max-age=31536000');
  next();
 });
 app.get('/health',(_req,res)=>res.json({status:'ok'}));
 app.use((req,res,next)=>{
  if(req.headers.host!==new URL(cfg.origin).host||(cfg.production&&!req.secure))throw new ApiError(403,'INVALID_HOST');
  next();
 });
 app.use('/api/v1',async(req,res,next)=>{
  const origin=req.get('Origin');
  const allowed=[cfg.origin,...cfg.storefrontOrigins];
  if(origin&&!allowed.includes(origin))throw new ApiError(403,'INVALID_ORIGIN');
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.vary('Origin');}
  if(req.method==='OPTIONS'){res.set({'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600'});res.status(204).end();return;}
  if(!['GET','HEAD'].includes(req.method)&&(!origin||!allowed.includes(origin)||!req.is('application/json')))throw new ApiError(403,'INVALID_ORIGIN');
  await auth.limit(req,['GET','HEAD'].includes(req.method)?'public-read':'public-write',['GET','HEAD'].includes(req.method)?120:20,600);
  next();
 });
 app.use(express.json({limit:'24kb'}));
 app.use(express.urlencoded({extended:false,limit:'4kb'}));
 const adminOrigin:express.RequestHandler=(req,_res,next)=>{if(req.get('Origin')!==cfg.origin)throw new ApiError(403,'INVALID_ORIGIN');next();};
 app.get('/',(_req,res)=>res.redirect(303,'/admin'));
 app.get('/admin/style.css',(_req,res)=>res.type('css').send(adminCSS));
 app.get('/admin',async(req,res)=>{const session=await auth.session(req);res.type('html').send(session?adminPage(await groups.list(),session.csrf):loginPage());});
 app.post('/admin/login',adminOrigin,async(req,res)=>{if(!req.is('application/x-www-form-urlencoded'))throw new ApiError(415,'INVALID_CONTENT_TYPE');await auth.login(req,res);});
 app.use('/admin',async(req,res,next)=>{
  const session=await auth.session(req);if(!session)throw new ApiError(401,'ADMIN_AUTH_REQUIRED','גישה אינה מורשית');
  if(!['GET','HEAD'].includes(req.method)&&(req.get('Origin')!==cfg.origin||!same(req.get('X-CSRF-Token')||req.body?.csrf,session.csrf)))throw new ApiError(403,'CSRF_REQUIRED');
  next();
 });
 app.get('/admin/api/groups',async(_req,res)=>res.json({groups:await groups.list()}));
 app.post('/admin/groups/:publicId/approve',async(req,res)=>{await groups.approve(req.params.publicId);res.redirect(303,'/admin');});
 app.post('/admin/api/groups/:publicId/approve',async(req,res)=>res.json({group:await groups.approve(req.params.publicId)}));
 app.post('/admin/logout',async(req,res)=>auth.logout(req,res));
 app.post('/api/v1/groups/find-or-create',async(req,res)=>res.json(await groups.find(req.body)));
 app.get('/api/v1/groups/:publicId',async(req,res)=>res.json({group:await groups.get(req.params.publicId)}));
 app.post('/api/v1/groups/:publicId/join',async(req,res)=>res.status(201).json(await groups.join(req.params.publicId,req.body)));
 app.post('/api/v1/groups/:publicId/update-pledge',async(req,res)=>{
  const token=req.get('Authorization')?.replace(/^Bearer /,'')||'';
  res.json(await groups.update(req.params.publicId,token,req.body));
 });
 app.use((_req,res)=>res.status(404).json({error:'העמוד לא נמצא',code:'NOT_FOUND'}));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=error instanceof ApiError?error.status:error?.status===413?413:error?.status===400?400:500;
  if(status===429)res.set('Retry-After','600');
  // Never serialize exception/provider/database text, customer input, headers or config.
  res.status(status).json({error:error instanceof ApiError?error.message:'לא ניתן להשלים את הבקשה כרגע.',code:error instanceof ApiError?error.code:status===413?'BODY_TOO_LARGE':status===400?'INVALID_INPUT':'SERVICE_UNAVAILABLE'});
 });
 return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let db:ReturnType<typeof database>|undefined;
 try{
  const cfg=config();db=database(cfg.databaseUrl);await migrate(db);
  const server=createApp(db,cfg).listen(cfg.port,'0.0.0.0',()=>console.info('Group delivery listening on port '+cfg.port));
  const stop=()=>{server.close(()=>{void db!.end().then(()=>process.exit(0));});setTimeout(()=>process.exit(1),10000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
 }catch{console.error('Group delivery startup failed. Check configuration and database connectivity.');await db?.end().catch(()=>{});process.exitCode=1;}
}
