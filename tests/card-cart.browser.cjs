const {test} = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.ACCESSIBILITY_PREVIEW_URL || 'http://127.0.0.1:9292';
const debug = process.env.ACCESSIBILITY_DEBUG_URL || 'http://127.0.0.1:9333';
// Requires Shopify theme dev and isolated Chrome with CDP enabled.
test('Product-card AJAX cart behavior', {timeout:120000}, async t=>{
  const tab=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
  const ws=new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0; const pending=new Map(); const errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const visit=async()=>{await call('Page.navigate',{url:base+'/'});await sleep(1000);for(let i=0;i<50;i++){if(await ev('document.readyState==="complete"&&!!document.querySelector("[data-card-cart]")'))return;await sleep(150)}throw Error('Card preview did not load; check the storefront password')};
  const viewport=width=>call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
  const key=async(value,code,num)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:value,code,windowsVirtualKeyCode:num,...(type==='keyDown'&&value==='Enter'?{text:'\r'}:{})})};
  const open=()=>ev('document.querySelector("[data-mega-trigger]").click()');
  let cartReady=false;
  const waitFor=async expression=>{for(let i=0;i<120;i++){if(await ev(expression))return;await sleep(100)}throw Error('Timed out: '+expression)};
  try{
    await call('Page.enable');await call('Runtime.enable');await viewport(1280);await visit();cartReady=true;
    await ev('fetch((window.Shopify?.routes?.root||"/")+"cart/clear.js",{method:"POST"}).then(r=>r.json())');await visit();
    const start=await ev('location.href');
    const product=await ev('document.querySelector("[data-card-cart]").closest(".catalog-card").querySelector(".catalog-card__image").getAttribute("href")');
    await ev(`(()=>{window.__originalCartFetch=window.fetch.bind(window);window.__cartRequests=[];window.__cartActive=0;window.__cartMaximum=0;window.fetch=async(input,options)=>{const url=String(input);if(/\/cart\/add\.js(?:\?|$)/.test(url)){window.__cartRequests.push({url,body:JSON.parse(options.body),headers:options.headers});window.__cartActive++;window.__cartMaximum=Math.max(window.__cartMaximum,window.__cartActive);try{await new Promise(r=>setTimeout(r,250));return await window.__originalCartFetch(input,options)}finally{window.__cartActive--}}return window.__originalCartFetch(input,options)};const unique=new Map();document.querySelectorAll('[data-card-cart]').forEach(f=>{const id=f.querySelector('[name=id]').value;if(!unique.has(id))unique.set(id,f)});window.__cardForms=[...unique.values()];})()`);
    assert.ok(await ev('window.__cardForms.length>=3'),'Need three available single-variant products');
    await t.test('Keyboard direct add stays on page, sends one unit, refreshes badge and mini-cart, and blocks duplicate submission',async()=>{
      const variant=await ev('window.__cardForms[0].querySelector("[name=id]").value');
      await ev('window.__cardForms[0].querySelector("button[name=add]").focus()');await key('Enter','Enter',13);
      assert.equal(await ev('window.__cardForms[0].getAttribute("aria-busy")'),'true');
      assert.equal(await ev('window.__cardForms[0].querySelector("button[name=add]").disabled'),true);
      assert.equal(await ev('window.__cardForms[0].querySelector("button[name=add]").textContent'),'מוסיף...');
      await ev('window.__cardForms[0].requestSubmit();window.__cardForms[0].requestSubmit()');
      await waitFor('!window.__cardForms[0].hasAttribute("aria-busy")');
      assert.equal(await ev('window.__cartRequests.length'),1);
      const request=await ev('window.__cartRequests[0]');assert.equal(request.body.items[0].id,variant);assert.equal(request.body.items[0].quantity,1);assert.deepEqual(request.body.sections,['header']);assert.equal(request.headers['Content-Type'],'application/json');assert.equal(request.headers.Accept,'application/json');
      assert.equal(await ev('location.href'),start);assert.equal(await ev('window.__cardForms[0].querySelector("[data-card-feedback]").textContent'),'המוצר נוסף לסל');
      assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');assert.ok(await ev('document.querySelector(".mini-cart-items [name=\"updates[]\"]") !== null'));
      assert.equal(await ev('window.__cardForms[0].querySelector("[data-card-feedback]").getAttribute("aria-live")'),'polite');
      assert.equal(await ev('window.__cardForms[0].querySelector("button[name=add]").disabled'),false);
    });
    await t.test('Success message clears automatically',async()=>{
      await waitFor('window.__cardForms[0].querySelector("[data-card-feedback]").textContent===""');
    });
    await t.test('API rejection gives a Hebrew error and restores the button without redirecting',async()=>{
      await ev(`window.__workingCartFetch=window.fetch;window.fetch=(input,options)=>/\/cart\/add\.js(?:\?|$)/.test(String(input))?Promise.resolve(new Response(JSON.stringify({status:422,description:'Unavailable'}),{status:422,headers:{'Content-Type':'application/json'}})):window.__workingCartFetch(input,options)`);
      await ev('window.__cardForms[1].querySelector("button[name=add]").scrollIntoView({block:"center"})');
      const point=await ev('(()=>{const r=window.__cardForms[1].querySelector("button[name=add]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
      await waitFor('!window.__cardForms[1].hasAttribute("aria-busy")');
      const state=await ev('({text:window.__cardForms[1].querySelector("[data-card-feedback]").textContent,error:window.__cardForms[1].querySelector("[data-card-feedback]").hasAttribute("data-feedback-error"),disabled:window.__cardForms[1].querySelector("button[name=add]").disabled})');
      assert.equal(state.text,'לא הצלחנו להוסיף את המוצר לסל. כדאי לנסות שוב.');assert.equal(state.error,true);assert.equal(state.disabled,false);assert.equal(await ev('location.href'),start);assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');await ev('window.fetch=window.__workingCartFetch');
    });
    await t.test('Different card adds are serialized and the cart count is Shopify-authoritative',async()=>{
      await ev('window.__cardForms[1].requestSubmit();window.__cardForms[2].requestSubmit()');
      await waitFor('!window.__cardForms[1].hasAttribute("aria-busy")&&!window.__cardForms[2].hasAttribute("aria-busy")');
      assert.equal(await ev('window.__cartMaximum'),1);assert.equal(await ev('window.__cartRequests.length'),3);
      const cart=await ev('window.__originalCartFetch((window.Shopify?.routes?.root||"/")+"cart.js").then(r=>r.json())');assert.equal(cart.item_count,3);assert.equal(await ev('document.querySelector(".cart-count").textContent'),String(cart.item_count));
      assert.equal(await ev('window.__cardForms[1].querySelector("[data-card-feedback]").textContent'),'המוצר נוסף לסל');assert.equal(await ev('location.href'),start);
      await ev('document.querySelector(".cart-toggle-btn").click()');await sleep(400);assert.equal(await ev('document.querySelector(".mini-cart-content").inert'),false);await key('Escape','Escape',27);assert.equal(await ev('document.querySelector(".mini-cart-content").inert'),true);
    });
    await t.test('Missing bundled markup refreshes sections without repeating the add request',async()=>{
      await ev('window.__originalCartFetch((window.Shopify?.routes?.root||"/")+"cart/clear.js",{method:"POST"}).then(r=>r.json())');
      await ev(`window.fetch=async(input,options)=>{const response=await window.__workingCartFetch(input,options);if(/\/cart\/add\.js(?:\?|$)/.test(String(input))&&response.ok){const data=await response.json();data.sections={header:null};return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}})}return response};window.__cardForms[0].requestSubmit()`);
      await waitFor('!window.__cardForms[0].hasAttribute("aria-busy")');assert.equal(await ev('window.__cartRequests.length'),4);assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');assert.equal(await ev('window.__cardForms[0].querySelector("[data-card-feedback]").textContent'),'המוצר נוסף לסל');await ev('window.fetch=window.__workingCartFetch');
    });
    await t.test('Sold-out cards stay disabled and product-page forms are not intercepted',async()=>{
      assert.ok(await ev('document.querySelector(".catalog-card button:disabled:not([data-pending-label])") !== null'));
      await call('Page.navigate',{url:new URL(product,base).href});await sleep(1400);
      await ev('window.__productSubmitUntouched=false;document.addEventListener("submit",event=>{if(event.target.classList.contains("catalog-product-form")){window.__productSubmitUntouched=!event.defaultPrevented;event.preventDefault()}},{once:true});document.querySelector(".catalog-product-form").requestSubmit()');assert.equal(await ev('window.__productSubmitUntouched'),true);
    });
    assert.deepEqual(errors,[]);
  }finally{
    if(cartReady) await ev('fetch((window.Shopify?.routes?.root||"/")+"cart/clear.js",{method:"POST"}).then(r=>r.json())').catch(()=>{});
    ws.close();await fetch(debug+'/json/close/'+tab.id).catch(()=>{});
  }
});