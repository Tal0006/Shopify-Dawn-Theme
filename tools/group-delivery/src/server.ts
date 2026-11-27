
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
import {Renewals} from './renewals.js';
import {groupExtras,RENEWAL_ERRORS} from './renewals-page.js';
import {Orders} from './orders.js';
import {paymentsSection,splitLink,cycleSplitForm,cycleSplitPreview,ORDER_ERRORS,ORDER_NOTICES} from './orders-page.js';
import {audit,actorOf,auditPage} from './audit.js';
import {safeNext} from './auth.js';
import {ApiError,type ErrorCode} from './domain.js';
import {SystemHealth,systemsView,type HealthOptions} from './system.js';
import {systemPage} from './system-page.js';
import {Recovery,RECOVERY_LIMITS,type RecoveryLimits} from './recovery.js';
import {emailProvider,type EmailProvider} from './email.js';
import {Payments,webhookLowProfileId} from './payments.js';
import {CardcomService,CardcomError,type CardcomGateway} from './cardcom.js';
import {CARDCOM_WEBHOOK_PATH} from './payments-config.js';
import {ShopifyOrders,type OrderGateway} from './shopify-orders.js';
import {containsCardData} from './domain.js';
import {Finance,FinanceInputError,listFilters,rangeOf,nextBilling,UUID} from './finance.js';
import {financePage,formValues,valuesOf,recurringValuesOf,type DialogState,type ViewParams} from './finance-page.js';
import {Cancellations,CancellationInputError} from './cancellations.js';
import {cancellationsPage,cancellationPage,CANCELLATION_NOTICES,CANCELLATION_PAGE_ERRORS} from './cancellations-page.js';
import {Feedback,FeedbackInputError,FEEDBACK_SUCCESS_MESSAGE} from './feedback.js';
import {feedbackPage} from './feedback-page.js';
// deps: test seams for the operations page (outbound fetch and health-check timings) and for recovery email
// (provider and limits; the default provider comes from cfg.recovery and is null when recovery is disabled).
// cardcom/paymentsLog: test seams for the Cardcom gateway (default: the real CardcomService when payments are ENABLED,
// none otherwise) and for payment log lines.
export function createApp(db:Database,cfg:Config,validator:CartValidator=new Shopify(cfg),deps:{fetch?:(input:string,init?:RequestInit)=>Promise<Response>;health?:Partial<HealthOptions>;email?:EmailProvider|null;recoveryLimits?:Partial<RecoveryLimits>;cardcom?:CardcomGateway|null;paymentsLog?:(line:string)=>void;orders?:OrderGateway|null;now?:()=>Date;cancellationLog?:(line:string)=>void}={}){
 const app=express(),areas=new Areas(db,cfg);
 // Card reservation is required for new memberships whenever Cardcom is enabled (even if misconfigured: fail closed).
 const groups=new Groups(db,cfg,validator,areas,{paymentMode:()=>cfg.payments.state==='DISABLED'?'NONE':'CARDCOM'});
 const cardcom=deps.cardcom!==undefined?deps.cardcom:cfg.payments.state==='ENABLED'?new CardcomService(cfg.payments.cardcom!):null;
 // Shopify orders (GraphQL Admin, offline token): required before any Cardcom charge (default: real client when configured).
 const orders=deps.orders!==undefined?deps.orders:cfg.payments.orders?new ShopifyOrders({domain:cfg.domain,...cfg.payments.orders}):null;
 const payments=new Payments(db,groups,validator,cfg.payments,cardcom,deps.paymentsLog,orders);
 groups.attachPayments(payments);app.locals.payments=payments;
 const auth=new Auth(db,cfg),admin=new AdminData(db,groups,validator,payments),renewals=new Renewals(db,groups,validator),lifecycle=new Orders(db,groups,validator);
 const systemHealth=new SystemHealth(db,cfg.ops,()=>cfg.origin,deps.fetch,deps.health);
 // Business finance (/admin/system). deps.now: test seam for "today" (Israel time decides the current month).
 const finance=new Finance(db,cfg.ops.costs,deps.now);
 // One transactional email provider (RECOVERY_EMAIL_PROVIDER) for recovery codes and cancellation notices.
 const mail=deps.email!==undefined?deps.email:emailProvider(cfg.recovery);
 const recovery=new Recovery(db,cfg.secret,mail,groups,{...RECOVERY_LIMITS,...deps.recoveryLimits});
 app.locals.recovery=recovery;
 // Cancellation requests ("בקשות ביטול"): public submission on /api/v1, admin pages under /admin/cancellations.
 const cancellations=new Cancellations(db,cfg.cancellations,{email:mail,adminOrigin:()=>cfg.origin,log:deps.cancellationLog});
 app.locals.cancellations=cancellations;
 // Post-purchase feedback from the Thank you page extension (public POST, admin page /admin/feedback).
 const feedback=new Feedback(db,cfg.feedback);
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
  if(req.method==='OPTIONS'){res.set({'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Max-Age':'600'});res.status(204).end();return;}
  if(!['GET','HEAD'].includes(req.method)&&(!origin||!allowed.includes(origin)||!req.is('application/json')))throw new ApiError(403,'INVALID_ORIGIN');
  // Nearest-area lookups get their own small bucket so location attempts cannot use up the join budget (or vice versa).
  // The member read is a POST only to carry the bearer token; it changes nothing, so it shares the read budget.
  const memberRead=req.method==='POST'&&(/^\/groups\/[^/]+\/member$/.test(req.path)||/^\/reservations\/[^/]+$/.test(req.path));
  const read=['GET','HEAD'].includes(req.method)||memberRead,nearest=req.method==='POST'&&req.path==='/areas/nearest';
  await auth.limit(req,nearest?'area-nearest':read?'public-read':'public-write',nearest?10:read?120:20,600);
  next();
 });
 // Post-purchase feedback from the Thank you page checkout UI extension. The extension runs in a Web Worker whose origin
 // Shopify does not guarantee, so CORS allows any origin with no cookies or credentials. Origin is never the proof: every
 // submission needs a valid Shopify session token for this app and shop (Authorization: Bearer).
 app.use('/api/post-purchase-feedback',(req,res,next)=>{
  res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'});
  if(req.method==='OPTIONS'){res.status(204).end();return;}
  next();
 });
 app.use('/api/post-purchase-feedback',express.json({limit:'8kb'}));
 // The cancellation form has its own, smaller body limit (parsed first; the general parser then skips it).
 app.use('/api/v1/cancellations',express.json({limit:'10kb'}));
 app.use(express.json({limit:'24kb'}));
 // Cancellation admin forms carry a note of up to 1000 characters (about 6 kB URL-encoded in Hebrew).
 app.use('/admin/cancellations',express.urlencoded({extended:false,limit:'16kb'}));
 app.use(express.urlencoded({extended:false,limit:'4kb'}));
 // Card numbers, CVV and similar fields are refused on every public API before any handler sees them.
 app.use('/api/v1',(req,_res,next)=>{if(req.body&&typeof req.body==='object'&&containsCardData(req.body))throw new ApiError(400,'CARD_DATA_NOT_ACCEPTED','פרטי כרטיס אשראי מוזנים רק בעמוד המאובטח של קארדקום.');next();});
 // Cardcom server-to-server webhook (public; HTTPS and the exact host are enforced above). The body is only a pointer:
 // the LowProfileId is looked up and the result is fetched from Cardcom (GetLpResult) before anything changes.
 // Replays and retries are no-ops once the reservation is final. 503 asks Cardcom to retry when it cannot be checked.
 app.post(CARDCOM_WEBHOOK_PATH,async(req,res)=>{
  await auth.limit(req,'cardcom-webhook',600,600);
  try{await payments.webhook(webhookLowProfileId(req.body,req.query));}
  catch(error){if(error instanceof CardcomError){res.status(503).json({ok:false});return;}throw error;}
  res.json({ok:true});
 });
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
 const GROUP_PAGE_ERRORS=['APPROVAL_NOT_ALLOWED','PAYMENT_UNAVAILABLE','INVALID_OPERATIONAL_STATUS','OPERATIONAL_TRANSITION_NOT_ALLOWED','COMPLETION_CONFIRMATION_REQUIRED'];
 const noticeOf=(value:unknown)=>typeof value==='string'&&/^[a-z_]{1,30}$/.test(value)?value:undefined;
 // Dashboard home: summary cards plus the server-side filtered, sorted and paginated groups table.
 app.get('/admin',async(req,res)=>{
  const [metrics,list,areaList]=await Promise.all([admin.dashboard(),admin.listGroups(req.query),admin.areas()]);
  res.type('html').send(dashboardPage({metrics,list,areas:areaList,csrf:csrfOf(res)}));
 });
 app.get('/admin/groups/:publicId',async(req,res)=>{
  const [data,timeline,products,renewal,payments]=await Promise.all([admin.members(req.params.publicId,req.query),admin.timeline(req.params.publicId),admin.products(req.params.publicId,req.query.products==='names'),renewals.state(req.params.publicId),lifecycle.payments(req.params.publicId)]);
  const error=typeof req.query.error==='string'&&GROUP_PAGE_ERRORS.includes(req.query.error)?req.query.error:noticeOf(req.query.error);
  // Renewal messages belong to the renewal section; the price-change step reopens the form of that one member.
  const renewalError=typeof req.query.renewalError==='string'&&RENEWAL_ERRORS[req.query.renewalError]?req.query.renewalError:undefined;
  const priceMember=typeof req.query.member==='string'&&/^[a-f0-9-]{36}$/.test(req.query.member)?req.query.member:undefined;
  const priceTotal=typeof req.query.total==='string'&&/^\d{1,10}$/.test(req.query.total)?Number(req.query.total):undefined;
  const orderError=typeof req.query.orderError==='string'&&ORDER_ERRORS[req.query.orderError]?req.query.orderError:undefined;
  const orderNotice=typeof req.query.orderNotice==='string'&&ORDER_NOTICES[req.query.orderNotice]?req.query.orderNotice:undefined;
  const extras=groupExtras({group:data.group,products,renewal,csrf:csrfOf(res),error:renewalError,notice:noticeOf(req.query.renewalNotice),priceMember,priceTotal})+
   paymentsSection({groupPublicId:data.group.publicId,overview:payments,csrf:csrfOf(res),notice:orderNotice,error:orderError})+splitLink({groupPublicId:data.group.publicId,group:data.group});
  res.type('html').send(groupPage({...data,timeline,extras,csrf:csrfOf(res),notice:noticeOf(req.query.notice),error,confirming:req.query.confirm==='complete'}));
 });
 app.get('/admin/groups/:publicId/members/:memberId',async(req,res)=>{
  const data=await admin.member(req.params.publicId,req.params.memberId);
  const error=typeof req.query.error==='string'&&['GROUP_CLOSED','WITHDRAW_CONFIRMATION_REQUIRED'].includes(req.query.error)?req.query.error:undefined;
  res.type('html').send(memberPage({...data,csrf:csrfOf(res),error,confirming:req.query.confirm==='withdraw'}));
 });
 app.get('/admin/areas',async(req,res)=>res.type('html').send(areasPage({areas:await areas.adminList(),csrf:csrfOf(res),notice:noticeOf(req.query.notice)})));
 // Operations overview (מערכות האתר): safe configuration plus on-demand health checks; ?refresh=1 re-checks (rate floor).
 const systemData=async(req:express.Request)=>systemsView(cfg.ops,await systemHealth.results(req.query.refresh==='1'),cfg.origin,
  {state:deps.email!==undefined?(deps.email?'ENABLED':'DISABLED'):cfg.recovery.state,provider:deps.email?deps.email.name:cfg.recovery.provider,senderDomain:cfg.recovery.senderDomain});
 // The systems overview moved under /admin/system/services; /admin/system is the finance dashboard. Old refresh
 // links keep working.
 // The cost table also says how the finance page counts each cost (read only: no synchronization from this page).
 app.get('/admin/system/services',async(req,res)=>res.type('html').send(systemPage({...await systemData(req),finance:await finance.opsCosts(),cancellationWarnings:cancellations.warnings(),csrf:csrfOf(res)})));
 app.get('/admin/api/system',async(req,res)=>res.json(await systemData(req)));
 // ---- Business finance ("כספים"). Admin session only (above); mutations also need Origin + CSRF (above), have their
 // own rate limit and are audited with the change in one transaction (finance.ts). HTML forms redirect back to the
 // same filters; a rejected form is shown again with its values and field errors.
 const financeLimit=(req:express.Request)=>auth.limit(req,'admin-finance-write',120,600);
 const viewParams=(source:any):ViewParams=>{const f=listFilters(source);return {range:rangeOf(source?.range),q:f.q,month:f.month,type:f.type,category:f.category,page:f.page};};
 // The hidden "back" field: only the dashboard's own filter parameters survive (validated again by viewParams).
 const backParams=(value:unknown)=>{const raw=typeof value==='string'&&value.length<=400?value:'';return viewParams(Object.fromEntries(new URLSearchParams(raw)));};
 const backUrl=(p:ViewParams,notice:string)=>{
  const search=new URLSearchParams();
  if(p.range!=='6m')search.set('range',p.range);for(const key of ['q','month','type','category'] as const)if(p[key])search.set(key,p[key]);if(p.page>1)search.set('page',String(p.page));
  search.set('notice',notice);return '/admin/system?'+search.toString();
 };
 const errorUrl=(p:ViewParams,code:string)=>{const url=new URL(backUrl(p,'x'),'http://x');url.searchParams.delete('notice');url.searchParams.set('error',code);return url.pathname+url.search;};
 const renderFinance=async(res:express.Response,p:ViewParams,extra:{dialog?:DialogState|null;notice?:string;error?:string}={},status=200)=>{
  // Record due billing dates once, then read (summary/list record again, which is then a no-op).
  await finance.record();
  const [summary,list,ops]=await Promise.all([finance.summary(p.range),finance.list(p),finance.opsCosts()]);
  res.status(status).type('html').send(financePage({summary,list,ops,csrf:csrfOf(res),params:{...p,page:list.filters.page},...extra}));
 };
 const FINANCE_NOTICES=['tx_created','tx_updated','tx_deleted','tx_deactivated','rec_updated'];
 const FINANCE_ERRORS=['delete_confirm','occurrence_locked','inactive','ops_managed'];
 app.get('/admin/system',async(req,res)=>{
  if(req.query.refresh==='1'){res.redirect(303,'/admin/system/services?refresh=1');return;}
  const p=viewParams(req.query),today=finance.today();
  let dialog:DialogState|null=null,error:string|undefined;
  const add=req.query.add,edit=req.query.edit,remove=req.query.delete;
  if(add==='INCOME'||add==='EXPENSE'||add==='RECURRING')dialog={mode:'create',kind:add,values:formValues(add,today),errors:{}};
  else if(typeof edit==='string'||typeof remove==='string'){
   const id=String(edit??remove);
   let item=UUID.test(id)?await finance.find(id).catch(()=>null):null;
   // A recorded billing date is history: "edit" opens its charge; "delete" is refused.
   if(item?.kind==='transaction'&&item.transaction.recurringDefinitionId){
    if(typeof edit==='string')item=await finance.find(item.transaction.recurringDefinitionId).catch(()=>null);else{item=null;error='occurrence_locked';}
   }
   if(!item)error??='not_found';
   else if(item.kind==='recurring'&&typeof edit==='string'&&!item.recurring.active)error='inactive';
   else if(typeof edit==='string')dialog=item.kind==='transaction'?{mode:'edit',kind:item.transaction.type,id,values:valuesOf(item.transaction),errors:{}}:
    {mode:'edit',kind:'RECURRING',id:item.recurring.id,values:recurringValuesOf(item.recurring),errors:{},nextBilling:nextBilling(item.recurring,today),opsLocked:finance.opsLocked(item.recurring)};
   // An OPS-managed charge is stopped by removing it from OPS_COSTS, not here.
   else if(item.kind==='recurring'&&finance.opsLocked(item.recurring))error='ops_managed';
   else dialog=item.kind==='transaction'?{mode:'delete',transaction:item.transaction}:{mode:'delete',recurring:item.recurring};
  }
  const notice=typeof req.query.notice==='string'&&FINANCE_NOTICES.includes(req.query.notice)?req.query.notice:undefined;
  if(!error&&typeof req.query.error==='string'&&FINANCE_ERRORS.includes(req.query.error))error=req.query.error;
  await renderFinance(res,p,{dialog,notice,error});
 });
 // Form values to show again after a refusal (strings only; the server never trusts them for anything else).
 const formEcho=(body:any)=>{const v:Record<string,string>={};for(const key of ['type','amount','date','category','description','paymentMethod','source','notes','recurring','frequency','startDate','endDate'])v[key]=typeof body?.[key]==='string'?body[key].slice(0,1000):'';return v;};
 const refused=async(res:express.Response,error:unknown,p:ViewParams,dialog:Omit<Extract<DialogState,{mode:'create'|'edit'|'import'}>,'errors'|'error'>)=>{
  if(error instanceof FinanceInputError){await renderFinance(res,p,{dialog:{...dialog,errors:error.fields,error:error.message}},422);return true;}
  return false;
 };
 app.post('/admin/system/transactions',async(req,res)=>{
  await financeLimit(req);
  const p=backParams(req.body?.back),values=formEcho(req.body);
  try{await finance.create(req.body,res.locals.actor);}
  catch(error){
   if(await refused(res,error,p,{mode:'create',kind:values.recurring==='on'?'RECURRING':values.type==='INCOME'?'INCOME':'EXPENSE',values}))return;
   throw error;
  }
  res.redirect(303,backUrl(p,'tx_created'));
 });
 app.post('/admin/system/transactions/:id',async(req,res)=>{
  await financeLimit(req);
  const p=backParams(req.body?.back),values=formEcho(req.body);
  let result;
  try{result=await finance.update(req.params.id,req.body,res.locals.actor);}
  catch(error){
   const item=error instanceof FinanceInputError?await finance.find(req.params.id).catch(()=>null):null;
   if(await refused(res,error,p,{mode:'edit',kind:values.recurring==='on'?'RECURRING':values.type==='INCOME'?'INCOME':'EXPENSE',id:req.params.id,values,
    opsLocked:item?.kind==='recurring'&&finance.opsLocked(item.recurring)}))return;
   if(error instanceof ApiError&&(error.code==='RECURRING_OCCURRENCE'||error.code==='RECURRING_INACTIVE')){res.redirect(303,errorUrl(p,error.code==='RECURRING_INACTIVE'?'inactive':'occurrence_locked'));return;}
   throw error;
  }
  res.redirect(303,backUrl(p,'recurring' in result?'rec_updated':'tx_updated'));
 });
 app.post('/admin/system/transactions/:id/delete',async(req,res)=>{
  await financeLimit(req);
  const p=backParams(req.body?.back);
  if(req.body?.confirm!=='yes'){
   await finance.remove(req.params.id,false,res.locals.actor).catch(()=>{});// audited as DENIED
   res.redirect(303,errorUrl(p,'delete_confirm'));return;
  }
  let result;
  try{result=await finance.remove(req.params.id,true,res.locals.actor);}
  catch(error){if(error instanceof ApiError&&(error.code==='RECURRING_OCCURRENCE'||error.code==='OPS_MANAGED')){res.redirect(303,errorUrl(p,error.code==='OPS_MANAGED'?'ops_managed':'occurrence_locked'));return;}throw error;}
  res.redirect(303,backUrl(p,'deactivated' in result?'tx_deactivated':'tx_deleted'));
 });
 // JSON API (same session; X-CSRF-Token for mutations). Amounts are integer agorot (amountAgorot) or a decimal
 // shekel string (amount). 422 INVALID_TRANSACTION carries per-field messages in "fields".
 app.get('/admin/api/finance/summary',async(req,res)=>res.json({summary:await finance.summary(req.query.range),opsCosts:await finance.opsCosts()}));
 app.get('/admin/api/finance/transactions',async(req,res)=>res.json(await finance.list(req.query)));
 // One id space: a one-off/recorded row answers {transaction}, a recurring charge {recurring}.
 app.get('/admin/api/finance/transactions/:id',async(req,res)=>{const item=await finance.find(req.params.id);res.json(item.kind==='transaction'?{transaction:item.transaction}:{recurring:item.recurring});});
 app.get('/admin/api/finance/recurring',async(_req,res)=>{await finance.record();res.json({recurring:await finance.recurring()});});
 app.post('/admin/api/finance/transactions',async(req,res)=>{await financeLimit(req);res.status(201).json(await finance.create(req.body,res.locals.actor));});
 app.post('/admin/api/finance/transactions/:id',async(req,res)=>{await financeLimit(req);res.json(await finance.update(req.params.id,req.body,res.locals.actor));});
 app.post('/admin/api/finance/transactions/:id/delete',async(req,res)=>{await financeLimit(req);res.json(await finance.remove(req.params.id,req.body?.confirm===true,res.locals.actor));});
 app.get('/admin/audit',async(req,res)=>res.type('html').send(auditView({...await auditPage(db,req.query),csrf:csrfOf(res)})));
 // CSV exports (members, or one row per stored cart line). UTF-8 with BOM; formula-like cells neutralised in csv().
 const dateText=(iso:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'medium'}).format(new Date(iso));
 const sendCsv=(res:express.Response,name:string,body:string)=>{res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+name+'"'});res.send(body);};
 app.get('/admin/groups/:publicId/export.csv',async(req,res)=>{
  const {group,members}=await admin.exportRows(req.params.publicId);
  await audit(db,{action:'group.export',actor:res.locals.actor,target:group.publicId,result:'OK',detail:'members'});
  sendCsv(res,'group-'+group.shortId+'-members.csv',csv([
   ['אזור','מזהה קבוצה','סטטוס קבוצה','אימייל','טלפון','סטטוס לקוח','סכום התחייבות (₪)','שורות בסל','הצטרפות','עדכון אחרון'],
   // An expired, unconfirmed commitment is exported as such, never as a withdrawal.
   ...members.map(m=>[group.areaName,group.publicId,group.status,m.email,m.phone,m.withdrawnBy==='EXPIRED'?'EXPIRED_UNCONFIRMED':m.withdrawnBy==='TRANSFERRED'?'TRANSFERRED':m.orderState==='LOCKED'?'LOCKED_'+m.lockedReason:m.status,(m.pledgedTotalAgorot/100).toFixed(2),m.cartLines,dateText(m.createdAt),dateText(m.updatedAt)])
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
  catch(error){if(error instanceof ApiError&&['APPROVAL_NOT_ALLOWED','PAYMENT_UNAVAILABLE'].includes(error.code)){res.redirect(303,base+'?error='+error.code);return;}throw error;}
  res.redirect(303,base+'?notice=approved');
 });
 // Charging after approval (card groups). Both actions are idempotent: charges are claimed one by one and an UNKNOWN
 // charge is never re-sent; reconciliation only marks a charge paid when Cardcom confirms it by our charge id.
 const chargeAction=async(res:express.Response,id:string,action:'group.charges_process'|'group.charges_reconcile',run:()=>Promise<any>)=>{
  try{const result=await run();await audit(db,{action,actor:res.locals.actor,target:id,result:'OK'});return result;}
  catch(error){await audit(db,{action,actor:res.locals.actor,target:id,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 };
 app.post('/admin/groups/:publicId/charges/process',async(req,res)=>{
  const id=req.params.publicId,base='/admin/groups/'+encodeURIComponent(id);
  try{await chargeAction(res,id,'group.charges_process',()=>payments.processCharges(id));}
  catch(error){if(error instanceof ApiError&&['APPROVAL_NOT_ALLOWED','PAYMENT_UNAVAILABLE'].includes(error.code)){res.redirect(303,base+'?error='+error.code);return;}throw error;}
  res.redirect(303,base+'?notice=charges_processed');
 });
 app.post('/admin/groups/:publicId/charges/reconcile',async(req,res)=>{
  const id=req.params.publicId,base='/admin/groups/'+encodeURIComponent(id);
  try{await chargeAction(res,id,'group.charges_reconcile',()=>payments.reconcile(id));}
  catch(error){if(error instanceof ApiError&&['APPROVAL_NOT_ALLOWED','PAYMENT_UNAVAILABLE'].includes(error.code)){res.redirect(303,base+'?error='+error.code);return;}throw error;}
  res.redirect(303,base+'?notice=charges_reconciled');
 });
 app.post('/admin/api/groups/:publicId/charges/process',async(req,res)=>res.json({charges:await chargeAction(res,req.params.publicId,'group.charges_process',()=>payments.processCharges(req.params.publicId))}));
 app.post('/admin/api/groups/:publicId/charges/reconcile',async(req,res)=>res.json(await chargeAction(res,req.params.publicId,'group.charges_reconcile',()=>payments.reconcile(req.params.publicId))));
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
 // Expiration management (src/renewals.ts). Behind the same session, Origin and CSRF checks as every /admin route.
 // Successful changes and their audit rows commit together; refusals are audited here with the error code.
 app.get('/admin/api/groups/:publicId/renewal',async(req,res)=>res.json(await renewals.state(req.params.publicId)));
 const renewalAction=async<T>(res:express.Response,id:string,action:'member.reconfirm'|'group.reopen',subject:string|null,run:()=>Promise<T>):Promise<T>=>{
  try{return await run();}
  catch(error){await audit(db,{action,actor:res.locals.actor,target:id,subject,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 };
 const back=(id:string,params:Record<string,string>)=>'/admin/groups/'+encodeURIComponent(id)+'?'+new URLSearchParams(params).toString()+'#renew-title';
 app.post('/admin/groups/:publicId/members/:memberId/reconfirm',async(req,res)=>{
  const {publicId:id,memberId}=req.params;
  try{await renewalAction(res,id,'member.reconfirm',memberId,()=>renewals.reconfirm(id,memberId,{method:req.body?.method,reference:req.body?.reference,acceptTotalAgorot:req.body?.acceptTotalAgorot},res.locals.actor));}
  catch(error){
   if(error instanceof ApiError&&RENEWAL_ERRORS[error.code]){
    const total=error.code==='PRICE_CHANGED'?(await renewals.currentTotal(id,memberId).catch(()=>null)):null;
    res.redirect(303,back(id,{renewalError:error.code,...(total!==null?{member:memberId,total:String(total)}:{})}));return;
   }
   throw error;
  }
  res.redirect(303,back(id,{renewalNotice:'reconfirmed'}));
 });
 app.post('/admin/api/groups/:publicId/members/:memberId/reconfirm',async(req,res)=>{
  const {publicId:id,memberId}=req.params;
  res.json(await renewalAction(res,id,'member.reconfirm',memberId,()=>renewals.reconfirm(id,memberId,req.body,res.locals.actor)));
 });
 app.post('/admin/groups/:publicId/reopen',async(req,res)=>{
  const id=req.params.publicId;
  try{await renewalAction(res,id,'group.reopen',null,()=>renewals.reopen(id,{confirm:req.body?.confirm==='yes',days:Number(req.body?.days)},res.locals.actor));}
  catch(error){if(error instanceof ApiError&&RENEWAL_ERRORS[error.code]){res.redirect(303,back(id,{renewalError:error.code}));return;}throw error;}
  res.redirect(303,back(id,{renewalNotice:'reopened'}));
 });
 app.post('/admin/api/groups/:publicId/reopen',async(req,res)=>{
  const id=req.params.publicId;
  res.json(await renewalAction(res,id,'group.reopen',null,()=>renewals.reopen(id,req.body,res.locals.actor)));
 });
 // Order lifecycle (src/orders.ts). Same session, Origin and CSRF checks as every /admin route; refusals are audited.
 const orderAction=async<T>(res:express.Response,id:string,action:'member.payment_attest'|'group.cycle_split',subject:string|null,run:()=>Promise<T>):Promise<T>=>{
  try{return await run();}
  catch(error){await audit(db,{action,actor:res.locals.actor,target:id,subject,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 };
 app.post('/admin/api/groups/:publicId/members/:memberId/external-payment',async(req,res)=>{
  const {publicId:id,memberId}=req.params;
  res.json(await orderAction(res,id,'member.payment_attest',memberId,()=>lifecycle.attestPayment(id,memberId,req.body,res.locals.actor)));
 });
 // Owner forms: external payment, and the cycle split (choose, preview, execute). Messages go back to the group page.
 const amountOf=(value:unknown)=>{const text=typeof value==='string'?value.trim():'';if(!/^\d{1,7}(\.\d{1,2})?$/.test(text))return NaN;const [whole,frac='']=text.split('.');return Number(whole)*100+Number(frac.padEnd(2,'0'));};
 app.post('/admin/groups/:publicId/members/:memberId/external-payment',async(req,res)=>{
  const {publicId:id,memberId}=req.params,back=(q:Record<string,string>)=>'/admin/groups/'+encodeURIComponent(id)+'?'+new URLSearchParams(q).toString()+'#payments';
  try{
   const out=await orderAction(res,id,'member.payment_attest',memberId,()=>lifecycle.attestPayment(id,memberId,{attest:req.body?.attest==='yes',amountAgorot:amountOf(req.body?.amount),method:req.body?.method,receivedOn:req.body?.receivedOn,reference:req.body?.reference},res.locals.actor));
   res.redirect(303,back({orderNotice:out.recorded?'payment_recorded':'payment_unchanged'}));
  }catch(error){if(error instanceof ApiError&&ORDER_ERRORS[error.code]){res.redirect(303,back({orderError:error.code}));return;}throw error;}
 });
 // Roles chosen per order: KEEP (history), TRANSFER (next cycle), RESTORE (original back, current cart as a new order).
 const splitPlan=async(id:string,body:any)=>{
  const candidates=await lifecycle.candidates(id),roles:Record<string,string>={},restore:any[]=[],transfer:string[]=[],acceptTotals:Record<string,number>={};
  for(const o of candidates.orders){
   const role=body?.['role_'+o.id];
   if(role==='TRANSFER'){roles[o.id]=role;transfer.push(o.id);}
   else if(role==='RESTORE'&&o.original){roles[o.id]=role;restore.push({memberId:o.id,reconfirmationId:o.original.reconfirmationId});}
   else roles[o.id]='KEEP';
   const accepted=Number(body?.['accept_'+o.id]);if(Number.isSafeInteger(accepted)&&accepted>0)acceptTotals[o.id]=accepted;
  }
  return {candidates,roles,restore,transfer,acceptTotals};
 };
 app.get('/admin/groups/:publicId/cycle-split',async(req,res)=>{
  const error=typeof req.query.error==='string'&&ORDER_ERRORS[req.query.error]?req.query.error:undefined;
  res.type('html').send(cycleSplitForm({candidates:await lifecycle.candidates(req.params.publicId),csrf:csrfOf(res),error}));
 });
 app.post('/admin/groups/:publicId/cycle-split/review',async(req,res)=>{
  const id=req.params.publicId,plan=await splitPlan(id,req.body);
  try{
   const preview=await lifecycle.splitPreview(id,plan);
   res.type('html').send(cycleSplitPreview({group:plan.candidates.group,preview,plan,csrf:csrfOf(res)}));
  }catch(error){
   if(error instanceof ApiError&&ORDER_ERRORS[error.code]){res.status(409).type('html').send(cycleSplitForm({candidates:plan.candidates,csrf:csrfOf(res),error:error.code,selected:plan.roles}));return;}
   throw error;
  }
 });
 app.post('/admin/groups/:publicId/cycle-split/execute',async(req,res)=>{
  const id=req.params.publicId;
  let plan:any={};try{plan=JSON.parse(typeof req.body?.plan==='string'?req.body.plan:'{}');}catch{}
  try{
   const out=await orderAction(res,id,'group.cycle_split',null,()=>lifecycle.split(id,{...plan,confirm:req.body?.confirm==='yes',deliveredAttested:req.body?.deliveredAttested==='yes',
    reason:req.body?.reason,idempotencyKey:req.body?.idempotencyKey,expectedState:req.body?.expectedState},res.locals.actor));
   res.redirect(303,'/admin/groups/'+encodeURIComponent(out.source.publicId)+'?orderNotice=cycle_split#payments');
  }catch(error){
   // Nothing was changed: back to the choice, with the reason (stale preview, prices, confirmations...).
   if(error instanceof ApiError&&ORDER_ERRORS[error.code]){res.redirect(303,'/admin/groups/'+encodeURIComponent(id)+'/cycle-split?error='+encodeURIComponent(error.code));return;}
   throw error;
  }
 });
 app.get('/admin/api/groups/:publicId/members/:memberId/history',async(req,res)=>res.json(await lifecycle.history(req.params.memberId)));
 // Read-only preview (POST only because the plan is a body); the split itself needs the preview's state.
 app.post('/admin/api/groups/:publicId/cycle-split/preview',async(req,res)=>res.json(await lifecycle.splitPreview(req.params.publicId,req.body)));
 app.post('/admin/api/groups/:publicId/cycle-split',async(req,res)=>{
  const id=req.params.publicId;
  res.json(await orderAction(res,id,'group.cycle_split',null,()=>lifecycle.split(id,req.body,res.locals.actor)));
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
 // ---- Cancellation requests (admin session above; mutations also need Origin + CSRF). Status changes and notes are
 // audited with the request id and statuses only. The full ID number is shown only in the response to an explicit
 // POST (never in a URL), audited as cancellation.reveal_id.
 const cancellationLimit=(req:express.Request)=>auth.limit(req,'admin-cancellation-write',120,600);
 const cancellationBase=(reference:string)=>'/admin/cancellations/'+encodeURIComponent(reference);
 const cancellationError=(error:unknown)=>error instanceof ApiError?error.code==='CANCELLATION_PURGED'?'purged':error.code==='CANCELLATION_TRANSITION_NOT_ALLOWED'?'transition':error.code==='INVALID_INPUT'?'note_invalid':error.code==='CANCELLATION_UNAVAILABLE'?'unavailable':null:null;
 app.get('/admin/cancellations',async(req,res)=>{
  const purged=typeof req.query.purged==='string'&&/^\d{1,6}$/.test(req.query.purged)?Number(req.query.purged):null;
  res.type('html').send(cancellationsPage({list:await cancellations.list(req.query),warnings:cancellations.warnings(),retentionDays:cancellations.retentionDays,csrf:csrfOf(res),
   notice:typeof req.query.notice==='string'&&Object.hasOwn(CANCELLATION_NOTICES,req.query.notice)?req.query.notice:undefined,purged}));
 });
 app.post('/admin/cancellations/retention',async(req,res)=>{
  await cancellationLimit(req);
  const result=await cancellations.purgeExpired(res.locals.actor);
  res.redirect(303,'/admin/cancellations'+(result.configured?'?purged='+result.purged:''));
 });
 app.get('/admin/cancellations/:reference',async(req,res)=>{
  const error=typeof req.query.error==='string'&&Object.hasOwn(CANCELLATION_PAGE_ERRORS,req.query.error)?req.query.error:undefined;
  const notice=typeof req.query.notice==='string'&&Object.hasOwn(CANCELLATION_NOTICES,req.query.notice)?req.query.notice:undefined;
  res.type('html').send(cancellationPage({request:await cancellations.detail(req.params.reference),csrf:csrfOf(res),notice,error}));
 });
 app.post('/admin/cancellations/:reference/status',async(req,res)=>{
  await cancellationLimit(req);
  const reference=req.params.reference;
  try{await cancellations.setStatus(reference,req.body?.status,res.locals.actor);}
  catch(error){const code=cancellationError(error);if(code){res.redirect(303,cancellationBase(reference)+'?error='+code);return;}throw error;}
  res.redirect(303,cancellationBase(reference)+'?notice=status_updated');
 });
 app.post('/admin/cancellations/:reference/note',async(req,res)=>{
  await cancellationLimit(req);
  const reference=req.params.reference;
  try{await cancellations.setNote(reference,req.body?.note,res.locals.actor);}
  catch(error){const code=cancellationError(error);if(code){res.redirect(303,cancellationBase(reference)+'?error='+code);return;}throw error;}
  res.redirect(303,cancellationBase(reference)+'?notice=note_saved');
 });
 // Answered directly (no redirect), so the number exists only in this one no-store response.
 app.post('/admin/cancellations/:reference/reveal-id',async(req,res)=>{
  await auth.limit(req,'admin-cancellation-reveal',30,600);
  const reference=req.params.reference;
  if(req.body?.confirm!=='yes'){await cancellations.detail(reference);res.redirect(303,cancellationBase(reference)+'?error=reveal_confirm');return;}
  let revealedId:string;
  try{revealedId=await cancellations.revealId(reference,res.locals.actor);}
  catch(error){const code=cancellationError(error);if(code){res.redirect(303,cancellationBase(reference)+'?error='+code);return;}throw error;}
  res.type('html').send(cancellationPage({request:await cancellations.detail(reference),csrf:csrfOf(res),revealedId}));
 });
 // "משוב לקוחות": summary, filters, the missing-products list and recent responses (read-only).
 app.get('/admin/feedback',async(req,res)=>res.type('html').send(feedbackPage({...await feedback.dashboard(req.query),warnings:feedback.warnings(),
  shopHandle:cfg.domain.replace(/\.myshopify\.com$/,''),csrf:csrfOf(res)})));
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
 // Card reservation (Cardcom, no charge now). reserve returns the Cardcom page URL and the receipt the browser keeps;
 // the membership exists only after Cardcom confirms the token server-to-server (webhook or the status read below).
 app.post('/api/v1/groups/reserve',async(req,res)=>{await auth.limit(req,'card-reserve',10,600);res.status(201).json(await payments.reserve(null,req.body));});
 app.post('/api/v1/groups/:publicId/reserve',async(req,res)=>{await auth.limit(req,'card-reserve',10,600);res.status(201).json(await payments.reserve(req.params.publicId,req.body,bearer(req)));});
 app.post('/api/v1/reservations/:id',async(req,res)=>res.json(await payments.status(req.params.id,bearer(req),req.body)));
 app.post('/api/v1/reservations/:id/cancel',async(req,res)=>res.json(await payments.cancel(req.params.id,bearer(req))));
 // Explicit consent to a higher pledge after a cart change (card members); the card is not entered again.
 app.post('/api/v1/groups/:publicId/confirm-pledge',async(req,res)=>res.json(await groups.confirmPledge(req.params.publicId,bearer(req),req.body)));
 app.post('/api/v1/groups/:publicId/withdraw',async(req,res)=>res.json(await groups.withdraw(req.params.publicId,bearer(req),req.body)));
 // Another, separate order from an existing receipt (never an edit of it): {lines, confirm:true, requestId}.
 app.post('/api/v1/groups/:publicId/orders',async(req,res)=>res.status(201).json(await lifecycle.anotherOrder(req.params.publicId,bearer(req),req.body)));
 // Receipts for the orders linked to this receipt's order (a split order, or one placed from it).
 app.post('/api/v1/groups/:publicId/member/linked',async(req,res)=>res.json(await lifecycle.linkedReceipts(req.params.publicId,bearer(req))));
 // Email OTP recovery for a browser without the receipt (see src/recovery.ts). Besides the shared public-write budget,
 // each step has its own per-IP hourly bucket; per-details, per-group and per-challenge limits live in Recovery.
 app.post('/api/v1/groups/:publicId/recovery/start',async(req,res)=>{
  if(!recovery.enabled)throw new ApiError(503,'RECOVERY_UNAVAILABLE','שחזור ההצטרפות אינו זמין כרגע.');
  await auth.limit(req,'recovery-start',10,3600);
  res.json(await recovery.start(req.params.publicId,req.body,req.ip||'unknown'));
 });
 app.post('/api/v1/groups/:publicId/recovery/verify',async(req,res)=>{
  if(!recovery.enabled)throw new ApiError(503,'RECOVERY_UNAVAILABLE','שחזור ההצטרפות אינו זמין כרגע.');
  await auth.limit(req,'recovery-verify',30,3600);
  res.json(await recovery.verify(req.params.publicId,req.body));
 });
 // Cancellation request from the storefront form: JSON only, an allowed storefront Origin (both above), a 10 kB body
 // and its own per-IP hourly limit besides the shared public-write budget. The answer never echoes what was sent and
 // never says whether an order or customer exists.
 // One response per order. The answer is the same for a new and a repeated submission (never reveals other orders).
 app.post('/api/post-purchase-feedback',async(req,res)=>{
  if(!feedback.enabled)throw new ApiError(503,'FEEDBACK_UNAVAILABLE','לא ניתן לשלוח משוב כרגע.');
  await auth.limit(req,'feedback-submit',30,600);
  if(!req.is('application/json'))throw new ApiError(415,'INVALID_CONTENT_TYPE');
  if(!feedback.authenticated(req.get('Authorization')))throw new ApiError(401,'FEEDBACK_AUTH_REQUIRED','לא ניתן לאמת את הבקשה.');
  if(req.body&&typeof req.body==='object'&&containsCardData(req.body))throw new ApiError(400,'CARD_DATA_NOT_ACCEPTED','אין לכתוב פרטי כרטיס אשראי במשוב.');
  await feedback.submit(req.body);
  res.json({ok:true,message:FEEDBACK_SUCCESS_MESSAGE});
 });
 app.post('/api/v1/cancellations',async(req,res)=>{
  if(!cancellations.enabled)throw new ApiError(503,'CANCELLATION_UNAVAILABLE','לא ניתן לשלוח בקשת ביטול דרך האתר כרגע.');
  await auth.limit(req,'cancellation-submit',10,3600);
  const result=await cancellations.submit(req.body);
  res.status(result.created?201:200).json({ok:true,reference:result.reference,message:'הבקשה התקבלה ונשלחה לטיפול.'});
 });
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
  const details=error instanceof ApiError&&error.details&&Object.values(error.details).every(Number.isSafeInteger)?error.details:undefined;
  res.status(status).json({error:message,code,...(details?{details}:{}),...(error instanceof FinanceInputError||error instanceof CancellationInputError||error instanceof FeedbackInputError?{fields:error.fields}:{})});
 });
 return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let db:ReturnType<typeof database>|undefined;
 try{
  const cfg=config();db=database(cfg.databaseUrl);await migrate(db);
  // Names variables only, never values.
  if(cfg.recovery.state==='MISCONFIGURED')console.warn('Group delivery recovery email is disabled until configured: '+cfg.recovery.problems.join(' '));
  // Names variables only, never values. Card reservations fail closed (503) until fixed; joins still require a card.
  if(cfg.payments.state==='ENABLED'&&cfg.payments.chargingProblems.length)console.warn('Group delivery card groups cannot be approved or charged until configured: '+cfg.payments.chargingProblems.join(' '));
  if(cfg.payments.state==='MISCONFIGURED')console.warn('Group delivery card reservation is enabled but unavailable until configured: '+cfg.payments.problems.join(' '));
  // Names variables only, never values.
  if(cfg.cancellations.state!=='ENABLED')console.warn('Group delivery cancellation requests are refused until configured: '+cfg.cancellations.problems.join(' '));
  if(cfg.cancellations.retentionProblem)console.warn('Group delivery cancellation retention: '+cfg.cancellations.retentionProblem);
  else if(cfg.cancellations.retentionDays===null)console.warn('Group delivery cancellation retention is not configured (CANCELLATION_RETENTION_DAYS); no cancellation request is deleted.');
  if(cfg.feedback.state!=='ENABLED')console.warn('Post-purchase feedback is refused until configured: '+cfg.feedback.problems.join(' '));
  if(cfg.cancellations.notifyProblem)console.warn('Group delivery cancellation notices: '+cfg.cancellations.notifyProblem);
  const app=createApp(db,cfg),server=app.listen(cfg.port,'0.0.0.0',()=>console.info('Group delivery listening on port '+cfg.port));
  // Retention: at startup (the instance wakes on demand) and every 6 hours while running. A no-op until configured.
  const retention=()=>void (app.locals.cancellations as Cancellations).purgeExpired().then(result=>{if(result.purged)console.info('Group delivery cancellation retention removed personal data from '+result.purged+' request(s).');})
   .catch(()=>console.error('Group delivery cancellation retention run failed.'));
  if(cfg.cancellations.retentionDays!==null){retention();setInterval(retention,6*3600000).unref();}
  // Recovery emails still being sent finish before the pool closes.
  const stop=()=>{server.close(()=>{void Promise.all([(app.locals.recovery as Recovery).idle(),(app.locals.payments as Payments).idle(),(app.locals.cancellations as Cancellations).idle()]).then(()=>db!.end()).then(()=>process.exit(0));});setTimeout(()=>process.exit(1),10000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
 }catch {
  console.error('Group delivery startup failed. Check configuration and database connectivity.'); }
}
