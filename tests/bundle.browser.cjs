const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Bought together browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'sections/frequently-bought-together.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>'+['bootstrap.min.css','style.css','storefront.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('')+css+'</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="cart-title" data-cart-added="Added"><button class="mini-cart-close">Close</button><p data-cart-status></p><div class="mini-cart-items"><h2 id="cart-title">Cart</h2></div></dialog></div></header><main></main><footer><a data-store-whatsapp href="https://wa.me/123456789">Chat</a></footer></body></html>';
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




  const bundleHTML=(count=3)=>'<section class="container bundle-section" data-bundle data-product-id="100" data-currency="ILS" data-locale="he" data-in-stock="Available" data-sold-out="Sold out" data-options-required="Choose options"><header class="catalog-section-header"><h2>Bought together</h2></header><form data-card-cart data-bundle-cart action="/he/cart/add"><input type="hidden" name="id" value="11"><div class="bundle-section__items">'+Array.from({length:count+1},(_,i)=>'<article class="bundle-item" '+(!i?'data-bundle-main':'')+'><label class="bundle-item__check"><input type="checkbox" name="bundle_variant" value="'+[11,12,13,14][i]+'" data-price="'+[1590,1250,330,999][i]+'" '+(!i?'data-bundle-main-choice':'')+' checked><span class="sr-only">Select '+i+'</span></label><div class="bundle-item__image"></div><div class="bundle-item__content"><h3><a href="/products/'+i+'">Long product title '+i+'</a></h3><div data-bundle-price><div class="catalog-price"><bdi>Current price</bdi><s>Old price</s></div></div><p data-bundle-availability>Available</p></div></article>').join('')+'</div><div class="bundle-section__summary"><p role="status" aria-live="polite">Total <bdi data-bundle-total></bdi></p><button class="theme-btn" name="add" disabled data-pending-label="Adding">Add selected</button></div><p data-card-feedback data-success="All selected added" data-error="Check cart before retry" data-refresh-error="Added; refresh failed" role="status"></p></form><script type="application/json" data-bundle-variants>'+JSON.stringify([{id:"11",price:1590,available:true,safe:true},{id:"22",price:2990,available:true,safe:true},{id:"33",price:500,available:false,safe:true},{id:"44",price:990,available:true,safe:false}])+'</script></section>';
  await ev('window.bundleHTML='+bundleHTML.toString());
  await ev(`
   window.Shopify={routes:{root:'/he/'}};
   window.calls=[];window.mode='ok';window.slow=false;window.count=2;
   window.headerHTML=()=>'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items">Cart items '+count+'</div></div></header>';
   window.fetch=async(input,options={})=>{
    const url=String(input);calls.push({url,body:options.body?JSON.parse(options.body):null});
    if(url.endsWith('/cart/add.js')){
     if(slow)await new Promise(r=>setTimeout(r,150));
     if(mode==='network')throw Error('secret upstream error');
     if(mode==='422')return new Response('private upstream error',{status:422});
     const body=JSON.parse(options.body);
     const items=mode==='partial'?body.items.slice(0,1):body.items;
     count+=items.length;
     if(mode==='invalid')return new Response('not json');
     return new Response(JSON.stringify({items,sections:{header:headerHTML()}}));
    }
    if(url.endsWith('/cart.js'))return new Response(JSON.stringify({item_count:count}));
    if(url.includes('sections='))return new Response(JSON.stringify({header:headerHTML()}));
    throw Error('Unexpected request');
   };
   document.querySelector('main').innerHTML='<section data-product-page data-product-id="100"><div data-product-purchase data-selected-variant="11" data-selected-price="1590" data-selected-available="true" data-selected-unit-safe="true"><div class="product-page__price"><div class="catalog-price">Selected variant price</div></div></div><select name="id" data-product-variant><option value="11">One</option><option value="22">Two</option><option value="33">Unavailable</option><option value="44">Rules</option></select></section>';
  `);
  await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
  await ev(fs.readFileSync(path.join(root,'assets/frequently-bought-together.js'),'utf8'));
  await t.test('No configuration leaves no bundle UI or additional requests',async()=>{
   assert.equal(await ev('document.querySelector("[data-bundle]")'),null);
   assert.equal(await ev('calls.length'),0);
  });
  const mount=async count=>{
   await ev('document.querySelector("[data-bundle]")?.closest(".bundle-fixture").remove();var wrap=document.createElement("div");wrap.className="bundle-fixture";wrap.innerHTML=bundleHTML('+count+');document.querySelector("main").append(wrap);wrap.dispatchEvent(new CustomEvent("shopify:section:load",{bubbles:true}));window.bundle=wrap.querySelector("[data-bundle]");window.bundleForm=bundle.querySelector("form");window.addButton=bundleForm.querySelector("[name=add]")');
  };
  await t.test('One, two and three companions use numeric minor units and selection totals',async()=>{
   for(const [number,total] of [[1,28.4],[2,31.7],[3,41.69]]){
    await mount(number);
    const expected=new Intl.NumberFormat('he',{style:'currency',currency:'ILS'}).format(total);
    assert.equal(await ev('bundle.querySelector("[data-bundle-total]").textContent'),expected);
   }
   await ev('const choice=bundleForm.querySelectorAll("[name=bundle_variant]")[1];choice.checked=false;choice.dispatchEvent(new Event("change",{bubbles:true}))');
   assert.equal(await ev('bundle.querySelector("[data-bundle-total]").textContent'),new Intl.NumberFormat('he',{style:'currency',currency:'ILS'}).format(29.19));
   await ev('bundleForm.querySelectorAll("[name=bundle_variant]").forEach(c=>c.checked=false);bundleForm.dispatchEvent(new Event("change",{bubbles:true}))');
   assert.equal(await ev('addButton.disabled'),true);
   await ev('bundleForm.querySelectorAll("[name=bundle_variant]").forEach(c=>c.checked=true);bundleForm.dispatchEvent(new Event("change",{bubbles:true}))');
   assert.equal(await ev('addButton.disabled'),false);
  });
  await t.test('Unavailable companion cannot contribute to totals or cart; batch preserves existing cart and blocks duplicates',async()=>{
   await call('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true});
   await ev('const sold=bundleForm.querySelectorAll("[name=bundle_variant]")[2];sold.disabled=true;sold.checked=false;bundleForm.dispatchEvent(new Event("change",{bubbles:true}));slow=true;bundleForm.requestSubmit(addButton);bundleForm.requestSubmit(addButton)');
   assert.equal(await ev('addButton.disabled'),true);
   assert.equal(await ev('addButton.getAttribute("aria-busy")'),'true');
   await wait('!bundleForm.hasAttribute("aria-busy")');
   const request=await ev('calls.find(c=>c.url.endsWith("/cart/add.js"))');
   assert.deepEqual(request.body.items,[{id:'11',quantity:1},{id:'12',quantity:1},{id:'14',quantity:1}]);
   assert.equal(await ev('calls.filter(c=>c.url.endsWith("/cart/add.js")).length'),1);
   assert.equal(await ev('document.querySelector(".cart-count").textContent'),'5');
   assert.equal(await ev('document.querySelector("dialog").open'),false);
   assert.equal(await ev('bundleForm.querySelector("[data-card-feedback]").textContent'),'All selected added');
  });
  await t.test('422, network, incomplete and malformed responses show sanitized error and allow retry',async()=>{
   for(const mode of ['422','network','partial','invalid']){
    await ev('mode='+JSON.stringify(mode)+';slow=false;bundleForm.requestSubmit(addButton)');
    await wait('!bundleForm.hasAttribute("aria-busy")');
    assert.equal(await ev('bundleForm.querySelector("[data-card-feedback]").textContent'),'Check cart before retry');
    assert.equal(await ev('addButton.disabled'),false);
    assert.equal(await ev('bundleForm.querySelectorAll("[name=bundle_variant]:checked:not(:disabled)").length'),3);
   }
   await ev('mode="ok";bundleForm.requestSubmit(addButton)');await wait('!bundleForm.hasAttribute("aria-busy")');
   assert.equal(await ev('bundleForm.querySelector("[data-card-feedback]").textContent'),'All selected added');
  });
  await t.test('Main selected variant follows product UI, disables unsafe variants and uses fresh rendered prices',async()=>{
   await ev('window.page=document.querySelector("[data-product-page]");page.querySelector("[name=id]").value="22";Object.assign(page.querySelector("[data-product-purchase]").dataset,{selectedVariant:"22",selectedPrice:"2990",selectedAvailable:"true",selectedUnitSafe:"true"});document.dispatchEvent(new CustomEvent("storefront:variant:updated",{detail:{page,variantId:"22"}}))');
   assert.equal(await ev('bundle.querySelector("[data-bundle-main-choice]").value'),'22');
   assert.equal(await ev('bundle.querySelector("[data-bundle-main] [data-bundle-price]").textContent'),'Selected variant price');
   assert.equal(await ev('bundle.querySelector("[data-bundle-total]").textContent'),new Intl.NumberFormat('he',{style:'currency',currency:'ILS'}).format(52.39));
   for(const id of ['33','44']){
    await ev('page.querySelector("[name=id]").value='+JSON.stringify(id)+';Object.assign(page.querySelector("[data-product-purchase]").dataset,{selectedVariant:'+JSON.stringify(id)+',selectedPrice:"500",selectedAvailable:'+JSON.stringify(id==='33'?'false':'true')+',selectedUnitSafe:'+JSON.stringify(id==='44'?'false':'true')+'});document.dispatchEvent(new CustomEvent("storefront:variant:updated",{detail:{page,variantId:'+JSON.stringify(id)+'}}))');
    assert.equal(await ev('bundle.querySelector("[data-bundle-main-choice]").disabled'),true);
    assert.equal(await ev('bundle.querySelector("[data-bundle-main-choice]").checked'),false);
   }
   await ev('page.querySelector("[name=id]").value="11";Object.assign(page.querySelector("[data-product-purchase]").dataset,{selectedVariant:"11",selectedPrice:"1590",selectedAvailable:"true",selectedUnitSafe:"true"});document.dispatchEvent(new CustomEvent("storefront:variant:updated",{detail:{page,variantId:"11"}}))');
   assert.equal(await ev('bundle.querySelector("[data-bundle-main-choice]").checked'),true);
   await ev('document.dispatchEvent(new CustomEvent("storefront:variant:updated",{detail:{page,variantId:"999"}}));bundleForm.dispatchEvent(new Event("change",{bubbles:true}))');
   assert.equal(await ev('addButton.disabled'),true);
   await ev('document.dispatchEvent(new CustomEvent("storefront:variant:updated",{detail:{page,variantId:"11"}}))');
   assert.equal(await ev('addButton.disabled'),false);
  });
  await t.test('RTL compact cards fit narrow through wide screens and reuse reduced-motion CTA',async()=>{
   await ev(`
    const controls=document.createElement('div');controls.id='control-fixture';
    controls.innerHTML='<style>.a11y-launcher{position:fixed;inset-inline-end:16px;bottom:16px;width:52px;height:52px}fankee-shopping-assistant [data-launch]{position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px}@media(max-width:991px){fankee-shopping-assistant{display:none}}</style><button class="a11y-launcher" aria-label="Accessibility">A</button><fankee-shopping-assistant><button data-launch>Assistant</button></fankee-shopping-assistant>';
    document.body.append(controls);
   `);
   for(const width of [320,360,375,390,768,1024,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const m=await ev('({overflow:document.documentElement.scrollWidth>innerWidth,dir:getComputedStyle(bundle).direction,button:addButton.getBoundingClientRect().height,items:bundle.querySelectorAll(".bundle-item").length})');
    assert.equal(m.overflow,false,'overflow '+width);assert.equal(m.dir,'rtl');assert.ok(m.button>=44);assert.equal(m.items,4);
   }
   for(const width of [320,390,1024,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:500,deviceScaleFactor:1,mobile:false});
    const safe=await ev(`(()=>{
     bundle.scrollIntoView({block:'end'});
     const controls=[...document.querySelectorAll('.a11y-launcher,fankee-shopping-assistant [data-launch]')].filter(n=>n.getBoundingClientRect().width);
     return [...bundle.querySelectorAll('input[type=checkbox],a,button')].every(n=>controls.every(control=>{
      const a=n.getBoundingClientRect(),b=control.getBoundingClientRect();return a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top;
     }));
    })()`);
    assert.equal(safe,true,'fixed control overlap '+width);
   }
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.equal(await ev('getComputedStyle(addButton,"::before").display'),'none');
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
