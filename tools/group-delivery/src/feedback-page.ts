// "משוב לקוחות" admin page (/admin/feedback): server-rendered, Hebrew RTL, the shared admin layout; every value is
// escaped. Read-only: responses are never edited from here.
import {escape,layout,pager,time} from './admin.js';
import {RATING_LABELS,type FeedbackFilters,type FeedbackRow,type FeedbackSummary,type MissingProduct} from './feedback.js';
import type {Page} from './admin-data.js';

const YES_NO:Record<string,string>={'':'הכול',yes:'כן',no:'לא'};
const number=(value:number)=>new Intl.NumberFormat('he-IL',{maximumFractionDigits:1}).format(value);
const ratingText=(rating:number)=>rating+' — '+(RATING_LABELS[rating]||'');
const text=(value:string|null)=>value?'<p class="fb-text">'+escape(value)+'</p>':'';

export function feedbackPage(data:{filters:FeedbackFilters;summary:FeedbackSummary;responses:FeedbackRow[];pagination:Page;missingProducts:MissingProduct[];
 warnings:string[];shopHandle:string;csrf:string}){
 const f=data.filters,s=data.summary,base='/admin/feedback';
 const params={rating:f.rating,missing:f.missing,problem:f.problem,from:f.from,to:f.to};
 const filtered=Boolean(f.rating||f.missing||f.problem||f.from||f.to);
 const card=(label:string,value:string,hint:string,key:string)=>'<li class="metric" data-feedback-metric="'+key+'"><span class="metric__label">'+escape(label)+'</span><strong class="metric__value">'+escape(value)+'</strong><span class="metric__hint">'+escape(hint)+'</span></li>';
 const percentText=(value:number|null)=>value===null?'—':number(value)+'%';
 const cards='<ul class="metrics" aria-label="סיכום המשוב'+(filtered?' לפי הסינון':'')+'">'+
  card('תשובות',number(s.responses),filtered?'לפי הסינון שנבחר':'מאז שהשאלון הופעל','responses')+
  card('ציון ממוצע להזמנה',s.averageRating===null?'—':number(s.averageRating)+' מתוך 5','1 — לא נוח בכלל · 5 — מצוין','average')+
  card('לא מצאו מוצר שחיפשו',percentText(s.missingPercent),'מתוך התשובות','missing')+
  card('נתקלו בבעיה באתר',percentText(s.problemPercent),'מתוך התשובות','problem')+'</ul>';
 const distribution=s.responses?'<section class="card" aria-labelledby="fb-dist-title"><h2 id="fb-dist-title">התפלגות הציונים</h2><ul class="fb-dist">'+
  [5,4,3,2,1].map(r=>{const count=s.ratingCounts[r as 1|2|3|4|5];const pct=Math.round(count/s.responses*100);
   return '<li><span class="fb-dist__label">'+escape(ratingText(r))+'</span><span class="meter__track fb-dist__bar" aria-hidden="true"><span class="p'+pct+'"></span></span><span class="fb-dist__count">'+count+' ('+pct+'%)</span></li>';}).join('')+'</ul></section>':'';
 const select=(name:string,label:string,options:Record<string,string>,value:string)=>'<div class="fb-field"><label for="fb-'+name+'">'+escape(label)+'</label><select id="fb-'+name+'" name="'+name+'">'+
  Object.entries(options).map(([v,l])=>'<option value="'+escape(v)+'"'+(v===value?' selected':'')+'>'+escape(l)+'</option>').join('')+'</select></div>';
 const ratingOptions:Record<string,string>={'':'הכול'};for(const r of [5,4,3,2,1])ratingOptions[String(r)]=ratingText(r);
 const filters='<form method="get" action="'+base+'" class="fb-filters" aria-label="סינון תשובות">'+
  select('rating','ציון',ratingOptions,f.rating)+select('missing','לא מצאו מוצר',YES_NO,f.missing)+select('problem','נתקלו בבעיה',YES_NO,f.problem)+
  '<div class="fb-field"><label for="fb-from">מתאריך</label><input id="fb-from" name="from" type="date" value="'+escape(f.from)+'"></div>'+
  '<div class="fb-field"><label for="fb-to">עד תאריך</label><input id="fb-to" name="to" type="date" value="'+escape(f.to)+'"></div>'+
  '<div class="fb-actions"><button class="btn">סינון</button>'+(filtered?'<a class="btn btn--quiet" href="'+base+'">ניקוי הסינון</a>':'')+'</div></form>';
 const orderCell=(r:FeedbackRow)=>{
  const label=r.confirmationNumber?'<code dir="ltr">'+escape(r.confirmationNumber)+'</code>':'<span class="muted">ללא מספר אישור</span>';
  const link=data.shopHandle?' <a href="'+escape('https://admin.shopify.com/store/'+data.shopHandle+'/orders/'+r.orderId)+'" target="_blank" rel="noopener noreferrer">בשופיפיי<span class="sr-only"> (הזמנה '+escape(r.confirmationNumber||r.orderId)+', נפתח בחלון חדש)</span></a>':'';
  return label+link;
 };
 const yesNo=(value:boolean,details:string|null)=>value?'<strong>כן</strong>'+text(details):'<span class="muted">לא</span>';
 const rows=data.responses.map(r=>'<tr><td data-label="התקבל">'+time(r.createdAt)+'</td><td data-label="הזמנה">'+orderCell(r)+'</td>'+
  '<td data-label="ציון"><span class="fb-score fb-score--'+r.rating+'">'+escape(ratingText(r.rating))+'</span></td>'+
  '<td data-label="מוצרים שלא נמצאו">'+yesNo(r.missingProducts,r.missingProductsDetails)+'</td>'+
  '<td data-label="בעיה באתר">'+yesNo(r.encounteredProblem,r.problemDetails)+'</td>'+
  '<td data-label="הצעה לשיפור">'+(r.improvementFeedback?text(r.improvementFeedback):'<span class="muted">—</span>')+'</td></tr>').join('');
 const table=data.responses.length?
  '<div class="table-wrap"><table class="table fb-table"><caption class="sr-only">תשובות אחרונות, מהחדשה לישנה</caption><thead><tr><th scope="col">התקבל</th><th scope="col">הזמנה</th><th scope="col">ציון</th><th scope="col">מוצרים שלא נמצאו</th><th scope="col">בעיה באתר</th><th scope="col">הצעה לשיפור</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+
  pager(base,params,data.pagination,'תשובות'):
  '<div class="empty"><strong>'+(filtered?'אין תשובות שמתאימות לסינון.':'עדיין לא התקבלו תשובות לשאלון.')+'</strong></div>';
 const missing=data.missingProducts.length?
  '<ol class="fb-terms">'+data.missingProducts.map(m=>'<li><span class="fb-terms__text">'+escape(m.text)+'</span> <span class="tag">'+(m.count===1?'פעם אחת':m.count+' פעמים')+'</span> <span class="muted">אחרון: '+time(m.lastAt)+'</span></li>').join('')+'</ol>'+
  '<p class="muted">הרשימה מקבצת אזכורים זהים (בלי הבדלי רווחים, סימני פיסוק ואותיות גדולות). אזכורים שונים של אותו מוצר מופיעים בנפרד.</p>':
  '<div class="empty"><strong>'+(filtered?'אין אזכורים של מוצרים חסרים בתשובות שמתאימות לסינון.':'עדיין לא נכתבו מוצרים שלקוחות חיפשו ולא מצאו.')+'</strong></div>';
 const warnings=data.warnings.length?'<div class="notice notice--info" role="status" data-feedback-warnings><strong>הגדרות המשוב:</strong><ul>'+data.warnings.map(w=>'<li>'+escape(w)+'</li>').join('')+'</ul></div>':'';
 return layout('משוב לקוחות',
  '<div class="page-head"><div><h1 id="feedback-title">משוב לקוחות</h1><p class="muted">תשובות לשאלון הקצר בעמוד התודה שאחרי הקנייה. השאלון אופציונלי; נשמרים רק מזהה ההזמנה והתשובות, בלי שם, דוא״ל או טלפון. ייתכן שלקוחות כתבו פרטים אישיים בטקסט החופשי.</p></div></div>'+
  warnings+filters+cards+distribution+
  '<section class="card" aria-labelledby="fb-missing-title"><h2 id="fb-missing-title">מוצרים שלקוחות חיפשו ולא מצאו</h2>'+missing+'</section>'+
  '<section class="card" aria-labelledby="fb-recent-title"><h2 id="fb-recent-title">תשובות אחרונות</h2>'+table+'</section>',
  {csrf:data.csrf,active:'feedback'});
}
