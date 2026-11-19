// "בקשות ביטול" admin pages (server-rendered, Hebrew RTL, same admin layout; every value is escaped). The full Israeli
// ID number never appears here except in the response to an explicit, audited reveal (a POST, never a URL); the list
// shows a minimal identifier (masked email) only.
import {escape,layout,notice,pager,query,time} from './admin.js';
import {CANCELLATION_STATUS_LABELS,CANCELLATION_STATUSES,type CancellationDetail,type CancellationStatus,type CancellationSummary} from './cancellations.js';
import type {Page} from './admin-data.js';

const CHIP:Record<CancellationStatus,string>={NEW:'chip chip--op chip--op-new',IN_REVIEW:'chip chip--op chip--op-in-progress',COMPLETED:'chip chip--op chip--op-completed'};
const chip=(status:CancellationStatus)=>'<span class="'+CHIP[status]+'">'+escape(CANCELLATION_STATUS_LABELS[status]||status)+'</span>';
export const CANCELLATION_NOTICES:Record<string,string>={status_updated:'שלב הטיפול עודכן.',note_saved:'ההערה נשמרה.'};
export const CANCELLATION_PAGE_ERRORS:Record<string,string>={reveal_confirm:'כדי להציג את המספר המלא יש לסמן שיש בכך צורך לטיפול בבקשה.',transition:'לא ניתן להעביר את הבקשה לשלב הזה.',
 purged:'הפרטים האישיים של הבקשה כבר נמחקו; לא ניתן לשנות אותה.',note_invalid:'ההערה ארוכה מדי או מכילה תווים לא תקינים (עד 1000 תווים).',unavailable:'לא ניתן לפענח את מספר תעודת הזהות כרגע. יש לבדוק את הגדרת CANCELLATION_ENCRYPTION_KEY.'};
const warningBlock=(warnings:string[])=>warnings.length?'<div class="notice notice--info cx-warnings" role="status" data-cancellation-warnings><strong>הגדרות בקשות הביטול:</strong><ul>'+warnings.map(w=>'<li>'+escape(w)+'</li>').join('')+'</ul></div>':'';

export function cancellationsPage(data:{list:{requests:CancellationSummary[];counts:Record<CancellationStatus,number>;filters:{status:string;q:string;page:number};pagination:Page};
 warnings:string[];retentionDays:number|null;csrf:string;notice?:string;purged?:number|null}){
 const f=data.list.filters,base='/admin/cancellations';
 const view=(status:string,label:string)=>'<a class="segmented__item" href="'+escape(query(base,{status,q:f.q}))+'"'+(f.status===status?' aria-current="page"':'')+'>'+escape(label)+'</a>';
 const rows=data.list.requests.map(r=>{
  const href=base+'/'+r.reference;
  return '<tr data-href="'+escape(href)+'"><td data-label="מספר בקשה"><a href="'+escape(href)+'"><code dir="ltr">'+escape(r.reference)+'</code></a></td><td data-label="התקבלה">'+time(r.createdAt)+'</td>'+
   '<td data-label="מספר הזמנה">'+(r.orderNumber?'<span dir="ltr">#'+escape(r.orderNumber)+'</span>':'<span class="muted">—</span>')+'</td>'+
   '<td data-label="לקוח">'+(r.purged?'<span class="tag">פרטים נמחקו</span>':'<span dir="ltr">'+escape(r.customer)+'</span>')+'</td>'+
   '<td data-label="סטטוס">'+chip(r.status)+'</td><td data-label="פעולות"><a class="btn btn--quiet" href="'+escape(href)+'">פתיחה<span class="sr-only"> של בקשה '+escape(r.reference)+'</span></a></td></tr>';
 }).join('');
 const purged=typeof data.purged==='number'?notice('ok','המחיקה לפי תקופת השמירה הסתיימה: '+(data.purged===1?'בקשה אחת נמחקה.':data.purged+' בקשות נמחקו.')):'';
 const retention=data.retentionDays===null?
  '<p class="muted">לא הוגדרה תקופת שמירה, ולכן בקשות אינן נמחקות. התקופה נקבעת במשתנה CANCELLATION_RETENTION_DAYS בשירות ב־Render, לאחר ייעוץ משפטי וחשבונאי.</p>':
  '<p>הפרטים האישיים של בקשה, כולל מספר תעודת הזהות המוצפן, נמחקים <strong>'+data.retentionDays+' ימים</strong> לאחר סיום הטיפול בה. נשארים רק מספר הבקשה, הסטטוס והמועדים. המחיקה רצה אוטומטית בהפעלת השירות ומדי כמה שעות.</p>'+
  '<form method="post" action="/admin/cancellations/retention" class="cx-inline"><input type="hidden" name="csrf" value="'+escape(data.csrf)+'"><button class="btn btn--quiet" data-once>הפעלת המחיקה עכשיו</button></form>';
 return layout('בקשות ביטול',
  '<div class="page-head"><div><h1 id="cancellations-title">בקשות ביטול</h1><p class="muted">בקשות לביטול עסקה שנשלחו מהטופס באתר. מספר תעודת הזהות שמור מוצפן ומוצג רק לפי בקשה מפורשת.</p></div></div>'+
  warningBlock(data.warnings)+(data.notice&&Object.hasOwn(CANCELLATION_NOTICES,data.notice)?notice('ok',CANCELLATION_NOTICES[data.notice]):'')+purged+
  '<nav class="segmented segmented--views" aria-label="סינון לפי שלב טיפול">'+view('','הכול')+CANCELLATION_STATUSES.map(s=>view(s,CANCELLATION_STATUS_LABELS[s]+' ('+data.list.counts[s]+')')).join('')+'</nav>'+
  '<form method="get" action="/admin/cancellations" class="cx-search" role="search">'+(f.status?'<input type="hidden" name="status" value="'+escape(f.status)+'">':'')+
   '<label for="cx-q">חיפוש לפי מספר בקשה, מספר הזמנה או דוא״ל (התאמה מלאה)</label><div class="cx-inline"><input id="cx-q" name="q" type="search" maxlength="254" dir="ltr" value="'+escape(f.q)+'"><button class="btn btn--quiet">חיפוש</button>'+
   (f.q?'<a class="btn btn--quiet" href="'+escape(query(base,{status:f.status}))+'">ניקוי</a>':'')+'</div></form>'+
  '<section class="card" aria-labelledby="cancellations-title">'+(data.list.requests.length?
   '<div class="table-wrap"><table class="table"><caption class="sr-only">בקשות ביטול, מהחדשה לישנה</caption><thead><tr><th scope="col">מספר בקשה</th><th scope="col">התקבלה</th><th scope="col">מספר הזמנה</th><th scope="col">לקוח</th><th scope="col">סטטוס</th><th scope="col">פעולות</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
   pager(base,{status:f.status,q:f.q},data.list.pagination,'בקשות'):
   '<div class="empty"><strong>'+(f.status||f.q?'אין בקשות שמתאימות לסינון.':'עדיין לא התקבלו בקשות ביטול.')+'</strong></div>')+'</section>'+
  '<section class="card" aria-labelledby="retention-title"><h2 id="retention-title">תקופת שמירה</h2>'+retention+'</section>',
  {csrf:data.csrf,active:'cancellations'});
}

const ACTION_LABELS:Record<CancellationStatus,string>={NEW:'',IN_REVIEW:'העברה לטיפול',COMPLETED:'סימון שהטיפול הסתיים'};
export function cancellationPage(data:{request:CancellationDetail;csrf:string;notice?:string;error?:string;revealedId?:string|null}){
 const r=data.request,base='/admin/cancellations/'+r.reference,csrf='<input type="hidden" name="csrf" value="'+escape(data.csrf)+'">';
 const fact=(label:string,value:string,wide=false)=>'<div'+(wide?' class="facts__wide"':'')+'><dt>'+escape(label)+'</dt><dd>'+value+'</dd></div>';
 const none='<span class="muted">לא נמסר</span>';
 const dates=fact('התקבלה',time(r.createdAt))+fact('עדכון אחרון',time(r.updatedAt))+(r.inReviewAt?fact('נכנסה לטיפול',time(r.inReviewAt)):'')+(r.completedAt?fact('הטיפול הסתיים',time(r.completedAt)):'')+
  (r.handledBy?fact('עודכנה על ידי',''+'<code dir="ltr">'+escape(r.handledBy)+'</code>'):'');
 const head='<p><a href="/admin/cancellations" class="back">→ חזרה לבקשות הביטול</a></p>'+
  (data.error&&Object.hasOwn(CANCELLATION_PAGE_ERRORS,data.error)?notice('error',CANCELLATION_PAGE_ERRORS[data.error]):'')+(data.notice&&Object.hasOwn(CANCELLATION_NOTICES,data.notice)?notice('ok',CANCELLATION_NOTICES[data.notice]):'');
 const title='<div class="page-head"><div><h1 id="request-title">בקשת ביטול <code dir="ltr">'+escape(r.reference)+'</code></h1>'+chip(r.status)+'</div></div>';
 if(r.purged)return layout('בקשת ביטול',head+'<section class="card" aria-labelledby="request-title">'+title+
  notice('info','הפרטים האישיים של הבקשה, כולל מספר תעודת הזהות המוצפן, נמחקו בהתאם לתקופת השמירה. נשארו רק מספר הבקשה, הסטטוס והמועדים.')+
  '<dl class="facts">'+dates+(r.purgedAt?fact('הפרטים נמחקו',time(r.purgedAt)):'')+'</dl></section>',{csrf:data.csrf,active:'cancellations'});
 const id=data.revealedId?
  '<strong class="cx-id" dir="ltr" data-revealed-id>'+escape(data.revealedId)+'</strong><p class="muted">המספר המלא מוצג בדף זה בלבד, ואינו נשמר בדפדפן. מעבר לדף אחר מסתיר אותו. ההצגה נרשמה ביומן הפעולות.</p>':
  r.maskedId?'<span class="cx-id" dir="ltr" data-masked-id>'+escape(r.maskedId)+'</span>'+
   '<form method="post" action="'+escape(base+'/reveal-id')+'" class="cx-reveal">'+csrf+
    '<label class="check"><input type="checkbox" name="confirm" value="yes" required> יש צורך בהצגת המספר המלא לטיפול בבקשה</label>'+
    '<button class="btn btn--quiet">הצגת המספר המלא</button></form><p class="muted">ההצגה נרשמת ביומן הפעולות. ברוב המקרים אפשר לאתר את העסקה לפי מספר ההזמנה או הדוא״ל.</p>':
  '<span class="muted">לא ניתן להציג כרגע (מפתח ההצפנה אינו זמין).</span>';
 const tel=r.phone?r.phone.replace(/[^+\d]/g,''):'';
 const details='<dl class="facts">'+
  fact('שם מלא',r.fullName?escape(r.fullName):none)+
  fact('דוא״ל',r.email?'<a href="mailto:'+escape(r.email)+'" dir="ltr">'+escape(r.email)+'</a> <button type="button" class="icon-btn" data-copy="'+escape(r.email)+'" data-copy-label="אימייל" hidden>העתקת אימייל</button>':none)+
  fact('טלפון',r.phone?'<a href="tel:'+escape(tel)+'" dir="ltr">'+escape(r.phone)+'</a>':none)+
  fact('מספר הזמנה',r.orderNumber?'<span dir="ltr">#'+escape(r.orderNumber)+'</span>':none)+
  fact('מספר תעודת זהות',id)+dates+
  fact('סיבת הביטול',r.reason?'<p class="cx-reason">'+escape(r.reason)+'</p>':none,true)+
  '</dl>';
 const actions=r.transitions.map(next=>'<form method="post" action="'+escape(base+'/status')+'" class="cx-inline">'+csrf+'<input type="hidden" name="status" value="'+next+'">'+
  '<button class="btn '+(next==='COMPLETED'?'btn--primary':'btn--quiet')+'" data-once>'+escape(r.status==='COMPLETED'&&next==='IN_REVIEW'?'פתיחה מחדש (חזרה לטיפול)':ACTION_LABELS[next])+'</button></form>').join('');
 return layout('בקשת ביטול',head+
  '<section class="card" aria-labelledby="request-title">'+title+details+'</section>'+
  '<section class="card" aria-labelledby="status-title"><h2 id="status-title">שלב הטיפול</h2><p class="muted">השלבים מתעדים את הטיפול בלבד, ואינם קובעים אם העסקה ניתנת לביטול. סימון שהטיפול הסתיים מתחיל את ספירת תקופת השמירה.</p>'+
   '<div class="actions">'+actions+'</div></section>'+
  '<section class="card" aria-labelledby="note-title"><h2 id="note-title">הערה פנימית</h2>'+
   '<form method="post" action="'+escape(base+'/note')+'" class="stack">'+csrf+'<label for="cx-note">הערה (לא נשלחת ללקוח; אין לרשום בה מספר תעודת זהות)</label>'+
   '<textarea id="cx-note" name="note" rows="4" maxlength="1000">'+escape(r.adminNote??'')+'</textarea><div><button class="btn btn--quiet">שמירת ההערה</button></div></form></section>',
  {csrf:data.csrf,active:'cancellations'});
}
