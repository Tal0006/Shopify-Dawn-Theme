// Returning-device behaviour of the Group Delivery page in real headless Chrome. The test server serves the page, the
// real assets/group-delivery.js, the Shopify cart and a stateful Group Delivery API over HTTP, so reloads, closing and
// reopening a tab, and back/forward (bfcache) navigation exercise the real page start-up.
// Rule under test: only a membership receipt that the service confirms is restored; an area search never is.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');

test('Group Delivery returning device',{timeout:180000},async t=>{
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 if(!fs.existsSync(exe)){t.skip('Chrome not installed (set CHROME_PATH)');return;}
 const tr=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,''));
 const g=tr.group_delivery;
 const raw=fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8');
 const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const labels=Object.fromEntries(Object.entries(g.status).map(([key,value])=>[key.toUpperCase(),value]));
 const errorKeys=Object.fromEntries(raw.match(/assign group_errors = '([^']+)'/)[1].split(',').map(entry=>entry.split(':')));
 const errors=Object.fromEntries(Object.entries(errorKeys).map(([code,key])=>[code,g[key]]));
 const css=raw.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const theme=['theme.css','storefront.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('');
 let origin='';
 const markup=()=>raw.slice(raw.indexOf('<fankee-group-delivery'),raw.indexOf('</fankee-group-delivery>')+25)
  .replace(/<script type="application\/json" data-group-labels>[\s\S]*?<\/script>/,'<script type="application/json" data-group-labels>'+JSON.stringify(labels)+'</script>')
  .replace(/<script type="application\/json" data-group-errors>[\s\S]*?<\/script>/,'<script type="application/json" data-group-errors>'+JSON.stringify(errors)+'</script>')
  .replace(/{{ group_delivery_service_url \| escape }}/g,origin+'/')
  .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ routes.cart_add_url }}/g,'/he/cart/add').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
  .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ area }}','__AREA__').replace('{{ count }}','__COUNT__').replace('{{ amount }}','__AMOUNT__').replace('{{ target }}','__TARGET__').replace('{{ old_price }}','__OLD__').replace('{{ new_price }}','__NEW__').replace('{{ old_quantity }}','__OLD__').replace('{{ new_quantity }}','__NEW__').replace('{{ quantity }}','__QUANTITY__')))
  .replace(/{%-?[\s\S]*?-?%}/g,'');
 const page=()=>'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+theme+css+'</style>'+
  '<script>addEventListener("pageshow",e=>{window.__pageshows=(window.__pageshows||[]).concat(e.persisted)});</script></head><body><main>'+markup()+'</main><p><a id="away" href="/other">דף אחר</a></p><script src="/assets/group-delivery.js" defer></script></body></html>';

 // Stateful fake service. groups: id -> aggregate; members: token -> {publicId, member}; find: area search result.
 const AREAS=[{publicId:'6f1a2c00-0001-4a00-8000-0000000000a1',name:'באר שבע'},{publicId:'6f1a2c00-0002-4a00-8000-0000000000a2',name:'אשדוד'},{publicId:'6f1a2c00-0003-4a00-8000-0000000000a3',name:'אשקלון'},{publicId:'6f1a2c00-0007-4a00-8000-0000000000a7',name:'שדרות'}];
 const aggregate=(publicId,areaName,status)=>({publicId,areaName,status,participantCount:4,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:30000,remainingAmountAgorot:20000,progressPercent:60,expiresAt:'2050-01-01T00:00:00.000Z'});
 const line={variantId:'101',title:'אבקת כביסה',quantity:1,storedUnitAgorot:1590,currentUnitAgorot:1590,available:true,restorableQuantity:1,maxAvailableQuantity:100,priceChanged:false,reason:'AVAILABLE'};
 const pledged={status:'PLEDGED',pledgedTotalAgorot:1590,cartCheck:'OK',cart:[line]},withdrawn={status:'WITHDRAWN',pledgedTotalAgorot:0,cartCheck:'OK',cart:[]};
 const ID={ashdod:'aaaaaaaa-0000-4000-8000-000000000001',ashkelon:'aaaaaaaa-0000-4000-8000-000000000002',done:'aaaaaaaa-0000-4000-8000-000000000003',expired:'aaaaaaaa-0000-4000-8000-000000000004',beer:'aaaaaaaa-0000-4000-8000-000000000005',gone:'aaaaaaaa-0000-4000-8000-000000000006'};
 const TOKEN={ashdod:'a'.repeat(64),ashkelon:'b'.repeat(64),done:'c'.repeat(64),expired:'d'.repeat(64),beer:'e'.repeat(64),wrong:'f'.repeat(64),gone:'9'.repeat(64)};
 const state={requests:[],find:null,groups:{},members:{}};
 const reset=()=>{
  state.find=aggregate(ID.ashdod,'אשדוד','OPEN');
  state.groups={[ID.ashdod]:aggregate(ID.ashdod,'אשדוד','OPEN'),[ID.ashkelon]:aggregate(ID.ashkelon,'אשקלון','OPEN'),[ID.done]:aggregate(ID.done,'אשדוד','COMPLETED'),[ID.expired]:aggregate(ID.expired,'שדרות','EXPIRED'),[ID.beer]:aggregate(ID.beer,'באר שבע','OPEN')};
  state.members={[TOKEN.ashdod]:{publicId:ID.ashdod,member:pledged},[TOKEN.ashkelon]:{publicId:ID.ashkelon,member:pledged},[TOKEN.done]:{publicId:ID.done,member:pledged},[TOKEN.expired]:{publicId:ID.expired,member:pledged},[TOKEN.beer]:{publicId:ID.beer,member:withdrawn}};
 };
 reset();
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+';charset=utf-8'});res.end(typeof data==='string'?data:JSON.stringify(data));};
   if(url.pathname.startsWith('/api/v1/'))state.requests.push(req.method+' '+url.pathname);
   if(url.pathname==='/'||url.pathname==='/pages/group-delivery')return send(200,page(),'text/html');
   if(url.pathname==='/other')return send(200,'<!doctype html><html><head><meta charset="utf-8"></head><body><p id="other">דף אחר</p></body></html>','text/html');
   if(url.pathname==='/assets/group-delivery.js')return send(200,fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8'),'text/javascript');
   if(url.pathname==='/he/cart.js')return send(200,{currency:'ILS',total_price:1590,items:[{variant_id:101,quantity:1,properties:{}}]});
   if(url.pathname==='/api/v1/areas')return send(200,{areas:AREAS});
   if(url.pathname==='/api/v1/areas/nearest')return send(200,{area:AREAS[1]});
   if(url.pathname==='/api/v1/groups/find')return send(200,{group:state.find,canCreateOnJoin:!state.find,withinStandardRadius:false,validatedPledgeAgorot:1590});
   const member=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/member$/);
   if(member){const token=(req.headers.authorization||'').replace('Bearer ','');const entry=state.members[token];
    return entry&&entry.publicId===member[1]?send(200,{member:entry.member}):send(401,{code:'MEMBER_AUTH_REQUIRED'});}
   const get=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})$/);
   if(get&&req.method==='GET')return state.groups[get[1]]?send(200,{group:state.groups[get[1]]}):send(404,{code:'GROUP_NOT_FOUND'});
   send(404,{code:'NOT_FOUND'});
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const prefix='fankee-group-delivery:'+origin+':receipt:';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-returning-'));
 let chrome,stderr='';const sockets=new Set();
 try{
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const debug='http://'+new URL(stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1]).host;
  // One tab = one CDP connection; tabs can be closed and reopened (a real "close and reopen").
  const openTab=async(width=1280)=>{
   const target=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
   const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));sockets.add(ws);
   let id=0;const pending=new Map();
   ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
   const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
   const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;};
   const wait=async(expression,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await ev(expression))return;}catch{}await sleep(30);}throw Error('Timeout: '+expression);};
   await call('Page.enable');
   // Geolocation answered by a stub (coarse Ashdod coordinates); the service suggests the area.
   await call('Page.addScriptToEvaluateOnNewDocument',{source:'Object.defineProperty(navigator,"geolocation",{configurable:true,value:{getCurrentPosition(ok){ok({coords:{latitude:31.8,longitude:34.65}});}}});'});
   await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768});
   const ready='!!window.widget&&widget.areas?.length>0&&!widget.hasAttribute("aria-busy")';
   const go=async(p='/pages/group-delivery')=>{await call('Page.navigate',{url:origin+p});await wait('document.readyState==="complete"');if(p!=='/other'){await ev('window.widget=document.querySelector("fankee-group-delivery")');await wait(ready);}};
   const close=async()=>{ws.close();sockets.delete(ws);await fetch(debug+'/json/close/'+target.id);};
   return {call,ev,wait,go,close,ready,size:w=>call('Emulation.setDeviceMetricsOverride',{width:w,height:900,deviceScaleFactor:1,mobile:w<768})};
  };
  let tab=await openTab();
  await tab.go();
  // Unrelated data that must survive everything (accessibility settings, other app keys, a cart cookie).
  await tab.ev('localStorage.setItem("fankee-a11y","{\\"contrast\\":\\"high\\",\\"text\\":1.2}");localStorage.setItem("shopify-cart-note","keep me");sessionStorage.setItem("checkout-step","2");document.cookie="cart=c1; path=/"');
  const receipts=(...list)=>tab.ev('(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('+JSON.stringify(prefix)+'))localStorage.removeItem(k);'+
   list.map(([id,token,savedAt])=>'localStorage.setItem('+JSON.stringify(prefix+id)+','+JSON.stringify(JSON.stringify({publicId:id,memberToken:token,savedAt}))+');').join('')+'})()');
  const stored=()=>tab.ev('Object.keys(localStorage).filter(k=>k.startsWith('+JSON.stringify(prefix)+')).map(k=>k.slice('+prefix.length+')).sort()');
  const view=()=>tab.ev('({panel:!widget.querySelector("[data-group-panel]").hidden,group:widget.group?.publicId||null,mine:!widget.querySelector("[data-mine]").hidden,resume:widget.querySelector("[data-resume]").hidden?null:widget.querySelector("[data-resume-text]").textContent,area:widget.area?.name||null,input:widget.querySelector("[data-area-input]").value})');
  const START={panel:false,group:null,mine:false,resume:null,area:null,input:''};
  const chooseAshdod=async()=>{
   await tab.ev('{const i=widget.querySelector("[data-area-input]");i.focus();i.value="אשד";i.dispatchEvent(new Event("input",{bubbles:true}));for(const key of ["ArrowDown","Enter"])i.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));}');
   await tab.wait('widget.area?.name==="אשדוד"');
  };
  const search=async()=>{await tab.ev('widget.querySelector("[data-find-group]").requestSubmit()');await tab.wait(tab.ready+'&&!widget.querySelector("[data-group-panel]").hidden');};

  await t.test('search Ashdod, leave and come back, reload, or close and reopen the tab: the area search, not the Ashdod group',async()=>{
   await receipts();await tab.go();
   assert.deepEqual(await view(),START);
   await chooseAshdod();await search();
   assert.deepEqual(await view(),{panel:true,group:ID.ashdod,mine:false,resume:null,area:'אשדוד',input:'אשדוד'},'the searched group is shown in this page session');
   assert.deepEqual(await tab.ev('Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(k=>k.startsWith("fankee-group-delivery")).length'),0,'a search stores nothing');
   const before=state.requests.length;
   await tab.go('/other');await tab.go();assert.deepEqual(await view(),START,'navigate away and back');
   await tab.call('Page.reload');await tab.wait('document.readyState==="complete"');await tab.ev('window.widget=document.querySelector("fankee-group-delivery")');await tab.wait(tab.ready);
   assert.deepEqual(await view(),START,'reload');
   await tab.close();tab=await openTab();await tab.go();assert.deepEqual(await view(),START,'closed and reopened tab');
   assert.equal(state.requests.slice(before).filter(r=>/\/groups\//.test(r)).length,0,'no group is requested on any of these visits');
  });

  await t.test('a geolocation suggestion and a viewed group are not remembered',async()=>{
   await tab.ev('widget.querySelector("[data-geolocate]").click()');await tab.wait('widget.area?.name==="אשדוד"');
   await search();
   await tab.close();tab=await openTab();await tab.go();
   assert.deepEqual(await view(),START);
  });

  await t.test('an active PLEDGED receipt restores the shopper\'s own delivery, clearly labelled',async()=>{
   await receipts([ID.ashdod,TOKEN.ashdod,1000]);await tab.go();
   assert.deepEqual(await view(),{panel:true,group:ID.ashdod,mine:true,resume:null,area:null,input:''});
   assert.equal(await tab.ev('widget.querySelector("[data-mine]").textContent'),g.my_delivery+' '+g.my_delivery_text);
   assert.match(await tab.ev('widget.querySelector("[data-member-pledge]").textContent'),new RegExp('^'+g.current_pledge.split('{{')[0]));
   assert.equal(await tab.ev('widget.querySelector("[data-withdraw]").hidden'),false);
  });

  await t.test('completed and expired receipts: a short history notice, the area search stays the main flow',async()=>{
   await receipts([ID.done,TOKEN.done,1000]);const visit=state.requests.length;await tab.go();
   assert.deepEqual(await view(),{...START,resume:g.previous_completed});
   assert.deepEqual(await tab.ev('[widget.querySelector("[data-resume-primary]").textContent,widget.querySelector("[data-resume-secondary]").textContent]'),[g.search_new,g.view_previous]);
   // Migration 018: the receipt holder's own member read also runs for a closed cycle, only to find an order linked to it
   // in the next cycle (owner split); nothing else is requested and the page shows the same history notice.
   assert.deepEqual(state.requests.slice(visit).filter(r=>r.includes('/groups/')),['GET /api/v1/groups/'+ID.done,'POST /api/v1/groups/'+ID.done+'/member'],'one group read and the member read for links');
   await receipts([ID.expired,TOKEN.expired,1000]);await tab.go();
   assert.deepEqual(await view(),{...START,resume:g.previous_closed});
   assert.deepEqual(await stored(),[ID.expired],'historical receipts are kept');
  });

  await t.test('a withdrawn membership is not an active "my delivery"; renewing is an explicit choice',async()=>{
   await receipts([ID.beer,TOKEN.beer,1000]);await tab.go();
   assert.deepEqual(await view(),{...START,resume:g.membership_inactive});
   assert.equal(await tab.ev('widget.querySelector("[data-resume-secondary]").textContent'),g.renew_here);
   await tab.ev('widget.querySelector("[data-resume-secondary]").click()');
   assert.deepEqual(await view(),{panel:true,group:ID.beer,mine:false,resume:null,area:null,input:''});
   assert.equal(await tab.ev('widget.querySelector("[data-member-pledge]").textContent'),g.withdrawn_state);
   assert.equal(await tab.ev('widget.querySelector("[data-join-button]").textContent'),g.update);
   assert.equal(await tab.ev('widget.querySelector("[data-withdraw]").hidden'),true);
  });

  await t.test('several receipts: history never takes over; an active membership wins; several active ones are listed',async()=>{
   await receipts([ID.done,TOKEN.done,3000],[ID.expired,TOKEN.expired,2000]);await tab.go();
   assert.deepEqual(await view(),{...START,resume:g.previous_completed},'newest history notice only, no group selected');
   await receipts([ID.done,TOKEN.done,3000],[ID.expired,TOKEN.expired,2000],[ID.ashdod,TOKEN.ashdod,1000]);await tab.go();
   assert.deepEqual(await view(),{panel:true,group:ID.ashdod,mine:true,resume:null,area:null,input:''},'the older active receipt wins over newer history');
   await receipts([ID.ashdod,TOKEN.ashdod,1000],[ID.ashkelon,TOKEN.ashkelon,2000]);await tab.go();
   assert.deepEqual(await view(),{panel:true,group:ID.ashkelon,mine:true,resume:g.other_memberships.replace('{{ count }}','1'),area:null,input:''});
   assert.deepEqual(await tab.ev('[...widget.querySelectorAll("[data-resume-list] button")].map(b=>b.textContent)'),[g.show_membership.replace('{{ area }}','אשדוד')]);
   await tab.ev('widget.querySelector("[data-resume-list] button").click()');
   assert.deepEqual(await view(),{panel:true,group:ID.ashdod,mine:true,resume:g.other_memberships.replace('{{ count }}','1'),area:null,input:''});
   assert.deepEqual(await tab.ev('[...widget.querySelectorAll("[data-resume-list] button")].map(b=>b.textContent)'),[g.show_membership.replace('{{ area }}','אשקלון')]);
  });

  await t.test('invalid receipts are dropped one by one; valid ones stay',async()=>{
   await receipts([ID.gone,TOKEN.gone,3000],[ID.ashkelon,TOKEN.wrong,2000],[ID.done,TOKEN.done,1000]);await tab.go();
   assert.deepEqual(await stored(),[ID.done],'only the deleted group and the rejected token are removed');
   assert.deepEqual(await view(),{...START,resume:g.previous_completed});
  });

  await t.test('back/forward cache: the restored page is re-checked, a search is dropped, a changed membership is updated',async()=>{
   await receipts();await tab.go();await chooseAshdod();await search();
   await tab.ev('document.getElementById("away").click()');await tab.wait('location.pathname==="/other"');
   await tab.ev('history.back()');await tab.wait('location.pathname==="/pages/group-delivery"&&document.readyState==="complete"');
   await tab.ev('window.widget=document.querySelector("fankee-group-delivery")');await tab.wait(tab.ready);
   const restored=await tab.ev('(window.__pageshows||[]).includes(true)');
   t.diagnostic('real bfcache restore '+(restored?'exercised':'not used by this Chrome (page reloaded)'));
   assert.deepEqual(await view(),START,'after back navigation: area search');
   // Deterministic path on a live page: a persisted pageshow re-reads receipts and re-checks them with the service.
   await receipts([ID.ashdod,TOKEN.ashdod,1000]);await tab.go();
   assert.equal((await view()).mine,true);
   state.members[TOKEN.ashdod]={publicId:ID.ashdod,member:withdrawn};
   const before=state.requests.length;
   await tab.ev('dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');
   await tab.wait(tab.ready+'&&!widget.querySelector("[data-resume]").hidden');
   assert.deepEqual(await view(),{...START,resume:g.membership_inactive},'revalidated, no longer shown as active');
   assert.deepEqual(state.requests.slice(before).filter(r=>r.includes('/groups/')),['GET /api/v1/groups/'+ID.ashdod,'POST /api/v1/groups/'+ID.ashdod+'/member']);
   assert.equal(await tab.ev('performance.getEntriesByType("navigation").length'),1,'no reload');
   // A searched group on a live page is dropped by the same path.
   reset();await receipts();await tab.go();await chooseAshdod();await search();
   await tab.ev('dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');await tab.wait(tab.ready+'&&widget.querySelector("[data-group-panel]").hidden');
   assert.deepEqual(await view(),START);
  });

  await t.test('mobile 320/390/768: notices and the restored delivery fit without overflow, 44px targets',async()=>{
   for(const setup of [async()=>receipts([ID.done,TOKEN.done,1000]),async()=>receipts([ID.ashdod,TOKEN.ashdod,1000],[ID.ashkelon,TOKEN.ashkelon,2000])]){
    await setup();
    for(const width of [320,390,768]){
     await tab.size(width);await tab.go();
     const m=await tab.ev('({overflow:document.documentElement.scrollWidth>innerWidth,small:[...widget.querySelectorAll("button")].filter(b=>b.getBoundingClientRect().width&&b.getBoundingClientRect().height<43.5).map(b=>b.textContent)})');
     assert.deepEqual(m,{overflow:false,small:[]},'width '+width);
    }
   }
   await tab.size(1280);
  });

  await t.test('nothing unrelated is touched: accessibility settings, other keys, cookies and valid receipts remain',async()=>{
   await receipts([ID.ashdod,TOKEN.ashdod,1000],[ID.done,TOKEN.done,2000]);await tab.go();
   await tab.ev('dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');await tab.wait(tab.ready);
   assert.deepEqual(await tab.ev('[localStorage.getItem("fankee-a11y"),localStorage.getItem("shopify-cart-note"),document.cookie.includes("cart=c1")]'),['{"contrast":"high","text":1.2}','keep me',true]);
   assert.deepEqual(await stored(),[ID.ashdod,ID.done].sort());
  });
 }finally{
  for(const ws of sockets)ws.close();chrome?.kill();server.close();await sleep(200);
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
