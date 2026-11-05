const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Group delivery browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
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





  const tr=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8'));
  const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const raw=fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8');
  const labels=Object.fromEntries(Object.entries(tr.group_delivery.status).map(([key,value])=>[key.toUpperCase(),value]));
  const markup=raw.slice(raw.indexOf('<fankee-group-delivery'),raw.indexOf('</fankee-group-delivery>')+25)
   .replace(/<script type="application\/json" data-group-labels>[\s\S]*?<\/script>/,'<script type="application/json" data-group-labels>'+JSON.stringify(labels)+'</script>')
   .replace(/{{ section.settings.service_url \| escape }}/g,'https://groups.example.test')
   .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
   .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ area }}','__AREA__').replace('{{ count }}','__COUNT__').replace('{{ amount }}','__AMOUNT__')));
  await ev('document.querySelector("main").innerHTML='+JSON.stringify(markup));
  await ev(`
   sessionStorage.clear();window.requests=[];window.geoCalls=0;window.apiFailure=false;window.quantity=1;
   Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(success){geoCalls++;success({coords:{latitude:31.812345,longitude:34.654321}});}}});
   window.group={publicId:'11111111-1111-4111-8111-111111111111',areaName:'אשדוד',status:'OPEN',participantCount:5,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:36500,remainingAmountAgorot:13500,progressPercent:73,expiresAt:'2050-01-01T00:00:00.000Z'};
   window.fetch=async(input,options={})=>{
    const url=new URL(input,location.origin),body=options.body?JSON.parse(options.body):null;requests.push({url:url.href,method:options.method||'GET',body,headers:options.headers});
    if(url.pathname==='/he/cart.js')return new Response(JSON.stringify({currency:'ILS',total_price:1590*quantity,items:quantity?[{variant_id:101,quantity,properties:{}}]:[]}));
    if(apiFailure)return new Response(JSON.stringify({code:'SERVICE_UNAVAILABLE',error:'upstream secret must not display'}),{status:503});
    if(url.pathname.endsWith('/find-or-create'))return new Response(JSON.stringify({group,withinStandardRadius:false,validatedPledgeAgorot:1590*quantity}));
    if(url.pathname.endsWith('/join')){group={...group,participantCount:6,pledgedTotalAgorot:38090,remainingAmountAgorot:11910,progressPercent:76};return new Response(JSON.stringify({group,memberToken:'a'.repeat(64),validatedPledgeAgorot:1590*quantity}));}
    if(url.pathname.endsWith('/update-pledge')){group={...group,pledgedTotalAgorot:39680,remainingAmountAgorot:10320,progressPercent:79};return new Response(JSON.stringify({group,validatedPledgeAgorot:1590*quantity}));}
    return new Response(JSON.stringify({group}));
   };
   window.widget=document.querySelector('fankee-group-delivery');
  `);
  await ev(fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8'));
  await wait('!widget.hasAttribute("aria-busy")');
  await t.test('No automatic geolocation; explicit action stores only approximate coordinates',async()=>{
   assert.equal(await ev('geoCalls'),0);assert.equal(await ev('requests.length'),1);
   await ev('widget.querySelector("[name=area]").value="אשדוד";widget.querySelector("[data-geolocate]").click()');
   assert.equal(await ev('geoCalls'),1);
   assert.deepEqual(await ev('widget.coords'),{lat:31.81,lng:34.65});
  });
  await t.test('Find renders aggregates and server-verified pledge with no customer identities',async()=>{
   await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),false);
   assert.equal(await ev('widget.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'73');
   assert.ok(await ev('widget.querySelector("[data-validated-pledge]").textContent.includes("15.90")'));
   assert.equal(await ev('requests.find(r=>r.url.endsWith("/find-or-create")).body.location.lat'),31.81);
   assert.ok(await ev('widget.querySelector("[data-group-title]").textContent.includes("אשדוד")'));
  });
  await t.test('Changing location invalidates unjoined results before another join',async()=>{
   await ev('widget.querySelector("[name=area]").dispatchEvent(new Event("input",{bubbles:true}))');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),true);
   assert.equal(await ev('widget.foundPlace'),null);
   await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),false);
  });
  await t.test('Join is guarded, stores only an opaque session receipt and updates without payment',async()=>{
   await ev('widget.querySelector("[name=email]").value="fixture@example.test";widget.querySelector("[name=phone]").value="0501234567";widget.querySelector("[data-join-group]").requestSubmit();widget.querySelector("[data-join-group]").requestSubmit()');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.filter(r=>r.url.endsWith("/join")).length'),1);
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   const receipt=await ev('JSON.parse(sessionStorage.getItem(widget.storageKey))');
   assert.deepEqual(Object.keys(receipt).sort(),['memberToken','publicId']);
   assert.ok(!JSON.stringify(receipt).includes('fixture@example'));
   await ev('quantity=2;widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   const update=await ev('requests.find(r=>r.url.endsWith("/update-pledge"))');
   assert.ok(await ev('widget.querySelector("[data-validated-pledge]").textContent.includes("31.80")'));
   assert.deepEqual(Object.keys(update.body),['lines']);assert.equal(update.headers.Authorization,'Bearer '+'a'.repeat(64));
   assert.ok(await ev('requests.every(r=>!r.url.includes("checkout")&&!r.url.includes("draft"))'));
  });
  await t.test('Empty carts, safe errors, explicit refresh and closed groups remain usable',async()=>{
   await ev('quantity=0;widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.updated);
   assert.deepEqual(await ev('requests.filter(r=>r.url.endsWith("/update-pledge")).at(-1).body.lines'),[]);
   await ev('quantity=1;apiFailure=true;widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error);
   await ev('apiFailure=false;group.status="APPROVED";widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),true);
   assert.ok(await ev('widget.querySelector("[data-group-state]").textContent.includes("התשלום עדיין")'));
  });
  await t.test('Receipt restoration needs no PII and does not duplicate listeners',async()=>{
   await ev('const parent=widget.parentNode;widget.remove();parent.append(widget)');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('geoCalls'),1);assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   const before=await ev('requests.length');
   await ev('widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.length'),before+1);
  });
  await t.test('Mobile and desktop RTL fit, keyboard targets are usable, progress respects reduced motion',async()=>{
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const m=await ev('({overflow:document.documentElement.scrollWidth>innerWidth,dir:getComputedStyle(widget).direction,buttons:[...widget.querySelectorAll("button")].filter(n=>n.getBoundingClientRect().width).every(n=>n.getBoundingClientRect().height>=44)})');
    assert.equal(m.overflow,false,'overflow '+width);assert.equal(m.dir,'rtl');assert.equal(m.buttons,true);
   }

   await ev(`
    const controls=document.createElement('div');
    controls.innerHTML='<style>.a11y-launcher{position:fixed;inset-inline-end:16px;bottom:16px;width:52px;height:52px}fankee-shopping-assistant [data-launch]{position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px}@media(max-width:991px){fankee-shopping-assistant{display:none}}</style><button class="a11y-launcher">Accessibility</button><fankee-shopping-assistant><button data-launch>Assistant</button></fankee-shopping-assistant>';
    document.body.append(controls);
   `);
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:600,deviceScaleFactor:1,mobile:false});
    const safe=await ev(`(()=>{
     widget.scrollIntoView({block:'end'});
     const controls=[...document.querySelectorAll('.a11y-launcher,fankee-shopping-assistant [data-launch]')].filter(n=>n.getBoundingClientRect().width);
     return [...widget.querySelectorAll('input,button')].filter(n=>n.getBoundingClientRect().width).every(n=>controls.every(control=>{
      const a=n.getBoundingClientRect(),b=control.getBoundingClientRect();return a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top;
     }))&&document.documentElement.scrollWidth<=innerWidth;
    })()`);
    assert.equal(safe,true,'floating control collision '+width);
   }
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.ok(parseFloat(await ev('getComputedStyle(widget.querySelector("[data-progress-fill]")).transitionDuration'))<0.001);
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
