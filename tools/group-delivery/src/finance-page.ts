// "כספים" (/admin/system): server-rendered Hebrew RTL finance dashboard. Works without JavaScript: the add/edit and
// delete dialogs are rendered open from ?add= / ?edit= / ?delete=, and /admin/app.js only turns them into
// modals and opens the add dialog in place. The chart is inline SVG (presentation attributes only, so it fits the
// admin CSP without inline styles) with the same numbers repeated in a table. Every value is escaped.
import {escape,layout,notice,pager,query} from './admin.js';
export {ils} from './finance.js';
import {ils,TYPE_LABELS,PAYMENT_LABELS,SOURCE_LABELS,FREQUENCY_LABELS,RANGE_LABELS,RANGES,CATEGORY_SUGGESTIONS,PAYMENT_METHODS,SOURCES,FREQUENCIES,type FieldErrors,type Transaction,type Recurring,type Range} from './finance.js';

const money=(agorot:number|bigint,extra='',sign:'auto'|'always'='auto')=>'<span class="money'+(extra?' '+extra:'')+'" dir="ltr">'+escape(ils(agorot,sign))+'</span>';
const compact=(agorot:number)=>'₪'+new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(agorot/100);
const dateText=(date:string)=>{const [y,m,d]=date.split('-');return d+'.'+m+'.'+y;};
const monthLabel=(month:string,withYear=true)=>new Intl.DateTimeFormat('he-IL',{month:'short',...(withYear?{year:'2-digit'}:{}),timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'));
const monthLong=(month:string)=>new Intl.DateTimeFormat('he-IL',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T00:00:00Z'));
const option=(value:string,label:string,selected:string)=>'<option value="'+escape(value)+'"'+(value===selected?' selected':'')+'>'+escape(label)+'</option>';
const typeChip=(type:string)=>'<span class="tx-type tx-type--'+(type==='INCOME'?'income':'expense')+'"><span aria-hidden="true">'+(type==='INCOME'?'↑':'↓')+'</span> '+escape(TYPE_LABELS[type as 'INCOME'])+'</span>';
const amountCell=(type:string,agorot:number)=>money(type==='INCOME'?agorot:-agorot,'tx-amount tx-amount--'+(type==='INCOME'?'income':'expense'),'always');

export type DialogState=
 {mode:'create'|'edit';kind:'INCOME'|'EXPENSE'|'RECURRING';id?:string;values:Record<string,string>;errors:FieldErrors;error?:string;nextBilling?:string|null;opsLocked?:boolean}|
 {mode:'delete';transaction:Transaction}|{mode:'delete';recurring:Recurring};

const NOTICES:Record<string,string>={tx_created:'התנועה נשמרה.',tx_updated:'התנועה עודכנה.',tx_deleted:'התנועה נמחקה.',
 tx_deactivated:'החיוב הקבוע הופסק. החיובים שכבר נרשמו נשארים בהיסטוריה.',rec_updated:'החיוב הקבוע עודכן. חיובים שכבר נרשמו לא השתנו.'};
const ERRORS:Record<string,string>={not_found:'התנועה לא נמצאה. ייתכן שכבר נמחקה.',ops_managed:'החיוב מנוהל דרך OPS_COSTS. כדי להפסיק אותו יש להסיר אותו מ־OPS_COSTS.',delete_confirm:'נדרש אישור מפורש למחיקה. לא בוצע שינוי.',
 occurrence_locked:'זהו חיוב שנרשם מחיוב קבוע ונשמר כפי שנרשם. לשינוי החיובים הבאים יש לערוך את החיוב הקבוע.',inactive:'החיוב הקבוע הופסק ואינו ניתן לעריכה.'};

// Filter/range state kept across links and form posts (validated again on the server).
export type ViewParams={range:Range;q:string;month:string;type:string;category:string;page:number};
const params=(p:ViewParams,extra:Record<string,string|number|undefined>={})=>({range:p.range==='6m'?undefined:p.range,q:p.q||undefined,month:p.month||undefined,type:p.type||undefined,category:p.category||undefined,page:p.page>1?p.page:undefined,...extra});
export const backOf=(p:ViewParams)=>query('',params(p)).replace(/^\?/,'');

function kpis(k:any,month:string){
 const card=(label:string,value:string,hint:string,extra='')=>'<li class="metric metric--fin'+extra+'"><span class="metric__label">'+escape(label)+'</span><strong class="metric__value">'+value+'</strong><span class="metric__hint">'+hint+'</span></li>';
 const profit=k.profitAgorot,state=profit>0?'רווח':profit<0?'הפסד':'מאוזן';
 return '<ul class="metrics metrics--fin" aria-label="סיכום '+escape(monthLong(month))+'">'+
  card('הכנסות החודש',money(k.incomeAgorot),escape(monthLong(month)),' metric--income')+
  card('הוצאות החודש',money(k.expenseAgorot),k.recurringThisMonthAgorot?'כולל '+money(k.recurringThisMonthAgorot)+' חיובים קבועים':'כולל חיובים קבועים לפי תאריך החיוב',' metric--expense')+
  card('רווח / הפסד',money(profit),'<span class="fin-state fin-state--'+(profit<0?'loss':profit>0?'profit':'even')+'"><span aria-hidden="true">'+(profit<0?'▼':profit>0?'▲':'●')+'</span> '+state+'</span> · הכנסות פחות הוצאות',profit<0?' metric--loss':profit>0?' metric--profit':'')+
  card('חיובים קבועים',money(k.recurringMonthlyAgorot),k.recurringActive+' חיובים פעילים · עלות חודשית (שנתי ÷ 12, רבעוני ÷ 3)',' metric--recurring')+
 '</ul>';
}

// Grouped bars, months right to left (RTL reading order). Expense bars are hatched, so the series differ without color.
function chart(months:{month:string;incomeAgorot:number;expenseAgorot:number}[],range:Range,p:ViewParams){
 const n=months.length,slot=n<=6?76:58,axis=70,W=axis+n*slot+8,H=250,top=14,base=206;
 const max=Math.max(1,...months.flatMap(m=>[m.incomeAgorot,m.expenseAgorot]));
 const raw=max/4,mag=10**Math.floor(Math.log10(raw)),step=[1,2,2.5,5,10].map(x=>x*mag).find(x=>x>=raw)!,top_=step*4;
 const y=(v:number)=>base-(v/top_)*(base-top);
 const grid=[0,1,2,3,4].map(i=>{const v=step*i,yy=y(v).toFixed(1);
  return '<line class="chart__grid'+(i===0?' chart__grid--base':'')+'" x1="8" x2="'+(W-axis)+'" y1="'+yy+'" y2="'+yy+'"/><text class="chart__axis" x="'+(W-axis+8)+'" y="'+(Number(yy)+4)+'" direction="ltr">'+escape(compact(Math.round(v)))+'</text>';}).join('');
 const bw=Math.round(slot*0.3);
 const bars=months.map((m,i)=>{
  const right=W-axis-i*slot,center=right-slot/2;
  const bar=(value:number,x:number,kind:'income'|'expense',label:string)=>{const h=Math.max(0,base-y(value));
   return '<rect class="chart__bar chart__bar--'+kind+'" x="'+x.toFixed(1)+'" y="'+(base-h).toFixed(1)+'" width="'+bw+'" height="'+h.toFixed(1)+'" rx="3"'+(kind==='expense'?' fill="url(#fin-hatch)"':'')+'><title>'+escape(label+' · '+monthLong(m.month)+': '+ils(value))+'</title></rect>';};
  return '<g class="chart__month">'+bar(m.incomeAgorot,center+2,'income','הכנסות')+bar(m.expenseAgorot,center-2-bw,'expense','הוצאות')+
   '<text class="chart__label" x="'+center.toFixed(1)+'" y="'+(base+20)+'" text-anchor="middle">'+escape(monthLabel(m.month,range!=='year'))+'</text></g>';
 }).join('');
 const empty=months.every(m=>!m.incomeAgorot&&!m.expenseAgorot);
 const svg='<svg class="chart__svg chart__svg--'+n+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-labelledby="chart-title chart-desc" focusable="false">'+
  '<desc id="chart-desc">'+escape('הכנסות מול הוצאות לפי חודש, '+monthLong(months[0].month)+' עד '+monthLong(months[n-1].month)+'. הנתונים המלאים מופיעים בטבלה שמתחת לתרשים.')+'</desc>'+
  '<defs><pattern id="fin-hatch" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect class="chart__hatch-bg" width="6" height="6"/><rect class="chart__hatch" width="2.5" height="6"/></pattern></defs>'+
  grid+bars+'</svg>';
 const table='<details class="chart__data"><summary>הצגת הנתונים כטבלה</summary><div class="table-wrap"><table class="table table--chart"><caption class="sr-only">הכנסות, הוצאות ורווח לפי חודש</caption><thead><tr><th scope="col">חודש</th><th scope="col">הכנסות</th><th scope="col">הוצאות</th><th scope="col">רווח / הפסד</th></tr></thead><tbody>'+
  [...months].reverse().map(m=>'<tr><th scope="row" data-label="חודש">'+escape(monthLong(m.month))+'</th><td data-label="הכנסות" class="num">'+money(m.incomeAgorot)+'</td><td data-label="הוצאות" class="num">'+money(m.expenseAgorot)+'</td><td data-label="רווח / הפסד" class="num">'+money(m.incomeAgorot-m.expenseAgorot)+'</td></tr>').join('')+'</tbody></table></div></details>';
 const tabs='<nav class="segmented" aria-label="טווח התרשים">'+RANGES.map(r=>'<a class="segmented__item" href="'+escape(query('/admin/system',params(p,{range:r==='6m'?undefined:r,page:undefined})))+'"'+(r===range?' aria-current="true"':'')+'>'+escape(RANGE_LABELS[r])+'</a>').join('')+'</nav>';
 return '<section class="card fin-chart" aria-labelledby="chart-title"><div class="section-head"><h2 id="chart-title">הכנסות מול הוצאות</h2>'+tabs+'</div>'+
  '<ul class="legend" aria-hidden="true"><li><span class="swatch swatch--income"></span>הכנסות</li><li><span class="swatch swatch--expense"></span>הוצאות</li></ul>'+
  '<div class="chart-scroll">'+svg+'</div>'+(empty?'<p class="muted chart__empty">אין עדיין תנועות בטווח הזה.</p>':'')+table+'</section>';
}

const STATUS:Record<string,string>={ACTIVE:'פעיל',SCHEDULED:'מתוכנן',ENDED:'הסתיים',INACTIVE:'הופסק'};
function recurringCard(items:any[],p:ViewParams){
 const rows=items.map(r=>'<tr class="'+(r.status==='ENDED'?'row--withdrawn':'')+'">'+
  '<td data-label="תיאור"><strong>'+escape(r.description||r.category)+'</strong>'+
   (r.managedBy==='OPS_COSTS'||r.description?'<span class="cell-note">'+(r.managedBy==='OPS_COSTS'?'<span class="tag tag--ops">הוצאת מערכת</span> <span dir="ltr">OPS_COSTS</span>'+(r.amountSource==='MANUAL'?' · סכום ידני (ייבוא קודם)':'')+(r.description?' · ':''):'')+(r.description?escape(r.category):'')+'</span>':'')+'</td>'+
  // Four columns so the card fits the side column: frequency sits with the amount, status with the next billing date.
  '<td data-label="סכום" class="num">'+money(r.amountAgorot)+'<span class="cell-note">'+escape(FREQUENCY_LABELS[r.frequency as 'MONTHLY'])+(r.frequency!=='MONTHLY'?' · ≈ ':'')+'</span>'+
   (r.provider?'<span class="cell-note"><span dir="ltr">'+escape(providerPrice(r.provider.amountCents,r.provider.currency))+'</span> אצל הספק</span>':'')+
   (r.frequency!=='MONTHLY'?'<span class="cell-note">'+money(r.monthlyAgorot)+' לחודש</span>':'')+'</td>'+
  '<td data-label="החיוב הבא / מצב"><span class="chip chip--rec-'+r.status.toLowerCase()+'">'+escape(STATUS[r.status])+'</span>'+
   (r.nextDate?'<span class="cell-note"><time datetime="'+escape(r.nextDate)+'">'+escape(dateText(r.nextDate))+'</time></span>':'')+
   (r.status==='SCHEDULED'?'<span class="cell-note">מתחיל ב־'+escape(dateText(r.anchor))+'</span>':'')+(r.endDate?'<span class="cell-note">עד '+escape(dateText(r.endDate))+'</span>':'')+'</td>'+
  '<td data-label="פעולות">'+(r.status==='INACTIVE'?'<span class="muted">'+r.occurrences+' חיובים נשמרו'+(r.deactivatedReason==='OPS_SYNC'?' · הוסר מ־OPS_COSTS':'')+'</span>':
   r.opsLocked?'<div class="actions"><a class="icon-btn" href="'+escape(query('/admin/system',params(p,{edit:r.id})))+'">עריכה<span class="sr-only"> של '+escape(r.description||r.category)+' (סכום ותדירות מנוהלים ב־OPS_COSTS)</span></a></div>':
   '<div class="actions">'+actions(r.id,p,r.description||r.category,r.occurrences?'הפסקה':'מחיקה')+'</div>')+'</td></tr>').join('');
 return '<section class="card fin-recurring" aria-labelledby="recurring-title"><div class="section-head"><h2 id="recurring-title">חיובים קבועים</h2>'+
   '<a class="btn btn--quiet" href="'+escape(query('/admin/system',params(p,{add:'RECURRING'})))+'" data-tx-add="RECURRING" aria-haspopup="dialog">+ חיוב קבוע</a></div>'+
  (items.length?'<div class="table-wrap"><table class="table table--recurring"><caption class="sr-only">חיובים קבועים: פעילים, מתוכננים ושהסתיימו</caption><thead><tr><th scope="col">תיאור</th><th scope="col">סכום</th><th scope="col">החיוב הבא / מצב</th><th scope="col">פעולות</th></tr></thead><tbody>'+rows+'</tbody></table></div>':
   '<div class="empty"><strong>אין חיובים קבועים.</strong><span>מנויים כמו Shopify או Render נרשמים פעם אחת כחיוב קבוע.</span></div>')+
  '<p class="muted">כל תאריך חיוב שמגיע (באותו יום בחודש, או ביום האחרון בחודש קצר) נרשם אוטומטית כהוצאה בתנועות. שינוי סכום או תדירות חל רק מהחיוב הבא; חיובים שכבר נרשמו לא משתנים. אין לרשום את החיובים האלה שוב כהוצאה רגילה.</p></section>';
}
const actions=(id:string,p:ViewParams,label:string,remove='מחיקה')=>
 '<a class="icon-btn" href="'+escape(query('/admin/system',params(p,{edit:id})))+'">עריכה<span class="sr-only"> של '+escape(label)+'</span></a>'+
 '<a class="icon-btn icon-btn--danger" href="'+escape(query('/admin/system',params(p,{delete:id})))+'">'+remove+'<span class="sr-only"> של '+escape(label)+'</span></a>';

function transactions(list:any,p:ViewParams){
 const f=list.filters,filtered=!!(f.q||f.type||f.category||f.month);
 const rows=list.entries.map((e:any)=>'<tr data-type="'+escape(e.type)+'"'+(e.occurrence?' class="row--occurrence"':'')+'>'+
  '<td data-label="תאריך"><time datetime="'+escape(e.date)+'">'+escape(dateText(e.date))+'</time></td>'+
  '<td data-label="סוג">'+typeChip(e.type)+'</td>'+
  '<td data-label="קטגוריה">'+escape(e.category)+'</td>'+
  '<td data-label="תיאור">'+(e.description?escape(e.description):'<span class="muted">—</span>')+(e.occurrence?' <span class="tag">חיוב קבוע · '+escape(FREQUENCY_LABELS[e.frequency as 'MONTHLY'])+'</span>':'')+'</td>'+
  '<td data-label="סכום" class="num">'+amountCell(e.type,e.amountAgorot)+'</td>'+
  '<td data-label="מקור">'+escape(SOURCE_LABELS[e.source]||e.source)+(e.paymentMethod?'<span class="cell-note">'+escape(PAYMENT_LABELS[e.paymentMethod]||'')+'</span>':'')+'</td>'+
  '<td data-label="פעולות"><div class="actions">'+(e.occurrence?
   '<a class="icon-btn" href="'+escape(query('/admin/system',params(p,{edit:e.recurringDefinitionId})))+'">עריכת החיוב הקבוע<span class="sr-only"> '+escape(e.description||e.category)+'</span></a>':
   actions(e.id,p,(e.description||e.category)+' מ־'+dateText(e.date)))+'</div></td></tr>').join('');
 const categories=[...new Set([...list.categories,...(f.category?[f.category]:[])])];
 const t=list.totals;
 return '<section class="card" aria-labelledby="tx-title"><div class="section-head"><h2 id="tx-title">תנועות אחרונות</h2></div>'+
  '<form method="get" action="/admin/system" class="filters filters--fin" role="search" aria-label="סינון תנועות">'+
   (p.range!=='6m'?'<input type="hidden" name="range" value="'+escape(p.range)+'">':'')+
   '<div class="field field--wide"><label for="fin-q">חיפוש</label><input id="fin-q" name="q" type="search" value="'+escape(f.q)+'" placeholder="תיאור, קטגוריה או הערה" autocomplete="off" maxlength="100"></div>'+
   '<div class="field"><label for="fin-month">חודש</label><input id="fin-month" name="month" type="month" value="'+escape(f.month)+'" dir="ltr"></div>'+
   '<div class="field"><label for="fin-type">סוג</label><select id="fin-type" name="type">'+option('','הכול',f.type)+option('INCOME','הכנסות',f.type)+option('EXPENSE','הוצאות',f.type)+'</select></div>'+
   '<div class="field"><label for="fin-category">קטגוריה</label><select id="fin-category" name="category">'+option('','כל הקטגוריות',f.category)+categories.map((c:string)=>option(c,c,f.category)).join('')+'</select></div>'+
   '<div class="filters__actions"><button class="btn btn--primary">סינון</button>'+(filtered?'<a class="btn btn--quiet" href="'+escape(query('/admin/system',{range:p.range==='6m'?undefined:p.range}))+'">ניקוי</a>':'')+'</div>'+
  '</form>'+
  '<p class="fin-totals" role="status">'+(filtered?'בסינון: ':'סך הכול: ')+'<span>הכנסות '+money(t.incomeAgorot)+'</span> · <span>הוצאות '+money(t.expenseAgorot)+'</span> · <span>'+(t.profitAgorot<0?'הפסד':'רווח')+' '+money(t.profitAgorot)+'</span></p>'+
  (list.entries.length?'<div class="table-wrap"><table class="table table--tx"><caption class="sr-only">תנועות, מהחדשה לישנה'+(filtered?' (מסוננות)':'')+'</caption><thead><tr><th scope="col">תאריך</th><th scope="col">סוג</th><th scope="col">קטגוריה</th><th scope="col">תיאור</th><th scope="col">סכום</th><th scope="col">מקור</th><th scope="col">פעולות</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
   pager('/admin/system',params(p,{page:undefined}),list.pagination,'תנועות'):
   filtered?'<div class="empty"><strong>לא נמצאו תנועות שמתאימות לסינון.</strong><a class="btn btn--quiet" href="/admin/system">ניקוי הסינון</a></div>':
   '<div class="empty"><strong>עדיין לא נרשמו תנועות.</strong><span>הוסיפו הכנסה או הוצאה בכפתורים שבראש הדף.</span></div>')+
 '</section>';
}

// OPS_COSTS status: synced ILS costs already appear in "חיובים קבועים" (counted once, there); this lists only the
// entries that are NOT counted, so nothing is shown twice.
const providerPrice=(cents:number,currency:string)=>(currency==='ILS'?'₪':currency==='USD'?'$':'')+new Intl.NumberFormat('en-US',{minimumFractionDigits:2}).format(cents/100)+(currency!=='ILS'&&currency!=='USD'?' '+currency:'');
const OPS_STATES:Record<string,string>={FREE:'חינם · ללא הוצאה',NOT_COUNTED:'לא נכלל בסיכומים · אין סכום בשקלים',STOPPED:'הופסק ידנית · לא נכלל בסיכומים',PENDING:'יסונכרן בטעינה הבאה',
 MANUAL_AMOUNT:'נכלל בסכום שהוזן ידנית בשקלים'};
function opsCard(entries:any[]){
 if(!entries.length)return '';
 const synced=entries.filter(e=>e.state==='SYNCED'||e.state==='MANUAL_AMOUNT').length,others=entries.filter(e=>e.state!=='SYNCED'&&e.state!=='MANUAL_AMOUNT');
 const price=providerPrice;
 const rows=others.map(e=>'<tr data-ops-state="'+escape(e.state)+'"><td data-label="שירות">'+escape(e.service)+'</td>'+
  '<td data-label="עלות מוגדרת" class="num"><span dir="ltr">'+escape(e.amountCents?price(e.amountCents,e.currency):'חינם')+'</span>'+(e.amountCents?'<span class="cell-note">'+(e.frequency==='YEARLY'?'שנתי':'חודשי')+'</span>':'')+'</td>'+
  '<td data-label="מצב"><span class="chip chip--rec-'+(e.state==='MANUAL_AMOUNT'?'active':'inactive')+'">'+escape(OPS_STATES[e.state]||e.state)+'</span></td></tr>').join('');
 return '<section class="card fin-ops" aria-labelledby="ops-costs-title"><div class="section-head"><h2 id="ops-costs-title">עלויות מערכת (OPS_COSTS)</h2></div>'+
  '<p class="muted">'+(synced?'<strong>'+synced+' עלויות בשקלים</strong> מסונכרנות אוטומטית ומופיעות ב"חיובים קבועים" (מסומנות "הוצאת מערכת"). ':'')+
   'הן נרשמות כהוצאה בכל תאריך חיוב, החל מהחודש שבו סונכרנו לראשונה. שינוי סכום ב־<code dir="ltr">OPS_COSTS</code> חל מהחיוב הבא בלבד; הסרה מפסיקה את החיוב ומשאירה את ההיסטוריה.</p>'+
  (others.length?'<div class="table-wrap"><table class="table table--ops"><caption class="sr-only">עלויות OPS_COSTS שאינן נכללות בסיכומים</caption><thead><tr><th scope="col">שירות</th><th scope="col">עלות מוגדרת</th><th scope="col">מצב</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
   (others.some(e=>e.state==='NOT_COUNTED')?'<p class="muted">עלויות במטבע אחר אינן מומרות אוטומטית. כדי לכלול עלות כזאת, יש להגדיר לה ב־<code dir="ltr">OPS_COSTS</code> את <code dir="ltr">financeAmountIls</code>: הסכום בשקלים לרישום בכספים.</p>':''):'')+
  '</section>';
}

// ---- Dialogs --------------------------------------------------------------------------------------------------------
const TITLES={create:{INCOME:'הוספת הכנסה',EXPENSE:'הוספת הוצאה',RECURRING:'הוספת חיוב קבוע'},edit:'עריכת תנועה'};
export function formValues(kind:'INCOME'|'EXPENSE'|'RECURRING',today:string):Record<string,string>{
 return {type:kind==='INCOME'?'INCOME':'EXPENSE',amount:'',date:today,category:'',description:'',paymentMethod:kind==='RECURRING'?'CARD':'',source:'MANUAL',notes:'',recurring:kind==='RECURRING'?'on':'',frequency:'MONTHLY',startDate:kind==='RECURRING'?today:'',endDate:''};
}
export const valuesOf=(t:Transaction):Record<string,string>=>({type:t.type,amount:ils(t.amountAgorot).replace(/[₪,]/g,''),date:t.date,category:t.category,description:t.description??'',paymentMethod:t.paymentMethod??'',source:t.source,notes:t.notes??'',
 recurring:'',frequency:'MONTHLY',startDate:'',endDate:''});
// A charge is edited through the same form: "תאריך" is its first billing date (start), "תאריך התחלה" stays empty.
export const recurringValuesOf=(r:Recurring):Record<string,string>=>({type:'EXPENSE',amount:ils(r.amountAgorot).replace(/[₪,]/g,''),date:r.startDate,category:r.category,description:r.description??'',paymentMethod:r.paymentMethod??'',source:r.source,notes:r.notes??'',
 recurring:'on',frequency:r.frequency,startDate:'',endDate:r.endDate??''});
const FIELD_ORDER=['type','amount','date','category','description','paymentMethod','source','notes','recurring','frequency','startDate','endDate','importKey'] as const;
const FIELD_LABELS:Record<string,string>={type:'סוג',amount:'סכום',date:'תאריך',category:'קטגוריה',description:'תיאור',paymentMethod:'אמצעי תשלום',source:'מקור',notes:'הערות',recurring:'חיוב קבוע',frequency:'תדירות',startDate:'תאריך התחלה',endDate:'תאריך סיום',importKey:'ייבוא'};

function txDialog(d:Extract<DialogState,{mode:'create'|'edit'}>,csrf:string,back:string,id:string,open:boolean){
 const v=d.values,e=d.errors,prefix=id+'-';
 const err=(field:string)=>e[field as keyof FieldErrors]?'<p class="field-error" id="'+prefix+field+'-error">'+escape(e[field as keyof FieldErrors]!)+'</p>':'';
 const aria=(field:string)=>e[field as keyof FieldErrors]?' aria-invalid="true" aria-describedby="'+prefix+field+'-error"':'';
 const input=(field:string,label:string,attrs:string,hint='')=>'<div class="field'+(e[field as keyof FieldErrors]?' field--invalid':'')+'"><label for="'+prefix+field+'">'+label+'</label><input id="'+prefix+field+'" name="'+field+'" value="'+escape(v[field])+'" '+attrs+aria(field)+'>'+(hint?'<span class="field-hint">'+hint+'</span>':'')+err(field)+'</div>';
 const select=(field:string,label:string,options:string)=>'<div class="field"><label for="'+prefix+field+'">'+label+'</label><select id="'+prefix+field+'" name="'+field+'"'+aria(field)+'>'+options+'</select>'+err(field)+'</div>';
 const title=d.mode==='create'?TITLES.create[d.kind]:TITLES[d.mode];
 const action=d.mode==='edit'?'/admin/system/transactions/'+d.id:'/admin/system/transactions';
 const recurring=v.recurring==='on',isIncome=v.type==='INCOME',editing=d.mode==='edit',editingCharge=editing&&recurring,locked=editingCharge&&!!d.opsLocked,ro=locked?' readonly':'';
 const summary=Object.keys(e).length?'<div class="notice notice--error" role="alert" tabindex="-1" data-error-summary><strong>'+escape(d.error||'לא ניתן לשמור את התנועה.')+'</strong><ul>'+
  FIELD_ORDER.filter(f=>e[f]).map(f=>'<li><a href="#'+prefix+(f==='type'?'type-EXPENSE':f==='recurring'?'recurring':f)+'">'+escape(FIELD_LABELS[f])+': '+escape(e[f]!)+'</a></li>').join('')+'</ul></div>':d.error?'<div class="notice notice--error" role="alert">'+escape(d.error)+'</div>':'';
 return '<dialog id="'+id+'" class="dialog dialog--form" aria-labelledby="'+prefix+'title" data-mode="'+d.mode+'"'+(open?' open data-autoshow':'')+'>'+
  '<form method="post" action="'+escape(action)+'" class="dialog__body tx-form" data-tx-form>'+
   '<input type="hidden" name="csrf" value="'+escape(csrf)+'"><input type="hidden" name="back" value="'+escape(back)+'">'+
   '<h2 id="'+prefix+'title" data-title-income="הוספת הכנסה" data-title-expense="הוספת הוצאה" data-title-recurring="הוספת חיוב קבוע">'+escape(title)+'</h2>'+summary+
   (locked?'<p class="notice notice--info"><strong>הוצאת מערכת מ־OPS_COSTS.</strong> הסכום, התדירות והתאריכים מנוהלים במשתנה הסביבה ומתעדכנים אוטומטית (מהחיוב הבא בלבד). כאן ניתן לשנות קטגוריה, תיאור, אמצעי תשלום והערות.</p>':'')+
   (editingCharge?'<input type="hidden" name="type" value="EXPENSE"><input type="hidden" name="recurring" value="on">'+
    '<p class="notice notice--info">חיוב קבוע (הוצאה). שינוי סכום, תדירות או תאריכים יחול רק '+(d.nextBilling?'מהחיוב הבא שטרם נרשם: <strong>'+escape(dateText(d.nextBilling))+'</strong>':'מהיום')+'. חיובים שכבר נרשמו לא ישתנו. שינוי קטגוריה, תיאור או הערות חל על החיובים הבאים בלבד.</p>':
   '<fieldset class="field field--choice"'+(e.type?' aria-describedby="'+prefix+'type-error"':'')+'><legend>סוג</legend><div class="choice">'+
    (['EXPENSE','INCOME'] as const).map(t=>'<label class="choice__item"><input type="radio" name="type" value="'+t+'" id="'+prefix+'type-'+t+'"'+(v.type===t?' checked':'')+' data-tx-type> '+(t==='INCOME'?'↑ הכנסה':'↓ הוצאה')+'</label>').join('')+'</div>'+err('type')+'</fieldset>')+
   '<div class="tx-form__grid">'+
    input('amount','סכום (₪)','inputmode="decimal" autocomplete="off" dir="ltr" required maxlength="16" placeholder="0.00"'+ro,locked?'מנוהל ב־OPS_COSTS':'לדוגמה 129.90')+
    input('date',editingCharge?'תאריך החיוב הראשון':'תאריך','type="date" required dir="ltr" min="2000-01-01" max="2100-12-31"'+ro)+
    input('category','קטגוריה','required maxlength="60" autocomplete="off" list="fin-categories-'+(isIncome?'income':'expense')+'" data-tx-category','בחירה מההצעות או טקסט חופשי')+
    input('description','תיאור','maxlength="200" autocomplete="off"')+
    select('paymentMethod','אמצעי תשלום',option('','—',v.paymentMethod)+PAYMENT_METHODS.map(m=>option(m,PAYMENT_LABELS[m],v.paymentMethod)).join(''))+
    select('source','מקור',SOURCES.map(s=>option(s,SOURCE_LABELS[s],v.source)).join(''))+
   '</div>'+
   '<div class="field"><label for="'+prefix+'notes">הערות</label><textarea id="'+prefix+'notes" name="notes" rows="2" maxlength="1000"'+aria('notes')+'>'+escape(v.notes)+'</textarea>'+err('notes')+'</div>'+
   (editing?err('recurring'):'<label class="check" for="'+prefix+'recurring"><input type="checkbox" id="'+prefix+'recurring" name="recurring" value="on"'+(recurring?' checked':'')+(isIncome&&!recurring?' disabled':'')+' data-tx-recurring'+aria('recurring')+'> חיוב קבוע (הוצאה שחוזרת, למשל מנוי)</label>'+err('recurring'))+
   (editing&&!recurring?'':'<fieldset class="tx-recurrence" data-tx-recurrence'+(recurring?'':' hidden')+'><legend>פרטי החיוב הקבוע</legend><div class="tx-form__grid">'+
    (locked?'<div class="field"><label for="'+prefix+'frequency-text">תדירות</label><input id="'+prefix+'frequency-text" value="'+escape(FREQUENCY_LABELS[v.frequency as 'MONTHLY']||'')+'" readonly><input type="hidden" name="frequency" value="'+escape(v.frequency)+'"></div>':
     select('frequency','תדירות',FREQUENCIES.map(f=>option(f,FREQUENCY_LABELS[f],v.frequency)).join('')))+
    (editingCharge?'':input('startDate','תאריך התחלה (רשות)','type="date" dir="ltr" min="2000-01-01" max="2100-12-31"','ריק: מתאריך התנועה'))+
    input('endDate','תאריך סיום (רשות)','type="date" dir="ltr" min="2000-01-01" max="2100-12-31"'+ro,'ריק: ללא סיום')+
   '</div><p class="muted">כל תאריך חיוב שמגיע, מתאריך ההתחלה ובאותו יום בחודש, נרשם אוטומטית כהוצאה. אין צורך לרשום כל חיוב בנפרד.</p></fieldset>')+
   '<div class="dialog__actions"><button type="submit" formmethod="dialog" formnovalidate class="btn btn--quiet" data-dialog-cancel>ביטול</button><button type="submit" class="btn btn--primary" data-once>שמירה</button></div>'+
  '</form></dialog>';
}
function deleteDialog(d:Extract<DialogState,{mode:'delete'}>,csrf:string,back:string){
 const t='transaction' in d?d.transaction:null,r='recurring' in d?d.recurring:null,id=(t??r)!.id,stop=!!r&&r.occurrences>0;
 const facts=t?'<div><dt>סוג</dt><dd>'+typeChip(t.type)+'</dd></div><div><dt>סכום</dt><dd><strong>'+money(t.amountAgorot)+'</strong></dd></div><div><dt>תאריך</dt><dd>'+escape(dateText(t.date))+'</dd></div>'+
   '<div class="facts__wide"><dt>קטגוריה ותיאור</dt><dd>'+escape(t.category)+(t.description?' · '+escape(t.description):'')+'</dd></div>':
  '<div><dt>סוג</dt><dd>'+typeChip('EXPENSE')+'</dd></div><div><dt>סכום</dt><dd><strong>'+money(r!.amountAgorot)+'</strong> · '+escape(FREQUENCY_LABELS[r!.frequency])+'</dd></div><div><dt>החל מ־</dt><dd>'+escape(dateText(r!.startDate))+'</dd></div>'+
   '<div><dt>חיובים שנרשמו</dt><dd>'+r!.occurrences+'</dd></div><div class="facts__wide"><dt>קטגוריה ותיאור</dt><dd>'+escape(r!.category)+(r!.description?' · '+escape(r!.description):'')+'</dd></div>';
 const title=t?'מחיקת תנועה':stop?'הפסקת חיוב קבוע':'מחיקת חיוב קבוע';
 const text=t?'התנועה תימחק ולא תיספר עוד בסיכומים.':stop?'החיוב הקבוע יופסק מהיום ולא יירשמו עוד חיובים. '+r!.occurrences+' החיובים שכבר נרשמו נשארים בתנועות ובסיכומים.':'עדיין לא נרשם אף חיוב, ולכן החיוב הקבוע יימחק.';
 return '<dialog id="delete-dialog" class="dialog" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-text" open data-autoshow>'+
  '<form method="post" action="'+escape('/admin/system/transactions/'+id+'/delete')+'" class="dialog__body"><input type="hidden" name="csrf" value="'+escape(csrf)+'"><input type="hidden" name="back" value="'+escape(back)+'"><input type="hidden" name="confirm" value="yes">'+
   '<h2 id="delete-dialog-title">'+title+'</h2><dl class="dialog__facts">'+facts+'</dl><p id="delete-dialog-text">'+escape(text)+'</p>'+
   '<p class="muted">הפעולה תישמר ביומן הפעולות ואינה ניתנת לביטול.</p>'+
   '<div class="dialog__actions"><button type="submit" formmethod="dialog" formnovalidate class="btn btn--quiet" autofocus data-dialog-cancel>ביטול</button><button type="submit" class="btn btn--danger" data-once>'+(stop?'הפסקה':'מחיקה')+'</button></div>'+
  '</form></dialog>';
}

export function financePage(data:{summary:any;list:any;ops:any[];csrf:string;params:ViewParams;dialog?:DialogState|null;notice?:string;error?:string}){
 const s=data.summary,p=data.params,back=backOf(p);
 const addLink=(kind:'INCOME'|'EXPENSE'|'RECURRING',label:string,primary=false)=>'<a class="btn '+(primary?'btn--primary':'btn--quiet')+' fin-add" href="'+escape(query('/admin/system',params(p,{add:kind})))+'" data-tx-add="'+kind+'" aria-haspopup="dialog">'+escape(label)+'</a>';
 const d=data.dialog;
 // The add dialog is always present (closed) so app.js can open it in place; an edit dialog replaces it when open.
 const createOpen=d&&d.mode==='create'?d:null;
 const dialogs=txDialog(createOpen??{mode:'create',kind:'EXPENSE',values:formValues('EXPENSE',s.today),errors:{}},data.csrf,back,'tx-new',!!createOpen)+
  (d&&d.mode==='edit'?txDialog(d,data.csrf,back,'tx-edit',true):'')+
  (d&&d.mode==='delete'?deleteDialog(d,data.csrf,back):'');
 const datalists=(['expense','income'] as const).map(k=>'<datalist id="fin-categories-'+k+'">'+CATEGORY_SUGGESTIONS[k==='income'?'INCOME':'EXPENSE'].map(c=>'<option value="'+escape(c)+'"></option>').join('')+'</datalist>').join('');
 return layout('כספים',
  '<div class="page-head fin-head"><div><h1>כספים</h1><p class="muted">הכנסות, הוצאות וחיובים קבועים · שקלים בלבד · נכון ל־'+escape(dateText(s.today))+' (שעון ישראל)</p></div>'+
   '<div class="fin-actions" role="group" aria-label="רישום תנועה">'+addLink('INCOME','+ הכנסה',true)+addLink('EXPENSE','+ הוצאה',true)+addLink('RECURRING','+ חיוב קבוע')+'</div></div>'+
  (data.notice&&NOTICES[data.notice]?notice('ok',NOTICES[data.notice]):'')+(data.error&&ERRORS[data.error]?notice('error',ERRORS[data.error]):'')+
  kpis(s.kpis,s.month)+
  '<div class="fin-grid">'+chart(s.chart,s.range,p)+recurringCard(s.recurring,p)+'</div>'+
  transactions(data.list,p)+opsCard(data.ops)+datalists+dialogs,
  {csrf:data.csrf,active:'finance'});
}
