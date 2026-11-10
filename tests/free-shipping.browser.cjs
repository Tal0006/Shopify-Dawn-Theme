// Free shipping progress meter (snippets/free-shipping-meter.liquid).
// 1. Contract (always): Theme Settings, placement in drawer and cart page, cart value used, no hard-coded threshold.
// 2. Liquid rendering and 3. browser AJAX behaviour render the real snippet with liquidjs and Shopify-like
//    money/t filters. They run when liquidjs is resolvable (NODE_PATH) and are skipped otherwise.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const snippet=read('snippets/free-shipping-meter.liquid');
const he=JSON.parse(read('locales/he.default.json')),en=JSON.parse(read('locales/en.json'));

test('Contract: Theme Settings, placement, cart value and no hard-coded threshold',()=>{
 const group=JSON.parse(read('config/settings_schema.json')).find(item=>item.name==='t:free_shipping_editor.settings');
 assert.ok(group);
 const ids=Object.fromEntries(group.settings.filter(item=>item.id).map(item=>[item.id,item]));
 assert.deepEqual(Object.keys(ids),['free_shipping_enabled','free_shipping_threshold','free_shipping_remaining_text','free_shipping_success_text']);
 assert.equal(ids.free_shipping_enabled.default,true);assert.equal(ids.free_shipping_threshold.type,'number');assert.equal(ids.free_shipping_threshold.default,150);
 const schemaHe=JSON.parse(read('locales/he.schema.json')).free_shipping_editor;
 assert.match(schemaHe.threshold_info,/יש לוודא שסכום זה תואם להגדרת המשלוח החינם ב-Shopify\./);
 for(const locale of ['he.schema.json','en.default.schema.json']){const keys=JSON.parse(read('locales/'+locale)).free_shipping_editor;for(const item of [group,...group.settings])for(const value of [item.name,item.label,item.info,item.content].filter(Boolean))assert.ok(keys[value.replace('t:free_shipping_editor.','')],locale+' '+value);}
 assert.equal(he.free_shipping.remaining,'עוד {{ amount }} למשלוח חינם');assert.equal(he.free_shipping.reached,'מגיע לך משלוח חינם!');
 // One reusable snippet, rendered in the drawer summary (before the total) and on the cart page.
 const drawer=read('snippets/cart-drawer.liquid'),cart=read('sections/main-cart.liquid');
 // Meter first in the summary, then the optional order note, then total and checkout.
 assert.match(drawer,/<footer class="cart-drawer__summary">\s*{% render 'free-shipping-meter', context: 'drawer' %}\s*<details class="cart-drawer__note"[\s\S]*?<\/details>\s*<p class="cart-drawer__total">/);
 assert.match(cart,/{% render 'free-shipping-meter', context: 'cart' %}\s*<p class="catalog-cart-total">/);
 assert.match(drawer,/data-shipping-announcer/);
 assert.doesNotMatch(read('sections/header.liquid'),/free_shipping|shipping_threshold/,'old header threshold removed');
 assert.doesNotMatch(drawer,/cart-drawer__shipping|drawer_shipping/);
 // Shopify values only: cart.total_price vs settings threshold in minor units; Shopify money formatting.
 assert.match(snippet,/assign shipping_threshold = settings\.free_shipping_threshold \| default: 0 \| times: 100 \| round/);
 assert.match(snippet,/assign shipping_total = cart\.total_price\b/);
 assert.match(snippet,/shipping_threshold \| minus: shipping_total \| money/);
 assert.doesNotMatch(snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/,''),/150|15000|shipping_price|total_discount|original_total/);
 const js=read('assets/storefront.js'),hook=js.slice(js.indexOf('function shippingMeterUpdated'),js.indexOf('function renderCardCartSection'));
 assert.ok(hook.length>100);
 assert.doesNotMatch(hook,/fetch\(|150|toFixed|Intl\.NumberFormat|₪/,'no requests, amounts or currency in JavaScript');
 assert.match(snippet,/role="progressbar"[^>]*aria-valuemin="0" aria-valuemax="100" aria-valuenow="{{ shipping_percent }}" aria-valuetext=/);
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
function engine(locale=he){
 const liquid=new Liquid();
 const lookup=key=>key.split('.').reduce((a,k)=>a?.[k],locale);
 liquid.registerFilter('t',(key,...args)=>{let value=lookup(key);assert.equal(typeof value,'string',key);for(const [k,v] of args.filter(Array.isArray))value=value.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),v);return value;});
 // Shopify ILS money format "₪{{amount}}": minor units → 1,234.50.
 liquid.registerFilter('money',cents=>'₪'+(Number(cents)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}));
 liquid.registerFilter('divided_by',(a,b)=>Number.isInteger(a)&&Number.isInteger(b)?Math.floor(a/b):a/b);
 liquid.registerFilter('handleize',value=>String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-'));
 const template=liquid.parse(snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''));
 return ({total,count=total>0?1:0,settings={},currency='ILS',context='drawer'})=>liquid.render(template,{context,shop:{currency:'ILS'},cart:{total_price:total,item_count:count,currency:{iso_code:currency}},settings:{free_shipping_enabled:true,free_shipping_threshold:150,free_shipping_remaining_text:'',free_shipping_success_text:'',...settings}});
}
function parse(html){
 if(!html.trim())return null;
 const attr=(name,source=html)=>source.match(new RegExp(name+'="([^"]*)"'))?.[1];
 const track=html.match(/<div class="free-shipping__track"[^>]*>/)[0];
 return {reached:attr('data-reached'),progress:Number(attr('data-progress')),now:Number(attr('aria-valuenow',track)),valuetext:attr('aria-valuetext',track),bar:Number(html.match(/--free-shipping-progress: (\d+)"/)[1]),
  text:html.match(/<span class="free-shipping__text" data-shipping-text>([\s\S]*?)<\/span>\s*<\/p>/)[1].replace(/<[^>]+>/g,''),amount:html.match(/<bdi class="free-shipping__amount">([^<]*)<\/bdi>/)?.[1]??null,html};
}

test('Liquid rendering: thresholds, amounts, progress and settings',{skip:SKIP},async()=>{
 const render=engine();
 const cases=[
  // [cart total in agorot, reached, progress, remaining]
  [7500,'false',50,'₪75.00'],
  [11750,'false',78,'₪32.50'],
  [14999,'false',99,'₪0.01'],
  [15000,'true',100,null],
  [20000,'true',100,null],
  [999999,'true',100,null]
 ];
 for(const [total,reached,progress,amount] of cases){
  const m=parse(await render({total}));
  assert.equal(m.reached,reached,total);assert.equal(m.progress,progress,total);assert.equal(m.now,progress);assert.equal(m.bar,progress);
  assert.equal(m.amount,amount,total);
  if(amount){assert.equal(m.text,'עוד '+amount+' למשלוח חינם');assert.equal(m.valuetext,'עוד '+amount+' למשלוח חינם');}
  else{assert.equal(m.text,'מגיע לך משלוח חינם!');assert.equal(m.valuetext,m.text);assert.match(m.html,/free-shipping--reached/);}
  assert.ok(m.progress>=0&&m.progress<=100);assert.doesNotMatch(m.html,/₪-|-₪/,'never negative');
 }
 // Nothing for an empty cart, when disabled, for a non-positive/missing threshold, or another currency.
 for(const options of [{total:0,count:0},{total:5000,settings:{free_shipping_enabled:false}},{total:5000,settings:{free_shipping_threshold:0}},{total:5000,settings:{free_shipping_threshold:-10}},{total:5000,settings:{free_shipping_threshold:null}},{total:5000,currency:'USD'}])assert.equal((await render(options)).trim(),'',JSON.stringify(options));
 // Threshold from Theme Settings, including decimals and thousands formatting.
 assert.equal(parse(await render({total:5000,settings:{free_shipping_threshold:99.5}})).amount,'₪49.50');
 assert.equal(parse(await render({total:5000,settings:{free_shipping_threshold:1300}})).amount,'₪1,250.00');
 assert.equal(parse(await render({total:9950,settings:{free_shipping_threshold:99.5}})).reached,'true');
 // Discounts: cart.total_price is already after discounts, so a ₪200 cart discounted to ₪140 is below ₪150.
 assert.equal(parse(await render({total:14000})).amount,'₪10.00');
 // Custom merchant text with the {{ amount }} placeholder is escaped; the amount stays formatted.
 const custom=parse(await render({total:10000,settings:{free_shipping_remaining_text:'עוד {{ amount }} <b>ומשלוח</b> עלינו',free_shipping_success_text:'יש! "חינם"'}}));
 assert.equal(custom.text,'עוד ₪50.00 &lt;b&gt;ומשלוח&lt;/b&gt; עלינו');assert.equal(custom.amount,'₪50.00');
 assert.match(parse(await render({total:15000,settings:{free_shipping_success_text:'יש! "חינם"'}})).html,/יש! &(quot|#34);חינם&(quot|#34);/);
 // English locale keeps the placeholder working.
 assert.equal(parse(await engine(en)({total:11750})).text,'₪32.50 more for free shipping');
 assert.match(await render({total:5000,context:'cart'}),/free-shipping--cart/);
});

test('Browser: drawer and cart page update live, RTL, mobile, accessibility and motion',{skip:SKIP,timeout:180000},async t=>{
 const render=engine();
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['bootstrap.min.css','style.css','storefront.css','accessibility.css'].map(file=>read('assets/'+file)).join('')+block('snippets/storefront-design.liquid')+block('snippets/cart-drawer.liquid')+block('snippets/free-shipping-meter.liquid');
 const page=(dir='rtl')=>`<!doctype html><html dir="${dir}" lang="${dir==='rtl'?'he':'en'}"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="title" data-cart-error="שגיאה" data-cart-updated="העגלה עודכנה" data-cart-stale="Stale" data-cart-added="Added"><button class="mini-cart-close" autofocus>Close</button><p class="cart-drawer__status" role="status" aria-live="polite" data-cart-status></p><p class="sr-only" aria-live="polite" aria-atomic="true" data-shipping-announcer></p><div class="mini-cart-items"></div></dialog></div></header><main><section class="catalog-section container" data-cart-page></section><form data-card-cart action="/he/cart/add"><input name="id" value="1000" type="hidden"><input name="quantity" value="1" type="hidden"><button name="add" data-pending-label="Adding">Add</button><p data-card-feedback data-success="Added" data-error="Failed" data-refresh-error="Stale"></p></form></main><button class="a11y-launcher" type="button">נגישות</button></body></html>`;
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x');
  if(url.pathname==='/meter'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(await render({total:Number(url.searchParams.get('total')),count:Number(url.searchParams.get('count')),context:url.searchParams.get('context')||'drawer'}));return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(page(url.searchParams.get('dir')||'rtl'));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-shipping-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws,call,ev;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<240;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  // A Shopify-like cart: one line at ₪40 (4000 agorot) with an optional cart discount. Each mutation answers with the
  // re-rendered header section, whose drawer contains the meter rendered by the real snippet for the new total.
  const setup=async({count=3,unit=4000,discount=0,cartPage=false}={})=>{
   await ev(`(async()=>{window.Shopify={routes:{root:'/he/'}};window.count=${count};window.unit=${unit};window.discount=${discount};window.calls=[];window.failure='';
   const realFetch=window.fetch.bind(window);
   window.total=()=>Math.max(0,count*unit-discount);
   window.meter=context=>realFetch('/meter?total='+total()+'&count='+count+'&context='+context).then(r=>r.text());
   window.items=async()=>'<header class="cart-drawer__header"><h2 id="title">Cart ('+count+')</h2></header>'+(count?'<form class="cart-drawer__form" action="/cart"><div class="cart-drawer__lines"><article data-cart-line="1000:key" class="cart-drawer__item"><div class="cart-drawer__image"></div><div class="cart-drawer__details"><h3>מוצר</h3><p class="cart-drawer__price">'+(total()/100).toFixed(2)+'</p><div class="cart-drawer__controls"><div class="cart-drawer__quantity"><button type="button" data-cart-delta="-1" aria-label="פחות" '+(count===1?'disabled':'')+'>-</button><input data-cart-quantity aria-label="כמות" name="updates[]" type="number" min="1" step="1" value="'+count+'"><button type="button" data-cart-delta="1" aria-label="עוד">+</button></div><a href="/remove" data-cart-remove>הסרה</a></div></div></article></div><footer class="cart-drawer__summary">'+await meter('drawer')+'<p class="cart-drawer__total"><span>סה"כ</span><bdi>₪'+(total()/100).toFixed(2)+'</bdi></p><button type="submit" name="checkout" class="theme-btn">לתשלום</button><a class="cart-drawer__view" href="/he/cart">לעגלה</a></footer></form>':'<div class="cart-drawer__empty"><p>העגלה ריקה</p><button type="button" data-cart-continue>המשך</button></div>');
   window.serverHTML=async()=>'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" aria-label="Cart '+count+'"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items">'+await items()+'</div></div></header>';
   window.fetch=async(input,options={})=>{const url=String(input);const data=options.body?JSON.parse(options.body):null;calls.push({url,method:options.method||'GET'});await new Promise(r=>setTimeout(r,60));
    if(options.method==='POST'){if(failure==='422')return new Response('{}',{status:422});count=url.endsWith('/add.js')?count+data.items[0].quantity:data.quantity;return new Response(JSON.stringify({sections:{header:await serverHTML()}}));}
    if(url.includes('sections='))return new Response(JSON.stringify({header:await serverHTML()}));throw Error('unexpected request '+url);};
   document.querySelector('.mini-cart-items').innerHTML=await items();
   document.querySelector('.cart-count').textContent=count;
   ${cartPage?"document.querySelector('[data-cart-page]').innerHTML=await meter('cart');":''}
   window.panel=document.querySelector('dialog');window.form=document.querySelector('[data-card-cart]');window.announcer=document.querySelector('[data-shipping-announcer]');
   window.state=(root=panel)=>{const m=root.querySelector('[data-shipping-meter]');if(!m)return null;const t=m.querySelector('[role=progressbar]');return {reached:m.dataset.reached,now:t.getAttribute('aria-valuenow'),valuetext:t.getAttribute('aria-valuetext'),text:m.querySelector('[data-shipping-text]').textContent.trim()};};})()`);
   await ev(read('assets/storefront.js'));
  };
  const open=async(width=1280,dir='rtl')=>{await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});await call('Page.navigate',{url:base+'?dir='+dir});await wait('document.readyState==="complete"');};
  const settle=()=>wait('!panel.hasAttribute("aria-busy")&&!form.hasAttribute("aria-busy")&&document.getAnimations().every(a=>a.playState!=="running")');
  const transformX=`(()=>{const m=new DOMMatrix(getComputedStyle(panel.querySelector('.free-shipping__bar')).transform);return Math.round(m.a*100)})()`;
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});

  await t.test('Initial drawer: remaining amount, progress semantics and RTL fill from the right',async()=>{
   await open();await setup({count:3});
   await ev('document.querySelector(".cart-toggle-btn").click()');await settle();
   assert.deepEqual(await ev('state()'),{reached:'false',now:'80',valuetext:'עוד ₪30.00 למשלוח חינם',text:'עוד ₪30.00 למשלוח חינם'});
   assert.equal(await ev(transformX),80);
   const g=await ev('(()=>{const t=panel.querySelector(".free-shipping__track").getBoundingClientRect(),b=panel.querySelector(".free-shipping__bar").getBoundingClientRect(),label=panel.querySelector("[role=progressbar]").getAttribute("aria-label");return {right:Math.abs(t.right-b.right)<1,left:b.left>t.left+1,within:b.left>=t.left-0.5&&b.right<=t.right+0.5,label,icon:panel.querySelector(".free-shipping__icon").getAttribute("aria-hidden")}})()');
   assert.deepEqual(g,{right:true,left:true,within:true,label:'התקדמות למשלוח חינם',icon:'true'});
   assert.equal(await ev('panel.querySelector(".free-shipping").compareDocumentPosition(panel.querySelector(".cart-drawer__total"))&Node.DOCUMENT_POSITION_FOLLOWING'),4,'meter before total and checkout');
  });
  await t.test('Quantity increase crosses the threshold immediately, with one request, one announcement and a one-time cue',async()=>{
   await ev('calls.length=0;panel.querySelectorAll("[data-cart-delta]")[1].click()');
   await wait('panel.querySelector("[data-shipping-meter]")?.dataset.reached==="true"');
   assert.equal(await ev('panel.querySelector("[data-shipping-meter]").hasAttribute("data-celebrate")'),true);
   assert.equal(await ev('getComputedStyle(panel.querySelector(".free-shipping__bar")).transitionDuration!=="0s"'),true,'smooth bar');
   await settle();await sleep(250);
   assert.deepEqual(await ev('state()'),{reached:'true',now:'100',valuetext:'מגיע לך משלוח חינם!',text:'מגיע לך משלוח חינם!'});
   assert.equal(await ev(transformX),100);
   assert.equal(await ev('announcer.textContent'),'מגיע לך משלוח חינם!');
   assert.deepEqual(await ev('calls.filter(c=>!c.url.endsWith("cart.js")).map(c=>c.method+" "+c.url.split("/").pop())'),['POST change.js'],'no extra cart requests');
   assert.equal(await ev('getComputedStyle(panel.querySelector(".free-shipping__icon")).animationIterationCount'),'1');
   // Staying above the threshold does not announce again.
   await ev('panel.querySelectorAll("[data-cart-delta]")[1].click()');await settle();await sleep(250);
   assert.equal(await ev('announcer.textContent'),'');
  });
  await t.test('Quantity decrease below the threshold shows the remaining amount again and announces once',async()=>{
   await ev('panel.querySelectorAll("[data-cart-delta]")[0].click()');await settle();
   await ev('panel.querySelectorAll("[data-cart-delta]")[0].click()');await settle();await sleep(250);
   assert.deepEqual(await ev('state()'),{reached:'false',now:'80',valuetext:'עוד ₪30.00 למשלוח חינם',text:'עוד ₪30.00 למשלוח חינם'});
   assert.equal(await ev(transformX),80);
   assert.equal(await ev('announcer.textContent'),'עוד ₪30.00 למשלוח חינם');
  });
  await t.test('Rapid clicks, failed updates and reopening keep the meter consistent with the server cart',async()=>{
   await ev('const plus=panel.querySelectorAll("[data-cart-delta]")[1];plus.click();plus.click();plus.click()');await settle();
   assert.equal(await ev('count'),4,'duplicate clicks blocked while pending');
   assert.equal((await ev('state()')).reached,'true');
   await ev('failure="422";panel.querySelectorAll("[data-cart-delta]")[0].click()');await settle();
   assert.equal(await ev('count'),4);assert.equal((await ev('state()')).reached,'true','failed update leaves the last server state');
   await ev('failure="";panel.close()');await wait('!panel.open');
   await ev('document.querySelector(".cart-toggle-btn").click()');await wait('panel.open');
   assert.equal((await ev('state()')).now,'100','reopened drawer shows the current state');
  });
  await t.test('Removing the last item hides the meter; add to cart from the page brings it back',async()=>{
   await ev('panel.querySelector("[data-cart-remove]").click()');await settle();
   assert.equal(await ev('state()'),null);assert.equal(await ev('count'),0);
   await ev('panel.close()');await wait('!panel.open');
   await ev('form.requestSubmit(form.querySelector("[name=add]"))');await settle();
   assert.deepEqual(await ev('state()'),{reached:'false',now:'26',valuetext:'עוד ₪110.00 למשלוח חינם',text:'עוד ₪110.00 למשלוח חינם'});
   assert.equal(await ev('panel.open'),false,'adding does not open the drawer');
   assert.equal(await ev('announcer.textContent'),'','no announcement below the threshold');
  });
  await t.test('Exactly the threshold counts as free shipping; discounts use the discounted total',async()=>{
   await open();await setup({count:3,unit:5000});
   assert.equal((await ev('state()')).reached,'true');
   await open();await setup({count:4,unit:5000,discount:5001});
   assert.equal((await ev('state()')).text,'עוד ₪0.01 למשלוח חינם');
  });
  await t.test('Cart page meter uses the same snippet and follows drawer changes without a reload',async()=>{
   await open();await setup({count:3,cartPage:true});
   assert.equal(await ev('state(document.querySelector("[data-cart-page]")).now'),'80');
   await ev('document.querySelector(".cart-toggle-btn").click()');await wait('panel.open');
   await ev('panel.querySelectorAll("[data-cart-delta]")[1].click()');await settle();
   const page=await ev('(()=>{const m=document.querySelector("[data-cart-page] [data-shipping-meter]");return {cls:m.className,state:state(document.querySelector("[data-cart-page]"))}})()');
   assert.match(page.cls,/free-shipping--cart/);assert.equal(page.state.reached,'true');
   assert.equal(await ev('document.querySelectorAll("[data-cart-page] [data-shipping-meter]").length'),1);
  });
  await t.test('LTR (English) fills from the left',async()=>{
   await open(1280,'ltr');await setup({count:3});
   await ev('document.querySelector(".cart-toggle-btn").click()');await settle();
   assert.equal(await ev('(()=>{const t=panel.querySelector(".free-shipping__track").getBoundingClientRect(),b=panel.querySelector(".free-shipping__bar").getBoundingClientRect();return Math.abs(t.left-b.left)<1&&b.right<t.right-1})()'),true);
  });
  await t.test('Mobile and desktop widths: compact, no overflow, amount never clipped, checkout visible',async()=>{
   for(const width of [320,360,390,768,1280]){
    await open(width);await setup({count:1,unit:12345});
    await ev('document.querySelector(".cart-toggle-btn").click()');await settle();
    const m=await ev(`(()=>{const meter=panel.querySelector(".free-shipping"),r=meter.getBoundingClientRect(),amount=panel.querySelector(".free-shipping__amount"),a=amount.getBoundingClientRect(),checkout=panel.querySelector("[name=checkout]").getBoundingClientRect(),launcher=document.querySelector(".a11y-launcher").getBoundingClientRect();
     return {overflow:panel.scrollWidth>panel.clientWidth||document.documentElement.scrollWidth>innerWidth,meterInside:r.left>=panel.getBoundingClientRect().left&&r.right<=panel.getBoundingClientRect().right,amountInside:a.left>=r.left&&a.right<=r.right&&amount.scrollWidth<=amount.clientWidth+1,height:Math.round(r.height),checkoutVisible:checkout.bottom<=innerHeight&&checkout.top>=0,checkoutHeight:checkout.height,text:panel.querySelector("[data-shipping-text]").textContent}})()`);
    assert.equal(m.overflow,false,'overflow '+width);assert.equal(m.meterInside,true);assert.equal(m.amountInside,true,'amount clipped '+width);
    assert.ok(m.height<=96,'compact meter '+width+': '+m.height);assert.equal(m.checkoutVisible,true,'checkout visible '+width);assert.ok(m.checkoutHeight>=44);
    assert.equal(m.text,'עוד ₪26.55 למשלוח חינם');
   }
  });
  await t.test('Reduced motion and the accessibility pause: instant bar, no completion animation',async()=>{
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await open();await setup({count:3});
   await ev('document.querySelector(".cart-toggle-btn").click()');await settle();
   await ev('panel.querySelectorAll("[data-cart-delta]")[1].click()');await wait('!panel.hasAttribute("aria-busy")');
   assert.deepEqual(await ev('[getComputedStyle(panel.querySelector(".free-shipping__bar")).transitionDuration,getComputedStyle(panel.querySelector(".free-shipping__icon")).animationName]'),['0s','none']);
   assert.equal(await ev(transformX),100);
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await open();await setup({count:3});
   await ev('document.documentElement.setAttribute("data-a11y-paused","");document.querySelector(".cart-toggle-btn").click()');await settle();
   await ev('panel.querySelectorAll("[data-cart-delta]")[1].click()');await wait('!panel.hasAttribute("aria-busy")');
   assert.deepEqual(await ev('[getComputedStyle(panel.querySelector(".free-shipping__bar")).transitionDuration,getComputedStyle(panel.querySelector(".free-shipping__icon")).animationName,document.getAnimations().filter(a=>a.effect?.target?.closest?.(".free-shipping")).length]'),['0s','none',0],'meter is still (the drawer keeps its own pre-existing open animation)');
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
