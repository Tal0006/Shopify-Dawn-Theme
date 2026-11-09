
export const escape=(value:unknown)=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const page=(body:string)=>'<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>משלוחים קבוצתיים</title><link rel="stylesheet" href="/admin/style.css"></head><body><main>'+body+'</main></body></html>';
export const loginPage=()=>page('<h1>ניהול משלוחים קבוצתיים</h1><form method="post" action="/admin/login"><label>שם משתמש<input name="username" autocomplete="username" required maxlength="256"></label><label>סיסמה<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button>כניסה</button></form>');
// Area create/edit forms. All values are escaped; checkbox absence means inactive (HTML form semantics).
const areaFields=(csrf:string,area?:any)=>'<input type="hidden" name="csrf" value="'+escape(csrf)+'">'+
 '<label>שם האזור<input name="name" required maxlength="60" value="'+escape(area?.name??'')+'"></label>'+
 '<label>קו רוחב (מרכז)<input name="latitude" required inputmode="decimal" dir="ltr" value="'+escape(area?.latitude??'')+'"></label>'+
 '<label>קו אורך (מרכז)<input name="longitude" required inputmode="decimal" dir="ltr" value="'+escape(area?.longitude??'')+'"></label>'+
 '<label>סדר תצוגה<input name="sortOrder" inputmode="numeric" dir="ltr" value="'+escape(area?.sortOrder??0)+'"></label>'+
 '<label class="check"><input type="checkbox" name="active"'+(area===undefined||area.active?' checked':'')+'> פעיל (מוצג ללקוחות)</label>';
function areasSection(areas:any[],csrf:string){
 return '<section aria-labelledby="AreasTitle"><h2 id="AreasTitle">אזורי משלוח</h2><p>אזור לא פעיל מוסתר מהלקוחות ואינו פותח קבוצות חדשות. קבוצות קיימות שלו נשמרות.</p>'+
  '<form method="post" action="/admin/areas" class="area-new"><h3>הוספת אזור</h3>'+areaFields(csrf)+'<button>הוספת אזור</button></form>'+
  '<div class="areas">'+areas.map(area=>'<form method="post" action="/admin/areas/'+escape(area.publicId)+'"><h3>'+escape(area.name)+(area.active?'':' (לא פעיל)')+'</h3>'+areaFields(csrf,area)+'<button>שמירה</button></form>').join('')+'</div></section>';
}
const money=(agorot:number)=>new Intl.NumberFormat('he',{style:'currency',currency:'ILS'}).format(agorot/100);
// Aggregates only: counts and totals. No contact data, payment-method, authorization or charge references.
const when=(iso:string|null)=>iso?new Intl.DateTimeFormat('he',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Jerusalem'}).format(new Date(iso)):'—';
const reasons:Record<string,string>={APPROVAL_DEADLINE:'מועד אישורי התשלום עבר ללא מספיק אישורים',INSUFFICIENT_PAYMENTS:'לא ניתן היה לגבות את סכום היעד'};
function paymentSummary(group:any){
 const p=group.payment;if(!p)return '';
 const rows:[string,unknown][]=[['סך ההתחייבויות',money(group.pledgedTotalAgorot)],['יעד לאישור',money(group.thresholdAgorot)],['סך התחייבויות מאושרות',money(p.approvedPledgeTotalAgorot)],
  ['מוכנה לביצוע תשלום',p.ready?'כן':'לא'],['מועד אחרון לאישור',when(p.deadline)],['אישרו תשלום',p.approved],['ממתינים לאישור',p.waiting],['סירבו / פג תוקף',p.declined+' / '+p.expired],['נדרשת בדיקה (פריט בסל אינו זמין / הסל השתנה)',p.invalidated],
  ['אמצעי תשלום מאומתים',p.verified],['משתתפים ללא אמצעי תשלום (ותיקים)',p.legacyMembers],['הרשאות פעילות',p.authorized+' ('+money(p.authorizedTotalAgorot)+')'],['בעיבוד',p.processing],
  ['חיובים שהצליחו',p.charged+' ('+money(p.chargedTotalAgorot)+')'],['הרשאות/חיובים שנכשלו',p.failed],['הרשאות ששוחררו',p.voided]];
 return '<dl class="payments">'+rows.map(([label,value])=>'<div><dt>'+escape(label)+'</dt><dd>'+escape(value)+'</dd></div>').join('')+'</dl>'+
  (p.closedReason?'<p>סיבת סגירה: '+escape(reasons[p.closedReason]||p.closedReason)+'</p>':'')+
  (p.refundRequired?'<p class="alert" role="alert">נדרש החזר כספי ידני: נגבה כסף בקבוצה שלא הושלמה. הקבוצה אינה נחשבת סגורה עד לטיפול.</p>':'')+
  (p.openHolds?'<p class="alert">'+escape(p.openHolds)+' שריונים עדיין פתוחים בקבוצה סגורה; השחרור ינוסה שוב בתחזוקה הבאה.</p>':'')+
  (p.executionBlocked?'<p class="alert">ביצוע התשלומים חסום: ספק התשלומים אינו תומך בהרשאה ולכידה.</p>':'')+
  (['CONFIRMED','CANCELLED','EXPIRED'].includes(group.status)?'<p>מצב טיפול: '+(p.resolved?'סגורה':'דורשת טיפול')+'</p>':'');
}
const action=(group:any,csrf:string,path:string,label:string)=>'<form method="post" action="/admin/groups/'+escape(group.publicId)+'/'+path+'"><input type="hidden" name="csrf" value="'+escape(csrf)+'"><button>'+escape(label)+'</button></form>';
export function adminPage(groups:any[],areas:any[],csrf:string){
 const attention=groups.filter(group=>group.payment?.refundRequired||group.payment?.openHolds>0).length;
 return page('<h1>בדיקת משלוחים קבוצתיים</h1>'+(attention?'<p class="alert banner" role="alert">'+escape(attention)+' קבוצות דורשות טיפול ידני (החזר כספי או שריון פתוח). הן מוצגות ראשונות.</p>':'')+'<p>הגעה ליעד אינה מבקשת תשלום מאיש. אישור הקבוצה כאן קובע שהמשלוח אפשרי: הוא נועל את הקבוצה ואת הסלים, ופותח חלון לאישורי תשלום של המשתתפים. אישור של משתתף הוא הסכמה לסכום המדויק בלבד; הגבייה מתבצעת רק כשסך האישורים מכסה את היעד, ולאחר אימות מחודש של כל סל מול החנות.</p><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="'+escape(csrf)+'"><button>יציאה</button></form><div class="groups">'+groups.map(group=>'<article><h2>'+escape(group.areaName)+'</h2>'+(group.legacy?'<p>קבוצה ישנה (ללא אזור מוגדר)</p>':'')+'<p>מצב: '+escape(group.status)+'</p><p>'+escape(group.participantCount)+' משתתפים</p><p>נותרו ליעד: '+escape(money(group.remainingAmountAgorot))+'</p>'+paymentSummary(group)+'<p>נוצרה: '+escape(group.createdAt)+'<br>תפוגה: '+escape(group.expiresAt)+'</p>'+
  (group.status==='THRESHOLD_REACHED'?action(group,csrf,'approve','אישור הקבוצה ופתיחת אישורי תשלום'):'')+
  (group.status==='PAYMENT_OPEN'&&group.payment?.ready&&!group.payment.executionStarted?action(group,csrf,'execute','ביצוע התשלומים עכשיו'):'')+'</article>').join('')+'</div>'+areasSection(areas,csrf));
}
export const adminCSS='*{box-sizing:border-box}body{margin:0;background:#f2fafb;color:#153a46;font:16px/1.6 Arial,sans-serif}main{max-width:1100px;margin:24px auto;padding:16px}.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}article,form{padding:16px;border:1px solid #cfe4e8;border-radius:14px;background:white}label{display:block}input{display:block;max-width:100%;min-height:44px;margin-bottom:12px}button{min-height:44px;border:0;border-radius:10px;background:#086b7b;color:white;padding:8px 18px;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #14b8c9;outline-offset:3px}h1{font-size:24px}h2{font-size:20px}h3{font-size:18px;margin-top:0}section{margin-block:32px}.areas{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:16px}.area-new{max-width:420px}.check{display:flex;align-items:center;gap:8px;margin-bottom:12px}.check input{min-height:auto;margin:0;width:20px;height:20px}.payments{display:grid;gap:2px;margin:12px 0;padding:10px 12px;border-radius:10px;background:#f2fafb;font-size:14px}.payments div{display:flex;justify-content:space-between;gap:12px}.payments dt{color:#3d5f69}.payments dd{margin:0;font-weight:700}.alert{padding:8px 12px;border-radius:8px;background:#fff1f3;color:#8a1c33;font-weight:700;border:2px solid #c23a57}.banner{font-size:18px;padding:14px 18px}article form{padding:0;border:0;margin-top:8px}';
