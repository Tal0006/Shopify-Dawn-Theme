// "מערכות האתר": the store owner's operational overview of the systems that run Fankee. Admin only.
// Configuration comes from optional OPS_* environment variables (never secrets: URLs with credentials are rejected,
// warnings name the variable but never echo its value). Health checks are few, lightweight and on demand: the
// Group Delivery /health endpoint, a SELECT 1 on the database and an optional HEAD on the storefront. Nothing calls
// Google, GitHub, Render or Neon APIs. Results are kept in memory only (short cache, single flight, refresh floor).
import type {Queryable} from './db.js';

export type SystemStatus='OPERATIONAL'|'DEGRADED'|'OFFLINE'|'MANUAL'|'POSTPONED';
export type CheckReason='TIMEOUT'|'UNREACHABLE'|'BAD_RESPONSE'|'SLOW'|null;
export interface CheckResult {status:'OPERATIONAL'|'DEGRADED'|'OFFLINE';reason:CheckReason;checkedAt:string;latencyMs:number|null;lastSuccessAt:string|null;lastFailureAt:string|null}
export interface CostEntry {service:string;amountCents:number;currency:'USD'|'ILS';frequency:'MONTHLY'|'YEARLY';monthlyCents:number;note:string|null;system:string|null}
export interface RenderService {id:string;name:string;url:string|null;healthPath:string;dashboardUrl:string|null;purpose:string|null;note:string|null;primary:boolean}
export interface OpsConfig {
 shopifyAdminUrl:string|null;themeEditorUrl:string|null;storefrontUrl:string|null;storefrontCheck:boolean;
 githubRepoUrl:string|null;githubBranch:string;deployedCommit:string|null;
 theme:{name:string|null;id:string|null;revision:string|null;releasedAt:string|null};
 renderDashboardUrl:string|null;renderServices:RenderService[];neonConsoleUrl:string|null;
 googleBusinessUrl:string|null;merchantCenterUrl:string|null;
 costs:CostEntry[];notes:Record<string,string>;warnings:string[];
}

const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;
// A configured link: https (or http on localhost), no embedded credentials. Anything else is dropped with a warning.
function link(env:NodeJS.ProcessEnv,key:string,warnings:string[],fallback:string|null=null):string|null{
 const raw=env[key]?.trim();if(!raw)return fallback;
 const url=safeUrl(raw);if(!url)warnings.push(key+': ignored (needs an https URL without credentials).');
 return url;
}
export function safeUrl(raw:string):string|null{
 try{
  const url=new URL(raw);
  const local=['localhost','127.0.0.1'].includes(url.hostname);
  if(url.username||url.password||!(url.protocol==='https:'||(url.protocol==='http:'&&local)))return null;
  return url.href;
 }catch{return null;}
}
function json(env:NodeJS.ProcessEnv,key:string,warnings:string[]):unknown{
 const raw=env[key]?.trim();if(!raw)return undefined;
 try{return JSON.parse(raw);}catch{warnings.push(key+': ignored (not valid JSON).');return undefined;}
}
const slug=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'service';

export function opsConfig(env:NodeJS.ProcessEnv=process.env):OpsConfig{
 const warnings:string[]=[];
 // Monthly costs: one JSON array, e.g. [{"service":"Render Group Delivery","amount":7,"currency":"USD","system":"render-group-delivery"}].
 const costs:CostEntry[]=[];let skipped=0;
 const rawCosts=json(env,'OPS_COSTS',warnings);
 if(rawCosts!==undefined&&!Array.isArray(rawCosts))warnings.push('OPS_COSTS: ignored (expected a JSON array).');
 for(const entry of Array.isArray(rawCosts)?rawCosts.slice(0,50):[]){
  const service=text(entry?.service,60),amount=entry?.amount,currency=entry?.currency,frequency=entry?.frequency??'MONTHLY';
  if(!service||typeof amount!=='number'||!Number.isFinite(amount)||amount<0||amount>1000000||Math.abs(amount*100-Math.round(amount*100))>1e-6||!['USD','ILS'].includes(currency)||!['MONTHLY','YEARLY'].includes(frequency)){skipped++;continue;}
  const amountCents=Math.round(amount*100);
  costs.push({service,amountCents,currency,frequency,monthlyCents:frequency==='YEARLY'?Math.round(amountCents/12):amountCents,note:text(entry?.note,200),system:text(entry?.system,40)});
 }
 if(skipped)warnings.push('OPS_COSTS: '+skipped+' invalid entr'+(skipped===1?'y':'ies')+' ignored (service, amount ≥ 0, currency USD/ILS, frequency MONTHLY/YEARLY).');
 // Extra Render services: [{"name":"…","url":"https://…","healthPath":"/health","dashboardUrl":"https://dashboard.render.com/…"}].
 const services:RenderService[]=[{id:'render-group-delivery',name:'fankee-group-delivery',url:link(env,'OPS_RENDER_GROUP_DELIVERY_URL',warnings),healthPath:'/health',
  dashboardUrl:link(env,'OPS_RENDER_GROUP_DELIVERY_DASHBOARD_URL',warnings),purpose:null,note:null,primary:true}];
 const rawServices=json(env,'OPS_RENDER_SERVICES',warnings);
 if(rawServices!==undefined&&!Array.isArray(rawServices))warnings.push('OPS_RENDER_SERVICES: ignored (expected a JSON array).');
 for(const entry of Array.isArray(rawServices)?rawServices.slice(0,10):[]){
  const name=text(entry?.name,60),url=typeof entry?.url==='string'?safeUrl(entry.url):null,health=typeof entry?.healthPath==='string'&&/^\/[A-Za-z0-9._~/-]{0,100}$/.test(entry.healthPath)?entry.healthPath:'/health';
  if(!name||(entry?.url!==undefined&&!url)){warnings.push('OPS_RENDER_SERVICES: an entry was ignored (needs a name and an https URL without credentials).');continue;}
  services.push({id:'render-'+slug(name),name,url,healthPath:health,dashboardUrl:typeof entry?.dashboardUrl==='string'?safeUrl(entry.dashboardUrl):null,purpose:text(entry?.purpose,200),note:text(entry?.note,300),primary:false});
 }
 const rawNotes=json(env,'OPS_NOTES',warnings),notes:Record<string,string>={};
 if(rawNotes&&typeof rawNotes==='object'&&!Array.isArray(rawNotes))for(const [key,value] of Object.entries(rawNotes).slice(0,40)){const note=text(value,300);if(note&&/^[a-z0-9-]{2,40}$/.test(key))notes[key]=note;}
 else if(rawNotes!==undefined)warnings.push('OPS_NOTES: ignored (expected a JSON object of system id to note).');
 const revision=text(env.OPS_THEME_REVISION,40);
 if(revision&&!/^\d{4}-\d{2}-\d{2}\+[A-Za-z0-9._-]{1,30}$/.test(revision))warnings.push('OPS_THEME_REVISION: ignored (expected the theme-revision label, e.g. 2026-11-12+ab875ef).');
 const validRevision=revision&&/^\d{4}-\d{2}-\d{2}\+[A-Za-z0-9._-]{1,30}$/.test(revision)?revision:null;
 const themeId=text(env.OPS_THEME_ID,20);
 if(themeId&&!/^\d{6,20}$/.test(themeId))warnings.push('OPS_THEME_ID: ignored (expected the numeric theme id).');
 const commit=text(env.RENDER_GIT_COMMIT,40);
 const branch=text(env.OPS_GITHUB_BRANCH,60);
 const adminUrl=link(env,'OPS_SHOPIFY_ADMIN_URL',warnings);
 return {
  shopifyAdminUrl:adminUrl,
  // Theme editor: explicit link, or the configured store admin's themes page. Never a hard-coded store.
  themeEditorUrl:link(env,'OPS_SHOPIFY_THEME_EDITOR_URL',warnings,adminUrl?adminUrl.replace(/\/$/,'')+'/themes':null),
  storefrontUrl:link(env,'OPS_STOREFRONT_URL',warnings,'https://fanakee.com/'),
  storefrontCheck:(env.OPS_STOREFRONT_CHECK?.trim()||'on')!=='off',
  githubRepoUrl:link(env,'OPS_GITHUB_REPO_URL',warnings,'https://github.com/Tal0006/Shopify-Dawn-Theme'),
  githubBranch:branch&&/^[A-Za-z0-9._/-]{1,60}$/.test(branch)?branch:'main',
  deployedCommit:commit&&/^[a-f0-9]{7,40}$/.test(commit)?commit:null,
  theme:{name:text(env.OPS_THEME_NAME,80),id:themeId&&/^\d{6,20}$/.test(themeId)?themeId:null,revision:validRevision,releasedAt:validRevision?validRevision.slice(0,10):null},
  renderDashboardUrl:link(env,'OPS_RENDER_DASHBOARD_URL',warnings,'https://dashboard.render.com/'),
  renderServices:services,
  neonConsoleUrl:link(env,'OPS_NEON_CONSOLE_URL',warnings),
  googleBusinessUrl:link(env,'OPS_GOOGLE_BUSINESS_URL',warnings),
  merchantCenterUrl:link(env,'OPS_MERCHANT_CENTER_URL',warnings),
  costs,notes,warnings,
 };
}

export interface HealthOptions {timeoutMs:number;ttlMs:number;minRefreshMs:number;slowMs:number;now:()=>number}
type Fetcher=(input:string,init?:RequestInit)=>Promise<Response>;
// On-demand checks with a short in-memory cache. Concurrent page loads share one run; "בדיקה מחדש" re-runs at most
// once per minRefreshMs. Failures are reduced to a reason code; no error text, URL or response body is kept.
export class SystemHealth {
 private cache:{at:number;results:Record<string,CheckResult>}|null=null;
 private running:Promise<Record<string,CheckResult>>|null=null;
 private memory:Record<string,{lastSuccessAt:string|null;lastFailureAt:string|null}>={};
 private options:HealthOptions;
 constructor(private db:Queryable,private ops:OpsConfig,private appOrigin:()=>string,private fetcher:Fetcher=fetch,options:Partial<HealthOptions>={}){
  this.options={timeoutMs:3000,ttlMs:60000,minRefreshMs:10000,slowMs:2000,now:()=>Date.now(),...options};
 }
 async results(refresh=false):Promise<{results:Record<string,CheckResult>;checkedAt:string;cached:boolean}>{
  const now=this.options.now();
  const age=this.cache?now-this.cache.at:Infinity;
  if(this.cache&&(age<(refresh?this.options.minRefreshMs:this.options.ttlMs)))return {results:this.cache.results,checkedAt:new Date(this.cache.at).toISOString(),cached:true};
  if(!this.running)this.running=this.run().finally(()=>{this.running=null;});
  const results=await this.running;
  return {results,checkedAt:new Date(this.cache!.at).toISOString(),cached:false};
 }
 private async run(){
  const checks:[string,()=>Promise<CheckReason|'OK'>][]=[];
  for(const service of this.ops.renderServices){
   const base=service.url||(service.primary?this.appOrigin():null);
   if(base)checks.push([service.id,()=>this.http(new URL(service.healthPath,base).href,'GET',service.primary)]);
  }
  checks.push(['neon',()=>this.database()]);
  if(this.ops.storefrontCheck&&this.ops.storefrontUrl)checks.push(['domain',()=>this.http(this.ops.storefrontUrl!,'HEAD',false)]);
  const at=this.options.now(),results:Record<string,CheckResult>={};
  await Promise.all(checks.map(async([id,check])=>{
   const started=this.options.now();let outcome:CheckReason|'OK';
   try{outcome=await check();}catch{outcome='UNREACHABLE';}
   const latency=this.options.now()-started,iso=new Date(this.options.now()).toISOString();
   if(outcome==='OK'&&latency>this.options.slowMs)outcome='SLOW';
   const memory=this.memory[id]||={lastSuccessAt:null,lastFailureAt:null};
   if(outcome==='OK'||outcome==='SLOW')memory.lastSuccessAt=iso;else memory.lastFailureAt=iso;
   results[id]={status:outcome==='OK'?'OPERATIONAL':outcome==='SLOW'||outcome==='BAD_RESPONSE'?'DEGRADED':'OFFLINE',reason:outcome==='OK'?null:outcome,checkedAt:iso,
    latencyMs:outcome==='TIMEOUT'||outcome==='UNREACHABLE'?null:latency,...memory};
  }));
  this.cache={at,results};
  return results;
 }
 // One request, short timeout, no retries, redirects not followed (a 3xx from the storefront still means it answers).
 private async http(url:string,method:'GET'|'HEAD',expectOk:boolean):Promise<CheckReason|'OK'>{
  let response:Response;
  try{response=await this.fetcher(url,{method,redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(this.options.timeoutMs),headers:{'User-Agent':'fankee-admin-ops-check'}});}
  catch(error){return (error as any)?.name==='TimeoutError'||(error as any)?.name==='AbortError'?'TIMEOUT':'UNREACHABLE';}
  if(response.status<200||response.status>=400){await response.body?.cancel().catch(()=>{});return 'BAD_RESPONSE';}
  if(expectOk){
   const body=await response.json().catch(()=>null) as any;
   return body?.status==='ok'?'OK':'BAD_RESPONSE';
  }
  await response.body?.cancel().catch(()=>{});
  return 'OK';
 }
 // Connectivity only (SELECT 1). Never exposes the connection string, host or user.
 private async database():Promise<CheckReason|'OK'>{
  let timer:NodeJS.Timeout|undefined;
  const timeout=new Promise<'TIMEOUT'>(resolve=>{timer=setTimeout(()=>resolve('TIMEOUT'),this.options.timeoutMs);});
  try{
   return await Promise.race([this.db.query('SELECT 1 AS ok').then(r=>Number(r.rows[0]?.ok)===1?'OK' as const:'BAD_RESPONSE' as const),timeout]);
  }catch{return 'UNREACHABLE';}finally{clearTimeout(timer);}
 }
}

// ---- View model -------------------------------------------------------------------------------------------------
export interface SystemLink {label:string;url:string;external:boolean}
export interface SystemDetail {label:string;value:string;href?:string;mono?:boolean}
export interface SystemView {
 id:string;name:string;mark:string;status:SystemStatus;statusLabel:string|null;purpose:string[];note:string|null;
 links:SystemLink[];details:SystemDetail[];check:CheckResult|null;checkKind:'http'|'database'|'derived'|null;missing:string[];costs:CostEntry[];
}
const NOTES:Record<string,string>={
 'shopify-theme-editor':'שינויים שנעשים בעורך התבניות של Shopify יש למשוך לקוד המקומי לפני שממשיכים בפיתוח.',
 'theme':'הגרסה מתעדכנת לפני כל שחרור (node tests/helpers/theme-revision.cjs --write) ומוגדרת כאן ידנית ב־OPS_THEME_REVISION.',
 'github':'ענף הפרודקשן הוא main. אין למזג אליו את ענף התשלומים שנדחה.',
 'neon':'Neon הוא מסד הנתונים של המשלוחים הקבוצתיים בפרודקשן.',
 'render-group-delivery':'שירות זה מגיש גם את לוח הניהול. בתוכנית החינמית של Render השירות עשוי להירדם ולהתעורר לאט.',
 'dynamic-google-reviews':'אינטגרציית ביקורות Google הדינמית (Google Places / GCP) נדחתה בכוונה. כפתור ביקורות Google בפוטר נשאר פעיל. אין לפרוס או להפעיל את השרת שנדחה.',
 'group-delivery-payments':'קיים מימוש תשלומים נפרד שנדחה. אין למזג אותו ל־main או להפעיל אותו. לוח הניהול אינו תלוי בתשלומים.',
};
const worst=(...results:(CheckResult|undefined)[]):SystemStatus=>{
 if(results.some(r=>!r||r.status==='OFFLINE'))return 'OFFLINE';
 return results.some(r=>r!.status==='DEGRADED')?'DEGRADED':'OPERATIONAL';
};
// recovery: the recovery-email state only (provider name and sender domain); the API key never reaches this view.
export function systemsView(ops:OpsConfig,health:{results:Record<string,CheckResult>;checkedAt:string;cached:boolean},appOrigin:string,recovery:{state:'ENABLED'|'DISABLED'|'MISCONFIGURED';provider:string|null;senderDomain:string|null}={state:'DISABLED',provider:null,senderDomain:null}){
 const r=health.results;
 const note=(id:string)=>ops.notes[id]??NOTES[id]??null;
 const external=(label:string,url:string|null):SystemLink[]=>url?[{label,url,external:true}]:[];
 const costsFor=(id:string)=>ops.costs.filter(cost=>cost.system===id);
 const view=(v:Omit<SystemView,'note'|'costs'|'missing'|'check'|'checkKind'>&{missing?:string[];check?:CheckResult|null;checkKind?:SystemView['checkKind']}):SystemView=>
  ({check:null,checkKind:null,missing:[],...v,note:note(v.id),costs:costsFor(v.id)});
 const github=ops.githubRepoUrl;
 const systems:SystemView[]=[
  view({id:'shopify',name:'Shopify',mark:'S',status:'MANUAL',statusLabel:null,purpose:['חנות ואתר','מוצרים ומלאי','הזמנות','הנחות','משלוחים','תבנית האתר'],
   links:external('פתיחת Shopify',ops.shopifyAdminUrl),details:[],missing:ops.shopifyAdminUrl?[]:['OPS_SHOPIFY_ADMIN_URL']}),
  view({id:'shopify-theme-editor',name:'עורך התבניות של Shopify',mark:'ע',status:'MANUAL',statusLabel:null,purpose:['שינויי תוכן ועיצוב','הגדרות סקשנים','הגדרות תבנית'],
   links:external('פתיחת עורך התבניות',ops.themeEditorUrl),details:[],missing:ops.themeEditorUrl?[]:['OPS_SHOPIFY_THEME_EDITOR_URL / OPS_SHOPIFY_ADMIN_URL']}),
  view({id:'theme',name:'תבנית האתר (Shopify CLI)',mark:'T',status:'MANUAL',statusLabel:null,purpose:['פריסת התבנית','גרסת התבנית בפרודקשן'],links:[],
   details:[{label:'תבנית חיה',value:ops.theme.name??''},{label:'מזהה תבנית',value:ops.theme.id??'',mono:true},{label:'גרסת תבנית',value:ops.theme.revision??'',mono:true},{label:'תאריך שחרור אחרון',value:ops.theme.releasedAt??''}],
   missing:[...(ops.theme.name?[]:['OPS_THEME_NAME']),...(ops.theme.id?[]:['OPS_THEME_ID']),...(ops.theme.revision?[]:['OPS_THEME_REVISION'])]}),
  view({id:'github',name:'GitHub',mark:'GH',status:'MANUAL',statusLabel:null,purpose:['ניהול קוד','קומיטים וענפים','גיבוי והיסטוריה'],
   links:[...external('פתיחת GitHub',github),...(github?[{label:'ענף '+ops.githubBranch,url:github.replace(/\/$/,'')+'/tree/'+encodeURIComponent(ops.githubBranch),external:true}]:[])],
   details:[{label:'מאגר',value:github?github.replace(/^https:\/\/github\.com\//,'').replace(/\/$/,''):'',href:github??undefined},{label:'ענף פרודקשן',value:ops.githubBranch,mono:true},
    {label:'קומיט השרת הפרוס',value:ops.deployedCommit?ops.deployedCommit.slice(0,7):'',mono:true,href:github&&ops.deployedCommit?github.replace(/\/$/,'')+'/commit/'+ops.deployedCommit:undefined}],
   missing:github?[]:['OPS_GITHUB_REPO_URL']}),
  ...ops.renderServices.map(service=>{
   const url=service.url||(service.primary?appOrigin:null),check=r[service.id]??null;
   return view({id:service.id,name:'Render · '+service.name,mark:'R',status:check?check.status:'MANUAL',statusLabel:null,
    purpose:service.primary?['שרת המשלוחים הקבוצתיים','לוח הניהול']:service.purpose?[service.purpose]:[],
    links:[...external('פתיחת השירות',url),...external('פתיחת Render',service.dashboardUrl||ops.renderDashboardUrl)],
    details:[{label:'כתובת השירות',value:url??'',href:url??undefined,mono:true},{label:'בדיקת תקינות',value:service.healthPath,mono:true}],
    check,checkKind:check?'http':null,missing:url?[]:['url']});
  }),
  view({id:'neon',name:'Neon',mark:'N',status:r.neon?.status??'OFFLINE',statusLabel:null,purpose:['מסד נתונים PostgreSQL של המשלוחים הקבוצתיים'],
   links:external('פתיחת Neon',ops.neonConsoleUrl),details:[{label:'ספק',value:'Neon PostgreSQL'}],check:r.neon??null,checkKind:'database',missing:ops.neonConsoleUrl?[]:['OPS_NEON_CONSOLE_URL']}),
  view({id:'group-delivery-admin',name:'ניהול משלוחים קבוצתיים',mark:'מ',status:worst(r['render-group-delivery'],r.neon),statusLabel:null,purpose:['קבוצות ולקוחות','סטטוס משלוח','אזורי משלוח','יומן פעולות'],
   links:[{label:'לוח בקרה',url:'/admin',external:false},{label:'אזורי משלוח',url:'/admin/areas',external:false},{label:'יומן פעולות',url:'/admin/audit',external:false}],details:[],checkKind:'derived'}),
  view({id:'recovery-email',name:'מייל לשחזור הצטרפות (Resend)',mark:'@',status:'MANUAL',statusLabel:recovery.state==='ENABLED'?'פעיל':recovery.state==='MISCONFIGURED'?'חסרה הגדרה, השחזור כבוי':'כבוי',
   purpose:['קודי אימות לשחזור הצטרפות ממכשיר אחר'],links:external('פתיחת Resend',recovery.provider==='resend'?'https://resend.com/emails':null),
   details:[{label:'ספק',value:recovery.provider??''},{label:'דומיין שולח',value:recovery.senderDomain??'',mono:true}],
   missing:recovery.state==='MISCONFIGURED'?['RECOVERY_EMAIL_PROVIDER / RESEND_API_KEY / RECOVERY_EMAIL_FROM']:[]}),
  view({id:'google-business',name:'Google Business Profile',mark:'G',status:'MANUAL',statusLabel:null,purpose:['נוכחות העסק ב־Google','ביקורות'],
   links:external('פתיחת Google Business Profile',ops.googleBusinessUrl),details:[],missing:ops.googleBusinessUrl?[]:['OPS_GOOGLE_BUSINESS_URL']}),
  view({id:'merchant-center',name:'Google Merchant Center',mark:'MC',status:'MANUAL',statusLabel:null,purpose:['מוצרים ב־Google','אבחון מוצרים'],
   links:external('פתיחת Google Merchant Center',ops.merchantCenterUrl),details:[],missing:ops.merchantCenterUrl?[]:['OPS_MERCHANT_CENTER_URL']}),
  view({id:'domain',name:'דומיין',mark:'D',status:r.domain?.status??'MANUAL',statusLabel:null,purpose:['כתובת האתר ללקוחות'],
   links:external('פתיחת האתר',ops.storefrontUrl),details:[{label:'כתובת',value:ops.storefrontUrl?new URL(ops.storefrontUrl).host:'',href:ops.storefrontUrl??undefined}],
   check:r.domain??null,checkKind:r.domain?'http':null,missing:ops.storefrontUrl?[]:['OPS_STOREFRONT_URL']}),
 ];
 const postponed:SystemView[]=[
  view({id:'dynamic-google-reviews',name:'ביקורות Google דינמיות',mark:'★',status:'POSTPONED',statusLabel:'נדחה',purpose:['ביקורות Google מתעדכנות באתר (Google Places / GCP)'],links:[],details:[]}),
  view({id:'group-delivery-payments',name:'תשלומים במשלוח קבוצתי',mark:'₪',status:'POSTPONED',statusLabel:'בפיתוח / לא בפרודקשן',purpose:['תשלום על התחייבויות בקבוצה'],links:[],details:[]}),
 ];
 // Monthly totals per currency, never converted.
 const totals:Record<'USD'|'ILS',number>={USD:0,ILS:0};
 for(const cost of ops.costs)totals[cost.currency]+=cost.monthlyCents;
 const currencies=(['USD','ILS'] as const).filter(currency=>ops.costs.some(cost=>cost.currency===currency));
 const quickLinks:SystemLink[]=[
  ...external('פתיחת Shopify',ops.shopifyAdminUrl),...external('פתיחת GitHub',github),...external('פתיחת Render',ops.renderDashboardUrl),
  ...external('פתיחת Neon',ops.neonConsoleUrl),...external('פתיחת Google Merchant Center',ops.merchantCenterUrl),...external('פתיחת Google Business Profile',ops.googleBusinessUrl),
  ...external('פתיחת האתר',ops.storefrontUrl),{label:'ניהול משלוחים קבוצתיים',url:'/admin',external:false},{label:'יומן פעולות',url:'/admin/audit',external:false},
 ];
 return {
  generatedAt:new Date().toISOString(),checkedAt:health.checkedAt,cached:health.cached,
  systems,postponed,quickLinks,
  costs:{entries:ops.costs,monthlyTotals:Object.fromEntries(currencies.map(currency=>[currency,totals[currency]/100])) as Partial<Record<'USD'|'ILS',number>>,monthlyTotalsCents:Object.fromEntries(currencies.map(currency=>[currency,totals[currency]])) as Partial<Record<'USD'|'ILS',number>>},
  missing:[...new Set(systems.flatMap(system=>system.missing).filter(key=>key.startsWith('OPS_')))],
  warnings:ops.warnings,
 };
}
