// Transaction cancellation request ("ביטול עסקה"): sections/cancellation-request.liquid, templates/page.cancellation.json
// and the footer link. 1. Contracts run everywhere. 2. Liquid rendering and 3. browser behaviour render the real section
// and footer with liquidjs (skipped when liquidjs is not resolvable through NODE_PATH) against a local server that plays
// Shopify's native contact endpoint (POST /contact, then redirect with contact_posted=true).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const section=read('sections/cancellation-request.liquid'),footer=read('sections/footer.liquid');
const he=json('locales/he.default.json'),en=json('locales/en.json');
const script=section.match(/<script>([\s\S]*?)<\/script>/)[1];
const markup=section.replace(/<script>[\s\S]*?<\/script>/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'').replace(/{% schema %}[\s\S]*?{% endschema %}/,'');
const ID='012345678',ID_FIELD='contact[מספר תעודת זהות]';

test('Contract: native Shopify contact form, field rules, isolation and no client-side persistence',()=>{
 const template=json('templates/page.cancellation.json');
 assert.deepEqual(template,{sections:{main:{type:'cancellation-request',settings:{}}},order:['main']});
 assert.match(markup,/{% form 'contact', id: cancellation_form_id, class: 'cancellation-request__form storefront-validated-form' %}/);
 assert.equal((section.match(/{% form /g)||[]).length,1);
 assert.match(markup,/<input type="hidden" name="contact\[סוג פנייה\]" value="בקשת ביטול עסקה">/);
 const field=name=>markup.match(new RegExp('<(?:input|textarea)[^>]*name="'+name.replace(/[[\]]/g,'\\$&')+'"[^>]*>'))?.[0];
 for(const name of ['contact[name]',ID_FIELD,'contact[email]'])assert.match(field(name),/\srequired\b/,name+' required');
 for(const name of ['contact[מספר הזמנה]','contact[phone]','contact[body]'])assert.doesNotMatch(field(name),/\srequired\b/,name+' optional');
 const id=field(ID_FIELD);
 for(const attribute of ['type="text"','inputmode="numeric"','autocomplete="off"','maxlength="9"','pattern="[0-9]{1,9}"'])assert.ok(id.includes(attribute),attribute);
 assert.match(field('contact[email]'),/type="email"/);assert.match(field('contact[phone]'),/type="tel"/);assert.match(field('contact[מספר הזמנה]'),/placeholder="#1058"/);
 // Nothing submitted is ever rendered back: no value attributes except the fixed request type, no form.* echo.
 assert.deepEqual([...markup.matchAll(/\svalue="([^"]*)"/g)].map(m=>m[1]),['בקשת ביטול עסקה']);
 assert.doesNotMatch(markup,/form\.(email|body|name|phone)|customer\./);
 assert.doesNotMatch(markup,/accepts_marketing|contact\[tags\]|newsletter/,'no marketing consent or subscription');
 // Each label points at its control.
 for(const m of markup.matchAll(/<label for="{{ cancellation_field }}-(\w+)">/g))assert.match(markup,new RegExp('id="{{ cancellation_field }}-'+m[1]+'"'));
 // Script: scoped to this form, no storage, cookies, logging, extra requests or analytics.
 assert.match(script,/document\.getElementById\({{ cancellation_form_id \| json }}\)/);
 assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|fetch\(|XMLHttpRequest|sendBeacon|gtag|dataLayer|fbq|analytics|\.submit\(\)/);
 // CSS stays inside the component: every selector starts with the cancellation namespace.
 const css=section.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1].replace(/@media[^{]+{([\s\S]*?})\s*}/g,'$1');
 for(const rule of css.matchAll(/([^{}]+){[^{}]*}/g))for(const selector of rule[1].split(/,(?![^(]*\))/))assert.match(selector.trim(),/^\.cancellation-request/,selector);
 // The existing contact page form is untouched.
 const contact=read('sections/contact-form.liquid');
 assert.match(contact,/{% form 'contact', id: contact_id, class: 'storefront-validated-form' %}/);assert.match(contact,/name="contact\[body\]" required/);
 assert.doesNotMatch(contact,/cancellation/);
 // Footer: page picker setting and link through the existing policy lists, bottom bar fallback.
 const schema=JSON.parse(footer.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
 assert.deepEqual(schema.settings.find(s=>s.id==='cancellation_page'),{type:'page',id:'cancellation_page',label:'t:cancellation_editor.page',info:'t:cancellation_editor.page_info'});
 assert.equal((footer.match(/<li><a href="{{ cancellation_page\.url }}"/g)||[]).length,2);
 assert.doesNotMatch(footer+section,/\/pages\/|page\.id|pages\[/,'no hard-coded page');
 assert.equal(he.cancellation_request.link,'ביטול עסקה');
 assert.deepEqual(Object.keys(en.cancellation_request).sort(),Object.keys(he.cancellation_request).sort());
 const tr=he.cancellation_request;
 assert.deepEqual([tr.heading,tr.intro,tr.support,tr.note,tr.submit,tr.success_heading,tr.success_text],['בקשה לביטול עסקה','ניתן לשלוח באמצעות טופס זה בקשה לביטול עסקה שבוצעה באתר פאנקי.','לאחר קבלת הבקשה נבדוק את פרטי העסקה ונטפל בה בהתאם למדיניות ההחזרים ולהוראות הדין.','שליחת הטופס מהווה בקשה לביטול ואינה אישור אוטומטי לכך שהעסקה ניתנת לביטול. לאחר בדיקת הבקשה נעדכן אתכם בהתאם.','שליחת בקשת ביטול','הבקשה נשלחה בהצלחה','קיבלנו את בקשת הביטול ונבדוק את פרטי העסקה. ניצור עמכם קשר במידת הצורך.']);
 assert.deepEqual([tr.name,tr.id_number,tr.order,tr.order_hint,tr.email,tr.phone,tr.reason,tr.reason_hint],['שם מלא','מספר תעודת זהות','מספר הזמנה','אם מספר ההזמנה זמין לכם, הוא יעזור לנו לאתר את העסקה במהירות.','דוא״ל','טלפון','סיבת הביטול','ניתן לציין פרטים נוספים שיסייעו לנו לטפל בבקשה. אין חובה לציין סיבה לביטול.']);
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
const escapeHTML=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function engine(){
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid'});
 const ignore=end=>({parse(token,remain){const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',()=>{}).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(){}});
 for(const [tag,end] of [['doc','enddoc'],['stylesheet','endstylesheet'],['schema','endschema']])liquid.registerTag(tag,ignore(end));
 // Shopify's {% form 'contact' %} output: POST /contact with form_type and utf8 hidden inputs.
 liquid.registerTag('form',{parse(token,remain){this.type=token.args.match(/^'(\w+)'/)[1];this.id=(token.args.match(/id: (\w+)/)||[])[1];this.className=(token.args.match(/class: '([^']+)'/)||[])[1]||'';this.tpls=[];const stream=this.liquid.parser.parseStream(remain);stream.on('tag:endform',()=>stream.stop()).on('template',tpl=>this.tpls.push(tpl)).on('end',()=>{throw Error('endform missing');});stream.start();},
  *render(ctx,emitter){const id=this.id?yield this.liquid.evalValue(this.id,ctx):'';emitter.write(`<form method="post" action="/${this.type}#${id}" id="${id}" accept-charset="UTF-8" class="${this.className}"><input type="hidden" name="form_type" value="${this.type}"><input type="hidden" name="utf8" value="✓">`);yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');}});
 liquid.registerFilter('t',key=>{const value=key.split('.').reduce((a,k)=>a?.[k],he);assert.equal(typeof value,'string',key);return value;});
 liquid.registerFilter('default_errors',errors=>'<ul><li>'+(errors||[]).map(e=>e==='email'?'כתובת הדוא״ל אינה תקינה':e).join('</li><li>')+'</li></ul>');
 liquid.registerFilter('payment_type_svg_tag',()=>'');
 return liquid;
}
async function renderSection(liquid,{success=false,errors=null}={}){
 return liquid.parseAndRender(section.replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''),{section:{id:'main'},form:{'posted_successfully?':success,errors}});
}
async function renderFooter(liquid,{page={url:'/pages/cancel',title:'ביטול עסקה'},showPolicies=true,design=false,path='/'}={}){
 return liquid.parseAndRender(footer.replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''),{
  section:{id:'footer',settings:{show_store_name:false,show_copyright:true,show_policies:showPolicies,show_footer_links:false,show_newsletter:false,show_payment_icons:false,cancellation_page:page,accessibility_statement_page:{url:'/pages/accessibility'}}},
  shop:{name:'פאנקי',policies:[{title:'מדיניות החזרים',url:'/policies/refund-policy',body:'x'},{title:'תנאי שימוש',url:'/policies/terms-of-service',body:'x'}],enabled_payment_types:[]},
  settings:{group_delivery_footer:false,google_review_enabled:false},request:{design_mode:design,path},routes:{root_url:'/'}});
}

test('Liquid rendering: form states and the footer link',{skip:SKIP},async()=>{
 const liquid=engine();
 const html=await renderSection(liquid);
 assert.match(html,/<form method="post" action="\/contact#CancellationForm-main" id="CancellationForm-main" accept-charset="UTF-8" class="cancellation-request__form storefront-validated-form"><input type="hidden" name="form_type" value="contact">/);
 assert.match(html,/<h1 id="Cancellation-main-heading">בקשה לביטול עסקה<\/h1>/);
 assert.doesNotMatch(html.replace(/<script>[\s\S]*<\/script>/,''),/role="alert"|data-cancellation-success/);
 const success=await renderSection(liquid,{success:true});
 assert.match(success,/role="status" tabindex="-1" data-cancellation-success>\s*<h2>הבקשה נשלחה בהצלחה<\/h2>\s*<p>קיבלנו את בקשת הביטול/);
 assert.doesNotMatch(success.replace(/<script>[\s\S]*<\/script>/,''),/<input(?! type="hidden" name="(form_type|utf8)")|<textarea|תעודת זהות/,'success state shows no fields');
 const errors=await renderSection(liquid,{errors:['email']});
 assert.match(errors,/class="storefront-form-errors cancellation-request__errors" id="Cancellation-main-errors" role="alert" tabindex="-1" data-cancellation-errors>\s*<p>לא הצלחנו לשלוח את הבקשה/);
 assert.match(errors,/name="contact\[email\]"[^>]*aria-invalid="true"/);
 // Footer: in the policy list of the current live configuration (show_policies, menus hidden).
 const live=await renderFooter(liquid);
 assert.match(live,/<nav class="storefront-footer-policies" aria-label="[^"]*"><h3>[^<]*<\/h3><ul><li><a href="\/policies\/refund-policy">מדיניות החזרים<\/a><\/li><li><a href="\/policies\/terms-of-service">תנאי שימוש<\/a><\/li><li><a href="\/pages\/cancel">ביטול עסקה<\/a><\/li><\/ul><\/nav>/);
 assert.equal((live.match(/>ביטול עסקה</g)||[]).length,1);
 assert.match(await renderFooter(liquid,{path:'/pages/cancel'}),/<a href="\/pages\/cancel" aria-current="page">ביטול עסקה<\/a>/);
 const bottom=await renderFooter(liquid,{showPolicies:false});
 assert.match(bottom,/<a class="storefront-footer-statement" href="\/pages\/cancel">ביטול עסקה<\/a>/);assert.equal((bottom.match(/>ביטול עסקה</g)||[]).length,1);
 assert.doesNotMatch(await renderFooter(liquid,{page:null}),/ביטול עסקה/,'nothing is linked until a page is selected');
 assert.match(await renderFooter(liquid,{page:null,design:true}),/יש לבחור עמוד ביטול עסקה בהגדרות התחתית\./);
});

test('Browser: validation, single native submission, success without personal data, privacy, layout and keyboard',{skip:SKIP,timeout:150000},async t=>{
 const liquid=engine();
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['theme.css','storefront.css'].map(file=>read('assets/'+file)).join('')+block('snippets/storefront-design.liquid')+block('sections/footer.liquid')+block('sections/cancellation-request.liquid');
 const posts=[];let delay=0;
 const page=async state=>'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}'+css+'</style><script>window.themeStrings={required:'+JSON.stringify(he.storefront.required)+',invalidEmail:'+JSON.stringify(he.storefront.invalid_email)+',quantityError:"",backToTop:""};</script><script src="/storefront.js" defer></script></head><body><main id="MainContent">'+await renderSection(liquid,state)+'</main>'+await renderFooter(liquid,{path:'/'})+'</body></html>';
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const url=new URL(req.url,'http://x');
  if(url.pathname==='/storefront.js'){res.setHeader('Content-Type','text/javascript');return res.end(read('assets/storefront.js'));}
  if(url.pathname==='/contact'&&req.method==='POST'){posts.push(Object.fromEntries(new URLSearchParams(body)));await sleep(delay);res.writeHead(302,{Location:'/?contact_posted=true#CancellationForm-main'});return res.end();}
  if(url.pathname==='/away'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end('<p id="away">away</p>');}
  res.setHeader('Content-Type','text/html;charset=utf-8');
  res.end(await page({success:url.searchParams.get('contact_posted')==='true',errors:url.searchParams.has('errors')?['email']:null}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-cancellation-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),errors=[],urls=[],requests=[],consoleText=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);return;}
   if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||''));
   if(m.method==='Page.frameNavigated')urls.push(m.params.frame.url);
   if(m.method==='Network.requestWillBeSent')requests.push({url:m.params.request.url,post:m.params.request.postData||''});
   if(m.method==='Runtime.consoleAPICalled')consoleText.push(JSON.stringify(m.params.args));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression).catch(()=>false))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const load=async url=>{await call('Page.navigate',{url});await wait('document.readyState==="complete"');};
  const key=async(keyName,code,vk,shift=false)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:keyName,code,windowsVirtualKeyCode:vk,modifiers:shift?8:0,...(type==='keyDown'&&keyName==='Enter'?{text:'\r'}:{})});};
  const type=async text=>{for(const ch of text)await call('Input.insertText',{text:ch});};
  const click=async selector=>{const {x,y}=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);for(const kind of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type:kind,x,y,button:'left',clickCount:1});};
  const field=name=>`document.querySelector('[name="${name}"]')`;
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await load(origin+'/');

  await t.test('Hebrew RTL page with labelled fields and the footer link',async()=>{
   assert.equal(await ev('getComputedStyle(document.querySelector(".cancellation-request")).direction'),'rtl');
   assert.equal(await ev('document.querySelector("h1").textContent'),'בקשה לביטול עסקה');
   assert.deepEqual(await ev(`[...document.querySelectorAll('#CancellationForm-main :is(input:not([type=hidden]),textarea)')].map(e=>[e.name,e.labels[0].textContent.replace(/\\s+/g,' ').trim(),e.required])`),[
    ['contact[name]','שם מלא *',true],[ID_FIELD,'מספר תעודת זהות *',true],['contact[מספר הזמנה]','מספר הזמנה (לא חובה)',false],['contact[email]','דוא״ל *',true],['contact[phone]','טלפון (לא חובה)',false],['contact[body]','סיבת הביטול (לא חובה)',false]]);
   assert.equal(await ev(`document.querySelector('.storefront-footer a[href="/pages/cancel"]').textContent`),'ביטול עסקה');
  });
  await t.test('Required name, ID and email: no submission, Hebrew inline errors, aria-invalid, focus on the first field',async()=>{
   await click('.cancellation-request__submit');await sleep(150);
   assert.equal(posts.length,0);
   assert.equal(await ev('document.activeElement.name'),'contact[name]');
   const state=await ev(`[...document.querySelectorAll('#CancellationForm-main :is(input:not([type=hidden]),textarea)')].map(e=>[e.name,e.getAttribute('aria-invalid')])`);
   // Native validation reports the first invalid control; the other required fields are flagged when they are checked.
   assert.deepEqual(state[0],['contact[name]','true']);
   for(const [name,invalid] of state.slice(1))if(['contact[מספר הזמנה]','contact[phone]','contact[body]'].includes(name))assert.equal(invalid,null,name+' optional');
   assert.equal(await ev(`document.getElementById('Cancellation-main-name-error').textContent`),'יש למלא שם מלא.');
   assert.equal(await ev(`document.getElementById('Cancellation-main-name-error').hidden`),false);
   assert.match(await ev(`${field('contact[name]')}.getAttribute('aria-describedby')`),/Cancellation-main-name-error/);
   await ev(`document.getElementById('CancellationForm-main').checkValidity()`);
   assert.equal(await ev(`document.getElementById('Cancellation-main-id-error').textContent`),'יש למלא מספר תעודת זהות.');
   assert.equal(await ev(`document.getElementById('Cancellation-main-email-error').textContent`),'יש למלא כתובת דוא״ל.');
   assert.equal(await ev(`${field(ID_FIELD)}.getAttribute('aria-invalid')`),'true');
   await type('ישראל ישראלי');
   assert.equal(await ev(`${field('contact[name]')}.getAttribute('aria-invalid')`),null,'error clears once fixed');
   assert.equal(await ev(`document.getElementById('Cancellation-main-name-error').hidden`),true);
  });
  await t.test('ID number keeps leading zeros, rejects letters, normalizes spaces and dashes',async()=>{
   await ev(`${field(ID_FIELD)}.focus()`);await type('12ab');
   assert.equal(await ev(`document.getElementById('CancellationForm-main').checkValidity()`),false);
   assert.equal(await ev(`document.getElementById('Cancellation-main-id-error').textContent`),'מספר תעודת זהות יכול להכיל ספרות בלבד, עד 9 ספרות.');
   await ev(`(()=>{const e=${field(ID_FIELD)};e.value='0123 456-78';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await ev(`${field(ID_FIELD)}.value`),ID);assert.equal(await ev(`${field(ID_FIELD)}.validity.valid`),true);
   await ev(`${field('contact[email]')}.focus()`);await type('not-an-email');
   assert.equal(await ev(`document.getElementById('CancellationForm-main').checkValidity()`),false);
   assert.equal(await ev(`document.getElementById('Cancellation-main-email-error').textContent`),'יש להזין כתובת דוא״ל תקינה.');
   await ev(`${field('contact[email]')}.value=''`);await ev(`${field('contact[email]')}.focus()`);await type('customer@example.com');
  });
  await t.test('Optional fields empty: one native POST to Shopify contact with the request type; no marketing fields',async()=>{
   delay=300;
   await click('.cancellation-request__submit');await click('.cancellation-request__submit');
   await wait('location.search.includes("contact_posted=true")&&document.readyState==="complete"');delay=0;
   assert.equal(posts.length,1,'double click submits once');
   const post=posts[0];
   assert.deepEqual(Object.keys(post).sort(),['contact[body]','contact[email]','contact[name]','contact[phone]','contact[מספר הזמנה]',ID_FIELD,'contact[סוג פנייה]','form_type','utf8'].sort());
   assert.equal(post.form_type,'contact');assert.equal(post['contact[סוג פנייה]'],'בקשת ביטול עסקה');assert.equal(post[ID_FIELD],ID);
   assert.equal(post['contact[name]'],'ישראל ישראלי');assert.equal(post['contact[email]'],'customer@example.com');
   for(const name of ['contact[מספר הזמנה]','contact[phone]','contact[body]'])assert.equal(post[name],'');
   const posted=requests.filter(r=>r.post);assert.equal(posted.length,1,'no duplicate request');assert.equal(new URL(posted[0].url).pathname,'/contact');
  });
  await t.test('Success state: Hebrew confirmation, focused, no fields and no personal data in DOM, URL or storage',async()=>{
      await wait('document.activeElement.matches("[data-cancellation-success]")');
   assert.equal(await ev('document.querySelector("[data-cancellation-success] h2").textContent'),'הבקשה נשלחה בהצלחה');
   assert.equal(await ev('document.querySelectorAll("#CancellationForm-main :is(input:not([type=hidden]),textarea)").length'),0);
   const html=await ev('document.documentElement.outerHTML');
   for(const value of [ID,'customer@example.com','ישראל ישראלי'])assert.ok(!html.includes(value),value+' not in DOM');
   for(const url of [...urls,...requests.map(r=>r.url),await ev('location.href')])assert.ok(!decodeURIComponent(url).includes(ID)&&!url.includes('contact%5B')&&!url.includes('contact['),url);
   assert.equal(await ev('localStorage.length+sessionStorage.length'),0);
   assert.ok(!(await ev('document.cookie')).includes(ID));
   assert.ok(!consoleText.join('').includes(ID),'never logged');
   await call('Page.navigateToHistoryEntry',{entryId:(await call('Page.getNavigationHistory')).entries.at(-2).id});
   await wait('document.readyState==="complete"&&!!document.querySelector("#CancellationForm-main")');
   const restored=await ev(`document.querySelector('[name="${ID_FIELD}"]')?.value??''`);
   assert.equal(restored,'','back navigation never restores the ID number');
  });
  await t.test('Server error state: accessible summary is focused; contact[...] query values are removed from the URL',async()=>{
   await load(origin+'/?errors=1&contact%5Bemail%5D=x&contact%5Bname%5D=y&keep=1');
   await wait('document.activeElement.id==="Cancellation-main-errors"');
   assert.equal(await ev('document.activeElement.getAttribute("role")'),'alert');
   assert.equal(await ev('location.search'),'?errors=1&keep=1');
   assert.equal(await ev(`${field('contact[email]')}.getAttribute('aria-invalid')`),'true');
   assert.equal(await ev(`${field('contact[email]')}.value`),'','nothing is prefilled');
  });
  await t.test('Keyboard: logical tab order, visible focus, Enter submits through native validation',async()=>{
   await load(origin+'/');
   await ev(`document.querySelector('h1').setAttribute('tabindex','-1');document.querySelector('h1').focus()`);
   const order=[];
   for(let i=0;i<7;i++){await key('Tab','Tab',9);order.push(await ev('document.activeElement.name||document.activeElement.className'));
    const outline=await ev('(()=>{const s=getComputedStyle(document.activeElement);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>=2})()');assert.equal(outline,true,'visible focus on '+order.at(-1));}
   assert.deepEqual(order,['contact[name]',ID_FIELD,'contact[מספר הזמנה]','contact[email]','contact[phone]','contact[body]','theme-btn cancellation-request__submit']);
   await ev(`${field('contact[name]')}.focus()`);await key('Enter','Enter',13);await sleep(150);
   assert.equal(posts.length,1,'Enter with empty required fields does not submit');
   assert.equal(await ev(`${field('contact[name]')}.getAttribute('aria-invalid')`),'true');
  });
  await t.test('Mobile and desktop: no horizontal overflow, touch-size controls, RTL alignment',async()=>{
   for(const [width,height,mobile] of [[320,640,true],[390,844,true],[768,1024,true],[1280,900,false]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await load(origin+'/');
    const m=await ev(`(()=>{const form=document.getElementById('CancellationForm-main').getBoundingClientRect();const controls=[...document.querySelectorAll('#CancellationForm-main :is(input:not([type=hidden]),textarea,button)')].map(e=>e.getBoundingClientRect());const label=document.querySelector('#CancellationForm-main label').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,inside:controls.every(r=>r.left>=form.left-1&&r.right<=form.right+1),minHeight:Math.min(...controls.map(r=>r.height)),labelRight:Math.round(form.right-label.right)};})()`);
    assert.equal(m.overflow,false,width+': no horizontal overflow');assert.equal(m.inside,true,width);
    assert.ok(m.minHeight>=44,width+': touch targets '+m.minHeight);assert.ok(m.labelRight<=2,width+': labels start on the right');
   }
  });
  assert.deepEqual(errors,[]);
 }finally{ws?.close();chrome?.kill();server.close();await sleep(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
