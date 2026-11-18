// "מערכות האתר" page (server-rendered, Hebrew RTL, same admin layout). Every value is escaped; external links open in
// a new tab with rel="noopener noreferrer". Statuses come only from real checks or are explicitly manual/postponed.
import {escape,layout,notice,time} from './admin.js';
import type {SystemView,CostEntry,SystemLink} from './system.js';
import {ils} from './finance.js';
// How the finance page counts each cost (from finance.opsCosts(); keyed by position in OPS_COSTS). Optional: without it
// the column is derived from the configuration alone.
export type FinanceCostState={state:string;financeAgorot:number|null;financeSource:string|null};

export const SYSTEM_STATUS_LABELS:Record<string,string>={OPERATIONAL:'פעיל',DEGRADED:'תקלה חלקית',OFFLINE:'לא זמין',MANUAL:'בדיקה ידנית',POSTPONED:'נדחה'};
const HTTP_REASONS:Record<string,string>={TIMEOUT:'לא ניתן לבדוק את השירות כרגע (תם הזמן הקצוב לבדיקה).',UNREACHABLE:'לא ניתן לבדוק את השירות כרגע.',BAD_RESPONSE:'השירות הגיב, אך התשובה אינה תקינה.',SLOW:'השירות תקין, אך הגיב לאט מהרגיל.'};
const DB_REASONS:Record<string,string>={TIMEOUT:'לא ניתן לבדוק את מסד הנתונים כרגע (תם הזמן הקצוב לבדיקה).',UNREACHABLE:'לא ניתן להתחבר למסד הנתונים כרגע.',BAD_RESPONSE:'מסד הנתונים החזיר תשובה לא צפויה.',SLOW:'מסד הנתונים תקין, אך הגיב לאט מהרגיל (ייתכן שהתעורר ממצב שינה).'};
const FREQUENCY:Record<string,string>={MONTHLY:'חודשי',YEARLY:'שנתי'};
const price=(cents:number,currency:string)=>cents===0?'חינם':new Intl.NumberFormat('he-IL',{style:'currency',currency}).format(cents/100);
const anchor=(item:SystemLink,className:string)=>'<a class="'+className+'" href="'+escape(item.url)+'"'+(item.external?' target="_blank" rel="noopener noreferrer"':'')+'>'+escape(item.label)+(item.external?'<span class="sr-only"> (נפתח בכרטיסייה חדשה)</span>':'')+'</a>';
// The finance column: the ILS amount recorded by the finance page, or why nothing is recorded. An ILS cost without an
// override shows no second amount (it is the provider price).
function financeCell(cost:CostEntry,state?:FinanceCostState){
 const per=cost.frequency==='YEARLY'?' / שנה':' / חודש';
 const amount=(agorot:number)=>'<span class="num" dir="ltr">'+escape(ils(agorot))+'</span>'+per;
 if(cost.amountCents<=0)return '<span class="muted">חינם · ללא הוצאה</span>';
 if(state?.state==='MANUAL_AMOUNT'&&state.financeAgorot!==null)return amount(state.financeAgorot)+'<span class="cell-note">סכום ידני מייבוא קודם</span>';
 const agorot=cost.financeAgorot??(cost.currency==='ILS'?cost.amountCents:null);
 if(agorot===null)return '<span class="muted">לא נכלל בכספים · יש להגדיר financeAmountIls (סכום בשקלים) ב־OPS_COSTS</span>';
 const stopped=state?.state==='STOPPED'?'<span class="cell-note">הופסק ידנית בדף הכספים</span>':'';
 if(cost.currency==='ILS'&&cost.financeAgorot===null)return '<span class="muted">כמו עלות הספק</span>'+stopped;
 return amount(agorot)+stopped;
}
const statusChip=(system:SystemView)=>'<span class="chip chip--sys chip--sys-'+system.status.toLowerCase()+'">'+escape(system.statusLabel||SYSTEM_STATUS_LABELS[system.status])+'</span>';

function card(system:SystemView){
 const check=system.check,reasons=system.checkKind==='database'?DB_REASONS:HTTP_REASONS;
 const health=check?
  '<p class="sys__check sys__check--'+check.status.toLowerCase()+'">'+(check.reason?escape(reasons[check.reason]||HTTP_REASONS.UNREACHABLE)+' ':'השירות נבדק ונמצא תקין. ')+
   '<span class="muted">נבדק '+time(check.checkedAt)+(check.latencyMs!==null?' · '+check.latencyMs+' ms':'')+
   (check.reason&&check.lastSuccessAt&&check.reason!=='SLOW'?' · בדיקה תקינה אחרונה '+time(check.lastSuccessAt):check.reason&&!check.lastSuccessAt&&check.reason!=='SLOW'?' · אין בדיקה תקינה קודמת מאז הפעלת השירות':'')+'</span></p>':
  system.checkKind==='derived'?'<p class="sys__check sys__check--'+system.status.toLowerCase()+'">'+(system.status==='OPERATIONAL'?'נגזר מבדיקת השרת ומסד הנתונים: שניהם תקינים.':'נגזר מבדיקת השרת ומסד הנתונים: אחד מהם אינו תקין כרגע.')+'</p>':
  system.status==='MANUAL'?'<p class="sys__check muted">מצב השירות אינו נבדק אוטומטית. בדיקה ידנית בממשק השירות.</p>':'';
 const details=system.details.length?'<dl class="sys__details">'+system.details.map(d=>'<div><dt>'+escape(d.label)+'</dt><dd>'+
  (d.value?(d.href?'<a href="'+escape(d.href)+'" target="_blank" rel="noopener noreferrer"'+(d.mono?' dir="ltr"':'')+'>'+(d.mono?'<code>'+escape(d.value)+'</code>':escape(d.value))+'<span class="sr-only"> (נפתח בכרטיסייה חדשה)</span></a>':d.mono?'<code dir="ltr">'+escape(d.value)+'</code>':escape(d.value)):'<span class="muted">לא הוגדר</span>')+'</dd></div>').join('')+'</dl>':'';
 const costs=system.costs.length?'<p class="sys__cost">עלות: '+system.costs.map(cost=>escape(price(cost.amountCents,cost.currency))+(cost.amountCents?' / '+(cost.frequency==='YEARLY'?'שנה':'חודש'):'')).join(' · ')+'</p>':'';
 const links=system.links.length?'<div class="sys__links">'+system.links.map(item=>anchor(item,'btn btn--quiet')).join('')+'</div>':
  system.status==='POSTPONED'?'':'<p class="sys__links muted">לא הוגדר קישור ניהול.</p>';
 return '<article class="sys'+(system.status==='POSTPONED'?' sys--postponed':'')+'" aria-labelledby="sys-'+escape(system.id)+'" data-system="'+escape(system.id)+'">'+
  '<header class="sys__head"><span class="sys__mark" aria-hidden="true">'+escape(system.mark)+'</span><h3 id="sys-'+escape(system.id)+'">'+escape(system.name)+'</h3>'+statusChip(system)+'</header>'+
  (system.purpose.length?'<ul class="sys__purpose" aria-label="ייעוד">'+system.purpose.map(p=>'<li>'+escape(p)+'</li>').join('')+'</ul>':'')+
  health+details+costs+(system.note?'<p class="sys__note"><strong>הערה:</strong> '+escape(system.note)+'</p>':'')+links+'</article>';
}

export function systemPage(data:{systems:SystemView[];postponed:SystemView[];quickLinks:SystemLink[];costs:{entries:CostEntry[];monthlyTotalsCents:Partial<Record<'USD'|'ILS',number>>};finance?:FinanceCostState[];
 checkedAt:string;cached:boolean;missing:string[];warnings:string[];csrf:string}){
 const count=(status:string)=>data.systems.filter(s=>s.status===status).length;
 const problems=count('OFFLINE')+count('DEGRADED');
 const summary='<p class="sys-summary" role="status">'+count('OPERATIONAL')+' פעילים · '+count('MANUAL')+' בבדיקה ידנית · '+(problems?'<strong>'+problems+' דורשים תשומת לב</strong>':'אין תקלות שזוהו')+'</p>';
 const totals=(Object.entries(data.costs.monthlyTotalsCents) as ['USD'|'ILS',number][]);
 const costs=data.costs.entries.length?
  '<div class="table-wrap"><table class="table table--costs"><caption class="sr-only">עלויות שהוגדרו ידנית</caption><thead><tr><th scope="col">שירות</th><th scope="col">עלות ספק</th><th scope="col">חיוב</th><th scope="col">לחודש (משוער)</th><th scope="col">עלות לחישוב כספי</th><th scope="col">הערות</th></tr></thead><tbody>'+
   data.costs.entries.map((cost,i)=>'<tr><td data-label="שירות">'+escape(cost.service)+'</td><td data-label="עלות ספק" class="num">'+escape(price(cost.amountCents,cost.currency))+'</td><td data-label="חיוב">'+escape(cost.amountCents?FREQUENCY[cost.frequency]:'—')+'</td>'+
    '<td data-label="לחודש (משוער)" class="num">'+escape(price(cost.monthlyCents,cost.currency))+'</td><td data-label="עלות לחישוב כספי">'+financeCell(cost,data.finance?.[i])+'</td>'+
    '<td data-label="הערות">'+(cost.note?escape(cost.note):'<span class="muted">—</span>')+'</td></tr>').join('')+'</tbody></table></div>'+
  '<p class="cost-total"><span>סה"כ עלות חודשית משוערת:</span> '+totals.map(([currency,cents])=>'<strong data-currency="'+currency+'">'+escape(price(cents,currency)==='חינם'?new Intl.NumberFormat('he-IL',{style:'currency',currency}).format(0):price(cents,currency))+' לחודש</strong>').join('<span aria-hidden="true"> · </span>')+'</p>'+
  (totals.length>1?'<p class="muted">המטבעות מוצגים בנפרד ואינם מומרים.</p>':'')+'<p class="muted">עלות שנתית מחולקת ל־12 לצורך ההערכה החודשית. הסכומים מוזנים ידנית ואינם מתעדכנים מהספקים.</p>':
  '<div class="empty"><strong>לא הוגדרו עלויות.</strong><span>ניתן להגדיר אותן במשתנה הסביבה OPS_COSTS של השירות ב־Render. מחיר מוצג רק אם הוגדר.</span></div>';
 return layout('מערכות האתר',
  '<div class="page-head"><div><h1>מערכות האתר</h1><p class="muted">ניהול ומעקב אחר השירותים שמפעילים את פאנקי</p></div>'+
   '<form method="get" action="/admin/system/services" class="sys-refresh"><input type="hidden" name="refresh" value="1"><button class="btn btn--primary">בדיקה מחדש</button></form></div>'+
  '<p class="muted">בדיקה אחרונה: '+time(data.checkedAt)+(data.cached?' (תוצאה שמורה מהדקה האחרונה)':'')+'. הבדיקות רצות רק כשהדף נפתח, בלי ניטור רציף.</p>'+
  summary+
  (data.warnings.length?'<div class="notice notice--info" role="status"><strong>הגדרות שלא נקלטו:</strong><ul class="sys-warnings">'+data.warnings.map(w=>'<li dir="ltr">'+escape(w)+'</li>').join('')+'</ul></div>':'')+
  '<nav class="sys-quick" aria-label="קישורים מהירים">'+data.quickLinks.map(item=>anchor(item,'btn btn--quiet')).join('')+'</nav>'+
  '<section aria-labelledby="systems-title"><h2 id="systems-title" class="sys-section-title">שירותים</h2><div class="sys-grid">'+data.systems.map(card).join('')+'</div></section>'+
  '<section class="card" aria-labelledby="costs-title"><div class="section-head"><h2 id="costs-title">עלויות חודשיות</h2><a class="btn btn--quiet" href="/admin/system">לדף הכספים</a></div>'+costs+
   '<p class="muted sys-costs-finance">"עלות לחישוב כספי" היא הסכום בשקלים שנרשם כהוצאה בדף הכספים בכל תאריך חיוב: מחיר בשקלים, או financeAmountIls לעלות במטבע אחר. אין המרת מטבע אוטומטית; עלות במטבע אחר בלי financeAmountIls אינה נספרת בכספים.</p></section>'+
  '<section aria-labelledby="postponed-title"><h2 id="postponed-title" class="sys-section-title">נדחה / לא פעיל כרגע</h2><p class="muted">מערכות שנדחו בכוונה. אינן תקלות ואינן פעילות בפרודקשן.</p><div class="sys-grid">'+data.postponed.map(card).join('')+'</div></section>'+
  (data.missing.length?'<section class="card" aria-labelledby="missing-title"><h2 id="missing-title">הגדרות שעדיין חסרות</h2><p class="muted">משתני סביבה אופציונליים בשירות ב־Render. אין להזין בהם סיסמאות או אסימונים.</p><ul class="sys-missing">'+data.missing.map(key=>'<li><code dir="ltr">'+escape(key)+'</code></li>').join('')+'</ul></section>':''),
  {csrf:data.csrf,active:'system'});
}
