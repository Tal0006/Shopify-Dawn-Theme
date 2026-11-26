// Extra sections of the existing group page for expiration management (src/renewals.ts): the renewal of an expired
// group with customer reconfirmations, and the products in its pledges. The overview lives in the groups list (views
// expiring and expired), payments in the existing charges card and members table, and history in the audit page.
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
// Extra sections for the group page. renewal is null for groups that are not expired.
export function groupExtras(data:{group:any;products:any;renewal:any;csrf:string;error?:string;notice?:string;priceMember?:string;priceTotal?:number}){
 const g=data.group,base='/admin/groups/'+g.publicId,csrf='<input type="hidden" name="csrf" value="'+escape(data.csrf)+'">';
 const products=data.products.products.length?'<div class="table-wrap"><table class="table"><thead><tr><th scope="col">מוצר</th><th scope="col">כמות</th><th scope="col">לקוחות</th><th scope="col">סכום בהתחייבויות</th></tr></thead><tbody>'+
  data.products.products.map((p:any)=>'<tr><td data-label="מוצר">'+(p.title?escape(p.title):'<span class="muted">מוצר </span><code dir="ltr">'+escape(p.variantId)+'</code>')+'</td><td data-label="כמות" class="num">'+p.quantity+'</td><td data-label="לקוחות" class="num">'+p.customers+'</td><td data-label="סכום" class="num">'+escape(money(p.storedAgorot))+'</td></tr>').join('')+
  '</tbody></table></div>'+(data.products.lookup==='UNAVAILABLE'?'<p class="muted">שמות המוצרים אינם זמינים כרגע מהחנות.</p>':data.products.lookup==='SKIPPED'?'<p><a class="btn btn--quiet" href="'+escape(base+'?products=names#products-title')+'">הצגת שמות המוצרים</a></p>':''):'<div class="empty"><strong>אין התחייבויות פעילות בקבוצה.</strong></div>';
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
   '<p>ייספרו '+confirmed+' התחייבויות שאושרו מחדש.'+(waiting?' '+waiting+' התחייבויות שלא אושרו יישמרו כהתחייבויות שפג תוקפן ולא ייספרו (לא כפרישה; הסכום והסל המקוריים נשמרים, והלקוח יוכל לחדש בעצמו מהאתר).':'')+' המחירים והמלאי ייבדקו שוב מול החנות לפני הפתיחה.</p>'+
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
 // History is the existing audit page, filtered to this group.
 return renewal+'<section class="card" aria-labelledby="products-title"><h2 id="products-title">מוצרים בהתחייבויות</h2>'+products+'</section>'+
  '<p><a class="btn btn--quiet" href="'+escape('/admin/audit?target='+g.publicId)+'">יומן הפעולות של הקבוצה</a></p>';
}
