// Transaction cancellation request ("ביטול עסקה"): sections/cancellation-request.liquid, templates/page.cancellation.json
// and the footer link. The form sends JSON to the Fankee backend (tools/group-delivery, POST /api/v1/cancellations);
// it never uses Shopify's contact form, email, browser storage or the URL for what the shopper typed.
// 1. Contracts run everywhere. 2. Liquid rendering and 3. browser behaviour render the real section and footer with
// liquidjs (skipped when liquidjs is not resolvable through NODE_PATH). The browser test serves the page from one local
// origin and a fake backend from another, so CORS, the preflight and every answer the backend can give are exercised.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const section=read('sections/cancellation-request.liquid'),footer=read('sections/footer.liquid');
const he=json('locales/he.default.json'),en=json('locales/en.json');
const script=section.match(/<script>([\s\S]*?)<\/script>/)[1];
const markup=section.replace(/<script>[\s\S]*?<\/script>/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'').replace(/{% schema %}[\s\S]*?{% endschema %}/,'').replace(/{% comment %}[\s\S]*?{% endcomment %}/,'');
// A valid Israeli ID number (correct check digit) used only by this test, so any leak is a detectable substring.
const ID='314159260',NAME='ישראלה בדיקה',EMAIL='cancel.browser@example.test',PHONE='0547654321',REASON='סיבה פרטית לבדיקה';
const FIELDS=['name','idNumber','orderNumber','email','phone','reason'];
const tr=he.cancellation_request;

test('Contract: JSON to the Fankee backend, field rules, privacy notice, fallback channels, no client-side persistence',()=>{
 const template=json('templates/page.cancellation.json');
 assert.deepEqual(template,{sections:{main:{type:'cancellation-request',settings:{}}},order:['main']});
 assert.doesNotMatch(section,/{% form |contact\[|form_type/,'no Shopify contact form: its submissions are delivered by email');
 assert.match(markup,/<form id="{{ cancellation_form_id }}" class="cancellation-request__form" method="post" action="{{ cancellation_endpoint \| escape }}" hidden data-endpoint="{{ cancellation_endpoint \| escape }}"/);
 assert.match(section,/assign cancellation_service = section\.settings\.service_url \| default: 'https:\/\/fankee-group-delivery\.onrender\.com' \| strip/);
 assert.match(section,/assign cancellation_endpoint = cancellation_service \| append: '\/api\/v1\/cancellations'/);
 const field=name=>markup.match(new RegExp('<(?:input|textarea)[^>]*name="'+name+'"[^>]*>'))?.[0];
 for(const name of ['name','idNumber','email'])assert.match(field(name),/\srequired\b/,name+' required');
 for(const name of ['orderNumber','phone','reason'])assert.doesNotMatch(field(name),/\srequired\b/,name+' optional');
 for(const name of FIELDS)assert.match(field(name),new RegExp('data-field="'+name+'"'));
 const id=field('idNumber');
 for(const attribute of ['type="text"','inputmode="numeric"','autocomplete="off"','maxlength="9"','pattern="[0-9]{5,9}"','data-1p-ignore','data-lpignore="true"','spellcheck="false"'])assert.ok(id.includes(attribute),attribute);
 assert.match(field('email'),/type="email"/);assert.match(field('phone'),/type="tel"/);assert.match(field('orderNumber'),/placeholder="#1058"/);
 // Nothing submitted is ever rendered back: no value attributes, no form.* or customer.* echo.
 assert.deepEqual([...markup.matchAll(/\svalue="([^"]*)"/g)].map(m=>m[1]),[]);
 assert.doesNotMatch(markup,/form\.|customer\./);
 assert.doesNotMatch(markup,/accepts_marketing|newsletter/,'no marketing consent or subscription');
 for(const m of markup.matchAll(/<label for="{{ cancellation_field }}-(\w+)">/g))assert.match(markup,new RegExp('id="{{ cancellation_field }}-'+m[1]+'"'));
 // Privacy notice (section 11) inside the form, before the button, with the full policy link.
 const privacy=markup.match(/<section class="cancellation-request__privacy"[\s\S]*?<\/section>/)?.[0];
 assert.ok(privacy&&markup.indexOf(privacy)<markup.indexOf('cancellation-request__submit'),'privacy notice precedes the submit button');
 for(const key of ['privacy_collected','privacy_purpose','privacy_controller','privacy_access','privacy_required','privacy_rights'])assert.ok(privacy.includes("'cancellation_request."+key+"' | t"),key);
 assert.match(privacy,/{% if shop\.privacy_policy %} <a href="{{ shop\.privacy_policy\.url }}">/);
 assert.match(markup,/aria-describedby="{{ cancellation_field }}-privacy-heading"/,'the button is described by the notice');
 // Other channels, always rendered (not only on failure), from the business settings.
 for(const setting of ['business_phone','business_email','business_address','floating_whatsapp_number','business_legal_name'])assert.match(section,new RegExp('settings\\.'+setting));
 assert.match(markup,/<noscript>/);
 // Script: scoped, no storage/cookies/logging/analytics/history writes; exactly one network call, credential-less JSON.
 assert.match(script,/document\.getElementById\({{ cancellation_form_id \| json }}\)/);
 assert.doesNotMatch(script,/localStorage|sessionStorage|indexedDB|document\.cookie|console\.|XMLHttpRequest|sendBeacon|gtag|dataLayer|fbq|analytics|\.submit\(\)|history\.|location\.(href|search|hash)\s*=/);
 assert.equal((script.match(/fetch\(/g)||[]).length,1);
 assert.match(script,/credentials: 'omit'/);assert.match(script,/'Content-Type': 'application\/json'/);assert.match(script,/event\.preventDefault\(\)/);
 // CSS stays inside the component.
 const css=section.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1].replace(/@media[^{]+{([\s\S]*?})\s*}/g,'$1');
 for(const rule of css.matchAll(/([^{}]+){[^{}]*}/g))for(const selector of rule[1].split(/,(?![^(]*\))/))assert.match(selector.trim(),/^\.cancellation-request/,selector);
 // The contact page form is untouched.
 const contact=read('sections/contact-form.liquid');
 assert.match(contact,/{% form 'contact', id: contact_id, class: 'storefront-validated-form' %}/);assert.doesNotMatch(contact,/cancellation/);
 // Footer: page picker and link through the policy lists, bottom bar fallback.
 const footerSchema=JSON.parse(footer.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
 assert.deepEqual(footerSchema.settings.find(s=>s.id==='cancellation_page'),{type:'page',id:'cancellation_page',label:'t:cancellation_editor.page',info:'t:cancellation_editor.page_info'});
 assert.equal((footer.match(/<li><a href="{{ cancellation_page\.url }}"/g)||[]).length,2);
 assert.doesNotMatch(footer+section,/\/pages\/|page\.id|pages\[/,'no hard-coded page');
 const schema=JSON.parse(section.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
 assert.deepEqual(schema.settings,[{type:'url',id:'service_url',label:'t:cancellation_editor.service_url',info:'t:cancellation_editor.service_url_info'}]);
 // Locales: same keys in Hebrew and English; copy that must stay as approved.
 assert.deepEqual(Object.keys(en.cancellation_request).sort(),Object.keys(he.cancellation_request).sort());
 assert.equal(tr.link,'ביטול עסקה');
 assert.deepEqual([tr.heading,tr.intro,tr.support,tr.note,tr.submit],['בקשה לביטול עסקה','ניתן לשלוח באמצעות טופס זה בקשה לביטול עסקה שבוצעה באתר פאנקי.','לאחר קבלת הבקשה נבדוק את פרטי העסקה ונטפל בה בהתאם למדיניות ההחזרים ולהוראות הדין.','שליחת הטופס מהווה בקשה לביטול ואינה אישור אוטומטי לכך שהעסקה ניתנת לביטול. לאחר בדיקת הבקשה נעדכן אתכם בהתאם.','שליחת בקשת ביטול']);
 assert.equal(tr.success_text,'הבקשה התקבלה ונשלחה לטיפול.');
 // The notice states only what is technically true: encrypted, not emailed; no fixed retention period promised.
 assert.match(tr.privacy_controller,/{{ business }}/);assert.match(tr.privacy_controller,/מוצפן ואינו נשלח בדוא״ל/);
 assert.match(tr.privacy_purpose,/לזיהוי מגיש הבקשה, לאיתור העסקה ולטיפול בבקשת הביטול/);
 assert.match(tr.privacy_rights,/לעיין במידע האישי שלכם ולבקש לתקן אותו/);
 for(const text of Object.values(tr))assert.doesNotMatch(String(text),/\d+\s*(ימים|שנים|חודשים|days|years|months)/,'no retention period is promised');
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
const BUSINESS={business_phone:'054-396-6168',business_email:'shop@example.test',business_address:'אחוזם 80, מושב אחוזם',business_legal_name:'פאנקי מוצרי ניקיון',floating_whatsapp_number:'972543966168'};
function engine(){
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid'});
 const ignore=end=>({parse(token,remain){const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',()=>{}).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(){}});
 for(const [tag,end] of [['doc','enddoc'],['stylesheet','endstylesheet'],['schema','endschema']])liquid.registerTag(tag,ignore(end));
 // Shopify's t filter with interpolation (name: value pairs).
 liquid.registerFilter('t',(key,...args)=>{let value=key.split('.').reduce((a,k)=>a?.[k],he);assert.equal(typeof value,'string',key);for(const arg of args)if(Array.isArray(arg))value=value.replace('{{ '+arg[0]+' }}',arg[1]);return value;});
 // Shopify's {% form %} (the footer newsletter uses it): a POST form with the form_type hidden input.
 liquid.registerTag('form',{parse(token,remain){this.type=token.args.match(/^'(\w+)'/)[1];this.id=(token.args.match(/id: (\w+)/)||[])[1];this.className=(token.args.match(/class: '([^']+)'/)||[])[1]||'';this.tpls=[];const stream=this.liquid.parser.parseStream(remain);stream.on('tag:endform',()=>stream.stop()).on('template',tpl=>this.tpls.push(tpl)).on('end',()=>{throw Error('endform missing');});stream.start();},
  *render(ctx,emitter){const id=this.id?yield this.liquid.evalValue(this.id,ctx):'';emitter.write(`<form method="post" action="/${this.type}#${id}" id="${id}" class="${this.className}"><input type="hidden" name="form_type" value="${this.type}">`);yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');}});
 liquid.registerFilter('default_errors',errors=>'<ul><li>'+(errors||[]).join('</li><li>')+'</li></ul>');
 liquid.registerFilter('payment_type_svg_tag',()=>'');
 return liquid;
}
async function renderSection(liquid,{serviceUrl='',settings=BUSINESS,privacy=true}={}){
 return liquid.parseAndRender(section.replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''),{section:{id:'main',settings:{service_url:serviceUrl}},settings,shop:privacy?{privacy_policy:{url:'/policies/privacy-policy'}}:{}});
}
async function renderFooter(liquid,{page={url:'/pages/cancel',title:'ביטול עסקה'},showPolicies=true,design=false,path='/'}={}){
 return liquid.parseAndRender(footer.replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''),{
  section:{id:'footer',settings:{show_store_name:false,show_copyright:true,show_policies:showPolicies,show_footer_links:false,show_newsletter:false,show_payment_icons:false,cancellation_page:page,accessibility_statement_page:{url:'/pages/accessibility'}}},
  shop:{name:'פאנקי',policies:[{title:'מדיניות החזרים',url:'/policies/refund-policy',body:'x'},{title:'תנאי שימוש',url:'/policies/terms-of-service',body:'x'}],enabled_payment_types:[]},
  settings:{group_delivery_footer:false,google_review_enabled:false},request:{design_mode:design,path},routes:{root_url:'/'}});
}

test('Liquid rendering: endpoint, hidden-until-ready form, privacy notice, other channels and the footer link',{skip:SKIP},async()=>{
 const liquid=engine();
 const html=await renderSection(liquid);
 assert.match(html,/<form id="CancellationForm-main" class="cancellation-request__form" method="post" action="https:\/\/fankee-group-delivery\.onrender\.com\/api\/v1\/cancellations" hidden data-endpoint="https:\/\/fankee-group-delivery\.onrender\.com\/api\/v1\/cancellations"/);
 for(const custom of ['https://service.example.test','https://service.example.test/'])
  assert.match(await renderSection(liquid,{serviceUrl:custom}),/data-endpoint="https:\/\/service\.example\.test\/api\/v1\/cancellations"/,custom);
 assert.match(html,/<h1 id="Cancellation-main-heading" tabindex="-1">בקשה לביטול עסקה<\/h1>/);
 assert.match(html,/<li>המידע נשמר במאגר של פאנקי מוצרי ניקיון \(„פאנקי”\), האחראית על המידע\./);
 assert.match(html,/<li>בהתאם לדין, זכותכם לעיין במידע האישי שלכם ולבקש לתקן אותו\. <a href="\/policies\/privacy-policy">למדיניות הפרטיות המלאה<\/a><\/li>/);
 assert.doesNotMatch(await renderSection(liquid,{privacy:false}),/policies\/privacy-policy/,'no dead link without a policy');
 const other=html.match(/<section class="cancellation-request__other"[\s\S]*?<\/section>/)[0];
 assert.match(other,/<a href="tel:0543966168" dir="ltr">054-396-6168<\/a>/);assert.match(other,/<a href="mailto:shop@example\.test" dir="ltr">shop@example\.test<\/a>/);
 assert.match(other,/<a href="https:\/\/wa\.me\/972543966168" target="_blank" rel="noopener noreferrer">/);assert.match(other,/בדואר: אחוזם 80, מושב אחוזם/);
 assert.match(other,/מומלץ לא לכלול את מספר תעודת הזהות/);
 const empty=await renderSection(liquid,{settings:{}});
 assert.doesNotMatch(empty,/tel:|mailto:|wa\.me/,'no channel is invented when a setting is empty');
 assert.match(empty,/המידע נשמר במאגר של פאנקי מוצרי ניקיון/,'the controller name has a default');
 // Success and error regions exist but start hidden; nothing personal can be rendered server-side.
 assert.match(html,/class="cancellation-request__success" role="status" tabindex="-1" hidden data-cancellation-success>/);
 assert.match(html,/role="alert" tabindex="-1" hidden data-cancellation-errors>/);
 // Footer: in the policy list (current live configuration), current page marked, bottom bar fallback.
 const live=await renderFooter(liquid);
 assert.match(live,/<nav class="storefront-footer-policies" aria-label="[^"]*"><h3>[^<]*<\/h3><ul><li><a href="\/policies\/refund-policy">מדיניות החזרים<\/a><\/li><li><a href="\/policies\/terms-of-service">תנאי שימוש<\/a><\/li><li><a href="\/pages\/cancel">ביטול עסקה<\/a><\/li><\/ul><\/nav>/);
 assert.match(await renderFooter(liquid,{path:'/pages/cancel'}),/<a href="\/pages\/cancel" aria-current="page">ביטול עסקה<\/a>/);
 assert.match(await renderFooter(liquid,{showPolicies:false}),/<a class="storefront-footer-statement" href="\/pages\/cancel">ביטול עסקה<\/a>/);
 assert.doesNotMatch(await renderFooter(liquid,{page:null}),/ביטול עסקה/,'nothing is linked until a page is selected');
 assert.match(await renderFooter(liquid,{page:null,design:true}),/יש לבחור עמוד ביטול עסקה בהגדרות התחתית\./);
});

test('Browser: validation, one JSON request, success without personal data, failures, no-JS fallback, keyboard and layout',{skip:SKIP,timeout:240000},async t=>{
 const liquid=engine();
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['theme.css','storefront.css'].map(file=>read('assets/'+file)).join('')+block('snippets/storefront-design.liquid')+block('sections/footer.liquid')+block('sections/cancellation-request.liquid');
 // Fake backend on its own origin: records each request and answers according to mode.
 const backend={mode:'ok',delay:0,requests:[],preflights:0};
 const api=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const cors={'Access-Control-Allow-Origin':req.headers.origin||'','Vary':'Origin'};
  if(req.method==='OPTIONS'){backend.preflights++;res.writeHead(204,{...cors,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});return res.end();}
  backend.requests.push({method:req.method,url:req.url,headers:req.headers,body});
  await sleep(backend.delay);
  const send=(status,data)=>{res.writeHead(status,{...cors,'Content-Type':typeof data==='string'?'text/html':'application/json'});res.end(typeof data==='string'?data:JSON.stringify(data));};
  if(backend.mode==='down')return req.socket.destroy();
  if(backend.mode==='invalid')return send(400,{error:'x',code:'INVALID_CANCELLATION',fields:{idNumber:'INVALID',phone:'INVALID'}});
  if(backend.mode==='rate')return send(429,{error:'x',code:'RATE_LIMITED'});
  if(backend.mode==='unavailable')return send(503,{error:'x',code:'CANCELLATION_UNAVAILABLE'});
  if(backend.mode==='garbage')return send(200,'<html>maintenance</html>');
  return send(201,{ok:true,reference:'CR-7K4M-Q2XZ',message:'הבקשה התקבלה ונשלחה לטיפול.'});
 });
 await new Promise(r=>api.listen(0,'127.0.0.1',r));
 const serviceUrl='http://127.0.0.1:'+api.address().port;
 const page=async()=>'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}'+css+'</style><script>window.themeStrings={required:'+JSON.stringify(he.storefront.required)+',invalidEmail:'+JSON.stringify(he.storefront.invalid_email)+',quantityError:"",backToTop:""};</script><script src="/storefront.js" defer></script></head><body><main id="MainContent">'+await renderSection(liquid,{serviceUrl})+'</main>'+await renderFooter(liquid,{path:'/'})+'</body></html>';
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  if(url.pathname==='/storefront.js'){res.setHeader('Content-Type','text/javascript');return res.end(read('assets/storefront.js'));}
  if(url.pathname==='/away'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end('<p id="away">away</p>');}
  // A render error must fail the test, not leave the request (and the run) hanging.
  try{const html=await page();res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);}catch(error){res.statusCode=500;res.end(String(error));}
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
   if(m.method==='Network.requestWillBeSent')requests.push({url:m.params.request.url,method:m.params.request.method,post:m.params.request.postData||'',headers:m.params.request.headers});
   if(m.method==='Runtime.consoleAPICalled')consoleText.push(JSON.stringify(m.params.args));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(expression,tries=400)=>{for(let i=0;i<tries;i++){if(await ev(expression).catch(()=>false))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const load=async url=>{await call('Page.navigate',{url});await wait('document.readyState==="complete"');};
  const key=async(keyName,code,vk,shift=false)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:keyName,code,windowsVirtualKeyCode:vk,modifiers:shift?8:0,...(type==='keyDown'&&keyName==='Enter'?{text:'\r'}:{})});};
  const type=async text=>{for(const ch of text)await call('Input.insertText',{text:ch});};
  const click=async selector=>{const {x,y}=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);for(const kind of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type:kind,x,y,button:'left',clickCount:1});};
  const field=name=>`document.querySelector('[data-field="${name}"]')`;
  const fill=async(values={})=>{const v={name:NAME,idNumber:ID,orderNumber:'#1058',email:EMAIL,phone:PHONE,reason:REASON,...values};
   for(const name of FIELDS)await ev(`(()=>{const e=${field(name)};e.value=${JSON.stringify(v[name])};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);};
  const posts=()=>backend.requests.filter(r=>r.method==='POST');
  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await load(origin+'/');

  await t.test('Hebrew RTL page: labelled fields, visible privacy notice and other channels, footer link',async()=>{
   assert.equal(await ev('getComputedStyle(document.querySelector(".cancellation-request")).direction'),'rtl');
   assert.equal(await ev('document.querySelector("h1").textContent'),'בקשה לביטול עסקה');
   assert.equal(await ev('document.getElementById("CancellationForm-main").hidden'),false,'the script shows the form');
   assert.deepEqual(await ev(`[...document.querySelectorAll('#CancellationForm-main [data-field]')].map(e=>[e.name,e.labels[0].textContent.replace(/\\s+/g,' ').trim(),e.required])`),[
    ['name','שם מלא *',true],['idNumber','מספר תעודת זהות *',true],['orderNumber','מספר הזמנה (לא חובה)',false],['email','דוא״ל *',true],['phone','טלפון (לא חובה)',false],['reason','סיבת הביטול (לא חובה)',false]]);
   const privacy=await ev('(()=>{const s=document.querySelector(".cancellation-request__privacy");const r=s.getBoundingClientRect();return {visible:r.height>40&&getComputedStyle(s).display!=="none",heading:s.querySelector("h2").textContent,items:s.querySelectorAll("li").length,link:s.querySelector("a").getAttribute("href"),describes:document.querySelector(".cancellation-request__submit").getAttribute("aria-describedby")}})()');
   assert.deepEqual(privacy,{visible:true,heading:tr.privacy_heading,items:6,link:'/policies/privacy-policy',describes:'Cancellation-main-privacy-heading'});
   assert.deepEqual(await ev('[...document.querySelectorAll(".cancellation-request__other a")].map(a=>a.getAttribute("href"))'),['tel:0543966168','mailto:shop@example.test','https://wa.me/972543966168']);
   assert.equal(await ev(`document.querySelector('.storefront-footer a[href="/pages/cancel"]').textContent`),'ביטול עסקה');
  });

  await t.test('Required name, ID and email: no request, Hebrew inline errors, aria-invalid, focus on the first field',async()=>{
   await click('.cancellation-request__submit');await sleep(150);
   assert.equal(posts().length,0);
   assert.equal(await ev('document.activeElement.name'),'name');
   assert.equal(await ev(`document.getElementById('Cancellation-main-name-error').textContent`),'יש למלא שם מלא.');
   assert.match(await ev(`${field('name')}.getAttribute('aria-describedby')`),/Cancellation-main-name-error/);
   await ev(`document.getElementById('CancellationForm-main').checkValidity()`);
   assert.equal(await ev(`document.getElementById('Cancellation-main-id-error').textContent`),'יש למלא מספר תעודת זהות.');
   assert.equal(await ev(`document.getElementById('Cancellation-main-email-error').textContent`),'יש למלא כתובת דוא״ל.');
   for(const name of ['orderNumber','phone','reason'])assert.equal(await ev(`${field(name)}.getAttribute('aria-invalid')`),null,name+' optional');
   await type('ישראלה');
   assert.equal(await ev(`${field('name')}.getAttribute('aria-invalid')`),null,'error clears once fixed');
  });

  await t.test('ID number: digits only, spaces and dashes removed, leading zeros kept',async()=>{
   await ev(`${field('idNumber')}.focus()`);await type('12ab');
   assert.equal(await ev(`document.getElementById('CancellationForm-main').checkValidity()`),false);
   assert.equal(await ev(`document.getElementById('Cancellation-main-id-error').textContent`),tr.error_id_format);
   await ev(`(()=>{const e=${field('idNumber')};e.value='0577 215-65';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
   assert.equal(await ev(`${field('idNumber')}.value`),'057721565');assert.equal(await ev(`${field('idNumber')}.validity.valid`),true);
  });

  await t.test('Success: double click sends one JSON request without cookies; reference shown; fields removed; nothing kept',async()=>{
   await load(origin+'/');
   await ev('document.cookie="theme_session=abc; path=/"');
   await fill();backend.mode='ok';backend.delay=400;
   await ev(`(()=>{const button=document.querySelector('.cancellation-request__submit');button.scrollIntoView({block:'center'});button.click();button.click();})()`);
   assert.equal(await ev('document.querySelector(".cancellation-request__submit").getAttribute("aria-disabled")'),'true');
   assert.equal(await ev('document.querySelector(".cancellation-request__submit").textContent'),tr.sending);
   await wait('document.activeElement.matches("[data-cancellation-success]")');backend.delay=0;
   assert.equal(posts().length,1,'double click submits once');
   const sent=posts()[0];
   assert.equal(sent.url,'/api/v1/cancellations');assert.equal(sent.headers['content-type'],'application/json');assert.equal(sent.headers.origin,origin);
   assert.equal(sent.headers.cookie,undefined,'no cookies are sent');
   const body=JSON.parse(sent.body);
   assert.deepEqual(Object.keys(body).sort(),[...FIELDS,'submissionKey'].sort());
   assert.deepEqual(FIELDS.map(k=>body[k]),[NAME,ID,'#1058',EMAIL,PHONE,REASON]);
   assert.match(body.submissionKey,/^[A-Za-z0-9-]{16,64}$/);
   assert.equal(await ev('document.querySelector("[data-cancellation-success] h2").textContent'),tr.success_heading);
   assert.equal(await ev('document.querySelector("[data-cancellation-reference]").textContent'),'CR-7K4M-Q2XZ');
   assert.equal(await ev('document.querySelector("[data-cancellation-success]").getAttribute("role")'),'status');
   assert.equal(await ev('document.querySelectorAll("input,textarea").length'),0,'every field is removed from the page');
   assert.equal(await ev('!!document.getElementById("CancellationForm-main")'),false);
   const html=await ev('document.documentElement.outerHTML');
   for(const value of [ID,EMAIL,NAME,PHONE,REASON])assert.ok(!html.includes(value),value+' not in DOM');
   assert.equal(await ev('localStorage.length+sessionStorage.length'),0);
   assert.ok(!(await ev('document.cookie')).includes(ID));
   assert.equal(await ev('location.href'),origin+'/');
   assert.ok(await ev('!!document.querySelector(".cancellation-request__other")'),'the other channels stay available');
  });

  await t.test('Back/forward never restores the ID number',async()=>{
   await load(origin+'/');await fill();
   await load(origin+'/away');
   await call('Page.navigateToHistoryEntry',{entryId:(await call('Page.getNavigationHistory')).entries.at(-2).id});
   await wait('document.readyState==="complete"&&!!document.querySelector("#CancellationForm-main")');
   assert.equal(await ev(`${field('idNumber')}.value`),'');
  });

  await t.test('Server field errors: alert summary focused, fields marked, values kept for correction',async()=>{
   await load(origin+'/');await fill();backend.mode='invalid';
   await click('.cancellation-request__submit');
   await wait('document.activeElement.id==="Cancellation-main-errors"');
   assert.equal(await ev('document.activeElement.getAttribute("role")'),'alert');
   assert.equal(await ev('document.querySelector("[data-cancellation-error-text]").textContent'),tr.error_fields);
   assert.equal(await ev(`${field('idNumber')}.getAttribute('aria-invalid')`),'true');assert.equal(await ev(`document.getElementById('Cancellation-main-id-error').textContent`),tr.error_id_format);
   assert.equal(await ev(`${field('phone')}.getAttribute('aria-invalid')`),'true');assert.equal(await ev(`${field('name')}.getAttribute('aria-invalid')`),null);
   assert.equal(await ev(`${field('idNumber')}.value`),ID,'nothing the shopper typed is lost');
   assert.equal(await ev('document.querySelector(".cancellation-request__submit").getAttribute("aria-disabled")'),null,'can send again');
  });

  await t.test('Backend unreachable or failing: the other channels are offered; a retry without edits reuses the key',async()=>{
   await load(origin+'/');await fill();
   const before=posts().length;
   backend.mode='down';await click('.cancellation-request__submit');
   await wait('document.activeElement.id==="Cancellation-main-errors"');
   assert.equal(await ev('document.querySelector("[data-cancellation-error-text]").textContent'),tr.error_unavailable);
   assert.equal(await ev('document.querySelector("#Cancellation-main-errors a").getAttribute("href")'),'#Cancellation-main-other');
   backend.mode='ok';await click('.cancellation-request__submit');
   await wait('document.activeElement.matches("[data-cancellation-success]")');
   const [failed,retried]=posts().slice(before).map(r=>JSON.parse(r.body).submissionKey);
   assert.equal(retried,failed,'same submission, same key: the backend records it once');
   for(const [mode,message] of [['rate',tr.error_rate],['unavailable',tr.error_unavailable],['garbage',tr.error_unavailable]]){
    await load(origin+'/');await fill();backend.mode=mode;
    await click('.cancellation-request__submit');
    await wait('document.activeElement.id==="Cancellation-main-errors"');
    assert.equal(await ev('document.querySelector("[data-cancellation-error-text]").textContent'),message,mode);
   }
   // An edit after a failure is a new submission.
   const count=posts().length;
   await ev(`(()=>{const e=${field('reason')};e.value='עודכן';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
   backend.mode='ok';await click('.cancellation-request__submit');
   await wait('document.activeElement.matches("[data-cancellation-success]")');
   assert.notEqual(JSON.parse(posts()[count].body).submissionKey,JSON.parse(posts()[count-1].body).submissionKey);
  });

  await t.test('Slow backend (sleeping free instance): a polite waiting message while the request continues',async()=>{
   await load(origin+'/');await fill();backend.mode='ok';backend.delay=5000;
   await click('.cancellation-request__submit');
   await wait(`document.querySelector('[data-cancellation-status]').textContent===${JSON.stringify(tr.waking)}`,320);
   assert.equal(await ev('document.querySelector("[data-cancellation-status]").getAttribute("aria-live")'),'polite');
   await wait('document.activeElement.matches("[data-cancellation-success]")',400);backend.delay=0;
  });

  await t.test('Without JavaScript: no form (nothing could be submitted unsafely), the notice and the other channels',async()=>{
   await call('Emulation.setScriptExecutionDisabled',{value:true});
   try{
    await load(origin+'/');
    const state=await call('Runtime.evaluate',{expression:'({form:getComputedStyle(document.getElementById("CancellationForm-main")).display,other:getComputedStyle(document.querySelector(".cancellation-request__other")).display,links:document.querySelectorAll(".cancellation-request__other a").length,noscript:document.querySelector("noscript")?.textContent.includes("JavaScript")})',returnByValue:true});
    assert.deepEqual(state.result.value,{form:'none',other:'block',links:3,noscript:true});
   }finally{await call('Emulation.setScriptExecutionDisabled',{value:false});}
  });

  await t.test('Keyboard: logical tab order with visible focus; Enter with empty required fields sends nothing',async()=>{
   await load(origin+'/');
   await ev(`document.querySelector('h1').focus()`);
   const order=[];
   for(let i=0;i<8;i++){await key('Tab','Tab',9);order.push(await ev('document.activeElement.name||document.activeElement.getAttribute("href")||document.activeElement.className'));
    const outline=await ev('(()=>{const s=getComputedStyle(document.activeElement);return s.outlineStyle!=="none"&&parseFloat(s.outlineWidth)>=2})()');assert.equal(outline,true,'visible focus on '+order.at(-1));}
   assert.deepEqual(order,['name','idNumber','orderNumber','email','phone','reason','/policies/privacy-policy','theme-btn cancellation-request__submit']);
   const before=posts().length;
   await ev(`${field('name')}.focus()`);await key('Enter','Enter',13);await sleep(150);
   assert.equal(posts().length,before,'Enter with empty required fields does not submit');
   assert.equal(await ev(`${field('name')}.getAttribute('aria-invalid')`),'true');
  });

  await t.test('Mobile and desktop: no horizontal overflow, touch-size controls and links, RTL alignment',async()=>{
   for(const [width,height,mobile] of [[320,640,true],[390,844,true],[768,1024,true],[1280,900,false]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await load(origin+'/');
    const m=await ev(`(()=>{const form=document.getElementById('CancellationForm-main').getBoundingClientRect();const controls=[...document.querySelectorAll('#CancellationForm-main :is(input,textarea,button)')].map(e=>e.getBoundingClientRect());
     const links=[...document.querySelectorAll('.cancellation-request__privacy a,.cancellation-request__other a')].map(e=>e.getBoundingClientRect().height);const label=document.querySelector('#CancellationForm-main label').getBoundingClientRect();
     return {overflow:document.documentElement.scrollWidth>innerWidth,inside:controls.every(r=>r.left>=form.left-1&&r.right<=form.right+1),minHeight:Math.min(...controls.map(r=>r.height)),minLink:Math.min(...links),labelRight:Math.round(form.right-label.right)};})()`);
    assert.equal(m.overflow,false,width+': no horizontal overflow');assert.equal(m.inside,true,width);
    assert.ok(m.minHeight>=44,width+': touch targets '+m.minHeight);assert.ok(m.minLink>=44,width+': link targets '+m.minLink);assert.ok(m.labelRight<=2,width+': labels start on the right');
   }
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  });

  await t.test('The known test ID number never reaches a URL, a console message or any request except the one JSON body',async()=>{
   for(const url of [...urls,...requests.map(r=>r.url)])assert.ok(!decodeURIComponent(url).includes(ID),url);
   assert.ok(!consoleText.join('').includes(ID),'never logged');
   const carrying=requests.filter(r=>r.post.includes(ID));
   assert.ok(carrying.length>0&&carrying.every(r=>r.method==='POST'&&r.url===serviceUrl+'/api/v1/cancellations'),'only the cancellation request carries it');
   assert.ok(backend.preflights>0,'cross-origin JSON is preflighted (CORS enforced by the backend)');
  });
  assert.deepEqual(errors,[]);
 }finally{
  ws?.close();chrome?.kill();server.closeAllConnections();api.closeAllConnections();server.close();api.close();await sleep(300);try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
});
