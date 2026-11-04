import type {ShoppingQuote,Money,MatchedProduct} from '../../domain/types.js';
export const clean=(text:string)=>text.replace(/gid:\/\/shopify\/\S+/gi,'[מוצר]').replace(/[\u0000-\u0008\u000b-\u001f]/g,'');
export const intro="היי 👋 אני עוזר הקניות של פאנקי.\nשלחו לי את רשימת הקניות שלכם, כל מוצר בשורה נפרדת.\n\nלדוגמה:\n2 חומר רצפה מלון בוטיק\nאקונומיקה סנו\n3 ג'ל כביסה מקסימה בייבי";
export function money(value:Money|null):string {
 if(!value)return '—';
 return new Intl.NumberFormat('he-IL',{style:'currency',currency:value.currencyCode}).format(Number(value.amount));
}
export function productLabel(p:MatchedProduct){
 return clean(p.title+(p.variantTitle&&p.variantTitle!=='Default Title'?' — '+p.variantTitle:''));
}
export function renderQuote(quote:ShoppingQuote):string {
 const lines=['🛒 רשימת הקניות שלך'];
 for(const item of quote.items){
  if(item.status==='matched'&&item.bestMatch){
   const p=item.bestMatch;lines.push('✅ '+productLabel(p),'כמות: '+p.quantity,money(p.unitPrice)+' ליחידה','סה"כ: '+money(p.lineTotal));
  }else if(item.status==='unavailable')lines.push('⚠️ '+clean(item.requested.originalText),'מצאתי את המוצרים המתאימים, אבל הם כרגע לא זמינים במלאי.');
  else if(item.status==='not_found')lines.push('❓ לא הצלחתי למצוא: '+clean(item.requested.originalText),'אפשר לשלוח רשימה מעודכנת או להסיר את הפריט.');
  else lines.push('❓ '+clean(item.requested.originalText)+' — נדרשת בחירה.');
  lines.push('');
 }
 lines.push('────────────','סה"כ מוצרים: '+money(quote.subtotal),'משלוח, הנחות והסכום הסופי יחושבו ב-Shopify.');
 if(!quote.canCheckout)lines.push('יש לטפל בפריטים המסומנים. הסכום כולל רק פריטים שנפתרו.');
 return lines.join('\n');
}
