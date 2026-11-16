const $=id=>document.getElementById(id);
let csrf,previewId,lastPreview,reviewIndex,generation=0,importing=false,selecting=false;
function checkAuth(r){if(r.status===401){location.replace('/login');throw Error('נדרשת התחברות מחדש');}return r;}
const session=fetch('/api/session').then(checkAuth).then(r=>{if(!r.ok)throw Error('לא ניתן להתחבר לכלי');return r.json();}).then(data=>csrf=data.csrf);
session.catch(error=>message(error.message,true));
const sourceNames={'barcodelookup':'Barcode Lookup','go-upc':'Go-UPC','open-products-facts':'Open Products Facts',
  'upcitemdb':'UPCitemdb','serpapi':'Google / SerpAPI','authorized-api':'API מורשה','manual':'תמונה חלופית'};
// Display only. The server recomputes every usage policy and enforces it before Shopify.
const policyLabels={APPROVED:'מקור תמונה מאושר',MANUAL_APPROVED:'השימוש בתמונה אושר ידנית',DISCOVERY_ONLY:'תמונה לבדיקה',UNKNOWN:'תמונה לבדיקה'};
const origin=image=>image.sourceDomain||sourceNames[image.source]||image.source;
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
  checkAuth(r);
  const data=await r.json();if(!r.ok)throw Error(data.error||'לא ניתן להשלים את הבקשה');return data;
}
function disableForm(value){for(const id of ['search','barcode','price','manual-image','manual-image-approved','product-upload','upload-approved'])$(id).disabled=value;}
const MAX_UPLOAD=10*1024*1024;
function formatBytes(n){return n>=1048576?(n/1048576).toFixed(1)+'MB':Math.max(1,Math.round(n/1024))+'KB';}
function variantInfo(v,transparentLabel){return v.width+'×'+v.height+' · '+v.format.toUpperCase()+' · '+formatBytes(v.bytes)+(transparentLabel&&v.transparent?' · רקע שקוף':'');}
// Each selected file needs its own permission confirmation.
$('product-upload').addEventListener('change',()=>{
  $('upload-approved').checked=false;$('upload-approval').hidden=!$('product-upload').files[0];
});
function clearPreview(){previewId=undefined;generation++;$('preview').hidden=true;$('result').hidden=true;}
$('lookup').addEventListener('input',clearPreview);
// A confirmation belongs to the exact URL it was given for.
$('manual-image').addEventListener('input',()=>{
  $('manual-image-approved').checked=false;$('manual-approval').hidden=!$('manual-image').value.trim();
});
$('image').addEventListener('error',()=>{$('image').hidden=true;$('missing').hidden=false;message('התמונה לא נטענה. אפשר לבחור תמונה אחרת או ליצור ללא תמונה',true);});
function closeReview(){reviewIndex=undefined;$('candidate-review').hidden=true;$('review-approved').checked=false;$('use-image').disabled=true;}
function openReview(index){
  const candidate=lastPreview?.candidates?.[index];if(!candidate)return;
  reviewIndex=index;
  $('review-warning').textContent=candidate.source==='serpapi'?'נמצאה תמונה בחיפוש, אך המקור אינו מאושר לשימוש אוטומטי.':
    'נמצאה תמונה, אך המקור אינו מאושר לשימוש אוטומטי.';
  $('review-origin').textContent='תמונה נמצאה דרך: '+origin(candidate)+' · ספק: '+(sourceNames[candidate.source]||candidate.source);
  $('review-source').hidden=!candidate.sourcePageUrl;$('review-source').removeAttribute('href');
  if(candidate.sourcePageUrl)$('review-source').href=candidate.sourcePageUrl;
  $('review-approved').checked=false;$('use-image').disabled=true;
  $('candidate-review').hidden=false;$('review-title').focus();
  message('יש לאשר הרשאת שימוש לפני שמוסיפים את התמונה למוצר');
}
function render(data){
  lastPreview=data;
  previewId=data.id;
  closeReview();
  const p=data.product,selected=data.selectedImage,upload=data.upload;
  const uploadUrl=upload&&upload.choice?upload[upload.choice]?.url:undefined;
  const displayUrl=p.imageUrl||uploadUrl;
  $('product-title').textContent=p.title;
  $('image').hidden=!displayUrl;$('missing').hidden=!!displayUrl;
  $('image').removeAttribute('src');
  if(displayUrl){$('image').alt=p.title;$('image').src=displayUrl;}
  renderUpload(data);
  details($('details'),[['יצרן',p.manufacturer],['ברקוד',p.barcode],['קטגוריה',p.category],['כמות יחידה',p.unitQuantity],
    ['מקור תמונה',sourceNames[p.imageSource]||p.imageSource],
    ['רמת התאמה',selected?.confidence?Math.round(selected.confidence*100)+'%':undefined],
    ['מחיר באתר',new Intl.NumberFormat('he-IL',{style:'currency',currency:data.currency}).format(Number(data.price))]]);
  $('image-status').hidden=!(displayUrl&&selected);
  $('image-status').textContent=displayUrl&&selected?policyLabels[selected.usagePolicy]||'':'';
  $('image-origin').hidden=!(p.imageUrl&&selected?.sourceDomain);
  $('image-origin').textContent=p.imageUrl&&selected?.sourceDomain?'תמונה נמצאה דרך: '+selected.sourceDomain:'';
  $('search-selection').hidden=!(p.imageSource==='serpapi' && data.manuallySelected);
  $('source-page').hidden=!selected?.sourcePageUrl;
  $('source-page').removeAttribute('href');
  if(selected?.sourcePageUrl)$('source-page').href=selected.sourcePageUrl;
  const list=$('candidate-list');list.replaceChildren();
  const candidates=data.candidates||[];
  $('candidate-area').hidden=candidates.length===0;
  for(const [index,candidate] of candidates.entries()){
    const card=document.createElement('label');card.className='candidate';
    const radio=document.createElement('input');radio.type='radio';radio.name='candidate';radio.value=String(index);
    radio.checked=p.imageUrl===candidate.imageUrl;radio.disabled=selecting||importing;
    radio.setAttribute('aria-label','בחר תמונה מאת '+origin(candidate));
    const image=document.createElement('img');image.src=candidate.thumbnailUrl||candidate.imageUrl;image.alt='תמונת מוצר אפשרית';
    image.width=120;image.height=120;image.loading='lazy';image.referrerPolicy='no-referrer';
    image.addEventListener('load',()=>{
      if(image.naturalWidth<64||image.naturalHeight<64){radio.disabled=true;card.classList.add('unavailable');}
    });
    image.addEventListener('error',()=>{radio.disabled=true;card.classList.add('unavailable');});
    const badge=document.createElement('span');badge.className='badge'+(candidate.autoAttachAllowed?' approved':'');
    badge.textContent=candidate.autoAttachAllowed?policyLabels.APPROVED:policyLabels.DISCOVERY_ONLY;
    const name=document.createElement('span');name.textContent='תמונה נמצאה דרך: '+origin(candidate);
    const provider=document.createElement('span');provider.textContent='ספק: '+(sourceNames[candidate.source]||candidate.source);
    const title=document.createElement('span');title.className='candidate-title';title.textContent=candidate.title||'';
    card.append(image,badge);if(candidate.title)card.append(title);card.append(name,provider,radio);
    if(candidate.sourcePageUrl){
      const link=document.createElement('a');link.href=candidate.sourcePageUrl;link.textContent='דף המקור';link.target='_blank';link.rel='noopener noreferrer';card.append(link);
    }
    radio.addEventListener('change',()=>candidate.autoAttachAllowed?selectImage(index):openReview(index));
    list.append(card);
  }
  $('without-image').disabled=selecting||importing||!displayUrl;
  $('preview').hidden=false;$('confirm').disabled=selecting||importing;
  message(data.imageWarning||'בדקו את הפרטים ואשרו יצירה');
}
function renderUpload(data){
  const upload=data.upload;
  $('upload-area').hidden=!upload&&!data.uploadPending;
  document.querySelector('.upload-compare').hidden=!upload;$('use-original').hidden=!upload;
  if(!upload){
    $('use-processed').hidden=true;$('upload-status').hidden=true;
    $('upload-original').removeAttribute('src');$('upload-processed').removeAttribute('src');return;
  }
  $('upload-original').src=upload.original.url;$('upload-original-info').textContent=variantInfo(upload.original,false);
  $('upload-processed-figure').hidden=!upload.processed;$('use-processed').hidden=!upload.processed;
  if(upload.processed){$('upload-processed').src=upload.processed.url;$('upload-processed-info').textContent=variantInfo(upload.processed,true);}
  else $('upload-processed').removeAttribute('src');
  $('upload-status').hidden=!upload.warnings.length;$('upload-status').textContent=upload.warnings.join(' ');
  $('use-processed').setAttribute('aria-pressed',String(upload.choice==='processed'));
  $('use-original').setAttribute('aria-pressed',String(upload.choice==='original'));
}
async function sendUpload(file){
  await session;
  const r=await fetch('/api/image-upload',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream',
    'X-CSRF-Token':csrf,'X-Preview-Id':previewId,'X-Usage-Confirmed':'true'}});
  checkAuth(r);const data=await r.json();if(!r.ok)throw Error(data.error||'לא ניתן לעבד את התמונה');return data;
}
async function chooseUpload(choice){
  if(!previewId||importing||selecting)return;
  selecting=true;$('confirm').disabled=true;
  for(const b of document.querySelectorAll('.upload-actions button'))b.disabled=true;
  message(choice==='remove'?'מחפש תמונה במקורות…':'מעדכן את בחירת התמונה…');
  try{render(await post('/api/image-upload/choice',{previewId,choice,uploadId:lastPreview?.upload?.id}));}
  catch(error){if(lastPreview)render(lastPreview);message(error.message,true);}
  finally{selecting=false;$('confirm').disabled=false;for(const b of document.querySelectorAll('.upload-actions button'))b.disabled=false;}
}
$('use-processed').addEventListener('click',()=>chooseUpload('processed'));
$('use-original').addEventListener('click',()=>chooseUpload('original'));
$('upload-none').addEventListener('click',()=>chooseUpload('none'));
$('upload-remove').addEventListener('click',()=>chooseUpload('remove'));
// A different file starts a new search, so its permission must be confirmed again.
$('pick-other').addEventListener('click',()=>{
  $('product-upload').value='';$('upload-approved').checked=false;$('upload-approval').hidden=true;clearPreview();
  $('product-upload').focus();message('בחרו תמונה אחרת, אשרו הרשאת שימוש ולחצו על חיפוש מוצר');
});
async function selectImage(index,confirmUsage=false){
  if(!previewId||importing||selecting)return;
  selecting=true;disableForm(true);$('confirm').disabled=true;$('without-image').disabled=true;$('use-image').disabled=true;
  for(const input of $('candidate-list').querySelectorAll('input'))input.disabled=true;
  message('בודק את התמונה שנבחרה…');
  try{render(await post('/api/image-selection',{previewId,candidateIndex:index,confirmUsage}));}
  catch(error){if(lastPreview)render(lastPreview);message(error.message,true);}
  finally{
    selecting=false;disableForm(false);$('confirm').disabled=false;
    // Keep the selected radio aligned with the restored server preview.
    for(const input of $('candidate-list').querySelectorAll('.candidate:not(.unavailable) input'))input.disabled=false;
    $('without-image').disabled=false;
  }
}
$('review-approved').addEventListener('change',()=>{$('use-image').disabled=!$('review-approved').checked;});
$('use-image').addEventListener('click',()=>{
  if(reviewIndex===undefined||!$('review-approved').checked)return;
  selectImage(reviewIndex,true);
});
$('other-image').addEventListener('click',()=>{
  if(lastPreview)render(lastPreview);
  $('manual-image').focus();
  message('אפשר לבחור תמונה אחרת, להזין תמונה חלופית ולחפש שוב, או ליצור ללא תמונה');
});
$('without-image').addEventListener('click',()=>selectImage(null));
$('lookup').addEventListener('submit',async event=>{
  event.preventDefault();if(importing||selecting)return;
  const manualImageUrl=$('manual-image').value.trim(),manualImageApproved=$('manual-image-approved').checked;
  const file=$('product-upload').files[0];
  if(file&&file.type&&!['image/jpeg','image/png','image/webp'].includes(file.type)){message('יש לצרף תמונה בפורמט JPEG, PNG או WebP',true);return;}
  if(file&&file.size>MAX_UPLOAD){message('קובץ התמונה גדול מדי. הגודל המרבי הוא 10MB',true);return;}
  if(file&&!$('upload-approved').checked){
    $('upload-approval').hidden=false;$('upload-approved').focus();
    message('יש לאשר שיש הרשאה להשתמש בתמונה שצורפה, או להסיר אותה',true);return;
  }
  if(!file&&manualImageUrl&&!manualImageApproved){
    $('manual-approval').hidden=false;$('manual-image-approved').focus();
    message('יש לאשר שיש הרשאה להשתמש בתמונה החלופית, או להשאיר את השדה ריק',true);return;
  }
  clearPreview();const current=generation;$('search').disabled=true;message('מחפש מוצר ותמונות…');
  try{
    const data=await post('/api/preview',{barcode:$('barcode').value,price:$('price').value,
      manualImageUrl:file?'':manualImageUrl,manualImageApproved,uploadPending:!!file});
    if(current!==generation)return;render(data);
    if(file){
      selecting=true;$('confirm').disabled=true;message('מעבד את התמונה: הסרת רקע והתאמה לאתר…');
      try{const processed=await sendUpload(file);if(current===generation)render(processed);}
      catch(error){if(current===generation){message(error.message,true);$('upload-area').hidden=false;$('upload-title').focus();}}
      finally{selecting=false;$('confirm').disabled=false;}
    }
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
    // Usage confirmation applies to one product action only.
    $('manual-image-approved').checked=false;$('upload-approved').checked=false;$('product-upload').value='';$('upload-approval').hidden=true;
    $('result-title').textContent=data.duplicate?'המוצר כבר קיים בחנות':'המוצר נוצר בהצלחה';
    details($('result-details'),[['שם',data.product.title],['מזהה מוצר',data.product.id],['ברקוד',data.product.barcode]]);
    $('admin').href=data.product.adminUrl;
    message(data.duplicate?'הפרטים והמחיר של המוצר הקיים לא שונו':'הטיוטה זמינה בניהול Shopify. יש לבדוק גם את עיבוד התמונה לפני פרסום');
  }catch(error){message(error.message,true);}
  finally{importing=false;disableForm(false);}
});

$('logout').addEventListener('click',async()=>{try{await post('/logout',{});location.replace('/login');}catch(error){message(error.message,true);}});
