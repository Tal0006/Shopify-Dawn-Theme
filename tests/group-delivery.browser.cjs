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
  // Mirrors the Liquid data-group-errors table: CODE -> group_delivery locale key.
  const errorKeys=Object.fromEntries(raw.match(/assign group_errors = '([^']+)'/)[1].split(',').map(entry=>entry.split(':')));
  const errors=Object.fromEntries(Object.entries(errorKeys).map(([code,key])=>[code,tr.group_delivery[key]]));
  const markup=raw.slice(raw.indexOf('<fankee-group-delivery'),raw.indexOf('</fankee-group-delivery>')+25)
   .replace(/<script type="application\/json" data-group-labels>[\s\S]*?<\/script>/,'<script type="application/json" data-group-labels>'+JSON.stringify(labels)+'</script>')
   .replace(/<script type="application\/json" data-group-errors>[\s\S]*?<\/script>/,'<script type="application/json" data-group-errors>'+JSON.stringify(errors)+'</script>')
   .replace(/{{ group_delivery_service_url \| escape }}/g,'https://groups.example.test')
   .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
   .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ area }}','__AREA__').replace('{{ count }}','__COUNT__').replace('{{ amount }}','__AMOUNT__').replace('{{ target }}','__TARGET__').replace('{{ approved }}','__APPROVED__').replace('{{ waiting }}','__WAITING__').replace('{{ deadline }}','__DEADLINE__')));
  await ev('document.querySelector("main").innerHTML='+JSON.stringify(markup));
  await ev(`
   sessionStorage.clear();localStorage.clear();window.requests=[];window.logged=[];window.existing=true;window.updateResponse=null;window.getResponse=null;
   for(const level of ['log','info','warn','error','debug']){const original=console[level].bind(console);console[level]=(...args)=>{logged.push(args.map(String).join(' '));original(...args);};}window.geoCalls=0;window.apiFailure=false;window.quantity=1;
   window.geoMode='success';window.nearestArea=null;window.verifications=0;window.approvals=[];window.member=undefined;
   window.geolocationMock={getCurrentPosition(success,fail){geoCalls++;if(geoMode==='denied')fail({code:1});else if(geoMode==='error')fail({code:2});else success({coords:{latitude:31.812345,longitude:34.654321}});}};
   Object.defineProperty(navigator,'geolocation',{configurable:true,value:geolocationMock});
   window.areaList=[{"publicId":"6f1a2c00-0001-4a00-8000-0000000000a1","name":"באר שבע"},{"publicId":"6f1a2c00-0002-4a00-8000-0000000000a2","name":"אשדוד"},{"publicId":"6f1a2c00-0003-4a00-8000-0000000000a3","name":"אשקלון"},{"publicId":"6f1a2c00-0004-4a00-8000-0000000000a4","name":"קריית גת"},{"publicId":"6f1a2c00-0005-4a00-8000-0000000000a5","name":"נתיבות"},{"publicId":"6f1a2c00-0006-4a00-8000-0000000000a6","name":"אופקים"},{"publicId":"6f1a2c00-0007-4a00-8000-0000000000a7","name":"שדרות"}];
   window.group={publicId:'11111111-1111-4111-8111-111111111111',areaName:'אשדוד',status:'OPEN',participantCount:5,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:36500,remainingAmountAgorot:13500,progressPercent:73,expiresAt:'2050-01-01T00:00:00.000Z'};
   window.fetch=async(input,options={})=>{
    const url=new URL(input,location.origin),body=options.body?JSON.parse(options.body):null;requests.push({url:url.href,method:options.method||'GET',body,headers:options.headers});
    if(url.pathname==='/he/cart.js')return new Response(JSON.stringify({currency:'ILS',total_price:1590*quantity,items:quantity?[{variant_id:101,quantity,properties:{}}]:[]}));
    if(window.apiDelay){const delay=apiDelay;await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,delay);options.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));},{once:true});});}
    if(window.apiNetworkError)throw new TypeError('Failed to fetch');
    if(window.apiResponse)return new Response(apiResponse.raw??JSON.stringify(apiResponse.body),{status:apiResponse.status});
    if(apiFailure)return new Response(JSON.stringify({code:'SERVICE_UNAVAILABLE',error:'upstream secret must not display'}),{status:503});
    // Payment verification simulator endpoints (development provider) and receipt-authenticated membership.
    if(url.pathname.endsWith('/api/v1/payment-verifications')){verifications++;return new Response(JSON.stringify(window.verificationCreate||{verification:{id:'99999999-9999-4999-8999-99999999999'+(verifications%10),status:'PENDING',expiresAt:'2050-01-01T00:00:00.000Z'},verificationToken:'d'.repeat(64),next:{type:'mock'}}),{status:201});}
    if(url.pathname.endsWith('/mock-result')){const status={verified:'VERIFIED',failed:'FAILED',cancelled:'CANCELLED'}[body.outcome];return new Response(JSON.stringify({verification:{id:url.pathname.split('/').at(-2),status,expiresAt:'2050-01-01T00:00:00.000Z'}}));}
    if(url.pathname.endsWith('/payment-approval')){approvals.push(body);if(window.approvalResponse)return new Response(JSON.stringify(approvalResponse.body),{status:approvalResponse.status});return new Response(JSON.stringify({group,member:window.memberAfterApproval}));}
    if(url.pathname.endsWith('/membership')&&window.member!==undefined&&!window.getResponse)return new Response(JSON.stringify({group,member}));
    if(url.pathname.endsWith('/update-pledge')&&window.updateResponse)return new Response(JSON.stringify(updateResponse.body),{status:updateResponse.status});
    if(!body&&url.pathname.includes('/groups/')&&window.getResponse)return new Response(JSON.stringify(getResponse.body),{status:getResponse.status});
    if(url.pathname.endsWith('/api/v1/areas'))return new Response(JSON.stringify({areas:areaList}));
    if(url.pathname.endsWith('/api/v1/areas/nearest'))return new Response(JSON.stringify({area:nearestArea}));
    if(url.pathname.endsWith('/groups/find'))return new Response(JSON.stringify({group:existing?group:null,canCreateOnJoin:!existing,withinStandardRadius:false,validatedPledgeAgorot:1590*quantity}));
    if(url.pathname.endsWith('/groups/join')){const created=!existing;existing=true;group={...group,publicId:created?'22222222-2222-4222-8222-222222222222':group.publicId,participantCount:created?1:group.participantCount+1,pledgedTotalAgorot:1590*quantity,remainingAmountAgorot:50000-1590*quantity,progressPercent:3};return new Response(JSON.stringify({group,created,memberToken:'b'.repeat(64),validatedPledgeAgorot:1590*quantity}),{status:201});}
    if(url.pathname.endsWith('/join')){group={...group,participantCount:6,pledgedTotalAgorot:38090,remainingAmountAgorot:11910,progressPercent:76};return new Response(JSON.stringify({group,memberToken:'a'.repeat(64),validatedPledgeAgorot:1590*quantity}));}
    if(url.pathname.endsWith('/update-pledge')){group={...group,pledgedTotalAgorot:39680,remainingAmountAgorot:10320,progressPercent:79};return new Response(JSON.stringify({group,validatedPledgeAgorot:1590*quantity}));}
    return new Response(JSON.stringify({group}));
   };
   window.widget=document.querySelector('fankee-group-delivery');
  `);
  await ev(fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8'));
  await wait('!widget.hasAttribute("aria-busy")');
  const ASHDOD='6f1a2c00-0002-4a00-8000-0000000000a2',ASHKELON='6f1a2c00-0003-4a00-8000-0000000000a3',OFAKIM='6f1a2c00-0006-4a00-8000-0000000000a6';
  const input='widget.querySelector("[data-area-input]")',list='widget.querySelector("[data-area-list]")';
  const key=name=>ev(input+'.dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(name)+',bubbles:true,cancelable:true}))');
  const type=value=>ev(input+'.value='+JSON.stringify(value)+';'+input+'.dispatchEvent(new Event("input",{bubbles:true}))');
  // Development verification: start, then choose the simulated outcome.
  const verifyPayment=async(outcome='verified')=>{
   await ev('widget.querySelector("[data-verify-payment]").click()');await wait('!widget.hasAttribute("aria-busy")');
   await ev('widget.querySelector("[data-mock-outcome='+outcome+']").click()');await wait('!widget.hasAttribute("aria-busy")');
  };
  const optionNames=()=>ev('[...'+list+'.querySelectorAll("[role=option]")].map(o=>o.textContent)');
  await t.test('Areas load from the service; geolocation only on click, coarse coordinates sent once to suggest an area',async()=>{
   assert.equal(await ev('geoCalls'),0);
   assert.deepEqual(await ev('requests.map(r=>new URL(r.url).pathname).sort()'),['/api/v1/areas','/he/cart.js']);
   assert.equal(await ev('widget.areas.length'),7);
   await ev('window.nearestArea={publicId:'+JSON.stringify(ASHDOD)+',name:"אשדוד"};widget.querySelector("[data-geolocate]").click()');
   await wait('widget.area?.publicId==='+JSON.stringify(ASHDOD));await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('geoCalls'),1);
   const lookups=await ev('requests.filter(r=>r.url.endsWith("/areas/nearest"))');
   assert.equal(lookups.length,1);assert.deepEqual(lookups[0].body,{latitude:31.81,longitude:34.65},'only ~1 km coordinates leave the browser');
   assert.equal(await ev(input+'.value'),'אשדוד');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_selected.replace('{{ area }}','אשדוד'));
   assert.equal(await ev('widget.querySelector("[data-area-selected]").textContent'),tr.group_delivery.area_selected.replace('{{ area }}','אשדוד'));
   assert.ok(!(await ev('JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage})+document.documentElement.outerHTML')).includes('31.81'),'coordinates never stored or rendered');
  });
  await t.test('Find sends only the server area reference and renders aggregates without customer identities',async()=>{
   await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),false);
   assert.equal(await ev('widget.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),'73');
   assert.ok(await ev('widget.querySelector("[data-validated-pledge]").textContent.includes("15.90")'));
   const search=await ev('requests.find(r=>r.url.endsWith("/groups/find")).body');
   assert.deepEqual(Object.keys(search).sort(),['areaPublicId','lines']);assert.equal(search.areaPublicId,ASHDOD);
   assert.ok(await ev('widget.querySelector("[data-group-title]").textContent.includes("אשדוד")'));
  });
  await t.test('Changing location invalidates unjoined results before another join',async()=>{
   await ev('widget.querySelector("[name=area]").dispatchEvent(new Event("input",{bubbles:true}))');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),true);
   assert.equal(await ev('widget.foundPlace'),null);
   await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),false);
  });
  await t.test('Join is guarded, stores only an opaque durable receipt and updates without payment',async()=>{
   await ev('widget.querySelector("[name=email]").value="fixture@example.test";widget.querySelector("[name=phone]").value="0501234567"');
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),true,'Join waits for a verified payment method');
   await verifyPayment();
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),false);
   await ev('widget.querySelector("[data-join-group]").requestSubmit();widget.querySelector("[data-join-group]").requestSubmit()');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.filter(r=>r.url.endsWith("/join")).length'),1);
   const joinBody=await ev('requests.find(r=>r.url.endsWith("/join")).body');
   assert.equal(joinBody.verificationToken,'d'.repeat(64));assert.match(joinBody.verificationId,/^9{8}-/);
   assert.equal(await ev('widget.querySelector("[data-payment-step]").hidden'),true,'members see no verification step');
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   const receipt=await ev('JSON.parse(localStorage.getItem(widget.receiptPrefix+group.publicId))');
   assert.deepEqual(Object.keys(receipt).sort(),['memberToken','publicId','savedAt']);
   assert.equal(await ev('sessionStorage.length'),0,'no session-only copy');
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
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_unavailable);
   assert.ok(!(await ev('widget.message.textContent')).includes('secret'));
   await ev('apiFailure=false;group.status="APPROVED";widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),true);
   assert.equal(await ev('widget.querySelector("[data-group-state]").textContent'),tr.group_delivery.status.approved);
  });
  await t.test('Receipt restoration needs no PII and does not duplicate listeners',async()=>{
   await ev('const parent=widget.parentNode;widget.remove();parent.append(widget)');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('geoCalls'),1);assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   const before=await ev('requests.length');
   await ev('widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.length'),before+1);
  });
  const reconnect='{const parent=widget.parentNode;widget.remove();parent.append(widget);}';
  const receiptKey='widget.receiptPrefix+group.publicId';
  await t.test('Durable receipts survive a new session and legacy sessionStorage receipts migrate',async()=>{
   await ev('group.status="OPEN";sessionStorage.clear();'+reconnect);await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true,'new session keeps membership');
   assert.equal(await ev('widget.group.publicId'),await ev('group.publicId'));
   // Legacy single receipt in sessionStorage moves to its own localStorage key, then the old copy is removed.
   await ev('localStorage.clear();sessionStorage.setItem(widget.storageKey,JSON.stringify({publicId:group.publicId,memberToken:"a".repeat(64)}));'+reconnect);
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('JSON.parse(localStorage.getItem('+receiptKey+')).memberToken'),'a'.repeat(64));
   assert.equal(await ev('sessionStorage.getItem(widget.storageKey)'),null);
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   // If localStorage refuses the write, the legacy copy stays and the receipt still works in this tab.
   await ev('localStorage.clear();sessionStorage.setItem(widget.storageKey,JSON.stringify({publicId:group.publicId,memberToken:"a".repeat(64)}));window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(...args){if(this===localStorage)throw new DOMException("full","QuotaExceededError");return originalSetItem.apply(this,args);};'+reconnect);
   await wait('!widget.hasAttribute("aria-busy")');
   assert.notEqual(await ev('sessionStorage.getItem(widget.storageKey)'),null);
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   await ev('Storage.prototype.setItem=originalSetItem;'+reconnect);await wait('!widget.hasAttribute("aria-busy")');
   assert.notEqual(await ev('localStorage.getItem('+receiptKey+')'),null);assert.equal(await ev('sessionStorage.getItem(widget.storageKey)'),null);
  });
  await t.test('Temporary failures keep receipts; only definitive rejections remove the affected receipt',async()=>{
   await ev('group.status="OPEN";quantity=1;localStorage.setItem(widget.receiptPrefix+"33333333-3333-4333-8333-333333333333",JSON.stringify({publicId:"33333333-3333-4333-8333-333333333333",memberToken:"c".repeat(64),savedAt:1}));widget.loadReceipts()');
   const kept=[[{status:503,body:{code:'SERVICE_UNAVAILABLE'}},'error_unavailable'],[{status:429,body:{code:'RATE_LIMITED'}},'error_rate_limited'],[{status:503,body:{code:'SHOPIFY_UNAVAILABLE'}},'shopify_error'],[{status:409,body:{code:'GROUP_CLOSED'}},'closed']];
   for(const [response,key] of kept){
    await ev('window.updateResponse='+JSON.stringify(response)+';widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
    assert.equal(await ev('widget.message.textContent'),tr.group_delivery[key]);
    assert.notEqual(await ev('localStorage.getItem('+receiptKey+')'),null,response.body.code+' must keep the receipt');
    assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   }
   await ev('window.updateResponse=null;window.apiNetworkError=true;widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_network);
   assert.notEqual(await ev('localStorage.getItem('+receiptKey+')'),null,'network errors keep the receipt');
   // A rejected token removes only that group's receipt and returns the shopper to the contact form.
   await ev('window.apiNetworkError=false;window.updateResponse={status:401,body:{code:"MEMBER_AUTH_REQUIRED"}};widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('localStorage.getItem('+receiptKey+')'),null);
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_receipt);
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),false);
   assert.notEqual(await ev('localStorage.getItem(widget.receiptPrefix+"33333333-3333-4333-8333-333333333333")'),null,'other groups untouched');
   // A deleted group removes its receipt on restore.
   await ev('window.updateResponse=null;localStorage.removeItem(widget.receiptPrefix+"33333333-3333-4333-8333-333333333333");localStorage.setItem('+receiptKey+',JSON.stringify({publicId:group.publicId,memberToken:"a".repeat(64),savedAt:Date.now()}));window.getResponse={status:404,body:{code:"GROUP_NOT_FOUND"}};'+reconnect);
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('localStorage.getItem('+receiptKey+')'),null);
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_not_found);
   // Restore the membership for the following tests.
   await ev('window.getResponse=null;localStorage.setItem('+receiptKey+',JSON.stringify({publicId:group.publicId,memberToken:"a".repeat(64),savedAt:Date.now()}));'+reconnect);
   await wait('!widget.hasAttribute("aria-busy")');
  });
  await t.test('No group yet: searching creates nothing and the join starts the group',async()=>{
   await ev('existing=false;quantity=1');await type('אופ');await key('ArrowDown');await key('Enter');
   assert.equal(await ev('widget.area.publicId'),OFAKIM);
   await ev('widget.querySelector("[data-find-group]").requestSubmit()');
   await wait('!widget.hasAttribute("aria-busy")');
   const panel='widget.querySelector("[data-group-panel]")';
   assert.equal(await ev(panel+'.hidden'),false);assert.equal(await ev(panel+'.hasAttribute("data-group-pending")'),true);
   assert.equal(await ev('widget.querySelector("[data-group-title]").textContent'),tr.group_delivery.pending_title.replace('{{ area }}','אופקים'));
   assert.equal(await ev('widget.querySelector("[data-group-state]").textContent'),tr.group_delivery.pending_state);
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.none_found);
   assert.equal(await ev('widget.querySelector("[data-join-button]").textContent'),tr.group_delivery.start);
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),true,'disabled until payment verification');
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),false);
   for(const part of ['.group-delivery__totals','.group-delivery__progress','.group-delivery__stats','[data-refresh]'])assert.equal(await ev('getComputedStyle(widget.querySelector('+JSON.stringify(part)+')).display==="none"||!widget.querySelector('+JSON.stringify(part)+').getClientRects().length'),true,part);
   assert.equal(await ev('requests.filter(r=>r.url.endsWith("/groups/join")).length'),0,'nothing is created before Join');
   await ev('widget.querySelector("[name=email]").value="starter@example.test";widget.querySelector("[name=phone]").value="0507654321"');
   await verifyPayment();
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),false);
   await ev('widget.querySelector("[data-join-group]").requestSubmit();widget.querySelector("[data-join-group]").requestSubmit()');
   await wait('!widget.hasAttribute("aria-busy")');
   const joins=await ev('requests.filter(r=>r.url.endsWith("/groups/join"))');
   assert.equal(joins.length,1);assert.deepEqual(Object.keys(joins[0].body).sort(),['areaPublicId','email','lines','phone','verificationId','verificationToken']);
   assert.equal(joins[0].body.areaPublicId,OFAKIM,'the join uses the searched area');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.started);
   assert.equal(await ev(panel+'.hasAttribute("data-group-pending")'),false);
   assert.equal(await ev('widget.querySelector("[data-contact-fields]").hidden'),true);
   assert.equal(await ev('JSON.parse(localStorage.getItem(widget.receiptPrefix+"22222222-2222-4222-8222-222222222222")).memberToken'),'b'.repeat(64));
   assert.notEqual(await ev('localStorage.getItem(widget.receiptPrefix+"11111111-1111-4111-8111-111111111111")'),null,'receipts are per group');
   assert.ok(!(await ev('localStorage.getItem(widget.receiptPrefix+"22222222-2222-4222-8222-222222222222")')).includes('starter@'));
  });
  await t.test('Area combobox: filtering, keyboard navigation, selection state and exact typed names',async()=>{
   await ev('existing=true;group.status="OPEN";'+input+'.value="";widget.clearArea();widget.closeAreas()');
   // focus() fires no event when the input already has focus (perform() may restore it), so blur first.
   await wait('!widget.hasAttribute("aria-busy")');await ev(input+'.blur();'+input+'.focus()');
   assert.equal(await ev(input+'.getAttribute("aria-expanded")'),'true');
   assert.equal((await optionNames()).length,7);
   assert.equal(await ev(input+'.getAttribute("role")'),'combobox');assert.equal(await ev(list+'.getAttribute("role")'),'listbox');
   await type('אש');
   assert.deepEqual(await optionNames(),['אשדוד','אשקלון'],'typing filters');
   await key('ArrowDown');
   const first=await ev(list+'.querySelector("[role=option]").id');
   assert.equal(await ev(input+'.getAttribute("aria-activedescendant")'),first);
   assert.equal(await ev(list+'.querySelector("[data-active]").textContent'),'אשדוד');
   await key('ArrowDown');assert.equal(await ev(list+'.querySelector("[data-active]").textContent'),'אשקלון');
   await key('ArrowDown');assert.equal(await ev(list+'.querySelector("[data-active]").textContent'),'אשדוד','wraps to the first option');
   await key('ArrowUp');assert.equal(await ev(list+'.querySelector("[data-active]").textContent'),'אשקלון','wraps to the last option');
   await key('Enter');
   assert.equal(await ev('widget.area.publicId'),ASHKELON);assert.equal(await ev(input+'.value'),'אשקלון');
   assert.equal(await ev(list+'.hidden'),true);assert.equal(await ev(input+'.getAttribute("aria-expanded")'),'false');
   assert.equal(await ev(input+'.hasAttribute("aria-activedescendant")'),false);
   assert.equal(await ev('widget.querySelector("[data-area-selected]").textContent'),tr.group_delivery.area_selected.replace('{{ area }}','אשקלון'));
   // Reopening shows every area with the current one marked selected.
   await key('ArrowDown');
   assert.equal((await optionNames()).length,7);
   assert.equal(await ev(list+'.querySelector("[aria-selected=true]").textContent'),'אשקלון');
   await key('Escape');assert.equal(await ev(list+'.hidden'),true);assert.equal(await ev('widget.area.publicId'),ASHKELON,'Escape closes without changing the selection');
   await key('Escape');assert.equal(await ev(input+'.value'),'');assert.equal(await ev('widget.area'),null,'second Escape clears');
   // Pointer selection.
   await ev(input+'.focus();'+list+'.querySelectorAll("[role=option]")[3].dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}))');
   assert.equal(await ev('widget.area.name'),'קריית גת');
   // No match: no listbox, a clear message, and search is refused without a request.
   await type('zzz');
   assert.equal(await ev(list+'.hidden'),true);assert.equal(await ev('widget.querySelector("[data-area-selected]").textContent'),tr.group_delivery.area_empty);
   let before=await ev('requests.length');
   await type('אש');await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.area_required);
   assert.equal(await ev('requests.length'),before,'partial text never reaches the service');
   // An exact name typed in full counts as that area.
   await type(' אשקלון ');await ev('widget.querySelector("[data-find-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.filter(r=>r.url.endsWith("/groups/find")).at(-1).body.areaPublicId'),ASHKELON);
   assert.equal(await ev(list+'.hidden'),true);
   assert.ok(await ev('requests.every(r=>!r.url.includes("find-or-create"))'),'search uses only /groups/find');
  });
  await t.test('Location denied, failing, unsupported or far away keeps manual selection fully usable',async()=>{
   await ev('widget.clearArea();'+input+'.value=""');
   const locate=async()=>{await ev('widget.querySelector("[data-geolocate]").click()');await sleep(30);await wait('!widget.hasAttribute("aria-busy")');};
   let lookups=await ev('requests.filter(r=>r.url.endsWith("/areas/nearest")).length');
   await ev('geoMode="denied"');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_denied);
   await ev('geoMode="error"');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_error);
   assert.equal(await ev('requests.filter(r=>r.url.endsWith("/areas/nearest")).length'),lookups,'no lookup without a position');
   await ev('geoMode="success";nearestArea=null');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_none);assert.equal(await ev('widget.area'),null,'never forced into a wrong area');
   await ev('nearestArea={publicId:"99999999-9999-4999-8999-999999999999",name:"לא ברשימה"}');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_none,'unknown areas are ignored');
   await ev('window.apiResponse={status:400,body:{code:"INVALID_COORDINATES"}}');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_error);
   await ev('window.apiResponse=null;Object.defineProperty(navigator,"geolocation",{configurable:true,value:undefined})');await locate();
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.geo_unsupported);
   await ev('Object.defineProperty(navigator,"geolocation",{configurable:true,value:geolocationMock})');
   // Manual selection still works after every failure.
   await type('שד');
   assert.deepEqual(await optionNames(),['שדרות','אשדוד'],'names starting with the query rank first');
   await key('ArrowDown');await key('Enter');
   assert.equal(await ev('widget.area.name'),'שדרות');assert.equal(await ev(input+'.disabled'),false);
  });
  await t.test('Open listbox paints above the search button and other form controls; closed button stays clickable',async()=>{
   const button='widget.querySelector("[data-find-group] button[type=submit]")';
   // Diagnostics only: every ancestor/sibling that creates a stacking context, to explain a failure.
   const contexts='(()=>{const out=[];const add=el=>{const s=getComputedStyle(el);if(s.position!=="static"&&s.zIndex!=="auto"||s.isolation==="isolate"||s.transform!=="none"||Number(s.opacity)<1||s.filter!=="none"||s.backdropFilter&&s.backdropFilter!=="none"||s.willChange!=="auto"||s.contain!=="none")out.push((el.className||el.tagName)+" z="+s.zIndex+" pos="+s.position+" iso="+s.isolation+" tf="+s.transform);};for(let el='+list+';el;el=el.parentElement)add(el);add('+button+');return out.join(" | ")})()';
   for(const width of [320,390,768,1280]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<992});
    await ev(input+'.value="";widget.clearArea();'+input+'.scrollIntoView({block:"start"});'+input+'.focus();widget.openAreas()');
    const probe=await ev('(()=>{const b='+button+'.getBoundingClientRect(),l='+list+'.getBoundingClientRect();const x=Math.max(b.left,l.left)+Math.min(b.width,l.width)/2,y=Math.max(b.top,l.top)+Math.max(1,Math.min(b.bottom,l.bottom)-Math.max(b.top,l.top))/2;const hit=document.elementFromPoint(x,y);return {overlap:b.left<l.right&&b.right>l.left&&b.top<l.bottom&&b.bottom>l.top,inList:!!hit?.closest("[data-area-list]"),hit:hit?.tagName+"."+(hit?.className||""),overflow:document.documentElement.scrollWidth>innerWidth}})()');
    assert.equal(probe.overlap,true,'fixture: the open list should cover the button at '+width+'px');
    assert.equal(probe.inList,true,'button painted above the listbox at '+width+'px (hit '+probe.hit+'); stacking: '+await ev(contexts));
    assert.equal(probe.overflow,false,'overflow '+width);
    // Every other visible control the open list overlaps (geolocate, panel buttons, fields) is painted beneath it.
    const covered=await ev('(()=>{const l='+list+'.getBoundingClientRect(),bad=[];for(const el of widget.querySelectorAll("button,input:not([data-area-input])")){const b=el.getBoundingClientRect();if(!b.width||!(b.left<l.right&&b.right>l.left&&b.top<l.bottom&&b.bottom>l.top))continue;const x=(Math.max(b.left,l.left)+Math.min(b.right,l.right))/2,y=(Math.max(b.top,l.top)+Math.min(b.bottom,l.bottom))/2;if(!document.elementFromPoint(x,y)?.closest("[data-area-list]"))bad.push(el.textContent.trim()||el.name);}return bad})()');
    assert.deepEqual(covered,[],'controls above the open list at '+width+'px');
    // Long lists scroll inside the listbox, and the last option is reachable by keyboard and pointer.
    assert.ok(await ev(list+'.scrollHeight>='+list+'.clientHeight'));
    await key('ArrowUp');
    assert.equal(await ev(list+'.querySelector("[data-active]").textContent'),'שדרות');
    const last=await ev('(()=>{const o='+list+'.querySelector("[data-active]").getBoundingClientRect(),l='+list+'.getBoundingClientRect();return o.top>=l.top-1&&o.bottom<=l.bottom+1})()');
    assert.equal(last,true,'active option scrolled into view');
    const clicked=await ev('(()=>{const o='+list+'.querySelector("[data-active]").getBoundingClientRect();const hit=document.elementFromPoint(o.left+o.width/2,o.top+o.height/2);hit.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true}));return widget.area?.name})()');
    assert.equal(clicked,'שדרות','pointer on the visible option selects it');
    assert.equal(await ev(list+'.hidden'),true);
    // Closed: the button is the topmost element at its own center again.
    const free=await ev('(()=>{const b='+button+'.getBoundingClientRect();return document.elementFromPoint(b.left+b.width/2,b.top+b.height/2)?.closest("button")==='+button+'})()');
    assert.equal(free,true,'closed listbox must not block the button at '+width+'px');
   }
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  });
  await t.test('Combobox fits RTL mobile and desktop widths with touch-sized options',async()=>{
   for(const width of [320,360,375,390,768,1280]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<992});
    await ev(input+'.scrollIntoView({block:"start"});'+input+'.value="";widget.clearArea();'+input+'.focus();widget.openAreas()');
    const m=await ev('(()=>{const i='+input+'.getBoundingClientRect(),l='+list+'.getBoundingClientRect(),options=[...'+list+'.querySelectorAll("[role=option]")];return {dir:getComputedStyle('+input+').direction,open:!'+list+'.hidden,overflow:document.documentElement.scrollWidth>innerWidth,inside:l.left>=i.left-1&&l.right<=i.right+1&&l.right<=innerWidth,touch:options.every(o=>o.getBoundingClientRect().height>=44),inputHeight:i.height}})()');
    assert.equal(m.dir,'rtl');assert.equal(m.open,true,'open '+width);assert.equal(m.overflow,false,'overflow '+width);
    assert.equal(m.inside,true,'listbox stays within the control '+width);assert.equal(m.touch,true,'44px options '+width);assert.ok(m.inputHeight>=44);
    await key('Escape');
   }
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
   await type('אשדוד');await key('Escape');
  });
  await t.test('Payment verification gates Join: failed, cancelled, changed contact, rejection and fail-closed states',async()=>{
   await ev('localStorage.clear();sessionStorage.clear();existing=true;quantity=1;group={...group,status:"OPEN",publicId:"11111111-1111-4111-8111-111111111111"};'+reconnect);
   await wait('!widget.hasAttribute("aria-busy")');
   await ev('widget.querySelector("[name=area]").value="אשדוד";void widget.perform(()=>widget.find())');await wait('!widget.hasAttribute("aria-busy")');
   const step='widget.querySelector("[data-payment-step]")',status='widget.querySelector("[data-payment-status]").textContent',join='widget.querySelector("[data-join-button]")';
   assert.equal(await ev(step+'.hidden'),false);assert.equal(await ev(step+'.dataset.state'),'required');
   assert.equal(await ev(status),tr.group_delivery.pay_required);assert.equal(await ev(join+'.disabled'),true);
   assert.equal(await ev(step+'.querySelectorAll("input,select,textarea,iframe").length'),0,'no payment-detail fields of our own');
   await ev('widget.querySelector("[name=email]").value="verify@example.test";widget.querySelector("[name=phone]").value="0501112233"');
   // Starting verification shows the clearly labelled development control.
   await ev('widget.querySelector("[data-verify-payment]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev(step+'.dataset.state'),'verifying');assert.equal(await ev('widget.querySelector("[data-mock-payment]").hidden'),false);
   assert.equal(await ev('widget.querySelector(".group-delivery__mock-badge").textContent'),tr.group_delivery.pay_test_badge);
   assert.equal(await ev('document.activeElement.dataset.mockOutcome'),'verified','focus moves to the test control');
   assert.deepEqual(await ev('requests.filter(r=>r.url.endsWith("/payment-verifications")).at(-1).body'),{email:'verify@example.test',phone:'0501112233'});
   for(const outcome of ['failed','cancelled']){
    await ev('widget.querySelector("[data-mock-outcome='+outcome+']").click()');await wait('!widget.hasAttribute("aria-busy")');
    assert.equal(await ev(step+'.dataset.state'),outcome);assert.equal(await ev(status),tr.group_delivery['pay_'+outcome]);
    assert.equal(await ev('widget.message.textContent'),tr.group_delivery['pay_'+outcome]);
    assert.equal(await ev(join+'.disabled'),true,outcome+' never enables Join');assert.equal(await ev('widget.querySelector("[data-verify-payment]").hidden'),false);
    await ev('widget.querySelector("[data-verify-payment]").click()');await wait('!widget.hasAttribute("aria-busy")');
   }
   await ev('widget.querySelector("[data-mock-outcome=verified]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev(step+'.dataset.state'),'verified');assert.equal(await ev(status),tr.group_delivery.pay_verified);
   assert.equal(await ev(join+'.disabled'),false);assert.equal(await ev('document.activeElement===widget.querySelector("[data-join-button]")'),true);
   assert.equal(await ev('widget.querySelector("[data-mock-payment]").hidden'),true);
   const mockCalls=await ev('requests.filter(r=>r.url.endsWith("/mock-result"))');
   assert.ok(mockCalls.length>=3&&mockCalls.every(r=>r.headers.Authorization==='Bearer '+'d'.repeat(64)),'verification secret travels only as a bearer header');
   // Editing the contact voids the verification.
   await ev('{const phone=widget.querySelector("[name=phone]");phone.value="0509998877";phone.dispatchEvent(new Event("input",{bubbles:true}));}');
   assert.equal(await ev(step+'.dataset.state'),'reverify');assert.equal(await ev(status),tr.group_delivery.pay_reverify);assert.equal(await ev(join+'.disabled'),true);
   await verifyPayment();assert.equal(await ev(join+'.disabled'),false);
   // The service rejects the verification: no receipt, and the shopper starts verification again.
   await ev('window.apiResponse={status:403,body:{code:"PAYMENT_VERIFICATION_REQUIRED"}};widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   await ev('window.apiResponse=null');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_payment_required);
   assert.equal(await ev(step+'.dataset.state'),'expired');assert.equal(await ev(join+'.disabled'),true);
   assert.equal(await ev('localStorage.length'),0,'no receipt without a successful join');
   // No configured provider, or anything other than the simulator, fails closed without navigating anywhere.
   await ev('window.apiResponse={status:503,body:{code:"PAYMENTS_UNAVAILABLE"}};widget.querySelector("[data-verify-payment]").click()');await wait('!widget.hasAttribute("aria-busy")');
   await ev('window.apiResponse=null');assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_payments_unavailable);
   await ev('window.verificationCreate={verification:{id:"99999999-9999-4999-8999-999999999990",status:"PENDING",expiresAt:"2050-01-01T00:00:00.000Z"},verificationToken:"d".repeat(64),next:{type:"redirect",url:"https://evil.example/pay"}};widget.querySelector("[data-verify-payment]").click()');await wait('!widget.hasAttribute("aria-busy")');
   await ev('window.verificationCreate=null');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_payments_unavailable);assert.equal(await ev('location.hostname'),'127.0.0.1');
   assert.equal(await ev('widget.querySelector("[data-mock-payment]").hidden'),true);assert.equal(await ev(join+'.disabled'),true);
   const stored=await ev('JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage})+document.documentElement.outerHTML+logged.join("\\n")');
   assert.ok(!stored.includes('d'.repeat(64)),'verification secret is never stored, rendered or logged');
   // A clean verified join still works and stores only the receipt.
   await verifyPayment();await ev('widget.querySelector("[data-join-group]").requestSubmit()');await wait('!widget.hasAttribute("aria-busy")');
   assert.deepEqual(await ev('Object.keys(JSON.parse(localStorage.getItem('+receiptKey+')))'),['publicId','memberToken','savedAt']);
   assert.equal(await ev(step+'.hidden'),true);
  });
  await t.test('Payment phase: awaiting store, exact-amount consent with deadline, changed and invalid carts, cancellation',async()=>{
   const base={active:true,pledgedAgorot:1590,paymentMethod:'VERIFIED',approval:{status:'NOT_REQUIRED',amountAgorot:null,nonce:null,review:null},charge:{status:'NOT_STARTED',amountAgorot:null,chargedAt:null,failure:null},actions:{approve:false,decline:false}};
   const required={...base,approval:{status:'REQUIRED',amountAgorot:1590,nonce:'e'.repeat(32),review:null},actions:{approve:true,decline:true}};
   const setMember=member=>ev('window.member='+JSON.stringify(member));
   const refresh=async()=>{await ev('widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');};
   const box='widget.querySelector("[data-member-payment]")',approve='widget.querySelector("[data-approve-payment]")',decline='widget.querySelector("[data-decline-payment]")';
   const title='widget.querySelector("[data-member-pay-title]").textContent',detail='widget.querySelector("[data-member-pay-detail]").textContent';
   // Threshold reached, store has not approved yet: nothing to approve.
   await ev('localStorage.clear();localStorage.setItem('+receiptKey+',JSON.stringify({publicId:group.publicId,memberToken:"a".repeat(64),savedAt:Date.now()}));group={...group,status:"THRESHOLD_REACHED",progressPercent:100,remainingAmountAgorot:0,approvals:{approved:0,waiting:0,approvedPledgeTotalAgorot:0,ready:false,deadline:null}}');
   await setMember(base);await ev(reconnect);await wait('!widget.hasAttribute("aria-busy")');
   const restore=await ev('requests.filter(r=>r.url.endsWith("/membership")).at(-1)');
   assert.equal(restore.headers.Authorization,'Bearer '+'a'.repeat(64));assert.equal(restore.method,'GET');
   assert.equal(await ev(box+'.dataset.state'),'awaiting_store');assert.equal(await ev(title),tr.group_delivery.member_awaiting_store_title);
   assert.equal(await ev('widget.querySelector("[data-group-state]").textContent'),tr.group_delivery.status.threshold_reached);
   assert.equal(await ev(approve+'.hidden'),true);assert.equal(await ev(decline+'.hidden'),true);
   assert.equal(await ev('widget.querySelector("[data-approvals-summary]").hidden'),true);
   // Merchant approved: exact amount, deadline and explicit approval.
   await ev('group={...group,status:"PAYMENT_OPEN",approvals:{approved:1,waiting:4,approvedPledgeTotalAgorot:1590,ready:false,deadline:"2050-01-02T10:00:00.000Z"}}');
   await setMember(required);await refresh();
   assert.equal(await ev(box+'.dataset.state'),'required');assert.equal(await ev(title),tr.group_delivery.member_required_title);
   assert.ok((await ev('widget.querySelector("[data-member-pay-amount]").textContent')).includes('15.90'));
   assert.ok((await ev(approve+'.textContent')).includes('15.90'));assert.equal(await ev(decline+'.textContent'),tr.group_delivery.decline);
   assert.equal(await ev('widget.querySelector("[data-member-pay-exact]").textContent'),tr.group_delivery.member_exact);
   assert.ok((await ev('widget.querySelector("[data-member-pay-deadline]").textContent')).includes('2050'));
   const summary=await ev('widget.querySelector("[data-approvals-summary]").textContent');
   assert.ok(summary.startsWith(tr.group_delivery.approvals.replace('{{ approved }}','1').replace('{{ waiting }}','4'))&&summary.includes('15.90'));
   assert.notEqual(await ev('widget.message.textContent'),tr.group_delivery.closed,'members in the payment phase are not told the group is closed');
   // Double click: one request with the shown nonce and amount; the reply is consent only.
   await setMember({...required,approval:{...required.approval,status:'APPROVED',nonce:null},actions:{approve:false,decline:true}});
   await ev('window.memberAfterApproval=member;'+approve+'.click();'+approve+'.click()');await wait('!widget.hasAttribute("aria-busy")');
   const sent=await ev('approvals');assert.equal(sent.length,1);
   assert.deepEqual(sent[0],{decision:'approve',approvalNonce:'e'.repeat(32),amountAgorot:1590});
   assert.equal(await ev(box+'.dataset.state'),'approved');assert.equal(await ev('widget.message.textContent'),tr.group_delivery.member_approved);
   assert.equal(await ev(approve+'.hidden'),true);assert.equal(await ev(decline+'.textContent'),tr.group_delivery.withdraw,'consent can be withdrawn before execution');
   assert.equal(await ev('widget.querySelector("[data-member-pay-deadline]").hidden'),false);
   // Execution states.
   for(const [charge,state] of [['AUTHORIZED','authorized'],['PENDING','processing']]){
    await setMember({...base,approval:{status:'APPROVED',amountAgorot:1590,nonce:null,review:null},charge:{...base.charge,status:charge}});await refresh();
    assert.equal(await ev(box+'.dataset.state'),state);assert.equal(await ev(approve+'.hidden'),true);assert.equal(await ev(decline+'.hidden'),true);
   }
   await setMember({...base,approval:{status:'APPROVED',amountAgorot:1590,nonce:null,review:null},charge:{status:'SUCCEEDED',amountAgorot:1590,chargedAt:'2050-01-01T00:00:00.000Z',failure:null}});await refresh();
   assert.equal(await ev(box+'.dataset.state'),'paid');assert.ok((await ev('widget.querySelector("[data-member-pay-amount]").textContent')).includes(tr.group_delivery.member_charged));
   await setMember({...required,approval:{status:'APPROVED',amountAgorot:1590,nonce:'e'.repeat(32),review:null},charge:{...base.charge,status:'FAILED',failure:'DECLINED'}});await refresh();
   assert.equal(await ev(box+'.dataset.state'),'failed');assert.ok((await ev(approve+'.textContent')).startsWith(tr.group_delivery.retry.split('{{')[0]));
   // Shopify revalidation changed the price: the old approval is void and the new amount needs approval.
   await setMember({...required,pledgedAgorot:1690,approval:{status:'REQUIRED',amountAgorot:1690,nonce:'f'.repeat(32),review:'CART_CHANGED',previousAmountAgorot:1590}});await refresh();
   assert.ok((await ev('widget.querySelector("[data-member-pay-previous]").textContent')).includes('15.90'),'previously approved amount shown');
   assert.equal(await ev(box+'.dataset.state'),'changed');assert.equal(await ev(title),tr.group_delivery.member_changed_title);assert.equal(await ev(detail),tr.group_delivery.member_changed);
   assert.ok((await ev(approve+'.textContent')).includes('16.90'));
   // A stale screen: the server refuses and the panel refreshes to the current amount.
   await setMember({...required,pledgedAgorot:3180,approval:{status:'REQUIRED',amountAgorot:3180,nonce:'c'.repeat(32),review:'CART_CHANGED'}});
   await ev('window.approvalResponse={status:409,body:{code:"PAYMENT_AMOUNT_CHANGED"}};'+approve+'.click()');await wait('!widget.hasAttribute("aria-busy")');
   await ev('window.approvalResponse=null');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_amount_changed);assert.ok((await ev(approve+'.textContent')).includes('31.80'));
   // Decline is explicit.
   await ev('window.memberAfterApproval={...member,approval:{...member.approval,status:"DECLINED"},actions:{approve:true,decline:false}};'+decline+'.click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.deepEqual(await ev('approvals.at(-1)'),{decision:'decline'});
   assert.equal(await ev(box+'.dataset.state'),'declined');assert.equal(await ev(decline+'.hidden'),true);assert.equal(await ev(approve+'.hidden'),false);
   // Unavailable cart, cancelled group, legacy member: explanations only.
   await setMember({...base,approval:{status:'INVALIDATED',amountAgorot:1590,nonce:null,review:'CART_UNAVAILABLE'}});await refresh();
   assert.equal(await ev(box+'.dataset.state'),'invalidated');assert.equal(await ev(detail),tr.group_delivery.member_invalidated);assert.equal(await ev(approve+'.hidden'),true);
   await ev('group={...group,status:"CANCELLED"}');
   await setMember({...base,approval:{status:'APPROVED',amountAgorot:1590,nonce:null,review:null},charge:{...base.charge,status:'VOIDED'}});await refresh();
   assert.equal(await ev(box+'.dataset.state'),'cancelled');assert.equal(await ev(detail),tr.group_delivery.member_cancelled);
   await ev('group={...group,status:"PAYMENT_OPEN"}');
   await setMember({...base,paymentMethod:'NOT_STARTED'});await refresh();
   assert.equal(await ev(box+'.dataset.state'),'legacy');assert.equal(await ev(approve+'.hidden'),true);
   // Narrow RTL fit with the approval panel open.
   await setMember(required);await refresh();
   for(const width of [320,390]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    assert.equal(await ev('document.documentElement.scrollWidth>innerWidth'),false,'overflow '+width);
    assert.equal(await ev('['+approve+','+decline+'].every(b=>b.getBoundingClientRect().height>=44)'),true);
   }
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
   const stored=await ev('JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage})');
   for(const forbidden of ['e'.repeat(32),'f'.repeat(32),'approval','charge','VERIFIED'])assert.ok(!stored.includes(forbidden),'payment state stored: '+forbidden);
   await ev('window.member=undefined;window.memberAfterApproval=undefined;group={...group,status:"OPEN",progressPercent:73,remainingAmountAgorot:13500};delete group.approvals;'+reconnect);await wait('!widget.hasAttribute("aria-busy")');
  });
  await t.test('Member tokens never appear in logs or rendered content',async()=>{
   const page=await ev('document.documentElement.outerHTML'),logs=await ev('logged.join("\\n")');
   for(const token of ['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)]){assert.ok(!page.includes(token),'rendered token');assert.ok(!logs.includes(token),'logged token');}
  });

  await t.test('Milestones, clamping, safe share and known errors',async()=>{
   await ev('window.done=null;const button=widget.querySelector("[data-refresh]");void widget.perform(()=>new Promise(resolve=>window.done=resolve),button)');
   assert.equal(await ev('widget.querySelector("[data-refresh]").getAttribute("aria-busy")'), 'true');
   assert.equal(await ev('widget.querySelector("[data-join-group]").inert'), true);
   await ev('done()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.querySelector("[data-refresh]").hasAttribute("aria-busy")'),false);
   for(const [progress,state] of [[0,'normal'],[50,'middle'],[80,'almost'],[99,'almost'],[120,'success']]){
    await ev('widget.show({...group,status:"OPEN",progressPercent:'+progress+'})');
    assert.equal(await ev('widget.querySelector("[data-group-panel]").dataset.milestone'),state);
    assert.equal(await ev('widget.querySelector("[role=progressbar]").getAttribute("aria-valuenow")'),String(Math.min(100,progress)));
   }
   await ev('widget.show({...group,status:"OPEN",progressPercent:80,participantCount:1})');
   assert.equal(await ev('widget.querySelector("[data-milestone-message]").hidden'),false);
   assert.equal(await ev('widget.querySelector("[data-participants]").textContent'),tr.group_delivery.participant_one);
   await ev('widget.show({...group,status:"THRESHOLD_REACHED",progressPercent:100})');
   assert.equal(await ev('widget.querySelector("[data-milestone-title]").textContent'),tr.group_delivery.reached);
   assert.equal(await ev('widget.querySelector("[data-milestone-detail]").textContent'),tr.group_delivery.waiting);
   await ev('window.open=(...args)=>window.shared=args;history.replaceState(null,"","/?memberToken=private#secret");widget.querySelector("[data-share]").click()');
   const shared=await ev('shared');const text=new URL(shared[0]).searchParams.get('text');
   assert.ok(text.includes('500'));assert.ok(!/memberToken|private|secret|fixture@example|__TARGET__/.test(text));
   assert.equal(shared[2],'noopener,noreferrer');
   for(const [code,key] of [['INVALID_CART','invalid_cart'],['SHOPIFY_UNAVAILABLE','shopify_error'],['CART_UNAVAILABLE','cart_unavailable'],['GROUP_CLOSED','closed'],['GROUP_NOT_OPEN','error'],['INVALID_ORIGIN','error_unavailable'],['UNKNOWN_FUTURE_CODE','error']]){
    await ev('widget.perform(async()=>{throw Object.assign(Error(),{code:'+JSON.stringify(code)+'})})');
    assert.equal(await ev('widget.message.textContent'),tr.group_delivery[key]);
   }
   await ev('(async()=>{widget.show({...group,status:"EXPIRED"});quantity=0;await widget.perform(()=>widget.cart())})()');
   assert.equal(await ev('widget.querySelector("[data-empty-cart]").hidden'),false);
   assert.equal(await ev('widget.querySelector("[data-join-button]").disabled'),true);
  });
  await t.test('Actual server codes and proxy failures show Hebrew messages without server text',async()=>{
   await ev('widget.show({...group,status:"OPEN"})');
   const cases=[
    [{status:409,body:{code:'LOCATION_OUTSIDE_GROUP',error:'internal secret detail'}},'error_outside'],
    [{status:409,body:{code:'GROUP_FULL',error:'internal secret detail'}},'error_full'],
    [{status:409,body:{code:'GROUP_CLOSED',error:'internal secret detail'}},'closed'],
    [{status:409,body:{code:'ALREADY_JOINED'}},'duplicate'],
    [{status:401,body:{code:'MEMBER_AUTH_REQUIRED'}},'error_receipt'],
    [{status:404,body:{code:'GROUP_NOT_FOUND'}},'error_not_found'],
    [{status:429,body:{code:'RATE_LIMITED'}},'error_rate_limited'],
    [{status:429,raw:'Too Many Requests'},'error_rate_limited'],
    [{status:502,raw:'<html>Bad gateway internal secret</html>'},'error_unavailable'],
    [{status:200,raw:'not json'},'error']
   ];
   for(const [response,key] of cases){
    await ev('window.apiResponse='+JSON.stringify(response)+';widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
    assert.equal(await ev('widget.message.textContent'),tr.group_delivery[key],JSON.stringify(response));
    assert.ok(!(await ev('widget.message.textContent')).includes('secret'));
   }
   await ev('window.apiResponse=null;window.apiNetworkError=true;widget.querySelector("[data-refresh]").click()');await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_network);
   await ev('window.apiNetworkError=false');
  });
  await t.test('Cold start announces waking, stays single-flight, times out finitely and aborts silently',async()=>{
   await ev('{const C=customElements.get("fankee-group-delivery");C.wakeDelay=60;C.requestTimeout=600;window.apiDelay=250;group.status="OPEN"}');
   let before=await ev('requests.length');
   await ev('widget.querySelector("[data-refresh]").click();widget.querySelector("[data-refresh]").click()');
   await wait('widget.message.textContent==='+JSON.stringify(tr.group_delivery.waking));
   assert.equal(await ev('widget.querySelector("[data-refresh]").getAttribute("aria-busy")'),'true');
   assert.equal(await ev('widget.querySelector("[data-join-group]").inert'),true);
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('requests.length'),before+1,'duplicate request while busy');
   assert.equal(await ev('widget.message.textContent'),'','waking state must clear after success');
   await ev('window.apiDelay=5000;widget.querySelector("[data-refresh]").click()');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.error_timeout);
   assert.equal(await ev('widget.querySelector("[data-refresh]").hasAttribute("aria-busy")'),false);
   assert.equal(await ev('widget.querySelector("[data-join-group]").inert'),false);
   // Removing the widget mid-request aborts it without surfacing an error.
   await ev('widget.querySelector("[data-refresh]").click()');await wait('widget.requests.size===1');
   await ev('window.parked=widget.parentNode;widget.remove()');
   await sleep(50);assert.equal(await ev('widget.requests.size'),0);
   await sleep(80);assert.notEqual(await ev('widget.message.textContent'),tr.group_delivery.error_timeout);
   await ev('{window.apiDelay=0;const C=customElements.get("fankee-group-delivery");C.wakeDelay=12000;C.requestTimeout=90000;parked.append(widget)}');
   await wait('!widget.hasAttribute("aria-busy")');
  });
  await t.test('Mobile and desktop RTL fit, keyboard targets are usable, progress respects reduced motion',async()=>{
   // Measure the settled layout: wait for finite entrance animations (infinite shimmer/pulse never finish).
   await ev('Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))');
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const m=await ev('({overflow:document.documentElement.scrollWidth>innerWidth,dir:getComputedStyle(widget).direction,small:[...widget.querySelectorAll("button")].filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height<44).map(n=>(n.textContent.trim()||n.outerHTML.slice(0,60))+" "+n.getBoundingClientRect().height.toFixed(1))})');
    assert.equal(m.overflow,false,'overflow '+width);assert.equal(m.dir,'rtl');assert.deepEqual(m.small,[],'44px buttons '+width);
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

  await t.test('Blank theme configuration uses the public service origin; explicit configuration takes precedence',async()=>{
   const configured=await ev('widget.origin.origin');
   assert.equal(configured,'https://groups.example.test');
   const fallback=raw.match(/assign group_delivery_service_url = section.settings.service_url \| default: '([^']+)'/)[1];
   assert.equal(fallback,'https://fankee-group-delivery.onrender.com');
   await ev('widget.remove();widget.dataset.serviceUrl='+JSON.stringify(fallback)+';document.querySelector("main").append(widget)');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.origin.origin'),fallback);
   await ev('group.status="OPEN";quantity=1;widget.querySelector("[name=area]").value="אשדוד";void widget.perform(()=>widget.find())');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.ok(await ev('requests.some(r=>r.url==='+JSON.stringify(fallback+'/api/v1/groups/find')+')'));
   assert.equal(await ev('widget.querySelector("[data-group-panel]").hidden'),false);
   assert.equal(await ev('widget.message.textContent'),tr.group_delivery.found);
   await ev('widget.remove();widget.dataset.serviceUrl="https://groups.example.test";document.querySelector("main").append(widget)');
   await wait('!widget.hasAttribute("aria-busy")');
   assert.equal(await ev('widget.origin.origin'),configured);
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
