
import express from 'express';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {config,type Config} from './config.js';
import {database,migrate,type Database} from './db.js';
import {Groups,OPERATIONAL_STATUSES} from './groups.js';
import {Areas} from './areas.js';
import {Shopify,type CartValidator} from './shopify.js';
import {Auth,same} from './auth.js';
import {loginPage,dashboardPage,groupPage,memberPage,areasPage,auditView,errorPage,adminCSS,adminJS} from './admin.js';
import {AdminData,csv} from './admin-data.js';
import {audit,actorOf,auditPage} from './audit.js';
import {safeNext} from './auth.js';
import {ApiError,type ErrorCode} from './domain.js';
export function createApp(db:Database,cfg:Config,validator:CartValidator=new Shopify(cfg)){
 const app=express(),areas=new Areas(db,cfg),groups=new Groups(db,cfg,validator,areas),auth=new Auth(db,cfg),admin=new AdminData(db,groups,validator);
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
  // Nearest-area lookups get their own small bucket so location attempts cannot use up the join budget (or vice versa).
  // The member read is a POST only to carry the bearer token; it changes nothing, so it shares the read budget.
  const memberRead=req.method==='POST'&&/^\/groups\/[^/]+\/member$/.test(req.path);
  const read=['GET','HEAD'].includes(req.method)||memberRead,nearest=req.method==='POST'&&req.path==='/areas/nearest';
  await auth.limit(req,nearest?'area-nearest':read?'public-read':'public-write',nearest?10:read?120:20,600);
  next();
 });
 app.use(express.json({limit:'24kb'}));
 app.use(express.urlencoded({extended:false,limit:'4kb'}));
 const adminOrigin:express.RequestHandler=(req,_res,next)=>{if(req.get('Origin')!==cfg.origin)throw new ApiError(403,'INVALID_ORIGIN');next();};
 // Every admin response: never indexed, never cached, and only same-origin script/style (no inline code).
 app.use('/admin',(_req,res,next)=>{
  res.set({'X-Robots-Tag':'noindex, nofollow','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
  next();
 });
 app.get('/',(_req,res)=>res.redirect(303,'/admin'));
 app.get('/admin/style.css',(_req,res)=>res.type('css').send(adminCSS));
 app.get('/admin/app.js',(_req,res)=>res.type('js').send(adminJS));
 app.get('/admin',async(req,res,next)=>{
  const session=await auth.session(req);
  if(!session){res.type('html').send(loginPage({expired:req.query.expired==='1',next:safeNext(req.query.next)}));return;}
  res.locals.session=session;next();
 });
 app.post('/admin/login',adminOrigin,async(req,res)=>{
  if(!req.is('application/x-www-form-urlencoded'))throw new ApiError(415,'INVALID_CONTENT_TYPE');
  try{await auth.login(req,res);}
  catch(error){
   if(error instanceof ApiError&&(error.code==='LOGIN_FAILED'||error.code==='RATE_LIMITED')){
    if(error.code==='RATE_LIMITED')res.set('Retry-After','900');
    res.status(error.status).type('html').send(loginPage({failed:error.code==='LOGIN_FAILED',limited:error.code==='RATE_LIMITED',next:safeNext(req.body?.next)}));return;
   }
   throw error;
  }
 });
 app.use('/admin',async(req,res,next)=>{
  const session=res.locals.session||await auth.session(req);
  if(!session){
   // Pages send an expired session back to the login form (and then to the same page); the JSON API answers 401.
   if(!req.path.startsWith('/api/')&&['GET','HEAD'].includes(req.method)){res.redirect(303,'/admin?expired=1&next='+encodeURIComponent(safeNext(req.originalUrl)));return;}
   if(!req.path.startsWith('/api/')){res.redirect(303,'/admin?expired=1');return;}
   throw new ApiError(401,'ADMIN_AUTH_REQUIRED','גישה אינה מורשית');
  }
  if(!['GET','HEAD'].includes(req.method)&&(req.get('Origin')!==cfg.origin||!same(req.get('X-CSRF-Token')||req.body?.csrf,session.csrf)))throw new ApiError(403,'CSRF_REQUIRED');
  res.locals.session=session;res.locals.actor=actorOf(session);
  next();
 });
 const csrfOf=(res:express.Response)=>res.locals.session.csrf as string;
 // Error codes the group page knows how to explain (anything else is ignored).
 const GROUP_PAGE_ERRORS=['APPROVAL_NOT_ALLOWED','INVALID_OPERATIONAL_STATUS','OPERATIONAL_TRANSITION_NOT_ALLOWED','COMPLETION_CONFIRMATION_REQUIRED'];
 const noticeOf=(value:unknown)=>typeof value==='string'&&/^[a-z_]{1,30}$/.test(value)?value:undefined;
 // Dashboard home: summary cards plus the server-side filtered, sorted and paginated groups table.
 app.get('/admin',async(req,res)=>{
  const [metrics,list,areaList]=await Promise.all([admin.dashboard(),admin.listGroups(req.query),admin.areas()]);
  res.type('html').send(dashboardPage({metrics,list,areas:areaList,csrf:csrfOf(res)}));
 });
 app.get('/admin/groups/:publicId',async(req,res)=>{
  const [data,timeline]=await Promise.all([admin.members(req.params.publicId,req.query),admin.timeline(req.params.publicId)]);
  const error=typeof req.query.error==='string'&&GROUP_PAGE_ERRORS.includes(req.query.error)?req.query.error:noticeOf(req.query.error);
  res.type('html').send(groupPage({...data,timeline,csrf:csrfOf(res),notice:noticeOf(req.query.notice),error,confirming:req.query.confirm==='complete'}));
 });
 app.get('/admin/groups/:publicId/members/:memberId',async(req,res)=>{
  const data=await admin.member(req.params.publicId,req.params.memberId);
  const error=typeof req.query.error==='string'&&['GROUP_CLOSED','WITHDRAW_CONFIRMATION_REQUIRED'].includes(req.query.error)?req.query.error:undefined;
  res.type('html').send(memberPage({...data,csrf:csrfOf(res),error,confirming:req.query.confirm==='withdraw'}));
 });
 app.get('/admin/areas',async(req,res)=>res.type('html').send(areasPage({areas:await areas.adminList(),csrf:csrfOf(res),notice:noticeOf(req.query.notice)})));
 app.get('/admin/audit',async(req,res)=>res.type('html').send(auditView({...await auditPage(db,req.query),csrf:csrfOf(res)})));
 // CSV exports (members, or one row per stored cart line). UTF-8 with BOM; formula-like cells neutralised in csv().
 const dateText=(iso:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'medium'}).format(new Date(iso));
 const sendCsv=(res:express.Response,name:string,body:string)=>{res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+name+'"'});res.send(body);};
 app.get('/admin/groups/:publicId/export.csv',async(req,res)=>{
  const {group,members}=await admin.exportRows(req.params.publicId);
  await audit(db,{action:'group.export',actor:res.locals.actor,target:group.publicId,result:'OK',detail:'members'});
  sendCsv(res,'group-'+group.shortId+'-members.csv',csv([
   ['אזור','מזהה קבוצה','סטטוס קבוצה','אימייל','טלפון','סטטוס לקוח','סכום התחייבות (₪)','שורות בסל','הצטרפות','עדכון אחרון'],
   ...members.map(m=>[group.areaName,group.publicId,group.status,m.email,m.phone,m.status,(m.pledgedTotalAgorot/100).toFixed(2),m.cartLines,dateText(m.createdAt),dateText(m.updatedAt)])
  ]));
 });
 app.get('/admin/groups/:publicId/export-lines.csv',async(req,res)=>{
  const {group,members}=await admin.exportRows(req.params.publicId);
  await audit(db,{action:'group.export',actor:res.locals.actor,target:group.publicId,result:'OK',detail:'cart-lines'});
  sendCsv(res,'group-'+group.shortId+'-cart-lines.csv',csv([
   ['מזהה קבוצה','אימייל','טלפון','סטטוס לקוח','מזהה וריאנט','כמות','מחיר יחידה שנשמר (₪)','סה"כ שורה שנשמר (₪)'],
   // Active pledges only: a withdrawn member's kept snapshot is history, not part of the order.
   ...members.filter(m=>m.status==='PLEDGED').flatMap(m=>m.snapshot.map(line=>{const unit=/^\d{1,12}$/.test(String(line.unitAgorot))?Number(line.unitAgorot):0;
    return [group.publicId,m.email,m.phone,m.status,String(line.variantId).replace('gid://shopify/ProductVariant/',''),Number(line.quantity),(unit/100).toFixed(2),(unit*Number(line.quantity)/100).toFixed(2)];}))
  ]));
 });
 // JSON API for the same data (authenticated; customer details only here, never on /api/v1).
 app.get('/admin/api/dashboard',async(_req,res)=>res.json({dashboard:await admin.dashboard()}));
 app.get('/admin/api/groups',async(req,res)=>res.json(await admin.listGroups(req.query)));
 app.get('/admin/api/groups/:publicId',async(req,res)=>{const {_id,...group}=await admin.group(req.params.publicId);res.json({group});});
 app.get('/admin/api/groups/:publicId/members',async(req,res)=>res.json(await admin.members(req.params.publicId,req.query)));
 app.get('/admin/api/groups/:publicId/members/:memberId',async(req,res)=>res.json(await admin.member(req.params.publicId,req.params.memberId)));
 // Approval: the only group transition the current domain supports. Audited; the HTML form needs an explicit tick.
 const approve=async(res:express.Response,id:string)=>{
  try{const group=await groups.approve(id);await audit(db,{action:'group.approve',actor:res.locals.actor,target:id,result:'OK'});return group;}
  catch(error){await audit(db,{action:'group.approve',actor:res.locals.actor,target:id,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 };
 app.post('/admin/groups/:publicId/approve',async(req,res)=>{
  const id=req.params.publicId,base='/admin/groups/'+encodeURIComponent(id);
  if(req.body?.confirm!=='yes'){res.redirect(303,base+'?error=confirm');return;}
  try{await approve(res,id);}
  catch(error){if(error instanceof ApiError&&error.code==='APPROVAL_NOT_ALLOWED'){res.redirect(303,base+'?error=APPROVAL_NOT_ALLOWED');return;}throw error;}
  res.redirect(303,base+'?notice=approved');
 });
 app.post('/admin/api/groups/:publicId/approve',async(req,res)=>res.json({group:await approve(res,req.params.publicId)}));
 // Store-owner removal of a customer: the same domain withdrawal as the customer's own (row kept as WITHDRAWN, totals
 // recalculated under the coordination lock). Explicit confirmation, audited with safe metadata only. Idempotent.
 const removeMember=async(res:express.Response,id:string,memberId:string,confirmed:boolean)=>{
  const base={action:'member.withdraw' as const,actor:res.locals.actor,target:id,subject:memberId};
  try{
   const result=await groups.adminWithdraw(id,memberId,{confirm:confirmed});
   await audit(db,{...base,result:'OK',previousStatus:result.previous.status,amountAgorot:result.previous.pledgedTotalAgorot,detail:result.changed?null:'ALREADY_WITHDRAWN'});
   return result;
  }catch(error){
   await audit(db,{...base,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});
   throw error;
  }
 };
 app.post('/admin/groups/:publicId/members/:memberId/withdraw',async(req,res)=>{
  const {publicId:id,memberId}=req.params,member='/admin/groups/'+encodeURIComponent(id)+'/members/'+encodeURIComponent(memberId);
  if(req.body?.confirm!=='yes'){res.redirect(303,member+'?error=WITHDRAW_CONFIRMATION_REQUIRED');return;}
  try{
   const result=await removeMember(res,id,memberId,true);
   res.redirect(303,'/admin/groups/'+encodeURIComponent(id)+'?notice='+(result.changed?'member_withdrawn':'member_already_withdrawn'));
  }catch(error){
   // Known refusals go back to the unchanged member page with a safe message; anything else is the generic error page.
   if(error instanceof ApiError&&['GROUP_CLOSED','WITHDRAW_CONFIRMATION_REQUIRED'].includes(error.code)){res.redirect(303,member+'?error='+error.code);return;}
   throw error;
  }
 });
 app.post('/admin/api/groups/:publicId/members/:memberId/withdraw',async(req,res)=>{
  const {group,member,previous,changed}=await removeMember(res,req.params.publicId,req.params.memberId,req.body?.confirm===true);
  res.json({group,member,previous,changed});
 });
 // Operational delivery workflow (admin only). The transition and its audit row commit together inside
 // groups.setOperationalStatus; refused attempts are audited here. COMPLETED needs an explicit confirmation.
 const operational=async(res:express.Response,id:string,body:{status?:unknown;confirm?:boolean})=>{
  try{return await groups.setOperationalStatus(id,body,res.locals.actor);}
  catch(error){
   const target=typeof body.status==='string'&&(OPERATIONAL_STATUSES as readonly string[]).includes(body.status)?body.status:null;
   await audit(db,{action:target==='COMPLETED'?'group.complete':'group.operational_status_change',actor:res.locals.actor,target:id,newStatus:target,
    result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});
   throw error;
  }
 };
 app.post('/admin/groups/:publicId/operational-status',async(req,res)=>{
  const id=req.params.publicId,base='/admin/groups/'+encodeURIComponent(id);
  try{
   const result=await operational(res,id,{status:req.body?.status,confirm:req.body?.confirm==='yes'});
   res.redirect(303,base+'?notice='+(!result.changed?'operational_unchanged':result.status==='COMPLETED'?'delivery_completed':'operational_updated'));
  }catch(error){
   if(error instanceof ApiError&&GROUP_PAGE_ERRORS.includes(error.code)){res.redirect(303,base+'?error='+error.code);return;}
   throw error;
  }
 });
 app.post('/admin/api/groups/:publicId/operational-status',async(req,res)=>{
  const result=await operational(res,req.params.publicId,{status:req.body?.status,confirm:req.body?.confirm===true});
  const {_id,...group}=await admin.group(req.params.publicId);
  res.json({previous:result.previous,status:result.status,changed:result.changed,group});
 });
 app.get('/admin/api/groups/:publicId/timeline',async(req,res)=>res.json({timeline:await admin.timeline(req.params.publicId)}));
 app.post('/admin/logout',async(req,res)=>auth.logout(req,res));
 app.get('/admin/api/audit',async(req,res)=>res.json(await auditPage(db,req.query)));
 // Delivery areas: same admin session, Origin and CSRF checks as group approval. HTML forms redirect; JSON API returns data.
 const areaChange=async<T extends {publicId?:string}>(res:express.Response,action:'area.create'|'area.update',target:string|null,run:()=>Promise<T>)=>{
  try{const area=await run();await audit(db,{action,actor:res.locals.actor,target:area?.publicId??target,result:'OK'});return area;}
  catch(error){await audit(db,{action,actor:res.locals.actor,target,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 };
 app.get('/admin/api/areas',async(_req,res)=>res.json({areas:await areas.adminList()}));
 app.post('/admin/api/areas',async(req,res)=>res.status(201).json({area:await areaChange(res,'area.create',null,()=>areas.create(req.body))}));
 app.post('/admin/api/areas/:publicId',async(req,res)=>res.json({area:await areaChange(res,'area.update',req.params.publicId,()=>areas.update(req.params.publicId,req.body))}));
 app.post('/admin/areas',async(req,res)=>{await areaChange(res,'area.create',null,()=>areas.create(req.body,true));res.redirect(303,'/admin/areas?notice=area_saved');});
 app.post('/admin/areas/:publicId',async(req,res)=>{await areaChange(res,'area.update',req.params.publicId,()=>areas.update(req.params.publicId,req.body,true));res.redirect(303,'/admin/areas?notice=area_saved');});
 // Public delivery areas (no coordinates) and the server-side nearest-area suggestion (coordinates never stored).
 app.get('/api/v1/areas',async(_req,res)=>res.json({areas:await areas.list()}));
 app.post('/api/v1/areas/nearest',async(req,res)=>res.json(await areas.nearest(req.body)));
 // Search is read-only and area-based (areaPublicId); groups are created only by the first join (POST /groups/join).
 app.post('/api/v1/groups/find',async(req,res)=>res.json(await groups.find(req.body)));
 app.post('/api/v1/groups/join',async(req,res)=>res.status(201).json(await groups.joinArea(req.body)));
 app.get('/api/v1/groups/:publicId',async(req,res)=>res.json({group:await groups.get(req.params.publicId)}));
 app.post('/api/v1/groups/:publicId/join',async(req,res)=>res.status(201).json(await groups.join(req.params.publicId,req.body)));
 const bearer=(req:express.Request)=>req.get('Authorization')?.replace(/^Bearer /,'')||'';
 app.post('/api/v1/groups/:publicId/update-pledge',async(req,res)=>res.json(await groups.update(req.params.publicId,bearer(req),req.body)));
 // Member-only: the receipt holder's pledge and stored cart re-checked against Shopify (no contact details or token).
 app.post('/api/v1/groups/:publicId/member',async(req,res)=>res.json(await groups.memberState(req.params.publicId,bearer(req))));
 // Explicit withdrawal; needs the member token and {"confirm":true}. A cart update never withdraws.
 app.post('/api/v1/groups/:publicId/withdraw',async(req,res)=>res.json(await groups.withdraw(req.params.publicId,bearer(req),req.body)));
 app.use((_req,res)=>res.status(404).json({error:'העמוד לא נמצא',code:'NOT_FOUND' satisfies ErrorCode}));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const status=error instanceof ApiError?error.status:error?.status===413?413:error?.status===400?400:500;
  if(status===429)res.set('Retry-After','600');
  const code:ErrorCode=error instanceof ApiError?error.code:status===413?'BODY_TOO_LARGE':status===400?'INVALID_INPUT':'SERVICE_UNAVAILABLE';
  // Never serialize exception/provider/database text, customer input, headers or config.
  const message=error instanceof ApiError?error.message:'לא ניתן להשלים את הבקשה כרגע.';
  // Admin pages and HTML form posts (approve, remove, areas) get a friendly page; /admin/api and assets keep JSON.
  if(_req.path.startsWith('/admin')&&!_req.path.startsWith('/admin/api/')&&_req.path!=='/admin/style.css'&&_req.path!=='/admin/app.js'){
   res.status(status).type('html').send(errorPage(status,message,res.locals.session?.csrf));return;
  }
  res.status(status).json({error:message,code});
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
