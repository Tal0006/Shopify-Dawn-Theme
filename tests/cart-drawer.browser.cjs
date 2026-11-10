const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('AJAX cart drawer browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}'+fs.readFileSync(path.join(root,'assets/bootstrap-subset.css'),'utf8')+fs.readFileSync(path.join(root,'assets/style.css'),'utf8')+fs.readFileSync(path.join(root,'assets/storefront.css'),'utf8')+css+'</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="title" data-cart-error="Update failed" data-cart-updated="Updated" data-cart-stale="Stale" data-cart-added="Added"><button class="mini-cart-close" autofocus>Close</button><p class="cart-drawer__status" role="status" data-cart-status></p><div class="mini-cart-items"><h2 id="title">Cart</h2></div></dialog></div></header><main><form data-card-cart action="/he/cart/add"><input name="id" value="1000" type="hidden"><input name="quantity" value="1" type="hidden"><button name="add" data-pending-label="Adding">Add</button><p data-card-feedback data-success="Added" data-error="Failed" data-refresh-error="Stale"></p></form></main></body></html>';
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-predictive-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws,call,ev,tab;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const debug='http://'+new URL(browserWS).host;
  tab=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<120;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  await call('Page.enable');await call('Page.bringToFront');await call('Emulation.setFocusEmulationEnabled',{enabled:true});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
  await wait('document.readyState==="complete"');

  await ev(`window.Shopify={routes:{root:'/he/'}};window.count=0;window.calls=[];window.failure='';window.noSection=false;
  window.items=()=>'<header class="cart-drawer__header"><h2 id="title">Cart ('+count+')</h2></header>'+(count?'<form class="cart-drawer__form" action="/cart"><div class="cart-drawer__lines"><article data-cart-line="1000:key" class="cart-drawer__item"><div class="cart-drawer__image"></div><div class="cart-drawer__details"><h3>Product</h3><p class="cart-drawer__price">'+(count*15.9).toFixed(2)+'</p><div class="cart-drawer__quantity"><button type="button" data-cart-delta="-1" '+(count===1?'disabled':'')+'>-</button><input data-cart-quantity name="updates[]" type="number" min="1" step="1" value="'+count+'"><button type="button" data-cart-delta="1">+</button></div><a href="/remove" data-cart-remove>Remove</a></div></article></div><footer class="cart-drawer__summary"><p class="cart-drawer__total">'+(count*15.9).toFixed(2)+'</p><button name="checkout">Checkout</button><a href="/he/cart">Cart</a></footer></form>':'<p class="empty">Empty</p><button data-cart-continue>Continue</button>');
  window.serverHTML=()=>'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" aria-label="Cart '+count+'"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items">'+items()+'</div></div></header>';
  window.fetch=async(input,options={})=>{const url=String(input);const data=options.body?JSON.parse(options.body):null;calls.push({url,data});await new Promise(r=>setTimeout(r,70));if(options.method==='POST'){if(failure==='network')throw Error('Offline');if(failure==='422')return new Response('{}',{status:422});count=url.endsWith('/add.js')?count+data.items[0].quantity:data.quantity;return new Response(JSON.stringify({sections:{header:noSection?null:serverHTML()}}));}if(url.includes('sections='))return new Response(JSON.stringify({header:serverHTML()}));throw Error(url);};
  window.form=document.querySelector('[data-card-cart]');window.add=form.querySelector('button');window.panel=document.querySelector('dialog');window.submit=()=>form.requestSubmit(add);
  `);
  await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
  await t.test('Add stays on page without opening; explicit cart click opens the updated drawer',async()=>{
    await ev('add.focus();submit();submit()');await wait('!form.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),1);assert.equal(await ev('calls.length'),1);
    assert.equal(await ev('panel.open'),false);assert.equal(await ev('document.activeElement===add'),true);await ev('document.querySelector(".cart-toggle-btn").click()');assert.equal(await ev('panel.matches(":modal")'),true);
    assert.equal(await ev('document.activeElement.className'),'mini-cart-close');
    assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');
    assert.equal(await ev('form.querySelector("[data-card-feedback]").textContent'),'Added');
    assert.equal(new URL(await ev('location.href')).pathname,'/');
  });
  await t.test('Native modal contains Tab focus; Escape restores the add button',async()=>{
    for(let i=0;i<12;i++){await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});assert.equal(await ev('panel.contains(document.activeElement)||document.activeElement===document.body'),true);}
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await wait('!panel.open');await wait('document.activeElement.matches(".cart-toggle-btn")');
  });
  await t.test('Quantity updates use line keys, block duplicates, refresh totals and restore control focus',async()=>{
    await ev('document.querySelector(".cart-toggle-btn").click();window.plus=panel.querySelectorAll("[data-cart-delta]")[1];plus.focus();plus.click();plus.click()');await wait('!panel.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),2);assert.equal(await ev('calls.filter(c=>c.url.endsWith("/change.js")).length'),1);
    assert.deepEqual(await ev('calls.at(-1).data'),{id:'1000:key',quantity:2,sections:['header'],sections_url:'/'});
    assert.equal(await ev('panel.querySelector(".cart-drawer__total").textContent'),'31.80');
    assert.equal(await ev('document.activeElement.dataset.cartDelta'),'1');
    await ev('panel.querySelectorAll("[data-cart-delta]")[0].click()');await wait('!panel.hasAttribute("aria-busy")');assert.equal(await ev('count'),1);
  });
  await t.test('422 and network failures preserve server state, show errors, and unlock controls',async()=>{
    for(const failure of ['422','network']){
      await ev('failure='+JSON.stringify(failure)+';panel.querySelectorAll("[data-cart-delta]")[1].click()');await wait('!panel.hasAttribute("aria-busy")');
      assert.equal(await ev('count'),1);assert.equal(await ev('panel.querySelector("[data-cart-status]").textContent'),'Update failed');
      assert.equal(await ev('panel.querySelectorAll("[data-cart-delta]")[1].disabled'),false);
    }await ev('failure=""');
  });
  await t.test('Removal renders empty cart and continue closes with focus restored',async()=>{
    await ev('panel.querySelector("[data-cart-remove]").click()');await wait('!panel.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),0);assert.equal(await ev('document.querySelector(".cart-count").textContent'),'0');assert.equal(await ev('panel.querySelector(".empty").textContent'),'Empty');
    await ev('panel.querySelector("[data-cart-continue]").click()');await wait('!panel.open');
    await wait('document.activeElement.className==="cart-toggle-btn"');
  });
  await t.test('Failed bundled render retries rendering once without repeating mutation; quantities preserved',async()=>{
    await ev('noSection=true;form.querySelector("[name=quantity]").value=3;submit()');await wait('!form.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),3);assert.equal(await ev('calls.at(-2).data.items[0].quantity'),3);assert.ok(await ev('calls.at(-1).url.includes("sections=")'));await ev('noSection=false');
  });
  await t.test('Mobile RTL drawer is right aligned without overflow; close and header reopen work',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    await ev('document.querySelector(".cart-toggle-btn").click()');await wait('panel.open');
    await sleep(250);
    const rect=await ev('(()=>{const r=panel.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,overflow:panel.scrollWidth>panel.clientWidth};})()');
    assert.equal(rect.right,390);assert.ok(rect.width<=390);assert.equal(rect.overflow,false,JSON.stringify(await ev('({client:panel.clientWidth,scroll:panel.scrollWidth,items:[...panel.querySelectorAll("*")].filter(e=>e.scrollWidth>e.clientWidth).map(e=>({tag:e.tagName,cls:e.className,w:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left}))})')));
    await ev('panel.querySelector(".mini-cart-close").click()');await wait('!panel.open');
    await ev('document.querySelector(".cart-toggle-btn").click()');await wait('panel.open');assert.equal(await ev('document.querySelector(".cart-toggle-btn").getAttribute("aria-expanded")'),'true');
    await sleep(250);
    if (process.env.CART_SCREENSHOT_PATH) { const image = await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.CART_SCREENSHOT_PATH,Buffer.from(image.data,'base64')); }
    await ev('panel.querySelector(".mini-cart-close").click()');
  });
  await t.test('Invalid manual quantities do not mutate; valid quantities update asynchronously',async()=>{
    await ev('document.querySelector(".cart-toggle-btn").click();window.before=calls.length;window.qty=panel.querySelector("[data-cart-quantity]");qty.value=-1;qty.dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await ev('calls.length'),await ev('before'));assert.equal(await ev('qty.value'),'3');
    await ev('qty.value=4;qty.focus();qty.dispatchEvent(new Event("change",{bubbles:true}))');await wait('!panel.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),4);assert.equal(await ev('document.activeElement.hasAttribute("data-cart-quantity")'),true);
    await ev('panel.querySelector(".mini-cart-close").click()');await wait('!panel.open');
  });
  await t.test('Backdrop closes, and Theme Editor reload does not duplicate mutation listeners',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await ev('document.querySelector(".cart-toggle-btn").click()');await sleep(250);
    assert.deepEqual(await ev('({right:panel.getBoundingClientRect().right,width:panel.getBoundingClientRect().width})'),{right:1280,width:420});
    await ev('window.clickLog=[];document.addEventListener("click",e=>clickLog.push({tag:e.target.tagName,cls:e.target.className,x:e.clientX,y:e.clientY}),true)');
    await call('Input.dispatchMouseEvent',{type:'mousePressed',x:50,y:400,button:'left',clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:50,y:400,button:'left',clickCount:1});
    await sleep(150);assert.equal(await ev('panel.open'),false,JSON.stringify(await ev('({events:clickLog,rect:panel.getBoundingClientRect().toJSON(),width:innerWidth,modal:panel.matches(":modal")})')));
    await ev('document.querySelector(".storefront-header").parentElement.dispatchEvent(new CustomEvent("shopify:section:load",{bubbles:true}));window.before=calls.filter(c=>c.url.endsWith("/add.js")).length;submit()');
    await wait('!form.hasAttribute("aria-busy")');
    assert.equal(await ev('calls.filter(c=>c.url.endsWith("/add.js")).length'),await ev('before+1'));
    await ev('panel.querySelector(".mini-cart-close").click()');
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
