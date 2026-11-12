const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Mobile add-to-cart loading and submission regression',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const guard=fs.readFileSync(path.join(root,'snippets/cart-submit-guard.liquid'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const toastCSS=fs.readFileSync(path.join(root,'snippets/cart-toast.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}'+fs.readFileSync(path.join(root,'assets/theme.css'),'utf8')+fs.readFileSync(path.join(root,'assets/storefront.css'),'utf8')+css+toastCSS+'</style><script>'+guard+'</script></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="title" data-cart-error="Update failed" data-cart-updated="Updated" data-cart-stale="Stale" data-cart-added="Added"><button class="mini-cart-close" autofocus>Close</button><p class="cart-drawer__status" role="status" data-cart-status></p><div class="mini-cart-items"><h2 id="title">Cart</h2></div></dialog></div></header><main><form data-card-cart action="/he/cart/add"><input name="id" value="1000" type="hidden"><input name="quantity" value="1" type="hidden"><button name="add" data-pending-label="Adding">Add</button><p data-card-feedback data-success="Added" data-error="Failed" data-refresh-error="Stale"></p></form></main><div class="cart-toast" data-cart-toast data-success="Success" hidden><p role="status" aria-live="polite" data-cart-toast-message></p><a href="/he/cart">View cart</a></div></body></html>';
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
  const wait=async expression=>{for(let i=0;i<180;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  await call('Page.enable');await call('Page.bringToFront');await call('Emulation.setFocusEmulationEnabled',{enabled:true});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
  await wait('document.readyState==="complete"');

  await ev(`window.Shopify={routes:{root:'/he/'}};window.count=0;window.calls=[];window.failure='';window.noSection=false;
  window.items=()=>'<header class="cart-drawer__header"><h2 id="title">Cart ('+count+')</h2></header>'+(count?'<form class="cart-drawer__form" action="/cart"><div class="cart-drawer__lines"><article data-cart-line="1000:key" class="cart-drawer__item"><div class="cart-drawer__image"></div><div class="cart-drawer__details"><h3>Product</h3><p class="cart-drawer__price">'+(count*15.9).toFixed(2)+'</p><div class="cart-drawer__quantity"><button type="button" data-cart-delta="-1" '+(count===1?'disabled':'')+'>-</button><input data-cart-quantity name="updates[]" type="number" min="1" step="1" value="'+count+'"><button type="button" data-cart-delta="1">+</button></div><a href="/remove" data-cart-remove>Remove</a></div></article></div><footer class="cart-drawer__summary"><p class="cart-drawer__total">'+(count*15.9).toFixed(2)+'</p><button name="checkout">Checkout</button><a href="/he/cart">Cart</a></footer></form>':'<p class="empty">Empty</p><button data-cart-continue>Continue</button>');
  window.serverHTML=()=>'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" aria-label="Cart '+count+'"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items">'+items()+'</div></div></header>';
  window.fetch=async(input,options={})=>{const url=String(input);const data=options.body?JSON.parse(options.body):null;calls.push({url,data});await new Promise(r=>setTimeout(r,70));if(options.method==='POST'){if(failure==='network')throw Error('Offline');if(failure==='422')return new Response('{}',{status:422});count=url.endsWith('/add.js')?count+data.items[0].quantity:data.quantity;return new Response(JSON.stringify({sections:{header:noSection?null:serverHTML()}}));}if(url.endsWith('/cart.js'))return new Response(JSON.stringify({item_count:count}));if(url.includes('sections='))return new Response(JSON.stringify({header:serverHTML()}));throw Error(url);};
  window.form=document.querySelector('[data-card-cart]');window.add=form.querySelector('button');window.panel=document.querySelector('dialog');window.submit=()=>form.requestSubmit(add);
  `);

  const tap=async()=>{const point=await ev('(()=>{const r=add.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:1}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await call('Emulation.setTouchEmulationEnabled',{enabled:true});
  await t.test('Mobile tap before deferred JavaScript is ready is blocked from native navigation and queued once',async()=>{
    await tap();await tap();assert.equal(await ev('form.hasAttribute("aria-busy")'),true);assert.equal(await ev('add.disabled'),true);
    assert.equal(await ev('calls.length'),0);assert.equal(new URL(await ev('location.href')).pathname,'/');
  });
  await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
  await t.test('Queued mobile tap hands off once to AJAX, refreshes count, shows toast, and preserves browsing',async()=>{
    await wait('!form.hasAttribute("aria-busy")');assert.equal(await ev('calls.filter(c=>c.url.endsWith("/add.js")).length'),1);
    assert.equal(await ev('count'),1);assert.equal(await ev('panel.open'),false);assert.equal(await ev('document.querySelector("[data-cart-toast]").hidden'),false);assert.equal(await ev('panel.textContent.includes("Product")'),true);
    assert.equal(new URL(await ev('location.href')).pathname,'/');
    await ev('document.querySelector(".cart-toggle-btn").click()');assert.equal(await ev('panel.open'),true);await ev('panel.querySelector(".mini-cart-close").click()');await wait('!panel.open');
  });
  await t.test('Mobile homepage and collection taps, including a dynamically inserted second product, stay on page',async()=>{
    for(const path of ['/','/collections/cleaning']){
      await ev('history.replaceState(null,"",'+JSON.stringify(path)+');window.before=count');
      await tap();await wait('!form.hasAttribute("aria-busy")');assert.equal(await ev('count'),await ev('before+1'));assert.equal(await ev('panel.open'),false);
      assert.equal(new URL(await ev('location.href')).pathname,path);await ev('panel.querySelector(".mini-cart-close").click()');
    }
    await ev('window.newForm=form.cloneNode(true);newForm.querySelector("[name=id]").value="1001";form.after(newForm);window.before=count;window.form=newForm;window.add=form.querySelector("[name=add]")');
    await tap();await wait('!form.hasAttribute("aria-busy")');assert.equal(await ev('count'),await ev('before+1'));assert.equal(await ev('calls.at(-1).data.items[0].id'),'1001');
    assert.equal(await ev('panel.open'),false);await ev('panel.querySelector(".mini-cart-close").click()');
  });
  await t.test('Far-down mobile adds preserve scroll, reuse one toast, pause for interaction and auto-dismiss',async()=>{
    await ev('document.querySelector("main").style.paddingTop="1800px";document.querySelector("main").style.paddingBottom="1000px";add.scrollIntoView({block:"center"});window.beforeScroll=scrollY');
    await tap();await wait('!form.hasAttribute("aria-busy")');
    assert.equal(await ev('scrollY'),await ev('beforeScroll'));assert.equal(await ev('panel.open'),false);
    assert.equal(await ev('document.querySelectorAll("[data-cart-toast]").length'),1);
    assert.equal(await ev('document.querySelector("[data-cart-toast] a").getAttribute("href")'),'/he/cart');
    assert.equal(await ev('document.querySelector("[data-cart-toast]").contains(document.activeElement)'),false);
    await ev('document.querySelector("[data-cart-toast] a").focus({preventScroll:true})');await sleep(3400);
    assert.equal(await ev('document.querySelector("[data-cart-toast]").hidden'),false);
    await ev('add.focus({preventScroll:true})');await wait('document.querySelector("[data-cart-toast]").hidden');
    assert.equal(await ev('scrollY'),await ev('beforeScroll'));
    await tap();await wait('!form.hasAttribute("aria-busy")');assert.equal(await ev('panel.open'),false);
    await wait('document.querySelector("[data-cart-toast]").hidden');
    await ev('document.querySelector("main").style.paddingTop="0";document.querySelector("main").style.paddingBottom="0";scrollTo(0,0)');
  });
  await t.test('Desktop homepage and collection native button submissions use the same AJAX handler',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    for(const path of ['/','/collections/cleaning']){
      await ev('history.replaceState(null,"",'+JSON.stringify(path)+');window.before=count;add.click()');await wait('!form.hasAttribute("aria-busy")');
      assert.equal(await ev('count'),await ev('before+1'));assert.equal(new URL(await ev('location.href')).pathname,path);
      assert.equal(await ev('panel.open'),false);
    }
  });
  await t.test('Mobile network and 422 failures remain on page with persistent accessible errors',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    for(const failure of ['network','422']){
      await ev('failure='+JSON.stringify(failure)+';window.before=count');await tap();await wait('!form.hasAttribute("aria-busy")');
      assert.equal(await ev('count'),await ev('before'));assert.equal(await ev('document.querySelector("[data-cart-toast]").hasAttribute("data-error")'),true);
      assert.equal(await ev('add.disabled'),false);assert.equal(new URL(await ev('location.href')).pathname,'/collections/cleaning');
    }await ev('failure=""');
  });
  await t.test('Without a drawer, mobile AJAX add displays success and never redirects',async()=>{
    await ev('panel.remove();window.before=count');await tap();await wait('!form.hasAttribute("aria-busy")');
    assert.equal(await ev('count'),await ev('before+1'));assert.equal(await ev('document.querySelector("[data-cart-toast-message]").textContent'),'Success');
    assert.equal(new URL(await ev('location.href')).pathname,'/collections/cleaning');
  });
  await t.test('Asset-load failure unlocks the queued mobile form and reports an error without normal submission',async()=>{
    await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
    await wait('document.readyState==="complete"');
    await ev('window.form=document.querySelector("[data-card-cart]");window.add=form.querySelector("[name=add]")');
    await tap();assert.equal(await ev('add.disabled'),true);
    await ev('window.dispatchEvent(new ErrorEvent("error",{filename:location.origin+"/storefront.js"}))');
    assert.equal(await ev('add.disabled'),false);assert.equal(await ev('form.querySelector("[data-card-feedback]").textContent'),'Failed');
    await tap();assert.equal(await ev('add.disabled'),false);assert.equal(new URL(await ev('location.href')).pathname,'/');
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
