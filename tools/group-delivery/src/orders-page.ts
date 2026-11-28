// Owner pages for the order lifecycle (src/orders.ts), inside the existing admin:
//  - the group page's payment reconciliation section (each order separately: delivery state, external payment),
//  - "סיום מחזור ופתיחת מחזור חדש": choose what happens to each order, a read-only preview of every affected order and
//    its cart, then an explicit final confirmation. No JavaScript is needed; submit buttons disable themselves once
//    (data-once) and the split is idempotent by a key issued with the preview.
import {randomUUID} from 'node:crypto';
import {escape,layout,notice,time} from './admin.js';
import {PAYMENT_METHODS} from './orders.js';

const money=(agorot:number)=>new Intl.NumberFormat('he-IL',{style:'currency',currency:'ILS'}).format(agorot/100);
export const PAYMENT_METHOD_LABELS:Record<string,string>={CASH:'מזומן',BANK_TRANSFER:'העברה בנקאית',BIT:'ביט',PAYBOX:'פייבוקס',CARD_EXTERNAL:'כרטיס אשראי (מחוץ למערכת)',OTHER:'אחר'};
export const ORDER_ERRORS:Record<string,string>={
 INVALID_PAYMENT_RECORD:'פרטי התשלום אינם תקינים: יש לבחור אמצעי תשלום ותאריך, להקליד סכום זהה לסכום ההזמנה ולאשר שהתשלום התקבל. לא נשמר דבר.',
 PAYMENT_ALREADY_RECORDED:'כבר נרשם תשלום להזמנה הזו. כדי לשנות אותו, יש לתקן את הרישום. לא נשמר דבר.',
 NO_PAYMENT_RECORD:'אין תשלום רשום להזמנה הזו. לא בוצע שינוי.',
 RELEASE_NOT_ALLOWED:'לא ניתן לשחרר את ההזמנה לעריכה: יש לה תשלום פעיל, היא נמסרה או שהמחזור הושלם. לא בוצע שינוי.',
 SPLIT_NOT_ALLOWED:'לא ניתן לבצע את הפעולה בקבוצה הזו. לא בוצע שינוי.',
 SPLIT_STATE_CHANGED:'הנתונים השתנו מאז התצוגה המקדימה (למשל לקוח עדכן הזמנה או הצטרף). לא בוצע שינוי. יש להציג תצוגה מקדימה חדשה.',
 SPLIT_CONFIRMATION_REQUIRED:'יש לסמן את שתי תיבות האישור ולבחור את סיבת הפעולה. לא בוצע שינוי.',
 RESTORE_SOURCE_INVALID:'לא ניתן לשחזר את ההזמנה המקורית שנבחרה. לא בוצע שינוי.',
 TRANSFER_CONFLICT:'ללקוח כבר יש הזמנה במחזור החדש. לא בוצע שינוי.',
 PRICE_CHANGED:'מחיר של הזמנה שעוברת למחזור החדש השתנה. יש לאשר עם הלקוח את הסכום החדש ולסמן זאת בתצוגה המקדימה. לא בוצע שינוי.',
 DUPLICATE_REQUEST:'הפעולה כבר בוצעה. לא בוצע שינוי נוסף.',
 SHOPIFY_UNAVAILABLE:'לא ניתן לבדוק כרגע מחירים ומלאי מול החנות. לא בוצע שינוי; נסו שוב.',
 CART_UNAVAILABLE:'חלק מהמוצרים בהזמנה שעוברת אינם זמינים כרגע. לא בוצע שינוי.',INVALID_CART:'סל של הזמנה שעוברת אינו תקין מול החנות. לא בוצע שינוי.',
 INVALID_INPUT:'יש לבחור לפחות הזמנה אחת שעוברת למחזור החדש. לא בוצע שינוי.'};
export const ORDER_NOTICES:Record<string,string>={payment_recorded:'התשלום נרשם וההזמנה ננעלה לשינויים. לא נוצרה עסקה בשופיפיי או בקארדקום.',
 payment_voided:'רישום התשלום בוטל ונשמר בהיסטוריה. ההזמנה נשארת נעולה לשינויי הלקוח עד שהתשלום יוסדר. לא בוצע זיכוי.',
 payment_corrected:'רישום התשלום תוקן: הרישום הקודם נשמר כמבוטל והרישום החדש פעיל. ההזמנה נעולה.',
 order_released:'ההזמנה שוחררה לעריכה. הלקוח יכול שוב לעדכן אותה.',
 payment_unchanged:'התשלום כבר היה רשום בדיוק כך. לא בוצע שינוי.',cycle_split:'המחזור הקודם הושלם והמחזור החדש פתוח. ההזמנות שנבחרו הועברו.'};
const BLOCKERS:Record<string,string>={CARD_GROUP:'זו קבוצה עם תשלום בכרטיס אשראי.',ALREADY_COMPLETED:'המשלוח של הקבוצה כבר הושלם.',NO_AREA:'לקבוצה אין אזור מוגדר.',
 PAYMENT_RECORDED:'נרשם תשלום מקוון בקבוצה.',CHARGES_OR_RESERVATIONS:'קיימים חיובים או שריוני כרטיס בקבוצה.',CARD_MODE_ACTIVE:'תשלום בכרטיס אשראי פעיל כרגע בחנות.'};
const blockerText=(code:string)=>BLOCKERS[code]||(code.startsWith('STATUS_')?'מצב הקבוצה ('+code.slice(7)+') אינו מאפשר את הפעולה.':code);
const csrfField=(csrf:string)=>'<input type="hidden" name="csrf" value="'+escape(csrf)+'">';
const cartTable=(cart:{variantId:string;quantity:number;unitAgorot:number;lineAgorot:number}[],caption:string)=>cart.length
 ?'<table class="table table--compact"><caption class="sr-only">'+escape(caption)+'</caption><thead><tr><th scope="col">מוצר (מזהה וריאנט)</th><th scope="col">כמות</th><th scope="col">מחיר יחידה</th><th scope="col">סה״כ</th></tr></thead><tbody>'+
  cart.map(l=>'<tr><td data-label="מוצר"><code dir="ltr">'+escape(l.variantId)+'</code></td><td data-label="כמות" class="num">'+l.quantity+'</td><td data-label="מחיר יחידה" class="num">'+escape(money(l.unitAgorot))+'</td><td data-label="סה״כ" class="num">'+escape(money(l.lineAgorot))+'</td></tr>').join('')+'</tbody></table>'
 :'<p class="muted">אין שורות בסל.</p>';
const who=(o:{email:string;phone:string})=>'<span dir="ltr">'+escape(o.email)+'</span> · <span dir="ltr">'+escape(o.phone)+'</span>';

// ---------- Group page: payment reconciliation ----------
export function paymentsSection(data:{groupPublicId:string;overview:{paymentMode:string;completed?:boolean;orders:any[]};csrf:string;notice?:string;error?:string}){
 const {overview}=data;
 if(overview.paymentMode!=='NONE'||!overview.orders.length)return '';
 const base='/admin/groups/'+data.groupPublicId;
 const rows=overview.orders.map((o:any)=>{
  const delivery=o.delivery==='DELIVERED'?'<span class="chip chip--pledged">נמסר</span>':'<span class="chip">לא סומן כנמסר</span>';
  const paid=o.payment?'<span class="chip chip--pledged">שולם מחוץ למערכת</span><br><span class="muted">'+escape(money(o.payment.amountAgorot))+' · '+escape(PAYMENT_METHOD_LABELS[o.payment.method]||o.payment.method)+' · '+escape(o.payment.receivedOn)+(o.payment.reference?' · '+escape(o.payment.reference):'')+'</span>':'<span class="chip chip--expired">לא נרשם תשלום</span>';
  const fields=(prefix:string)=>'<label>סכום (₪) <input name="'+prefix+'amount" inputmode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" placeholder="'+escape((o.amountAgorot/100).toFixed(2))+'"></label>'+
   '<label>אמצעי תשלום <select name="'+prefix+'method"><option value="">בחירה</option>'+PAYMENT_METHODS.map(k=>'<option value="'+k+'">'+escape(PAYMENT_METHOD_LABELS[k])+'</option>').join('')+'</select></label>'+
   '<label>תאריך קבלה <input type="date" name="'+prefix+'receivedOn"></label><label>אסמכתא (לא חובה) <input name="'+prefix+'reference" maxlength="60"></label>';
  // A mistaken record: voided (kept, with the reason) and optionally replaced by a corrected one. Never a refund.
  const correct=o.payment?'<details class="inline-details"><summary>תיקון או ביטול הרישום</summary><form method="post" action="'+escape(base+'/members/'+o.id+'/external-payment/correct')+'" class="inline-form">'+csrfField(data.csrf)+
   '<label>סיבה (חובה) <input name="reason" required minlength="3" maxlength="60"></label>'+
   '<p class="muted">להחלפה ברישום מתוקן יש למלא את הפרטים; בלי פרטים הרישום רק יבוטל. הרישום הקודם נשמר תמיד, וההזמנה נשארת נעולה.</p>'+fields('new_')+
   '<label class="check renewal-confirm"><input type="checkbox" name="attest" value="yes" required> אני מאשר/ת את התיקון</label><button class="btn btn--quiet" data-once>שמירת התיקון</button></form></details>':'';
  // Locked only by a voided payment, in a cycle that is not completed: an explicit release for customer edits.
  const release=!o.payment&&o.locked&&o.lockedReason==='PAID_EXTERNAL'&&!overview.completed?'<details class="inline-details"><summary>שחרור ההזמנה לעריכה</summary><form method="post" action="'+escape(base+'/members/'+o.id+'/release')+'" class="inline-form">'+csrfField(data.csrf)+
   '<label>סיבה (חובה) <input name="reason" required minlength="3" maxlength="60"></label><label class="check renewal-confirm"><input type="checkbox" name="attest" value="yes" required> ההזמנה לא שולמה ואפשר לאפשר ללקוח לערוך אותה</label>'+
   '<button class="btn btn--quiet" data-once>שחרור לעריכה</button></form></details>':'';
  const history=o.voidedRecords?'<br><span class="muted">'+o.voidedRecords+' רישומים קודמים בוטלו ונשמרו</span>':'';
  const locked=o.locked&&!o.payment?'<br><span class="chip">נעולה לשינויי הלקוח</span>':'';
  const form=o.payment?correct:locked+release+'<details class="inline-details"><summary>רישום תשלום שהתקבל</summary><form method="post" action="'+escape(base+'/members/'+o.id+'/external-payment')+'" class="inline-form">'+csrfField(data.csrf)+
   '<label>סכום שהתקבל (₪) <input name="amount" inputmode="decimal" required pattern="[0-9]+([.][0-9]{1,2})?" placeholder="'+escape((o.amountAgorot/100).toFixed(2))+'"></label>'+
   '<label>אמצעי תשלום <select name="method" required><option value="">בחירה</option>'+PAYMENT_METHODS.map(k=>'<option value="'+k+'">'+escape(PAYMENT_METHOD_LABELS[k])+'</option>').join('')+'</select></label>'+
   '<label>תאריך קבלה <input type="date" name="receivedOn" required></label>'+
   '<label>אסמכתא (לא חובה, ללא פרטי קשר או כרטיס) <input name="reference" maxlength="60"></label>'+
   '<label class="check renewal-confirm"><input type="checkbox" name="attest" value="yes" required> אני מאשר/ת שהתשלום הזה התקבל בפועל</label>'+
   '<button class="btn btn--quiet" data-once>רישום התשלום ונעילת ההזמנה</button></form></details>';
  return '<tr><td data-label="לקוח"><a href="'+escape(base+'/members/'+o.id)+'">'+who(o)+'</a></td><td data-label="סכום ההזמנה" class="num">'+escape(money(o.amountAgorot))+'</td>'+
   '<td data-label="משלוח">'+delivery+'</td><td data-label="תשלום">'+paid+history+form+'</td></tr>';
 }).join('');
 return '<section class="card" aria-labelledby="payments-title" id="payments"><h2 id="payments-title">התאמת תשלומים שהתקבלו מחוץ למערכת</h2>'+
  (data.notice&&ORDER_NOTICES[data.notice]?notice('ok',ORDER_NOTICES[data.notice]):'')+(data.error&&ORDER_ERRORS[data.error]?notice('error',ORDER_ERRORS[data.error]):'')+
  '<p class="muted">כל הזמנה נרשמת בנפרד, בסכום זהה לסכום ההזמנה. הרישום אינו יוצר עסקה בשופיפיי או בקארדקום ואינו מחייב איש. הזמנה ששולמה ננעלת: הלקוח לא יוכל לשנות או לבטל אותה, ויוכל לבצע הזמנה נוספת נפרדת.</p>'+
  '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">לקוח</th><th scope="col">סכום ההזמנה</th><th scope="col">מצב משלוח</th><th scope="col">מצב תשלום</th></tr></thead><tbody>'+rows+'</tbody></table></div></section>';
}
// Group page link to the split workflow (groups that can still be split only).
export function splitLink(data:{groupPublicId:string;group:any}){
 const g=data.group;
 if(g.paymentMode!=='NONE'||g.operationalStatus==='COMPLETED'||!['OPEN','THRESHOLD_REACHED','EXPIRED'].includes(g.status))return '';
 return '<p><a class="btn btn--quiet" href="'+escape('/admin/groups/'+data.groupPublicId+'/cycle-split')+'">סיום מחזור ופתיחת מחזור חדש</a></p>';
}

// ---------- Step 1: choose what happens to each order ----------
export function cycleSplitForm(data:{candidates:any;csrf:string;error?:string;selected?:Record<string,string>}){
 const c=data.candidates,g=c.group,base='/admin/groups/'+g.publicId;
 const rows=c.orders.map((o:any)=>{
  const sel=data.selected?.[o.id]||'KEEP';
  const option=(value:string,label:string,disabled=false)=>'<label class="check"><input type="radio" name="role_'+escape(o.id)+'" value="'+value+'"'+(sel===value?' checked':'')+(disabled?' disabled':'')+'> '+escape(label)+'</label>';
  const restore=o.original?option('RESTORE','שחזור ההזמנה המקורית ('+money(o.original.amountAgorot)+') במחזור הקודם, והסל הנוכחי ('+money(o.amountAgorot)+') כהזמנה נפרדת במחזור החדש',o.locked):'';
  return '<fieldset class="card card--inset"><legend>'+who(o)+' · '+escape(money(o.amountAgorot))+(o.locked?' · <span class="chip chip--pledged">נעולה</span>':'')+(o.paid?' · <span class="chip chip--pledged">שולם</span>':'')+'</legend>'+
   '<p class="muted">הצטרף '+time(o.createdAt)+' · עודכן לאחרונה '+time(o.updatedAt)+'</p>'+cartTable(o.cart,'הסל הנוכחי')+
   (o.original?'<details><summary>הסל המקורי המאומת ('+escape(money(o.original.amountAgorot))+')</summary>'+cartTable(o.original.cart,'הסל המקורי')+'</details>':'')+
   option('KEEP','נשארת במחזור הקודם כהיסטוריה (תינעל)')+option('TRANSFER','עוברת למחזור החדש כהזמנה פתוחה',o.locked||o.paid)+restore+'</fieldset>';
 }).join('');
 const blocked=g.paymentMode!=='NONE'||g.operationalStatus==='COMPLETED';
 return layout('סיום מחזור · '+g.areaName,
  '<nav class="breadcrumbs"><a href="'+escape(base)+'">חזרה לקבוצה</a></nav><section class="card"><h1>סיום מחזור ופתיחת מחזור חדש</h1>'+
  (data.error&&ORDER_ERRORS[data.error]?notice('error',ORDER_ERRORS[data.error]):'')+
  '<p>'+escape(g.areaName)+' · '+escape(money(g.totalAgorot))+' מתוך '+escape(money(g.thresholdAgorot))+'. '+(c.target?'כבר קיים מחזור פעיל באזור ('+escape(money(c.target.totalAgorot))+'); ההזמנות שיועברו יצטרפו אליו.':'ייפתח מחזור חדש באזור.')+'</p>'+
  '<p class="muted">שום דבר אינו משתנה בשלב הזה. בשלב הבא תוצג תצוגה מקדימה מלאה, ורק אחריה ניתן לאשר את הביצוע.</p>'+
  (blocked?notice('error','לא ניתן לבצע את הפעולה בקבוצה הזו.'):'<form method="post" action="'+escape(base+'/cycle-split/review')+'">'+csrfField(data.csrf)+rows+
   '<button class="btn btn--primary" data-once>הצגת תצוגה מקדימה</button></form>')+'</section>',{csrf:data.csrf});
}

// ---------- Step 2: read-only preview and the final confirmation ----------
export function cycleSplitPreview(data:{group:any;preview:any;plan:any;csrf:string}){
 const p=data.preview,base='/admin/groups/'+p.before.publicId;
 const block=(title:string,role:string,receipt:string,o:any,cart:any[],amount:number)=>'<article class="card card--inset"><h3>'+escape(title)+'</h3><p>'+who(o)+' · <strong>'+escape(money(amount))+'</strong> · <span class="chip">'+escape(role)+'</span></p>'+
  cartTable(cart,title)+'<p class="muted">אישור ההצטרפות של הלקוח: '+escape(receipt)+'</p></article>';
 const historical=p.historical.filter((h:any)=>!h.restored).map((h:any)=>block('הזמנה שנשארת במחזור הקודם','נשארת (תינעל)','האישור הקיים ממשיך לפתוח את ההזמנה הזו, לקריאה בלבד.',h,h.cart,h.amountAgorot)).join('');
 const restored=p.restore.map((r:any)=>block('הזמנה מקורית משוחזרת','משוחזרת (תינעל)','האישור הקיים פותח את ההזמנה המקורית, לקריאה בלבד, ומשם גם את ההזמנה החדשה.',r,r.restoredCart,r.restoredAgorot)).join('');
 const created=p.restore.map((r:any)=>block('הזמנה חדשה נפרדת (מהסל הנוכחי)','נוצרת במחזור החדש','נפתחת מהאישור הקיים של הלקוח (קישור), או בשחזור גישה באימייל.',r,r.newOrderCart,r.newOrderAgorot)).join('');
 const transferred=p.transfer.map((t:any)=>block('הזמנה שעוברת למחזור החדש','עוברת (שורה חדשה, אותו סל)','האישור הקיים מציג את ההזמנה כהיסטוריה (הועברה) ופותח את ההזמנה במחזור החדש.',t,t.cart,t.amountAgorot)).join('');
 const unaccepted=p.priceChanges.filter((c:any)=>!c.accepted);
 const prices=p.priceChanges.length?'<section class="card card--inset"><h3>שינויי מחיר מאז ההזמנה</h3><form method="post" action="'+escape(base+'/cycle-split/review')+'">'+csrfField(data.csrf)+
  Object.entries(data.plan.roles as Record<string,string>).map(([id,role])=>'<input type="hidden" name="role_'+escape(id)+'" value="'+escape(role)+'">').join('')+
  p.priceChanges.map((c:any)=>'<label class="check"><input type="checkbox" name="accept_'+escape(c.memberId)+'" value="'+c.todayAgorot+'"'+(c.accepted?' checked':'')+'> הלקוח אישר את הסכום המעודכן: '+escape(money(c.todayAgorot))+'</label>').join('')+
  '<button class="btn btn--quiet" data-once>עדכון התצוגה המקדימה</button></form></section>':'';
 const blocked=p.blockers.length?'<p><strong>לא ניתן לבצע:</strong></p><ul>'+p.blockers.map((b:string)=>'<li>'+escape(blockerText(b))+'</li>').join('')+'</ul>':'';
 const ready=!p.blockers.length&&!unaccepted.length;
 const confirm=ready?'<form method="post" action="'+escape(base+'/cycle-split/execute')+'" class="card card--inset">'+csrfField(data.csrf)+
  '<input type="hidden" name="plan" value="'+escape(JSON.stringify({restore:data.plan.restore,transfer:data.plan.transfer,acceptTotals:data.plan.acceptTotals}))+'">'+
  '<input type="hidden" name="expectedState" value="'+escape(p.state)+'"><input type="hidden" name="idempotencyKey" value="'+escape(randomUUID())+'">'+
  '<h3>אישור סופי</h3><label>סיבת הפעולה <select name="reason" required><option value="">בחירה</option><option value="ORDER_OVERWRITE_RECONCILIATION">תיקון הזמנה ששולמה ונדרסה</option><option value="PAID_ORDERS_DELIVERED">המשלוח של המחזור הקודם בוצע</option></select></label>'+
  '<label class="check renewal-confirm"><input type="checkbox" name="deliveredAttested" value="yes" required> המשלוח של ההזמנות שנשארות במחזור הקודם בוצע</label>'+
  '<label class="check renewal-confirm"><input type="checkbox" name="confirm" value="yes" required> בדקתי את התצוגה המקדימה ואני מאשר/ת את הביצוע</label>'+
  '<p class="muted">התשלומים אינם נרשמים כאן. אחרי הביצוע רושמים כל תשלום בנפרד בדף הקבוצה.</p>'+
  '<button class="btn btn--primary" data-once>ביצוע: סיום המחזור ופתיחת המחזור החדש</button></form>':'';
 const a=p.after;
 return layout('תצוגה מקדימה · סיום מחזור',
  '<nav class="breadcrumbs"><a href="'+escape(base)+'">חזרה לקבוצה</a> · <a href="'+escape(base+'/cycle-split')+'">שינוי הבחירה</a></nav>'+
  '<section class="card"><h1>תצוגה מקדימה: סיום מחזור ופתיחת מחזור חדש</h1><p class="muted">זו תצוגה בלבד; שום דבר עוד לא השתנה. אם נתון כלשהו ישתנה לפני האישור, הביצוע יידחה.</p>'+blocked+
  '<div class="table-wrap"><table class="table"><thead><tr><th scope="col"></th><th scope="col">מצב</th><th scope="col">הזמנות פעילות</th><th scope="col">סה״כ</th></tr></thead><tbody>'+
  '<tr><th scope="row">המחזור הקודם כעת</th><td>'+escape(p.before.status)+'</td><td class="num">'+p.before.orders+'</td><td class="num">'+escape(money(p.before.totalAgorot))+'</td></tr>'+
  '<tr><th scope="row">המחזור הקודם אחרי</th><td>הושלם'+(a.source.thresholdMet?'':' (היעד '+escape(money(a.source.thresholdAgorot))+' לא הושג)')+'</td><td class="num">'+a.source.orders+'</td><td class="num">'+escape(money(a.source.totalAgorot))+'</td></tr>'+
  '<tr><th scope="row">'+(a.target.created?'מחזור חדש (ייפתח)':'המחזור הפעיל באזור')+'</th><td>פתוח</td><td class="num">'+a.target.orders+'</td><td class="num">'+escape(money(a.target.totalAgorot))+'</td></tr></tbody></table></div></section>'+
  '<section class="card"><h2>המחזור הקודם (היסטוריה, ננעל)</h2>'+(restored+historical||'<p class="muted">אין.</p>')+'</section>'+
  '<section class="card"><h2>המחזור החדש</h2>'+(created+transferred||'<p class="muted">אין.</p>')+'</section>'+prices+confirm,{csrf:data.csrf});
}
