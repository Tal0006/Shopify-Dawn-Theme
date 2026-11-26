// Admin pages for expiration management (src/renewals.ts): the renewals overview, and the extra sections of a group page
// (products, payments, renewal with customer reconfirmations, and the group's own audit history).
import {escape,layout,notice,time} from './admin.js';
import {RECONFIRM_METHODS,REOPEN_DAYS} from './renewals.js';
import {dialable} from './admin-data.js';

const money=(agorot:number)=>new Intl.NumberFormat('he-IL',{style:'currency',currency:'ILS'}).format(agorot/100);
export const METHOD_LABELS:Record<string,string>={PHONE:'בשיחת טלפון',WHATSAPP:'בוואטסאפ',EMAIL:'באימייל',IN_PERSON:'פנים אל פנים'};
const BLOCKER_LABELS:Record<string,string>={NOT_EXPIRED:'הקבוצה אינה במצב "פג תוקף".',DELIVERY_STARTED:'המשלוח של הקבוצה כבר התחיל.',CARD_GROUP:'זו קבוצה עם שריון כרטיס: כל לקוח צריך לשריין כרטיס מחדש בעצמו.',
 PAYMENT_RECORDED:'נרשם תשלום או חיוב בקבוצה.',CHARGES_EXIST:'קיימים חיובים לקבוצה.',NO_AREA:'לקבוצה אין אזור מוגדר.',CURRENT_GROUP_EXISTS:'כבר קיימת קבוצה פעילה באזור הזה; פתיחה נוספת הייתה מפצלת את ההתקדמות.'};
export const RENEWAL_NOTICES:Record<string,string>={reconfirmed:'אישור הלקוח נרשם. ההתחייבות תיספר רק לאחר פתיחת הקבוצה מחדש.',reopened:'הקבוצה נפתחה מחדש. ההתקדמות המעודכנת מוצגת ללקוחות.'};
export const RENEWAL_ERRORS:Record<string,string>={INVALID_RECONFIRMATION:'פרטי האישור אינם תקינים: יש לבחור כיצד הלקוח אישר. ההערה יכולה להכיל עד 60 תווים, בלי אימייל או טלפון.',
 PRICE_CHANGED:'מחירי המוצרים השתנו. יש לאשר עם הלקוח את הסכום החדש ולסמן זאת. לא בוצע שינוי.',RENEWAL_NOT_ALLOWED:'לא ניתן לחדש את הקבוצה הזו כרגע. לא בוצע שינוי.',
 ALREADY_ACTIVE_ELSEWHERE:'הלקוח כבר רשום במשלוח קבוצתי פעיל אחר, ולכן לא ייספר פעמיים. לא בוצע שינוי.',CURRENT_GROUP_EXISTS:'כבר קיימת קבוצה פעילה באזור הזה. לא בוצע שינוי.',
 CARD_GROUP_REQUIRES_CUSTOMER:'בקבוצה עם שריון כרטיס, כל לקוח צריך לשריין כרטיס מחדש בעצמו. לא בוצע שינוי.',RECONFIRMATION_REQUIRED:'אף לקוח עדיין לא אישר מחדש. יש לרשום אישור של לקוח אחד לפחות. לא בוצע שינוי.',
 REOPEN_CONFIRMATION_REQUIRED:'יש לסמן את תיבת האישור לפני הפתיחה מחדש. לא בוצע שינוי.',INVALID_INPUT:'מספר הימים אינו תקין. לא בוצע שינוי.',SHOPIFY_UNAVAILABLE:'לא ניתן לבדוק כרגע מלאי ומחירים מול החנות. לא בוצע שינוי; נסו שוב מאוחר יותר.',
 CART_UNAVAILABLE:'חלק מהמוצרים בסל אינם זמינים כרגע, ולכן לא ניתן לחדש את ההתחייבות כפי שהיא. לא בוצע שינוי.',INVALID_CART:'הסל השמור כבר אינו תקין מול החנות. לא בוצע שינוי.'};
const ACTION_LABELS:Record<string,string>={'group.reopen':'פתיחת קבוצה מחדש','member.reconfirm':'רישום אישור לקוח','member.withdraw':'הסרת לקוח','group.approve':'אישור קבוצה','group.export':'ייצוא נתונים',
 'group.operational_status_change':'שינוי סטטוס משלוח','group.complete':'השלמת משלוח','group.charges_process':'שליחת חיובים','group.charges_reconcile':'בדיקת חיובים'};
const RESULT:Record<string,string>={OK:'הצליח',DENIED:'נדחה',FAILED:'נכשל'};

export function renewalsPage(data:{overview:any;csrf:string}){
 const o=data.overview;
 const row=(g:any,expired:boolean)=>'<tr data-href="/admin/groups/'+escape(g.publicId)+'"><td data-label="אזור"><a class="row-link" href="/admin/groups/'+escape(g.publicId)+'">'+escape(g.areaName)+'</a></td>'+
  '<td data-label="מזהה"><code dir="ltr">'+escape(String(g.publicId).slice(0,8))+'</code></td>'+
  '<td data-label="התחייבויות" class="num">'+escape(money(g.pledgedTotalAgorot))+' <span class="muted">מתוך '+escape(money(g.thresholdAgorot))+'</span></td>'+
  '<td data-label="לקוחות" class="num">'+g.activeMembers+'</td>'+
  (expired?'<td data-label="אישרו מחדש" class="num">'+g.reconfirmed+' מתוך '+g.activeMembers+'</td>':'')+
  '<td data-label="'+(expired?'פג תוקף':'תוקף עד')+'">'+time(g.expiresAt)+'</td>'+
  '<td data-label="תשלום">'+(g.paymentMode==='CARDCOM'?'שריון כרטיס':'ללא תשלום מקוון')+'</td></tr>';
 const table=(rows:any[],expired:boolean,empty:string)=>rows.length?'<div class="table-wrap"><table class="table"><thead><tr><th scope="col">אזור</th><th scope="col">מזהה</th><th scope="col">התחייבויות</th><th scope="col">לקוחות פעילים</th>'+
  (expired?'<th scope="col">אישרו מחדש</th>':'')+'<th scope="col">'+(expired?'פג תוקף':'תוקף עד')+'</th><th scope="col">תשלום</th></tr></thead><tbody>'+rows.map(g=>row(g,expired)).join('')+'</tbody></table></div>':'<div class="empty"><strong>'+empty+'</strong></div>';
 return layout('חידוש קבוצות',
  '<section class="card" aria-labelledby="soon-title"><div class="section-head"><h1 id="soon-title">קבוצות שתוקפן מסתיים בקרוב</h1><span class="muted">ב-'+o.hours+' השעות הקרובות</span></div>'+
   table(o.approaching,false,'אין קבוצות שתוקפן מסתיים בקרוב.')+'</section>'+
  '<section class="card" aria-labelledby="expired-title"><div class="section-head"><h2 id="expired-title">קבוצות שפג תוקפן ועדיין שמורות בהן התחייבויות</h2></div>'+
   '<p class="muted">התחייבות בקבוצה שפג תוקפה אינה נספרת. כדי לחדש: פותחים את הקבוצה, רושמים את אישור הלקוח (טלפון, וואטסאפ, אימייל או פנים אל פנים) ואז פותחים אותה מחדש. שום דבר אינו מתחדש אוטומטית.</p>'+
   table(o.expired,true,'אין קבוצות שפג תוקפן עם התחייבויות שמורות.')+'</section>',{csrf:data.csrf,active:'renewals'});
}

// Extra sections for the group page. renewal is null for groups that are not expired.
export function groupExtras(data:{group:any;products:any;history:any[];renewal:any;csrf:string;error?:string;notice?:string;priceMember?:string;priceTotal?:number}){
 const g=data.group,base='/admin/groups/'+g.publicId,csrf='<input type="hidden" name="csrf" value="'+escape(data.csrf)+'">';
 const products=data.products.products.length?'<div class="table-wrap"><table class="table"><thead><tr><th scope="col">מוצר</th><th scope="col">כמות</th><th scope="col">לקוחות</th><th scope="col">סכום בהתחייבויות</th></tr></thead><tbody>'+
  data.products.products.map((p:any)=>'<tr><td data-label="מוצר">'+(p.title?escape(p.title):'<span class="muted">מוצר </span><code dir="ltr">'+escape(p.variantId)+'</code>')+'</td><td data-label="כמות" class="num">'+p.quantity+'</td><td data-label="לקוחות" class="num">'+p.customers+'</td><td data-label="סכום" class="num">'+escape(money(p.storedAgorot))+'</td></tr>').join('')+
  '</tbody></table></div>'+(data.products.lookup==='UNAVAILABLE'?'<p class="muted">שמות המוצרים אינם זמינים כרגע מהחנות.</p>':data.products.lookup==='SKIPPED'?'<p><a class="btn btn--quiet" href="'+escape(base+'?products=names#products-title')+'">הצגת שמות המוצרים</a></p>':''):'<div class="empty"><strong>אין התחייבויות פעילות בקבוצה.</strong></div>';
 const s=g.paymentSummary||{};
 const payments='<section class="card" aria-labelledby="pay-title"><h2 id="pay-title">מצב תשלום</h2>'+(g.paymentMode==='CARDCOM'
  ?'<dl class="facts"><div><dt>כרטיס שמור</dt><dd>'+(s.reserved||0)+'</dd></div><div><dt>חויבו</dt><dd>'+(s.charged||0)+'</dd></div><div><dt>חיוב נכשל או בתהליך</dt><dd>'+(s.failed||0)+'</dd></div><div><dt>שריון בוטל</dt><dd>'+(s.canceled||0)+'</dd></div></dl>'
  :'<p class="muted">בקבוצה הזו אין תשלום מקוון. מצב ההתחייבות (פעילה, הוסרה) נפרד ממצב התשלום.</p>')+'</section>';
 let renewal='';
 const r=data.renewal;
 if(r&&r.expired){
  const blockers=r.blockers.map((code:string)=>'<li>'+escape(BLOCKER_LABELS[code]||code)+'</li>').join('');
  const members=r.members.map((m:any)=>{
   const tel=dialable(m.phone);
   const price=data.priceMember===m.id&&Number.isSafeInteger(data.priceTotal)?'<label class="check"><input type="checkbox" name="acceptTotalAgorot" value="'+data.priceTotal+'" required> הלקוח אישר את הסכום המעודכן: '+escape(money(data.priceTotal!))+'</label>':'';
   const state=m.activeElsewhere?'<span class="chip chip--withdrawn">רשום בקבוצה פעילה אחרת</span>':m.confirmation?'<span class="chip chip--pledged">אישר מחדש '+escape(METHOD_LABELS[m.confirmation.method]||'')+'</span> '+escape(money(m.confirmation.confirmedAmountAgorot))+' · '+time(m.confirmation.recordedAt):'<span class="chip chip--expired">ממתין לאישור הלקוח</span>';
   const form=!r.blockers.filter((b:string)=>b!=='CURRENT_GROUP_EXISTS').length&&!m.activeElsewhere?'<form method="post" action="'+escape(base+'/members/'+m.id+'/reconfirm')+'" class="inline-form">'+csrf+
    '<label>כיצד הלקוח אישר <select name="method" required><option value="">בחירה</option>'+RECONFIRM_METHODS.map(k=>'<option value="'+k+'">'+escape(METHOD_LABELS[k])+'</option>').join('')+'</select></label>'+
    '<label>הערה (לא חובה) <input name="reference" maxlength="60" placeholder="למשל: שיחה 26.11"></label>'+price+
    '<button class="btn btn--quiet">'+(m.confirmation?'עדכון האישור':'רישום אישור הלקוח')+'</button></form>':'';
   return '<li class="renewal-member"><div><a href="'+escape(base+'/members/'+m.id)+'" dir="ltr">'+escape(m.email)+'</a> · <span dir="ltr">'+escape(m.phone)+'</span>'+(tel?' · <a href="tel:'+escape(tel)+'">חיוג</a>':'')+
    ' · התחייבות שמורה: '+escape(money(m.pledgedTotalAgorot))+'</div><div>'+state+'</div>'+form+'</li>';
  }).join('');
  const confirmed=r.members.filter((m:any)=>m.confirmation&&!m.activeElsewhere).length,waiting=r.members.length-confirmed;
  const reopen=r.blockers.length?'':'<form method="post" action="'+escape(base+'/reopen')+'" class="card card--inset">'+csrf+'<h3>פתיחת הקבוצה מחדש</h3>'+
   '<p>ייספרו '+confirmed+' התחייבויות שאושרו מחדש.'+(waiting?' '+waiting+' התחייבויות שלא אושרו יוסרו מהקבוצה (הנתונים נשמרים, והלקוח יוכל לחדש בעצמו מהאתר).':'')+' המחירים והמלאי ייבדקו שוב מול החנות לפני הפתיחה.</p>'+
   '<label>פתוחה להצטרפות למשך <input type="number" name="days" min="'+REOPEN_DAYS.min+'" max="'+REOPEN_DAYS.max+'" value="'+REOPEN_DAYS.default+'" required> ימים</label>'+
   '<label class="check renewal-confirm"><input type="checkbox" name="confirm" value="yes" required> בדקתי את האישורים ואני פותח/ת את הקבוצה מחדש</label>'+
   '<button class="btn btn--primary"'+(confirmed?'':' disabled')+'>פתיחה מחדש</button></form>';
  renewal='<section class="card" aria-labelledby="renew-title"><h2 id="renew-title">חידוש הקבוצה</h2>'+
   (data.notice&&RENEWAL_NOTICES[data.notice]?notice('ok',RENEWAL_NOTICES[data.notice]):'')+(data.error&&RENEWAL_ERRORS[data.error]?notice('error',RENEWAL_ERRORS[data.error]):'')+
   '<p class="muted">תוקף הקבוצה פג, ולכן ההתחייבויות בה אינן נספרות. התחייבות תיספר שוב רק אחרי שהלקוח אישר אותה במפורש ונרשם כאן, והקבוצה נפתחה מחדש.</p>'+
   (blockers?'<p><strong>לא ניתן לחדש את הקבוצה:</strong></p><ul>'+blockers+'</ul>':'')+
   (r.members.length?'<ul class="renewal-list">'+members+'</ul>':'<p>אין התחייבויות שמורות בקבוצה.</p>')+reopen+'</section>';
 }else if(r&&r.reopenedCount){
  renewal='<section class="card"><h2>חידוש הקבוצה</h2>'+(data.notice&&RENEWAL_NOTICES[data.notice]?notice('ok',RENEWAL_NOTICES[data.notice]):'')+'<p>הקבוצה נפתחה מחדש '+r.reopenedCount+' פעמים'+(r.lastReopenedAt?', לאחרונה '+time(r.lastReopenedAt):'')+'.</p></section>';
 }
 const history=data.history.length?'<ol class="history">'+data.history.map((h:any)=>'<li>'+time(h.at)+' · '+escape(ACTION_LABELS[h.action]||h.action)+' · '+escape(RESULT[h.result]||h.result)+
  (h.amountAgorot!==null?' · '+escape(money(h.amountAgorot)):'')+(h.previousStatus||h.newStatus?' · <span dir="ltr">'+escape((h.previousStatus||'')+(h.newStatus?' → '+h.newStatus:''))+'</span>':'')+(h.detail?' · <code dir="ltr">'+escape(h.detail)+'</code>':'')+'</li>').join('')+'</ol>':'<p class="muted">עדיין לא נרשמו פעולות מנהל בקבוצה הזו.</p>';
 return renewal+'<section class="card" aria-labelledby="products-title"><h2 id="products-title">מוצרים בהתחייבויות</h2>'+products+'</section>'+payments+
  '<section class="card" aria-labelledby="history-title"><h2 id="history-title">היסטוריית פעולות בקבוצה</h2>'+history+'</section>';
}
