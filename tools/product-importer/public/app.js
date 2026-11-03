const $=id=>document.getElementById(id);
let csrf,previewId,lastPreview,generation=0,importing=false,selecting=false;
const session=fetch('/api/session').then(r=>{if(!r.ok)throw Error('לא ניתן להתחבר לכלי');return r.json();}).then(data=>csrf=data.csrf);
session.catch(error=>message(error.message,true));
const sourceNames={'barcodelookup':'Barcode Lookup','go-upc':'Go-UPC','open-products-facts':'Open Products Facts',
  'upcitemdb':'UPCitemdb','serpapi':'Google / SerpAPI','authorized-api':'API מורשה','manual':'תמונה חלופית'};
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function details(element,values){
  element.replaceChildren();
  for(const [label,value] of values){
    if(!value)continue;
    const dt=document.createElement('dt'),dd=document.createElement('dd');
    dt.textContent=label;dd.textContent=value;element.append(dt,dd);
  }
}
async function post(path,body){
  await session;
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});
  const data=await r.json();if(!r.ok)throw Error(data.error||'לא ניתן להשלים את הבקשה');return data;
}
function disableForm(value){for(const id of ['search','barcode','price','manual-image'])$(id).disabled=value;}
function clearPreview(){previewId=undefined;generation++;$('preview').hidden=true;$('result').hidden=true;}
$('lookup').addEventListener('input',clearPreview);
$('image').addEventListener('error',()=>{$('image').hidden=true;$('missing').hidden=false;message('התמונה לא נטענה. אפשר לבחור תמונה אחרת או ליצור ללא תמונה',true);});
function render(data){
  lastPreview=data;
  previewId=data.id;
  const p=data.product;
  $('product-title').textContent=p.title;
  $('image').hidden=!p.imageUrl;$('missing').hidden=!!p.imageUrl;
  $('image').removeAttribute('src');
  if(p.imageUrl){$('image').alt=p.title;$('image').src=p.imageUrl;}
  details($('details'),[['יצרן',p.manufacturer],['ברקוד',p.barcode],['קטגוריה',p.category],['כמות יחידה',p.unitQuantity],
    ['מקור תמונה',sourceNames[p.imageSource]||p.imageSource],
    ['רמת התאמה',data.selectedImage?.confidence?Math.round(data.selectedImage.confidence*100)+'%':undefined],
    ['מחיר באתר',new Intl.NumberFormat('he-IL',{style:'currency',currency:data.currency}).format(Number(data.price))]]);
  $('search-selection').hidden=!(p.imageSource==='serpapi' && data.manuallySelected);
  $('source-page').hidden=!data.selectedImage?.sourcePageUrl;
  $('source-page').removeAttribute('href');
  if(data.selectedImage?.sourcePageUrl)$('source-page').href=data.selectedImage.sourcePageUrl;
  const list=$('candidate-list');list.replaceChildren();
  const candidates=data.candidates||[];
  $('candidate-area').hidden=candidates.length===0;
  for(const [index,candidate] of candidates.entries()){
    const card=document.createElement('label');card.className='candidate';
    const radio=document.createElement('input');radio.type='radio';radio.name='candidate';radio.value=String(index);
    radio.checked=p.imageUrl===candidate.imageUrl;radio.disabled=selecting||importing;
    radio.setAttribute('aria-label','בחר תמונה מאת '+(candidate.sourceDomain||sourceNames[candidate.source]||candidate.source));
    const image=document.createElement('img');image.src=candidate.thumbnailUrl||candidate.imageUrl;image.alt='תמונת מוצר אפשרית';
    image.width=120;image.height=120;image.loading='lazy';image.referrerPolicy='no-referrer';
    image.addEventListener('load',()=>{
      if(image.naturalWidth<64||image.naturalHeight<64){radio.disabled=true;card.classList.add('unavailable');}
    });
    image.addEventListener('error',()=>{radio.disabled=true;card.classList.add('unavailable');});
    const name=document.createElement('span');name.textContent='מקור: '+(candidate.sourceDomain||sourceNames[candidate.source]||candidate.source);
    const title=document.createElement('span');title.className='candidate-title';title.textContent=candidate.title||'';
    card.append(image);if(candidate.title)card.append(title);card.append(name,radio);
    if(candidate.sourcePageUrl){
      const link=document.createElement('a');link.href=candidate.sourcePageUrl;link.textContent='דף המקור';link.target='_blank';link.rel='noopener noreferrer';card.append(link);
    }
    radio.addEventListener('change',()=>selectImage(index));
    list.append(card);
  }
  $('without-image').disabled=selecting||importing||!p.imageUrl;
  $('preview').hidden=false;$('confirm').disabled=selecting||importing;
  message(data.imageWarning||'בדקו את הפרטים ואשרו יצירה');
}
async function selectImage(index){
  if(!previewId||importing||selecting)return;
  selecting=true;disableForm(true);$('confirm').disabled=true;$('without-image').disabled=true;
  for(const input of $('candidate-list').querySelectorAll('input'))input.disabled=true;
  message('בודק את התמונה שנבחרה…');
  try{render(await post('/api/image-selection',{previewId,candidateIndex:index}));}
  catch(error){if(lastPreview)render(lastPreview);message(error.message,true);}
  finally{
    selecting=false;disableForm(false);$('confirm').disabled=false;
    // Keep the selected radio aligned with the restored server preview.
    for(const input of $('candidate-list').querySelectorAll('.candidate:not(.unavailable) input'))input.disabled=false;
    $('without-image').disabled=false;
  }
}
$('without-image').addEventListener('click',()=>selectImage(null));
$('lookup').addEventListener('submit',async event=>{
  event.preventDefault();if(importing||selecting)return;
  clearPreview();const current=generation;$('search').disabled=true;message('מחפש מוצר ותמונות…');
  try{
    const data=await post('/api/preview',{barcode:$('barcode').value,price:$('price').value,manualImageUrl:$('manual-image').value});
    if(current!==generation)return;render(data);
  }catch(error){if(current===generation)message(error.message,true);}
  finally{$('search').disabled=false;}
});
$('confirm').addEventListener('click',async()=>{
  if(!previewId||importing||selecting)return;
  importing=true;disableForm(true);$('confirm').disabled=true;$('without-image').disabled=true;
  for(const input of $('candidate-list').querySelectorAll('input'))input.disabled=true;
  message('בודק כפילויות ויוצר טיוטה…');
  try{
    const data=await post('/api/import',{previewId});
    $('preview').hidden=true;$('result').hidden=false;
    $('result-title').textContent=data.duplicate?'המוצר כבר קיים בחנות':'המוצר נוצר בהצלחה';
    details($('result-details'),[['שם',data.product.title],['מזהה מוצר',data.product.id],['ברקוד',data.product.barcode]]);
    $('admin').href=data.product.adminUrl;
    message(data.duplicate?'הפרטים והמחיר של המוצר הקיים לא שונו':'הטיוטה זמינה בניהול Shopify. יש לבדוק גם את עיבוד התמונה לפני פרסום');
  }catch(error){message(error.message,true);}
  finally{importing=false;disableForm(false);}
});
