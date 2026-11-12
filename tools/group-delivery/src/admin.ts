// Server-rendered admin dashboard (Hebrew, RTL). Every value is escaped here; pages work without JavaScript, and the
// one same-origin script (/admin/app.js) only adds copy buttons, row clicks, a loading bar and back-cache protection.
// Customer contact details appear only on these authenticated pages, never in public HTML or browser storage.
import {REACHABLE_STATUSES,dialable,type Page} from './admin-data.js';
export const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const TZ='Asia/Jerusalem';
const money=(agorot:number)=>new Intl.NumberFormat('he-IL',{style:'currency',currency:'ILS'}).format(agorot/100);
const dateTime=(iso:string)=>new Intl.DateTimeFormat('he-IL',{timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(iso));
const time=(iso:string)=>'<time datetime="'+escape(iso)+'">'+escape(dateTime(iso))+'</time>';
export const GROUP_LABELS:Record<string,string>={OPEN:'פתוחה',THRESHOLD_REACHED:'הגיעה ליעד',APPROVED:'אושרה',EXPIRED:'פג תוקף',PAYMENT_OPEN:'תשלום פתוח',CONFIRMED:'אושרה סופית',SCHEDULED:'מתוזמנת',COMPLETED:'הושלמה',CANCELLED:'בוטלה'};
export const MEMBER_LABELS:Record<string,string>={PLEDGED:'התחייבות פעילה',WITHDRAWN:'הוסר מהקבוצה'};
const ACTION_LABELS:Record<string,string>={'login':'התחברות','logout':'התנתקות','group.approve':'אישור קבוצה','area.create':'הוספת אזור','area.update':'עדכון אזור','group.export':'ייצוא נתוני קבוצה','member.withdraw':'הסרת לקוח מהקבוצה'};
const RESULT_LABELS:Record<string,string>={OK:'הצליח',DENIED:'נדחה',FAILED:'נכשל'};
const chip=(kind:'group'|'member',status:string)=>'<span class="chip chip--'+escape(status.toLowerCase())+'">'+escape((kind==='group'?GROUP_LABELS:MEMBER_LABELS)[status]||status)+'</span>';
// Visible, specific labels ("העתקת טלפון"), so neighbouring copy buttons are never ambiguous.
const copyButton=(value:string,label:string)=>'<button type="button" class="icon-btn" data-copy="'+escape(value)+'" data-copy-label="'+escape(label)+'" hidden>העתקת '+escape(label)+'</button>';
const query=(base:string,params:Record<string,string|number|undefined|null>)=>{
 const search=new URLSearchParams();for(const [key,value] of Object.entries(params))if(value!==undefined&&value!==null&&value!=='')search.set(key,String(value));
 const text=search.toString();return base+(text?'?'+text:'');
};
const progress=(group:{pledgedTotalAgorot:number;thresholdAgorot:number;progressPercent:number},large=false)=>
 '<div class="meter'+(large?' meter--large':'')+(group.progressPercent>=100?' meter--reached':'')+'">'+
 '<div class="meter__label"><span><strong>'+escape(money(group.pledgedTotalAgorot))+'</strong> מתוך '+escape(money(group.thresholdAgorot))+'</span><span>'+group.progressPercent+'%</span></div>'+
 '<div class="meter__track" role="progressbar" aria-label="התקדמות ליעד ההזמנה" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+group.progressPercent+'" aria-valuetext="'+escape(money(group.pledgedTotalAgorot)+' מתוך '+money(group.thresholdAgorot))+'"><span class="p'+Math.max(0,Math.min(100,group.progressPercent))+'"></span></div></div>';
const pager=(base:string,params:Record<string,string|number|undefined>,page:Page,label:string)=>{
 if(page.pageCount<=1)return '<p class="muted">'+page.total+' '+escape(label)+'</p>';
 const link=(target:number,text:string,rel:string)=>target<1||target>page.pageCount?'<span class="pager__link" aria-disabled="true">'+text+'</span>':'<a class="pager__link" rel="'+rel+'" href="'+escape(query(base,{...params,page:target}))+'">'+text+'</a>';
 return '<nav class="pager" aria-label="דפדוף">'+link(page.page-1,'הקודם','prev')+'<span>עמוד '+page.page+' מתוך '+page.pageCount+' · '+page.total+' '+escape(label)+'</span>'+link(page.page+1,'הבא','next')+'</nav>';
};

function layout(title:string,body:string,options:{csrf?:string;active?:string}={}){
 const nav=options.csrf?'<nav class="topbar__nav" aria-label="ניווט ניהול">'+[['/admin','לוח בקרה','dashboard'],['/admin/areas','אזורי משלוח','areas'],['/admin/audit','יומן פעולות','audit']]
  .map(([href,text,key])=>'<a href="'+href+'"'+(options.active===key?' aria-current="page"':'')+'>'+text+'</a>').join('')+'</nav>'+
  '<form method="post" action="/admin/logout" class="topbar__logout"><input type="hidden" name="csrf" value="'+escape(options.csrf)+'"><button class="btn btn--quiet">יציאה</button></form>':'';
 return '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'+
  '<title>'+escape(title)+' · ניהול משלוחים קבוצתיים</title><link rel="stylesheet" href="/admin/style.css"><script src="/admin/app.js" defer></script></head>'+
  '<body><a class="skip" href="#main">דילוג לתוכן</a><div class="loading-bar" aria-hidden="true"></div>'+
  '<header class="topbar"><a class="topbar__brand" href="/admin"><span class="topbar__dot" aria-hidden="true"></span>פאנקי · משלוחים קבוצתיים</a>'+nav+'</header>'+
  '<main id="main" tabindex="-1">'+body+'</main><p class="sr-only" role="status" aria-live="polite" id="admin-live"></p></body></html>';
}
const notice=(kind:'ok'|'error'|'info',text:string)=>'<p class="notice notice--'+kind+'" role="'+(kind==='error'?'alert':'status')+'">'+escape(text)+'</p>';

export function loginPage(state:{failed?:boolean;limited?:boolean;expired?:boolean;next?:string}={}){
 const message=state.failed?notice('error','שם המשתמש או הסיסמה אינם נכונים.'):state.limited?notice('error','יותר מדי ניסיונות התחברות. נסו שוב מאוחר יותר.'):state.expired?notice('info','פג תוקף ההתחברות או שנדרשת התחברות. יש להתחבר שוב.'):'';
 return layout('התחברות','<section class="login card"><h1>כניסה לניהול המשלוחים הקבוצתיים</h1>'+message+
  '<form method="post" action="/admin/login" class="stack"><input type="hidden" name="next" value="'+escape(state.next||'/admin')+'">'+
  '<label for="username">שם משתמש</label><input id="username" name="username" autocomplete="username" required maxlength="256" dir="ltr">'+
  '<label for="password">סיסמה</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024" dir="ltr">'+
  '<button class="btn btn--primary">כניסה</button></form><p class="muted">הגישה מוגבלת לבעלי החנות. המערכת מציגה פרטי לקוחות; אין לשתף את המסך.</p></section>');
}

export function dashboardPage(data:{metrics:any;list:any;areas:any[];csrf:string;notice?:string}){
 const {metrics:m,list}=data,f=list.filters;
 const card=(label:string,value:string,hint:string)=>'<li class="metric"><span class="metric__label">'+escape(label)+'</span><strong class="metric__value">'+escape(value)+'</strong><span class="metric__hint">'+escape(hint)+'</span></li>';
 const params={q:f.q,area:f.area,status:f.status,state:f.state,from:f.from,to:f.to,sort:f.sort,dir:f.dir,pageSize:list.pagination.pageSize===25?undefined:list.pagination.pageSize};
 const sortHeader=(key:string,label:string)=>{
  const current=f.sort===key,next=current&&f.dir==='desc'?'asc':'desc';
  return '<th scope="col"'+(current?' aria-sort="'+(f.dir==='asc'?'ascending':'descending')+'"':'')+'><a href="'+escape(query('/admin',{...params,sort:key,dir:next,page:undefined}))+'">'+escape(label)+(current?'<span aria-hidden="true">'+(f.dir==='asc'?' ▲':' ▼')+'</span>':'')+'</a></th>';
 };
 const filtered=!!(f.q||f.area||f.status||f.state||f.from||f.to);
 const rows=list.groups.map((g:any)=>'<tr data-href="/admin/groups/'+escape(g.publicId)+'">'+
  '<td data-label="אזור"><a class="row-link" href="/admin/groups/'+escape(g.publicId)+'">'+escape(g.areaName)+'</a>'+(g.legacy?' <span class="tag">ללא אזור מוגדר</span>':'')+'</td>'+
  '<td data-label="מזהה"><code dir="ltr">'+escape(g.shortId)+'</code> '+copyButton(g.publicId,'מזהה הקבוצה')+'</td>'+
  '<td data-label="סטטוס">'+chip('group',g.status)+'</td>'+
  '<td data-label="התחייבויות">'+progress(g)+'</td>'+
  '<td data-label="משתתפים" class="num">'+g.activeMembers+(g.totalMembers>g.activeMembers?' <span class="muted">('+(g.totalMembers-g.activeMembers)+' יצאו)</span>':'')+'</td>'+
  '<td data-label="נפתחה">'+time(g.createdAt)+'</td><td data-label="עודכנה">'+time(g.updatedAt)+'</td><td data-label="תוקף עד">'+time(g.expiresAt)+'</td></tr>').join('');
 const empty=filtered?'<div class="empty"><strong>לא נמצאו קבוצות שמתאימות לחיפוש.</strong><a class="btn btn--quiet" href="/admin">ניקוי הסינון</a></div>':'<div class="empty"><strong>עדיין אין משלוחים קבוצתיים.</strong><span>קבוצה נפתחת כשהלקוח הראשון מצטרף באזור.</span></div>';
 const option=(value:string,label:string,selected:string)=>'<option value="'+escape(value)+'"'+(value===selected?' selected':'')+'>'+escape(label)+'</option>';
 return layout('לוח בקרה',
  '<div class="page-head"><div><h1>לוח בקרה</h1><p class="muted">נכון ל־'+time(m.generatedAt)+' · שעון ישראל</p></div><a class="btn btn--quiet" href="'+escape(query('/admin',params))+'">רענון</a></div>'+
  (data.notice?notice('ok',data.notice):'')+
  '<ul class="metrics" aria-label="סיכום">'+
   card('קבוצות פעילות',String(m.activeGroups),'פתוחות להתחייבויות')+
   card('קבוצות שהגיעו ליעד',String(m.reachedGroups),m.reachedGroups?'ממתינות לאישור שלך':'אין קבוצות שממתינות')+
   card('לקוחות פעילים',String(m.activeCustomers),m.activePledges+' התחייבויות בקבוצות פעילות')+
   card('סך ההתחייבויות',money(m.activePledgedAgorot),'בקבוצות פעילות')+
   card('נפתחו היום',String(m.openedToday),'מחצות, שעון ישראל')+
   card('נפתחו השבוע',String(m.openedThisWeek),'מיום ראשון')+
  '</ul>'+
  '<section aria-labelledby="groups-title" class="card"><div class="section-head"><h2 id="groups-title">משלוחים קבוצתיים</h2><span class="muted">'+m.approvedGroups+' אושרו · '+m.expiredGroups+' פג תוקפן · '+m.allGroups+' בסך הכול</span></div>'+
  '<form method="get" action="/admin" class="filters" role="search" aria-label="סינון קבוצות">'+
   '<div class="field field--wide"><label for="q">חיפוש</label><input id="q" name="q" type="search" value="'+escape(f.q)+'" placeholder="מזהה קבוצה, אימייל או טלפון" autocomplete="off"></div>'+
   '<div class="field"><label for="area">אזור</label><select id="area" name="area">'+option('','כל האזורים',f.area)+data.areas.map((a:any)=>option(a.publicId,a.name+(a.active?'':' (לא פעיל)'),f.area)).join('')+option('none','ללא אזור מוגדר',f.area)+'</select></div>'+
   '<div class="field"><label for="status">סטטוס</label><select id="status" name="status">'+option('','כל הסטטוסים',f.status)+REACHABLE_STATUSES.map(s=>option(s,GROUP_LABELS[s],f.status)).join('')+'</select></div>'+
   '<div class="field"><label for="state">מצב</label><select id="state" name="state">'+option('','הכול',f.state)+option('active','פעילות',f.state)+option('closed','סגורות',f.state)+'</select></div>'+
   '<div class="field"><label for="from">נפתחה מתאריך</label><input id="from" name="from" type="date" value="'+escape(f.from)+'"></div>'+
   '<div class="field"><label for="to">עד תאריך</label><input id="to" name="to" type="date" value="'+escape(f.to)+'"></div>'+
   '<input type="hidden" name="sort" value="'+escape(f.sort)+'"><input type="hidden" name="dir" value="'+escape(f.dir)+'">'+
   '<div class="filters__actions"><button class="btn btn--primary">סינון</button>'+(filtered?'<a class="btn btn--quiet" href="/admin">ניקוי</a>':'')+'</div>'+
  '</form>'+
  (list.groups.length?'<div class="table-wrap"><table class="table table--groups"><caption class="sr-only">משלוחים קבוצתיים, ממוינים לפי '+escape(f.sort)+'</caption><thead><tr>'+
   sortHeader('area','אזור')+'<th scope="col">מזהה</th>'+sortHeader('status','סטטוס')+sortHeader('pledged','התחייבויות')+sortHeader('members','משתתפים')+sortHeader('created','נפתחה')+sortHeader('updated','עודכנה')+sortHeader('expires','תוקף עד')+
   '</tr></thead><tbody>'+rows+'</tbody></table></div>'+pager('/admin',params,list.pagination,'קבוצות'):empty)+
  '</section>',{csrf:data.csrf,active:'dashboard'});
}

const NOTICES:Record<string,string>={approved:'הקבוצה אושרה. אישור אינו פותח תשלום ואינו שולח הודעות ללקוחות.',area_saved:'האזור נשמר.',
 member_withdrawn:'הלקוח הוסר מהמשלוח הקבוצתי.',member_already_withdrawn:'הלקוח כבר הוסר מהקבוצה קודם לכן. לא בוצע שינוי.'};
const ERRORS:Record<string,string>={confirm:'יש לסמן את תיבת האישור לפני אישור הקבוצה.',APPROVAL_NOT_ALLOWED:'ניתן לאשר רק קבוצה פעילה שהגיעה ליעד.',
 GROUP_CLOSED:'לא ניתן להסיר לקוח מקבוצה שאינה פעילה. לא בוצע שינוי.',WITHDRAW_CONFIRMATION_REQUIRED:'נדרש אישור מפורש להסרת הלקוח. לא בוצע שינוי.'};
// Withdrawn members are labelled by who withdrew them (migration 004 backfills older rows as MEMBER).
const WITHDRAWN_BY:Record<string,string>={ADMIN:'הוסר על ידי מנהל',MEMBER:'פרש מהקבוצה'};
const memberChip=(m:{status:string;withdrawnBy?:string|null})=>m.status==='WITHDRAWN'
 ?'<span class="chip chip--'+(m.withdrawnBy==='ADMIN'?'removed':'withdrawn')+'">'+escape(WITHDRAWN_BY[m.withdrawnBy==='ADMIN'?'ADMIN':'MEMBER'])+'</span>'
 :chip('member',m.status);
export function groupPage(data:{group:any;members:any[];pagination:Page;memberStatus:string;csrf:string;notice?:string;error?:string}){
 const g=data.group,base='/admin/groups/'+g.publicId;
 const members=data.members.map((m:any)=>{
  const tel=dialable(m.phone),wa=tel?'https://wa.me/'+tel.slice(1):null;
  return '<tr data-href="'+escape(base+'/members/'+m.id)+'"'+(m.status==='WITHDRAWN'?' class="row--withdrawn"':'')+'>'+
   '<td data-label="אימייל"><a class="row-link" href="'+escape(base+'/members/'+m.id)+'" dir="ltr">'+escape(m.email)+'</a></td>'+
   '<td data-label="טלפון"><span dir="ltr">'+escape(m.phone)+'</span></td>'+
   '<td data-label="סטטוס">'+memberChip(m)+'</td>'+
   '<td data-label="התחייבות" class="num">'+escape(money(m.pledgedTotalAgorot))+'</td>'+
   '<td data-label="שורות בסל" class="num">'+m.cartLines+'</td>'+
   '<td data-label="הצטרפות">'+time(m.createdAt)+'</td><td data-label="עדכון אחרון">'+time(m.updatedAt)+'</td>'+
   '<td data-label="פעולות"><div class="actions">'+
    '<a class="icon-btn" href="mailto:'+escape(m.email)+'">אימייל<span class="sr-only"> אל '+escape(m.email)+'</span></a>'+
    (tel?'<a class="icon-btn" href="tel:'+escape(tel)+'">חיוג<span class="sr-only"> אל '+escape(m.phone)+'</span></a><a class="icon-btn" href="'+escape(wa!)+'" target="_blank" rel="noopener noreferrer">וואטסאפ<span class="sr-only"> אל '+escape(m.phone)+' (נפתח בכרטיסייה חדשה)</span></a>':'')+
    copyButton(m.email,'אימייל')+copyButton(m.phone,'טלפון')+
   '</div></td></tr>';
 }).join('');
 const filter=(value:string,label:string)=>'<a class="segmented__item" href="'+escape(query(base,{memberStatus:value||undefined}))+'"'+(data.memberStatus===value?' aria-current="true"':'')+'>'+escape(label)+'</a>';
 const approve=g.status==='THRESHOLD_REACHED'?'<form method="post" action="'+escape(base+'/approve')+'" class="approve card card--inset"><input type="hidden" name="csrf" value="'+escape(data.csrf)+'">'+
  '<h2>אישור הקבוצה</h2><p class="muted">אישור מסמן שהקבוצה הגיעה ליעד ונבדקה. הוא אינו פותח תשלום, אינו שולח הודעות ואינו ניתן לביטול מכאן.</p>'+
  '<label class="check"><input type="checkbox" name="confirm" value="yes" required> בדקתי את הקבוצה ואני מאשר/ת אותה</label><button class="btn btn--primary">אישור הקבוצה</button></form>':'';
 return layout('קבוצה ב'+g.areaName,
  '<p><a href="/admin" class="back">→ חזרה לרשימת הקבוצות</a></p>'+
  (data.notice&&NOTICES[data.notice]?notice('ok',NOTICES[data.notice]):'')+(data.error&&ERRORS[data.error]?notice('error',ERRORS[data.error]):'')+
  '<section class="card group-head" aria-labelledby="group-title"><div class="page-head"><div><h1 id="group-title">'+escape(g.areaName)+'</h1>'+chip('group',g.status)+(g.legacy?' <span class="tag">ללא אזור מוגדר</span>':'')+'</div>'+
   '<div class="actions"><a class="btn btn--quiet" href="'+escape(query(base,{memberStatus:data.memberStatus||undefined}))+'">רענון</a><a class="btn btn--quiet" href="'+escape(base+'/export.csv')+'" download>ייצוא לקובץ CSV</a><a class="btn btn--quiet" href="'+escape(base+'/export-lines.csv')+'" download>ייצוא שורות סל (CSV)</a></div></div>'+
   progress(g,true)+
   (g.progressPercent>=100?'<p class="reached">הקבוצה הגיעה ליעד ההזמנה.</p>':'<p class="muted">נותרו '+escape(money(g.remainingAgorot))+' עד היעד.</p>')+
   '<dl class="facts">'+
    '<div class="facts__wide"><dt>מזהה קבוצה</dt><dd><code dir="ltr">'+escape(g.publicId)+'</code> '+copyButton(g.publicId,'מזהה הקבוצה')+'</dd></div>'+
    '<div><dt>יעד</dt><dd>'+escape(money(g.thresholdAgorot))+'</dd></div>'+
    '<div><dt>משתתפים פעילים</dt><dd>'+g.activeMembers+(g.withdrawnMembers?' · '+g.withdrawnMembers+' הוסרו מהקבוצה':'')+'</dd></div>'+
    '<div><dt>תפוסה</dt><dd>'+g.capacity.active+' מתוך '+g.capacity.limit+' מקומות פעילים</dd></div>'+
    '<div><dt>נפתחה</dt><dd>'+time(g.createdAt)+'</dd></div><div><dt>עדכון אחרון</dt><dd>'+time(g.updatedAt)+'</dd></div>'+
    '<div><dt>'+(g.active?'פתוחה להצטרפות עד':'תאריך תפוגה')+'</dt><dd>'+time(g.expiresAt)+'</dd></div>'+
   '</dl></section>'+approve+
  '<section class="card" aria-labelledby="members-title"><div class="section-head"><h2 id="members-title">לקוחות בקבוצה</h2>'+
   '<nav class="segmented" aria-label="סינון לפי סטטוס">'+filter('','הכול')+filter('PLEDGED','פעילים')+filter('WITHDRAWN','הוסרו מהקבוצה')+'</nav></div>'+
   (data.members.length?'<div class="table-wrap"><table class="table table--members"><caption class="sr-only">לקוחות בקבוצה, לפי סדר ההצטרפות</caption><thead><tr><th scope="col">אימייל</th><th scope="col">טלפון</th><th scope="col">סטטוס</th><th scope="col">התחייבות</th><th scope="col">שורות בסל</th><th scope="col">הצטרפות</th><th scope="col">עדכון אחרון</th><th scope="col">פעולות</th></tr></thead><tbody>'+members+'</tbody></table></div>'+
    pager(base,{memberStatus:data.memberStatus||undefined},data.pagination,'לקוחות'):
    '<div class="empty"><strong>'+(data.memberStatus?'אין לקוחות בסטטוס הזה.':'אין לקוחות בקבוצה.')+'</strong></div>')+
   '<p class="muted">המערכת שומרת אימייל וטלפון בלבד; שם לקוח אינו נשמר. פעולות הקשר רק פותחות את האפליקציה המתאימה ואינן שולחות הודעות.</p>'+
  '</section>',{csrf:data.csrf,active:'dashboard'});
}

// Removal from the group (store owner). Shown only for a PLEDGED member of an active group. The trigger is a link to
// ?confirm=withdraw, which renders the confirmation in place without JavaScript; app.js opens the same <dialog>
// modally instead. Cancel comes first and has autofocus; it closes the dialog natively (formmethod=dialog).
function removal(g:any,m:any,csrf:string,confirming:boolean){
 if(m.status!=='PLEDGED')return '';
 if(!g.active)return '<section class="card" aria-labelledby="remove-title"><h2 id="remove-title">הסרה מהמשלוח הקבוצתי</h2><p class="muted">הקבוצה אינה פעילה ('+escape(GROUP_LABELS[g.status]||g.status)+'), ולכן לא ניתן להסיר ממנה לקוחות.</p></section>';
 const page='/admin/groups/'+g.publicId+'/members/'+m.id,amount=money(m.pledgedTotalAgorot);
 return '<section class="card danger-zone" aria-labelledby="remove-title"><div><h2 id="remove-title">הסרה מהמשלוח הקבוצתי</h2>'+
   '<p class="muted">לאחר שיצרתם קשר עם הלקוח והשתתפותו אינה רלוונטית עוד. הרשומה נשמרת בהיסטוריה, וההתחייבות מפסיקה להיספר ביעד הקבוצה.</p></div>'+
   '<a class="btn btn--danger-quiet" href="'+escape(page+'?confirm=withdraw')+'" data-open-dialog="withdraw-dialog" aria-haspopup="dialog">הסר מהמשלוח הקבוצתי</a></section>'+
  '<dialog id="withdraw-dialog" class="dialog" aria-labelledby="withdraw-dialog-title" aria-describedby="withdraw-dialog-text"'+(confirming?' open':'')+'>'+
   '<form method="post" action="'+escape(page+'/withdraw')+'" class="dialog__body"><input type="hidden" name="csrf" value="'+escape(csrf)+'"><input type="hidden" name="confirm" value="yes">'+
    '<h2 id="withdraw-dialog-title">הסרת לקוח מהמשלוח הקבוצתי</h2>'+
    '<dl class="dialog__facts"><div><dt>לקוח</dt><dd><span dir="ltr">'+escape(m.email)+'</span></dd><dd><span dir="ltr">'+escape(m.phone)+'</span></dd></div>'+
     '<div><dt>התחייבות נוכחית</dt><dd><strong>'+escape(amount)+'</strong></dd></div>'+
     '<div><dt>קבוצה</dt><dd>'+escape(g.areaName)+' · <code dir="ltr">'+escape(g.shortId)+'</code></dd></div></dl>'+
    '<p id="withdraw-dialog-text">הלקוח יוסר מהקבוצה וההתחייבות שלו בסך '+escape(amount)+' תוסר מהסכום הכולל.</p>'+
    '<p class="muted">הפעולה תישמר ביומן הפעולות.</p>'+
    '<div class="dialog__actions"><button type="submit" formmethod="dialog" formnovalidate class="btn btn--quiet" autofocus data-dialog-cancel>ביטול</button>'+
     '<button type="submit" class="btn btn--danger" data-withdraw-submit>הסר מהקבוצה</button></div>'+
   '</form></dialog>';
}

export function memberPage(data:{group:any;member:any;csrf:string;error?:string;confirming?:boolean}){
 const g=data.group,m=data.member,base='/admin/groups/'+g.publicId,tel=dialable(m.phone);
 const withdrawnFacts=m.status==='WITHDRAWN'?'<div><dt>יציאה מהקבוצה</dt><dd>'+escape(WITHDRAWN_BY[m.withdrawnBy==='ADMIN'?'ADMIN':'MEMBER'])+'</dd></div>'+
  '<div><dt>מועד היציאה</dt><dd>'+(m.withdrawnAt?time(m.withdrawnAt):'<span class="muted">לא נרשם (לפני תיעוד מועדי יציאה)</span>')+'</dd></div>':'';
 // Active pledge, or the last cart kept after a withdrawal (history only: never counted, restored or used for checkout).
 const past=m.snapshotKind==='HISTORICAL';
 const unitLabel=past?'מחיר יחידה (היסטורי)':'מחיר יחידה שנשמר',lineLabel=past?'סה״כ שורה (היסטורי)':'סה״כ שורה שנשמר';
 const lines=m.lines.map((line:any)=>'<tr><td data-label="מוצר">'+(line.title?escape(line.title):'<span class="muted">וריאנט</span>')+' <code dir="ltr">#'+escape(line.variantId)+'</code></td>'+
  '<td data-label="כמות" class="num">'+line.quantity+'</td><td data-label="'+unitLabel+'" class="num">'+escape(money(line.storedUnitAgorot))+'</td>'+
  '<td data-label="'+lineLabel+'" class="num">'+escape(money(line.storedLineAgorot))+'</td>'+
  '<td data-label="מחיר נוכחי בשופיפיי" class="num">'+(line.currentUnitAgorot===null?'<span class="muted">—</span>':escape(money(line.currentUnitAgorot))+(line.currentUnitAgorot!==line.storedUnitAgorot?' <span class="tag tag--warn">השתנה</span>':''))+(line.availableNow===false?' <span class="tag">לא זמין כעת</span>':'')+'</td></tr>').join('');
 const lookup=m.productLookup==='UNAVAILABLE'?notice('info','לא ניתן לטעון כרגע שמות מוצרים ומחירים נוכחיים מהחנות. הנתונים השמורים מוצגים במלואם.'):'';
 return layout('פרטי לקוח',
  '<p><a href="'+escape(base)+'" class="back">→ חזרה לקבוצה ב'+escape(g.areaName)+'</a></p>'+
  (data.error&&ERRORS[data.error]?notice('error',ERRORS[data.error]):'')+
  '<section class="card" aria-labelledby="member-title"><div class="page-head"><div><h1 id="member-title">פרטי לקוח</h1>'+memberChip(m)+'</div></div>'+
   '<dl class="facts">'+
    '<div><dt>אימייל</dt><dd><a href="mailto:'+escape(m.email)+'" dir="ltr">'+escape(m.email)+'</a> '+copyButton(m.email,'אימייל')+'</dd></div>'+
    '<div><dt>טלפון</dt><dd><span dir="ltr">'+escape(m.phone)+'</span> '+copyButton(m.phone,'טלפון')+'</dd></div>'+
    '<div><dt>סכום התחייבות שנשמר</dt><dd><strong>'+escape(money(m.pledgedTotalAgorot))+'</strong></dd></div>'+
    '<div><dt>הצטרפות</dt><dd>'+time(m.createdAt)+'</dd></div><div><dt>עדכון אחרון</dt><dd>'+time(m.updatedAt)+'</dd></div>'+
    '<div><dt>קבוצה</dt><dd><a href="'+escape(base)+'">'+escape(g.areaName)+'</a> · '+chip('group',g.status)+'</dd></div>'+
    withdrawnFacts+
    '<div class="facts__wide"><dt>מצב הקבוצה</dt><dd>'+progress(g)+'<span class="muted">'+g.activeMembers+' משתתפים פעילים'+(g.withdrawnMembers?' · '+g.withdrawnMembers+' הוסרו מהקבוצה':'')+'</span></dd></div>'+
   '</dl>'+
   '<div class="actions"><a class="btn btn--quiet" href="mailto:'+escape(m.email)+'">שליחת אימייל</a>'+(tel?'<a class="btn btn--quiet" href="tel:'+escape(tel)+'">חיוג</a><a class="btn btn--quiet" href="https://wa.me/'+escape(tel.slice(1))+'" target="_blank" rel="noopener noreferrer">וואטסאפ<span class="sr-only"> (נפתח בכרטיסייה חדשה)</span></a>':'')+'</div>'+
  '</section>'+
  '<section class="card'+(past?' card--history':'')+'" aria-labelledby="cart-title"><div class="section-head"><h2 id="cart-title">'+(past?'הסל האחרון לפני ההסרה':'הסל השמור בהתחייבות')+'</h2><span class="muted">'+(past?m.historicalLines:m.cartLines)+' שורות</span></div>'+
   (past?notice('info','תיעוד היסטורי בלבד: הסל אינו נספר ביעד הקבוצה, אינו משוחזר ללקוח ואינו משמש להזמנה או לתשלום. ההתחייבות הפעילה של הלקוח היא '+money(m.pledgedTotalAgorot)+'.'):'')+lookup+
   (m.lines.length?'<div class="table-wrap"><table class="table"><caption class="sr-only">'+(past?'הסל האחרון של הלקוח לפני היציאה מהקבוצה (היסטורי)':'שורות הסל כפי שנשמרו בעת ההתחייבות')+'</caption><thead><tr><th scope="col">מוצר</th><th scope="col">כמות</th><th scope="col">'+unitLabel+'</th><th scope="col">'+lineLabel+'</th><th scope="col">מחיר נוכחי בשופיפיי</th></tr></thead><tbody>'+lines+'</tbody>'+
    '<tfoot><tr><th scope="row" colspan="3">'+(past?'סכום הסל לפני ההסרה (היסטורי)':'סכום התחייבות שנשמר')+'</th><td class="num" colspan="2"><strong>'+escape(money(past?m.snapshotTotalAgorot:m.pledgedTotalAgorot))+'</strong></td></tr></tfoot></table></div>'+
    '<p class="muted">'+(past?'המחירים ההיסטוריים הם המחירים שאומתו מול שופיפיי בזמן ההתחייבות האחרונה. המחיר הנוכחי מוצג להשוואה בלבד.':'המחירים השמורים הם המחירים שאומתו מול שופיפיי בזמן ההתחייבות; הם אינם משתנים. המחיר הנוכחי מוצג להשוואה בלבד.')+'</p>':
    '<div class="empty"><strong>'+(past?'אין סל שמור מלפני ההסרה.':'אין שורות סל שמורות.')+'</strong>'+(past?'<span>יציאות שקדמו לשמירת הסל ההיסטורי אינן כוללות סל. סכום ההתחייבות שהוסר בידי מנהל מופיע ביומן הפעולות.</span>':'')+'</div>')+
  '</section>'+removal(g,m,data.csrf,!!data.confirming),{csrf:data.csrf,active:'dashboard'});
}

const areaFields=(csrf:string,area?:any)=>'<input type="hidden" name="csrf" value="'+escape(csrf)+'">'+
 '<label>שם האזור<input name="name" required maxlength="60" value="'+escape(area?.name??'')+'"></label>'+
 '<label>קו רוחב (מרכז)<input name="latitude" required inputmode="decimal" dir="ltr" value="'+escape(area?.latitude??'')+'"></label>'+
 '<label>קו אורך (מרכז)<input name="longitude" required inputmode="decimal" dir="ltr" value="'+escape(area?.longitude??'')+'"></label>'+
 '<label>סדר תצוגה<input name="sortOrder" inputmode="numeric" dir="ltr" value="'+escape(area?.sortOrder??0)+'"></label>'+
 '<label class="check"><input type="checkbox" name="active"'+(area===undefined||area.active?' checked':'')+'> פעיל (מוצג ללקוחות)</label>';
export function areasPage(data:{areas:any[];csrf:string;notice?:string}){
 return layout('אזורי משלוח','<div class="page-head"><div><h1 id="AreasTitle">אזורי משלוח</h1><p class="muted">אזור לא פעיל מוסתר מהלקוחות ואינו פותח קבוצות חדשות. קבוצות קיימות שלו נשמרות.</p></div></div>'+
  (data.notice&&NOTICES[data.notice]?notice('ok',NOTICES[data.notice]):'')+
  '<form method="post" action="/admin/areas" class="card area-form"><h2>הוספת אזור</h2>'+areaFields(data.csrf)+'<button class="btn btn--primary">הוספת אזור</button></form>'+
  '<div class="areas">'+data.areas.map(area=>'<form method="post" action="/admin/areas/'+escape(area.publicId)+'" class="card area-form"><h2>'+escape(area.name)+(area.active?'':' (לא פעיל)')+'</h2>'+areaFields(data.csrf,area)+'<button class="btn btn--primary">שמירה</button></form>').join('')+'</div>',
  {csrf:data.csrf,active:'areas'});
}

export function auditView(data:{events:any[];pagination:Page;csrf:string}){
 // A readable sentence for member removals, built only from the stored safe metadata (status, amount, ids).
 const describe=(e:any)=>{
  if(e.action!=='member.withdraw')return '';
  const text=e.result!=='OK'?'הבקשה לא בוצעה; הלקוח וההתחייבות לא שונו.':e.detail==='ALREADY_WITHDRAWN'?'הלקוח כבר הוסר קודם לכן. לא בוצע שינוי.':
   'הלקוח הוסר מהקבוצה.'+(e.amountAgorot!==null?' התחייבות של '+money(e.amountAgorot)+' הוסרה.':'');
  const link=e.target&&e.subject?' <a href="'+escape('/admin/groups/'+e.target+'/members/'+e.subject)+'">לפרטי הלקוח</a>':'';
  return '<span class="audit__desc">'+escape(text)+link+'</span>';
 };
 const rows=data.events.map(e=>'<tr><td data-label="זמן">'+time(e.at)+'</td><td data-label="פעולה">'+escape(ACTION_LABELS[e.action]||e.action)+describe(e)+'</td><td data-label="מבצע"><code dir="ltr">'+escape(e.actor)+'</code></td>'+
  '<td data-label="יעד">'+(e.target?'<code dir="ltr">'+escape(e.target)+'</code>':'—')+'</td><td data-label="תוצאה">'+escape(RESULT_LABELS[e.result]||e.result)+(e.detail?' <span class="muted" dir="ltr">'+escape(e.detail)+'</span>':'')+'</td></tr>').join('');
 return layout('יומן פעולות','<div class="page-head"><div><h1>יומן פעולות ניהול</h1><p class="muted">פעולות שינוי, התחברויות וייצוא נתונים. ללא סיסמאות, אסימונים או פרטי לקוחות.</p></div></div>'+
  '<section class="card">'+(data.events.length?'<div class="table-wrap"><table class="table"><caption class="sr-only">יומן פעולות, מהחדש לישן</caption><thead><tr><th scope="col">זמן</th><th scope="col">פעולה</th><th scope="col">מבצע</th><th scope="col">יעד</th><th scope="col">תוצאה</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+pager('/admin/audit',{},data.pagination,'אירועים'):'<div class="empty"><strong>אין עדיין אירועים ביומן.</strong></div>')+'</section>',
  {csrf:data.csrf,active:'audit'});
}

export function errorPage(status:number,message:string,csrf?:string){
 const text=status===404?'הדף או הפריט המבוקש לא נמצאו.':status===429?'יותר מדי בקשות. נסו שוב בעוד כמה דקות.':status>=500?'אירעה שגיאה בטעינת הנתונים. נסו לרענן בעוד רגע.':message;
 return layout('שגיאה','<section class="card"><h1>'+(status===404?'לא נמצא':'לא ניתן להציג את הדף')+'</h1>'+notice('error',text)+'<p><a class="btn btn--quiet" href="/admin">חזרה ללוח הבקרה</a></p></section>',{csrf});
}

export const adminCSS=`:root{--ink:#14323a;--muted:#5a6f76;--line:#d9e7ea;--surface:#fff;--bg:#f2f7f8;--teal:#0b5d66;--teal-strong:#084a52;--cyan:#12a7bb;--cyan-soft:#e3f5f7;--ok:#0f7a4f;--ok-soft:#e3f4ec;--warn:#8a5a00;--warn-soft:#fdf3dc;--bad:#a1271b;--bad-soft:#fbe9e7;--radius:14px;color-scheme:light}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,"Segoe UI",Arial,sans-serif}
a{color:var(--teal)}a:hover{color:var(--teal-strong)}code{font:13px/1.4 ui-monospace,Consolas,monospace;background:#eef4f5;padding:2px 6px;border-radius:6px}
:focus-visible{outline:3px solid var(--cyan);outline-offset:2px}
.sr-only{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.skip{position:absolute;inset-inline-start:12px;top:-60px;z-index:10;background:#fff;padding:10px 16px;border-radius:10px}.skip:focus{top:12px}
.loading-bar{position:fixed;inset-inline:0;top:0;height:3px;background:linear-gradient(90deg,var(--cyan),var(--teal));transform:scaleX(0);transform-origin:right;transition:transform .8s ease;z-index:20}
body[data-loading] .loading-bar{transform:scaleX(.8)}body[data-loading] main{opacity:.65;transition:opacity .2s}
@media (prefers-reduced-motion:reduce){.loading-bar,body[data-loading] main{transition:none}}
.topbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;padding:10px clamp(16px,3vw,32px);background:rgb(255 255 255 / 92%);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.topbar__brand{display:flex;align-items:center;gap:10px;font-weight:700;color:var(--ink);text-decoration:none;min-height:44px}
.topbar__dot{width:12px;height:12px;border-radius:50%;background:linear-gradient(135deg,var(--cyan),var(--teal))}
.topbar__nav{display:flex;flex-wrap:wrap;gap:4px;margin-inline-start:8px}.topbar__nav a{display:inline-flex;align-items:center;min-height:44px;padding:0 12px;border-radius:10px;color:var(--muted);text-decoration:none;font-weight:600}
.topbar__nav a[aria-current=page]{background:var(--cyan-soft);color:var(--teal-strong)}.topbar__nav a:hover{color:var(--teal-strong)}
.topbar__logout{margin-inline-start:auto}
main{max-width:1480px;margin:0 auto;padding:20px clamp(16px,3vw,32px) 48px}main:focus{outline:none}
h1{font-size:24px;line-height:1.3;margin:0 0 6px}h2{font-size:18px;margin:0}
.muted{color:var(--muted);font-size:13px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;box-shadow:0 1px 2px rgb(20 50 58 / 4%),0 6px 18px rgb(20 50 58 / 4%);margin-block:16px}
.card--inset{background:linear-gradient(160deg,var(--cyan-soft),#fff)}
.page-head,.section-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}.section-head{align-items:center;margin-bottom:12px}
.page-head h1{display:inline;margin-inline-end:10px}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid transparent;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn--primary{background:var(--teal);color:#fff}.btn--primary:hover{background:var(--teal-strong);color:#fff}
.btn--quiet{background:#fff;border-color:var(--line);color:var(--teal-strong)}.btn--quiet:hover{border-color:var(--teal);background:var(--cyan-soft)}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;min-width:44px;padding:0 10px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--teal-strong);font:inherit;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer}
.icon-btn:hover{background:var(--cyan-soft)}.icon-btn[data-copied]{background:var(--ok-soft);border-color:#b8dfc9;color:var(--ok)}
.actions{display:flex;flex-wrap:wrap;gap:6px}
.notice{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:#fff}.notice--ok{background:var(--ok-soft);border-color:#b8dfc9;color:var(--ok)}.notice--error{background:var(--bad-soft);border-color:#f0c4be;color:var(--bad)}.notice--info{background:var(--cyan-soft);border-color:#bfe3e8}
.metrics{list-style:none;padding:0;margin:16px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.metric{display:flex;flex-direction:column;gap:2px;padding:14px 16px;background:linear-gradient(160deg,#fff,var(--cyan-soft));border:1px solid var(--line);border-radius:var(--radius)}
.metric__label{color:var(--muted);font-size:13px;font-weight:600}.metric__value{font-size:26px;line-height:1.2;color:var(--teal-strong)}.metric__hint{color:var(--muted);font-size:12px}
.filters{display:grid;grid-template-columns:2fr repeat(5,minmax(120px,1fr)) auto;gap:10px;align-items:end;margin-bottom:14px}
.field{display:flex;flex-direction:column;gap:4px;min-width:0}.field label{font-size:13px;font-weight:600;color:var(--muted)}
input,select{min-height:44px;width:100%;padding:8px 10px;border:1px solid #b9cfd4;border-radius:10px;background:#fff;color:inherit;font:inherit}
.filters__actions{display:flex;gap:6px}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
.table{width:100%;border-collapse:collapse;font-size:14px}
.table th,.table td{padding:10px 12px;text-align:start;vertical-align:middle;border-bottom:1px solid var(--line)}
.table thead th{position:sticky;top:0;background:#f6fafb;color:var(--muted);font-size:12px;font-weight:700;white-space:nowrap}
.table thead th a{color:inherit;text-decoration:none;display:inline-flex;min-height:32px;align-items:center}.table thead th a:hover{color:var(--teal-strong)}
.table tbody tr:last-child td{border-bottom:0}.table tbody tr[data-href]{cursor:pointer}.table tbody tr[data-href]:hover{background:#f6fbfc}
.table tfoot th,.table tfoot td{background:#f6fafb;font-weight:700}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.row-link{font-weight:700;text-decoration:none}.row-link:hover{text-decoration:underline}
.chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap;background:#eef2f3;color:#4b5e64}
.chip::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.chip--open{background:var(--cyan-soft);color:var(--teal-strong)}.chip--threshold_reached{background:var(--ok-soft);color:var(--ok)}.chip--approved{background:#e8ecfb;color:#3346a8}
.chip--expired,.chip--cancelled{background:#f1f1f1;color:#666}.chip--pledged{background:var(--ok-soft);color:var(--ok)}.chip--withdrawn{background:#f1f1f1;color:#666}.chip--removed{background:var(--bad-soft);color:var(--bad)}
.card--history{background:#fafbfb;border-style:dashed}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:#eef2f3;color:var(--muted);font-size:12px}.tag--warn{background:var(--warn-soft);color:var(--warn)}
.meter{min-width:170px}.meter__label{display:flex;justify-content:space-between;gap:8px;font-size:13px}.meter__track{height:8px;margin-top:4px;border-radius:999px;background:#e3edf0;overflow:hidden}
.meter__track span{display:block;height:100%;border-radius:inherit;background:linear-gradient(270deg,var(--teal),var(--cyan))}.meter--reached .meter__track span{background:linear-gradient(270deg,#0f7a4f,#1ea672)}
.meter--large{margin-top:14px}.meter--large .meter__label{font-size:16px}.meter--large .meter__track{height:14px}
.reached{color:var(--ok);font-weight:700}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 20px;margin:16px 0 0}.facts .facts__wide{grid-column:1/-1}.facts div{min-width:0}.facts dt{font-size:12px;font-weight:700;color:var(--muted)}.facts dd{margin:2px 0 0;overflow-wrap:anywhere}
.segmented{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:12px;background:#eef4f5}.segmented__item{display:inline-flex;align-items:center;min-height:40px;padding:0 12px;border-radius:9px;color:var(--muted);text-decoration:none;font-weight:600;font-size:13px}
.segmented__item[aria-current]{background:#fff;color:var(--teal-strong);box-shadow:0 1px 3px rgb(20 50 58 / 12%)}
.pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;font-size:13px;color:var(--muted)}
.pager__link{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:#fff;text-decoration:none;font-weight:600}.pager__link[aria-disabled]{opacity:.45}
.empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:32px 16px;text-align:center;color:var(--muted)}.empty strong{color:var(--ink)}
.stack{display:flex;flex-direction:column;gap:6px}.stack button{margin-top:10px}
.login{max-width:420px;margin:48px auto}
.check{display:flex;align-items:center;gap:10px;min-height:44px}.check input{width:20px;height:20px;min-height:0}
.approve{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.areas{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.area-form{display:flex;flex-direction:column;gap:6px;margin:0}.area-form label:not(.check){display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;color:var(--muted)}
.area-form+.areas,.page-head+.notice+.area-form,.page-head+.area-form{margin-bottom:16px}
.back{display:inline-flex;align-items:center;min-height:44px;text-decoration:none;font-weight:600}
.btn--danger{background:var(--bad);color:#fff}.btn--danger:hover{background:#86200f;color:#fff}
.btn--danger-quiet{background:#fff;border-color:#f0c4be;color:var(--bad)}.btn--danger-quiet:hover{background:var(--bad-soft);color:var(--bad)}
.danger-zone{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;border-color:#f0c4be}.danger-zone>div{flex:1 1 320px;min-width:0}.danger-zone p{margin:6px 0 0}
.dialog{width:min(520px,calc(100vw - 32px));max-width:none;padding:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);color:var(--ink);box-shadow:0 20px 60px rgb(20 50 58 / 25%)}
.dialog::backdrop{background:rgb(20 50 58 / 45%)}
.dialog:not(:modal){position:static;width:auto;margin:16px 0;box-shadow:none;border-color:#f0c4be}
.dialog__body{display:flex;flex-direction:column;gap:12px;padding:20px}.dialog__body p{margin:0}
.dialog__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px 16px;margin:0;padding:12px 14px;border-radius:10px;background:#f6fafb}
.dialog__facts div{min-width:0}.dialog__facts dt{font-size:12px;font-weight:700;color:var(--muted)}.dialog__facts dd{margin:2px 0 0;overflow-wrap:anywhere}
.dialog__actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:4px}
.row--withdrawn{background:#fafafa}.row--withdrawn td{color:var(--muted)}
.audit__desc{display:block;margin-top:2px;font-size:13px;color:var(--muted)}
@media (max-width:1100px){.filters{grid-template-columns:repeat(3,minmax(0,1fr))}.field--wide{grid-column:1/-1}.filters__actions{grid-column:1/-1}}
@media (max-width:760px){
 body{font-size:15px}.topbar__nav{order:3;width:100%;margin:0}.filters{grid-template-columns:1fr 1fr}
 .table-wrap{border:0;overflow:visible}.table thead{display:none}.table,.table tbody,.table tr,.table td,.table tfoot,.table tfoot th{display:block;width:100%}
 .table tbody tr{margin-bottom:10px;padding:8px 12px;border:1px solid var(--line);border-radius:12px;background:#fff}
 .table td{display:grid;grid-template-columns:minmax(96px,34%) 1fr;gap:10px;align-items:center;padding:6px 0;border:0}
 .table td::before{content:attr(data-label);font-size:12px;font-weight:700;color:var(--muted)}
 .table tfoot tr{display:flex;justify-content:space-between;padding:10px 12px;border-radius:12px}.table tfoot th,.table tfoot td{width:auto;border:0}
 .meter{min-width:0}
}
@media (max-width:420px){.filters{grid-template-columns:1fr}.dialog__actions .btn,.danger-zone .btn{flex:1 1 100%}}
@media print{.topbar,.filters,.actions,.pager{display:none}}
`+Array.from({length:101},(_,i)=>`.meter__track .p${i}{width:${i}%}`).join("")+``;

// Progressive enhancements only (CSP: script-src 'self'). No storage, no network calls, no customer data kept in JS.
export const adminJS=`(()=>{'use strict';
 const live=document.getElementById('admin-live');
 const say=text=>{if(live){live.textContent='';requestAnimationFrame(()=>{live.textContent=text;});}};
 for(const button of document.querySelectorAll('[data-copy]')){
  button.hidden=false;
  button.addEventListener('click',async()=>{
   const value=button.dataset.copy||'';
   try{await navigator.clipboard.writeText(value);}catch{const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();try{document.execCommand('copy');}catch{}area.remove();}
   button.setAttribute('data-copied','');say((button.dataset.copyLabel||'')+' הועתק');setTimeout(()=>button.removeAttribute('data-copied'),1500);
  });
 }
 // A whole table row opens its detail page; links and buttons inside keep their own behaviour.
 document.addEventListener('click',event=>{
  const row=event.target.closest('tr[data-href]');
  if(!row||event.target.closest('a,button,input,select,label')||getSelection().toString())return;
  location.href=row.dataset.href;
 });
 // Confirmation dialogs: the trigger link (?confirm=…) works without script; here it opens the <dialog> modally with
 // focus on Cancel. Escape and Cancel close it without any request; focus returns to the trigger.
 for(const trigger of document.querySelectorAll('[data-open-dialog]')){
  const dialog=document.getElementById(trigger.dataset.openDialog||'');
  if(!(dialog instanceof HTMLDialogElement)||typeof dialog.showModal!=='function')continue;
  const open=()=>{if(dialog.open)dialog.close();dialog.showModal();dialog.querySelector('[data-dialog-cancel]')?.focus();};
  trigger.addEventListener('click',event=>{event.preventDefault();open();});
  dialog.addEventListener('close',()=>{
   if(new URLSearchParams(location.search).has('confirm'))history.replaceState(null,'',location.pathname);
   if(trigger.isConnected)trigger.focus();
  });
  if(dialog.open)open();
 }
 const busy=()=>{document.body.setAttribute('data-loading','');document.querySelector('main')?.setAttribute('aria-busy','true');};
 document.addEventListener('submit',event=>{
  const submitter=event.submitter;
  // Cancel (formmethod=dialog) only closes a dialog: no request, so no loading state.
  if(event.defaultPrevented||submitter?.getAttribute('formmethod')==='dialog')return;
  busy();
  // One removal request per click; the server is idempotent anyway.
  if(submitter?.hasAttribute('data-withdraw-submit'))setTimeout(()=>{submitter.disabled=true;});
 });
 document.addEventListener('click',event=>{
  const link=event.target.closest('a[href]');
  if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||link.target||link.hasAttribute('download'))return;
  const url=new URL(link.href,location.href);if(url.origin===location.origin&&url.pathname.startsWith('/admin')&&url.hash==='')busy();
 });
 // Never show a back/forward-cached admin page (for example after logout): fetch it again from the server.
 addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();`;
