// Delivery settlement selection before checkout (snippets/delivery-settlement.liquid, assets/delivery-settlement.js).
// 1. Contracts run everywhere. 2. Liquid rendering and 3. browser behaviour render the real snippet with liquidjs
//    (skipped when liquidjs is not resolvable through NODE_PATH) against a local server that stores the cart attribute.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const snippet=read('snippets/delivery-settlement.liquid'),js=read('assets/delivery-settlement.js');
const he=json('locales/he.default.json'),en=json('locales/en.json');
const ATTRIBUTE='יישוב למשלוח';
const APPROVED=['אחוזם','שלווה','נועם','אבן שמואל','איתן','עוזה','קריית גת','לכיש','שדה משה','ניר חן','שדה דוד','שחר','זוהר','גת','נהורה','נגה','עוצם','תלמים','אלומה','רווחה','סגולה','זבדיאל','מנוחה','ורדון'];

test('Contract: one whitelist, shared module, both checkout forms, existing group delivery setting, Hebrew copy',()=>{
 const list=snippet.match(/assign approved_settlements = '([^']+)'/)[1].split('|');
 assert.deepEqual([...list].sort(),[...APPROVED].sort());assert.equal(new Set(list).size,24);
 assert.doesNotMatch(js,/קריית גת|אחוזם|ורדון/,'the whitelist lives only in the snippet');
 assert.match(snippet,/<option value="" data-not-listed>{{ 'delivery_settlement\.not_listed' \| t }}<\/option>/,'not listed is never posted as a settlement');
 assert.match(snippet,/name="attributes\[{{ settlement_attribute }}\]"/);assert.match(snippet,/assign settlement_attribute = 'יישוב למשלוח'/);
 assert.match(snippet,/settings\.group_delivery_page \| default: pages\['group-delivery'\]/,'reuses the existing Group Delivery page setting');
 const drawer=read('snippets/cart-drawer.liquid'),cart=read('sections/main-cart.liquid');
 assert.match(drawer,/<p class="cart-drawer__total">[\s\S]*?<\/p>\s*{% render 'delivery-settlement', settlement_id: drawer_id %}\s*<button type="submit" name="checkout"/);
 assert.match(drawer,/{% render 'delivery-settlement', styles_only: true %}/,'empty drawer still loads the selector CSS');
 assert.match(cart,/{% render 'delivery-settlement', settlement_id: section\.id %}\s*<div class="catalog-actions">[^\n]*name="checkout"/);
 for(const file of ['snippets/cart-drawer.liquid','sections/main-cart.liquid'])assert.doesNotMatch(read(file),/additional_checkout_buttons|payment_button|content_for_additional_checkout_buttons/,file+': no accelerated checkout in the cart');
 assert.equal(fs.existsSync(path.join(root,'layout/checkout.liquid')),false);
 const layout=read('layout/theme.liquid');
 assert.ok(layout.indexOf("'delivery-settlement.js' | asset_url")>layout.indexOf("'storefront.js' | asset_url"),'loaded after storefront.js');
 assert.match(layout,/<script src="{{ 'delivery-settlement\.js' \| asset_url }}" defer><\/script>/);
 assert.match(js,/cart\/update\.js/);assert.match(js,/attributes: {\[ATTRIBUTE\]: value}/);assert.doesNotMatch(js,/localStorage|sessionStorage|location\.reload/);
 assert.deepEqual(he.delivery_settlement,{heading:'לאיזה יישוב המשלוח?',text:'בחרו את היישוב שלכם כדי לוודא שאנחנו מגיעים אליכם.',placeholder:'בחרו יישוב',not_listed:'היישוב שלי לא מופיע',supported:'מעולה! יש משלוח ליישוב שלך.',unsupported:'כרגע אין משלוח רגיל ליישוב שלך.',group:'ניתן להצטרף למשלוח קבוצתי לאזור שלך.',cta:'בדיקת משלוח קבוצתי',required:'יש לבחור יישוב לפני המעבר לתשלום.'});
 assert.deepEqual(Object.keys(en.delivery_settlement),Object.keys(he.delivery_settlement));
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
function engine(){
 const liquid=new Liquid();
 liquid.registerFilter('t',key=>{const value=key.split('.').reduce((a,k)=>a?.[k],he);assert.equal(typeof value,'string',key);return value;});
 const template=liquid.parse(snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''));
 return ({id='main',saved,groupPage=true,stylesOnly=false}={})=>liquid.render(template,{settlement_id:id,styles_only:stylesOnly,cart:{attributes:saved===undefined?{}:{[ATTRIBUTE]:saved}},settings:{group_delivery_page:null},pages:{'group-delivery':groupPage?{url:'/pages/group-delivery'}:null}});
}
const selected=html=>[...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)].filter(m=>/\sselected/.test(m[2])).map(m=>m[1]);

test('Liquid rendering: restores only an approved saved settlement',{skip:SKIP},async()=>{
 const render=engine();
 const neutral=await render();
 assert.deepEqual(selected(neutral),['']);assert.match(neutral,/data-state="neutral"/);assert.match(neutral,/data-settlement-message><\/div>/,'no message when the cart opens');
 assert.equal([...neutral.matchAll(/data-approved/g)].length,24);
 const options=[...neutral.matchAll(/<option value="([^"]*)"/g)].map(m=>m[1]);
 assert.equal(options[0],'');assert.equal(options.at(-1),'');assert.deepEqual(options.slice(1,-1),[...APPROVED].sort(),'sorted, with "not listed" last');
 const saved=await render({saved:'קריית גת'});
 assert.deepEqual(selected(saved),['קריית גת']);assert.match(saved,/data-state="supported"/);assert.match(saved,/<p>מעולה! יש משלוח ליישוב שלך\.<\/p>/);
 for(const stale of ['תל אביב','היישוב שלי לא מופיע','']){const html=await render({saved:stale});assert.deepEqual(selected(html),[''],stale);assert.match(html,/data-state="neutral"/);}
 assert.match(saved,/<label class="delivery-settlement__label" for="DeliverySettlement-main">לאיזה יישוב המשלוח\?<\/label>/);
 assert.match(saved,/aria-describedby="DeliverySettlement-main-hint DeliverySettlement-main-message"/);
 assert.match(saved,/<a class="delivery-settlement__cta" href="\/pages\/group-delivery" data-settlement-cta hidden>בדיקת משלוח קבוצתי<\/a>/);
 assert.doesNotMatch(await render({groupPage:false}),/data-settlement-cta/,'no invented URL without a Group Delivery page');
 assert.equal((await render({stylesOnly:true})).trim(),'');
});

test('Browser: validation, persistence, re-render, unsupported flow and checkout gating',{skip:SKIP,timeout:120000},async t=>{
 const render=engine();
 const css=read('snippets/storefront-design.liquid').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+read('snippets/cart-drawer.liquid').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+snippet.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const state={attributes:{},updates:[],checkouts:[],delay:150};
 const page=async()=>'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}'+read('assets/theme.css')+read('assets/storefront.css')+css+'</style></head><body><main id="MainContent" class="container">'
  +'<form id="drawer" class="cart-drawer__form" action="/cart" method="post"><footer class="cart-drawer__summary"><div id="drawer-slot">'+await render({id:'header',saved:state.attributes[ATTRIBUTE]})+'</div><button type="submit" name="checkout" class="theme-btn">לתשלום</button></footer></form>'
  +'<form id="page" action="/cart" method="post"><input name="updates[]" value="1">'+await render({id:'main',saved:state.attributes[ATTRIBUTE]})+'<div class="catalog-actions"><button type="submit" name="update" class="theme-btn">עדכון</button><button type="submit" name="checkout" class="theme-btn">לתשלום</button></div></form><a id="away" href="/away">away</a></main>'
  +'<script>window.Shopify={routes:{root:"/"}};</script><script src="/delivery-settlement.js" defer></script></body></html>';
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/delivery-settlement.js'){res.setHeader('Content-Type','text/javascript');return res.end(js);}
  if(req.url==='/cart/update.js'){const data=JSON.parse(body);state.updates.push({at:Date.now(),data});await sleep(state.delay);for(const [k,v] of Object.entries(data.attributes)){if(v)state.attributes[k]=v;else delete state.attributes[k];}res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({attributes:state.attributes}));}
  if(req.url==='/fragment'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(await render({id:'header',saved:state.attributes[ATTRIBUTE]}));}
  if(req.url==='/cart'&&req.method==='POST'){state.checkouts.push({at:Date.now(),form:Object.fromEntries(new URLSearchParams(body))});res.setHeader('Content-Type','text/html;charset=utf-8');return res.end('<p id="checkout">checkout</p>');}
  if(req.url==='/away'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end('<p id="away-page">away</p>');}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(await page());
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-settlement-'));
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
  let id=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||''));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const load=async url=>{await call('Page.navigate',{url});await wait('document.readyState==="complete"&&!!customElements.get("fankee-delivery-settlement")');};
  const center=async selector=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  const click=async selector=>{const {x,y}=await center(selector);for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});};
  const tap=async selector=>{const {x,y}=await center(selector);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  const enter=async selector=>{await ev(`document.querySelector(${JSON.stringify(selector)}).focus()`);for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});};
  const choose=(form,value)=>ev(`(()=>{const s=document.querySelector('#${form} select');s.selectedIndex=[...s.options].findIndex(o=>${value===null?"o.hasAttribute('data-not-listed')":'o.value==='+JSON.stringify(value)+'&&o.hasAttribute("data-approved")'});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const snapshot=()=>ev(`[...document.querySelectorAll('fankee-delivery-settlement')].map(e=>({state:e.dataset.state,value:e.querySelector('select').value,index:e.querySelector('select').selectedIndex,message:e.querySelector('[data-settlement-message]').textContent,invalid:e.querySelector('select').getAttribute('aria-invalid'),cta:e.querySelector('[data-settlement-cta]')?.hidden,checkout:e.closest('form').querySelector('[name=checkout]').getAttribute('aria-disabled')}))`);
  // Records checkout submissions that pass the gate without leaving the page.
  const trap=()=>ev(`window.submitted=[];for(const f of document.forms)f.addEventListener('submit',e=>{submitted.push({form:f.id,submitter:e.submitter?.name,at:Date.now()});e.preventDefault();});true`);
  await call('Page.enable');await call('Runtime.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await load(origin+'/');await trap();

  await t.test('Neutral on open: no message or error, regular checkout marked unavailable',async()=>{
   for(const item of await snapshot())assert.deepEqual(item,{state:'neutral',value:'',index:0,message:'',invalid:null,cta:true,checkout:'true'});
   assert.equal(await ev('document.querySelector("#drawer select").labels[0].textContent'),'לאיזה יישוב המשלוח?');
  });
  await t.test('Checkout without a settlement is blocked for mouse, keyboard and touch, with Hebrew validation and focus',async()=>{
   await click('#drawer [name=checkout]');
   assert.equal(await ev('submitted.length'),0);
   assert.equal(await ev('document.activeElement.id'),'DeliverySettlement-header');
   for(const item of await snapshot()){assert.equal(item.state,'required');assert.equal(item.message,'יש לבחור יישוב לפני המעבר לתשלום.');assert.equal(item.invalid,'true');}
   await enter('#page [name=checkout]');await sleep(120);
   assert.equal(await ev('submitted.length'),0);assert.equal(await ev('document.activeElement.id'),'DeliverySettlement-main');
   assert.equal(await ev('document.querySelector("#page [data-settlement-message]").textContent'),'יש לבחור יישוב לפני המעבר לתשלום.','re-announced');
   await call('Emulation.setTouchEmulationEnabled',{enabled:true});await tap('#drawer [name=checkout]');await call('Emulation.setTouchEmulationEnabled',{enabled:false});await sleep(120);
   assert.equal(await ev('submitted.length'),0);
   assert.equal(state.updates.length,0,'nothing saved yet');
   // The cart page update button is not gated.
   await click('#page [name=update]');assert.deepEqual(await ev('submitted.map(s=>s.submitter)'),['update']);await ev('submitted.length=0');
  });
  await t.test('Approved settlement: success, enabled checkout, one saved attribute, checkout waits for the save',async()=>{
   await choose('drawer','קריית גת');
   for(const item of await snapshot())assert.deepEqual(item,{state:'supported',value:'קריית גת',index:item.index,message:'מעולה! יש משלוח ליישוב שלך.',invalid:null,cta:true,checkout:null});
   await click('#drawer [name=checkout]');
   assert.equal(await ev('submitted.length'),0,'held while the attribute is being saved');
   await wait('submitted.length===1');
   assert.deepEqual(state.updates.map(u=>u.data),[{attributes:{[ATTRIBUTE]:'קריית גת'}}]);
   assert.equal(state.attributes[ATTRIBUTE],'קריית גת');
   assert.ok(await ev('submitted[0].at')>=state.updates[0].at+state.delay-5,'checkout submitted after the save completed');
   await choose('page','קריית גת');await sleep(250);assert.equal(state.updates.length,1,'an unchanged value is not saved again');
  });
  await t.test('Refresh, navigation away and back restore the settlement from the cart attribute',async()=>{
   await load(origin+'/');await trap();
   for(const item of await snapshot()){assert.equal(item.state,'supported');assert.equal(item.value,'קריית גת');assert.equal(item.checkout,null);}
   await click('#away');await wait('!!document.querySelector("#away-page")');
   await call('Page.navigateToHistoryEntry',{entryId:(await call('Page.getNavigationHistory')).entries.at(-2).id});
   await wait('document.readyState==="complete"&&!!document.querySelector("fankee-delivery-settlement")');await trap();
   for(const item of await snapshot()){assert.equal(item.state,'supported');assert.equal(item.value,'קריית גת');}
  });
  await t.test('Unsupported: group delivery message and CTA, checkout blocked and attribute cleared',async()=>{
   await choose('drawer',null);
   for(const item of await snapshot()){assert.equal(item.state,'unsupported');assert.equal(item.message,'כרגע אין משלוח רגיל ליישוב שלך.ניתן להצטרף למשלוח קבוצתי לאזור שלך.');assert.equal(item.cta,false);assert.equal(item.checkout,'true');}
   assert.equal(await ev('document.querySelector("#drawer [data-settlement-cta]").getAttribute("href")'),'/pages/group-delivery');
   await click('#drawer [name=checkout]');await sleep(80);
   assert.equal(await ev('submitted.length'),0);assert.equal(await ev('document.activeElement.matches("#drawer [data-settlement-cta]")'),true);
   assert.equal(await ev('document.querySelector("#drawer [data-settlement-message]").textContent.includes("יש לבחור")'),false,'no fake validation error');
   await wait('true');await sleep(state.delay+80);
   assert.equal(state.attributes[ATTRIBUTE],undefined,'"not listed" is never stored as a settlement');
  });
  await t.test('Cart re-render (quantity change) keeps the current choice and never duplicates listeners',async()=>{
   state.attributes[ATTRIBUTE]='שחר';// server markup now disagrees with the customer's latest choice
   await ev(`fetch('/fragment').then(r=>r.text()).then(html=>{document.querySelector('#drawer-slot').innerHTML=html;})`);
   const [drawerState]=await snapshot();assert.equal(drawerState.state,'unsupported');assert.equal(drawerState.cta,false);
   const before=state.updates.length;
   await choose('drawer','נגה');await wait(`document.querySelector('#drawer fankee-delivery-settlement').dataset.state==='supported'`);await sleep(state.delay+80);
   assert.equal(state.updates.length,before+1,'one save per change after re-render');
   for(const item of await snapshot()){assert.equal(item.state,'supported');assert.equal(item.value,'נגה');assert.equal(item.cta,true);assert.equal(item.checkout,null);}
  });
  await t.test('Rapid changes save only the newest value',async()=>{
   const before=state.updates.length;
   await choose('page','זוהר');await choose('page','תלמים');await choose('page','עוצם');
   await sleep(state.delay*3+150);
   assert.ok(state.updates.length-before<=2);assert.equal(state.attributes[ATTRIBUTE],'עוצם');
  });
  await t.test('Real checkout submission posts the settlement attribute with the cart form',async()=>{
   await ev('location.reload()');await wait('document.readyState==="complete"&&!!customElements.get("fankee-delivery-settlement")&&!!document.querySelector("#page select")');
   await click('#page [name=checkout]');await wait('!!document.querySelector("#checkout")');
   const last=state.checkouts.at(-1).form;assert.equal(last['attributes['+ATTRIBUTE+']'],'עוצם');assert.equal(last.checkout,'');
  });
  await t.test('Mobile and desktop RTL layout: no horizontal overflow, labelled, visible focus',async()=>{
   for(const [width,height,mobile] of [[390,844,true],[320,640,true],[1280,900,false]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
    await load(origin+'/');await choose('drawer',null);
    const m=await ev(`(()=>{const e=document.querySelector('#drawer fankee-delivery-settlement'),s=e.querySelector('select'),c=e.querySelector('[data-settlement-cta]');const r=e.getBoundingClientRect(),sr=s.getBoundingClientRect(),cr=c.getBoundingClientRect();s.focus();const o=getComputedStyle(s);return {overflow:document.documentElement.scrollWidth>innerWidth,inside:sr.left>=r.left-1&&sr.right<=r.right+1&&cr.left>=r.left-1&&cr.right<=r.right+1,selectHeight:sr.height,ctaHeight:cr.height,direction:getComputedStyle(e).direction,outline:o.outlineStyle,outlineWidth:o.outlineWidth,labelRight:Math.round(e.querySelector('label').getBoundingClientRect().right),boxRight:Math.round(r.right)};})()`);
    assert.equal(m.overflow,false,width+': no horizontal overflow');assert.equal(m.inside,true,width);
    assert.ok(m.selectHeight>=44&&m.ctaHeight>=44,width+': touch targets');assert.equal(m.direction,'rtl');
    assert.ok(m.boxRight-m.labelRight<=20,width+': label starts on the right');
    assert.ok(m.outline!=='none'&&parseFloat(m.outlineWidth)>=2,width+': visible keyboard focus');
   }
  });
  assert.deepEqual(errors,[]);
 }finally{ws?.close();chrome?.kill();server.close();await sleep(300);fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
