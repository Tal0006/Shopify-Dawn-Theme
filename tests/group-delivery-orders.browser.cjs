// Group Delivery orders in real headless Chrome (migration 018): "עדכון ההזמנה" and "הזמנה נוספת" are distinct actions,
// a paid (locked) order is never updated or overwritten, the separate order is sent once (double clicks, loading state,
// errors), receipts of linked orders after the owner split, and the page against current-backend responses (theme first).
// The test server serves the real section markup and assets/group-delivery.js with a stateful fake service.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');

test('Group Delivery orders and receipts',{timeout:180000},async t=>{
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

 // Stateful fake service with the order-lifecycle responses (migration 018). members: token -> {publicId, member}.
 const aggregate=(publicId,areaName,status,total=30000)=>({publicId,areaName,status,participantCount:3,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:total,remainingAmountAgorot:Math.max(0,50000-total),progressPercent:Math.min(100,Math.round(total/500)),expiresAt:'2050-01-01T00:00:00.000Z'});
 const line={variantId:'101',title:'אבקת כביסה',quantity:1,storedUnitAgorot:1590,currentUnitAgorot:1590,available:true,restorableQuantity:1,maxAvailableQuantity:100,priceChanged:false,reason:'AVAILABLE'};
 const ID={old:'bbbbbbbb-0000-4000-8000-000000000001',next:'bbbbbbbb-0000-4000-8000-000000000002',open:'bbbbbbbb-0000-4000-8000-000000000003'};
 const TOKEN={old:'1'.repeat(64),next:'2'.repeat(64),open:'3'.repeat(64),fresh:'4'.repeat(64)};
 const state={requests:[],bodies:[],groups:{},members:{},orders:{status:201,delay:0},linked:[]};
 const reset=()=>{
  state.requests=[];state.bodies=[];state.orders={status:201,delay:0};state.linked=[];
  state.groups={[ID.old]:aggregate(ID.old,'אשדוד','OPEN',33830),[ID.next]:aggregate(ID.next,'אשדוד','OPEN',36850),[ID.open]:aggregate(ID.open,'אשקלון','OPEN')};
  state.members={};
 };
 reset();
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');let body='';req.on('data',c=>body+=c);req.on('end',async()=>{
   const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+';charset=utf-8'});res.end(typeof data==='string'?data:JSON.stringify(data));};
   if(url.pathname.startsWith('/api/v1/')){state.requests.push(req.method+' '+url.pathname);if(body)state.bodies.push({path:url.pathname,body:JSON.parse(body)});}
   if(url.pathname==='/'||url.pathname==='/pages/group-delivery')return send(200,page(),'text/html');
   if(url.pathname==='/assets/group-delivery.js')return send(200,fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8'),'text/javascript');
   if(url.pathname==='/he/cart.js')return send(200,{currency:'ILS',total_price:1590,items:[{variant_id:101,quantity:1,properties:{}}]});
   if(url.pathname==='/api/v1/areas')return send(200,{areas:[{publicId:'6f1a2c00-0002-4a00-8000-0000000000a2',name:'אשדוד'},{publicId:'6f1a2c00-0003-4a00-8000-0000000000a3',name:'אשקלון'}]});
   const token=(req.headers.authorization||'').replace('Bearer ','');
   const member=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/member$/);
   if(member){const entry=state.members[token];return entry&&entry.publicId===member[1]?send(200,{member:entry.member}):send(401,{code:'MEMBER_AUTH_REQUIRED'});}
   const linked=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/member\/linked$/);
   if(linked){const entry=state.members[token];if(!entry||entry.publicId!==linked[1])return send(401,{code:'MEMBER_AUTH_REQUIRED'});return send(200,{orders:state.linked});}
   const orders=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/orders$/);
   if(orders){
    if(state.orders.delay)await sleep(state.orders.delay);
    if(state.orders.status!==201)return send(state.orders.status,{code:state.orders.code});
    state.members[TOKEN.fresh]={publicId:ID.next,member:{status:'PLEDGED',pledgedTotalAgorot:1590,cartCheck:'OK',cart:[line]}};
    return send(201,{group:state.groups[ID.next],memberToken:TOKEN.fresh,validatedPledgeAgorot:1590,created:false});
   }
   const update=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/update-pledge$/);
   if(update){const entry=state.members[token];if(!entry)return send(401,{code:'MEMBER_AUTH_REQUIRED'});
    if(entry.member.orderState==='LOCKED')return send(409,{code:'ORDER_LOCKED'});
    return send(200,{group:state.groups[update[1]],validatedPledgeAgorot:1590});}
   const get=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})$/);
   if(get&&req.method==='GET')return state.groups[get[1]]?send(200,{group:state.groups[get[1]]}):send(404,{code:'GROUP_NOT_FOUND'});
   send(404,{code:'NOT_FOUND'});
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const prefix='fankee-group-delivery:'+origin+':receipt:';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-orders-'));
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
  const panel=()=>tab.ev(`({group:widget.group?.publicId||null,mine:!widget.querySelector("[data-mine]").hidden,
   update:!widget.querySelector("[data-join-button]").hidden,updateLabel:widget.querySelector("[data-join-button]").textContent.trim(),
   another:!widget.querySelector("[data-another-order]").hidden,locked:!widget.querySelector("[data-member-locked]").hidden,withdraw:!widget.querySelector("[data-withdraw]").hidden})`);
  const pledged={status:'PLEDGED',pledgedTotalAgorot:1590,cartCheck:'OK',cart:[line]};

  await t.test('open order: "עדכון ההזמנה" edits it; "הזמנה נוספת" is not offered; nothing new is created',async()=>{
   reset();state.members[TOKEN.open]={publicId:ID.open,member:pledged};
   await receipts([ID.open,TOKEN.open,Date.now()]);await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.open)+'&&!widget.querySelector("[data-mine]").hidden');
   const view=await panel();
   assert.deepEqual([view.update,view.another,view.locked,view.withdraw],[true,false,false,true]);
   assert.equal(view.updateLabel,g.update);
   await tab.ev('widget.querySelector("[data-join-group]").requestSubmit()');
   await tab.wait('!widget.hasAttribute("aria-busy")&&document.querySelector("[data-group-message]").textContent==='+JSON.stringify(g.updated));
   assert.deepEqual(state.requests.filter(r=>r.startsWith('POST')&&!r.endsWith('/member')),['POST /api/v1/groups/'+ID.open+'/update-pledge']);
  });

  await t.test('paid (locked) order: never updated; "הזמנה נוספת" asks first, sends ONE request on a double click, keeps both receipts',async()=>{
   reset();state.members[TOKEN.old]={publicId:ID.old,member:{...pledged,orderState:'LOCKED'}};
   await receipts([ID.old,TOKEN.old,Date.now()]);await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.old)+'&&!widget.querySelector("[data-member-locked]").hidden');
   const view=await panel();
   assert.deepEqual([view.update,view.another,view.locked,view.withdraw],[false,true,true,false],'no edit, no withdrawal, another order offered');
   assert.equal(await tab.ev('widget.querySelector("[data-member-locked]").textContent'),g.order_locked_state);
   // The dialog explains it is a separate order; cancel sends nothing.
   await tab.ev('widget.querySelector("[data-another-order]").click()');
   assert.equal(await tab.ev('widget.querySelector("[data-another-dialog]").open'),true);
   assert.ok((await tab.ev('widget.querySelector("[data-another-dialog]").textContent')).includes(g.another_order_text));
   await tab.ev('widget.querySelector("[data-another-cancel]").click()');
   assert.equal(state.requests.filter(r=>r.endsWith('/orders')).length,0);
   // Confirm twice quickly while the service is slow: one request, a loading state, then success.
   state.orders.delay=500;
   await tab.ev('widget.querySelector("[data-another-order]").click()');
   await tab.ev('{const b=widget.querySelector("[data-another-confirm]");b.click();b.click();}');
   await tab.wait('widget.hasAttribute("aria-busy")',3000);
   await tab.wait('!widget.hasAttribute("aria-busy")&&document.querySelector("[data-group-message]").textContent==='+JSON.stringify(g.another_order_done),5000);
   const sent=state.bodies.filter(b=>b.path.endsWith('/orders'));
   assert.equal(sent.length,1,'exactly one order request');
   assert.equal(sent[0].body.confirm,true);assert.match(sent[0].body.requestId,/^[0-9a-f-]{36}$/);
   assert.equal(state.requests.filter(r=>r.endsWith('/update-pledge')).length,0,'the paid order was never touched');
   assert.deepEqual(await stored(),[ID.old,ID.next].sort(),'the historical receipt is kept beside the new one');
   assert.equal(await tab.ev('widget.group?.publicId'),ID.next);
  });

  await t.test('another order refused (e.g. an open order already exists): the message, no receipt, the action can be retried',async()=>{
   reset();state.members[TOKEN.old]={publicId:ID.old,member:{...pledged,orderState:'LOCKED'}};
   await receipts([ID.old,TOKEN.old,Date.now()]);await tab.go();
   await tab.wait('!widget.querySelector("[data-another-order]").hidden');
   state.orders={status:409,code:'ORDER_EXISTS_IN_CYCLE',delay:0};
   await tab.ev('widget.querySelector("[data-another-order]").click()');await tab.ev('widget.querySelector("[data-another-confirm]").click()');
   await tab.wait('!widget.hasAttribute("aria-busy")&&document.querySelector("[data-group-message]").textContent==='+JSON.stringify(g.order_exists_in_cycle));
   assert.deepEqual(await stored(),[ID.old],'no new receipt');
   assert.equal(await tab.ev('widget.querySelector("[data-another-confirm]").disabled'),false,'not stuck');
   state.orders={status:201,delay:0};
   await tab.ev('widget.querySelector("[data-another-dialog]").open||widget.querySelector("[data-another-order]").click()');
   await tab.ev('widget.querySelector("[data-another-confirm]").click()');
   await tab.wait('document.querySelector("[data-group-message]").textContent==='+JSON.stringify(g.another_order_done));
   assert.deepEqual(await stored(),[ID.old,ID.next].sort());
  });

  await t.test('after the owner split: the old receipt fetches the linked order once and shows it; the historical one stays',async()=>{
   reset();
   state.groups[ID.old]=aggregate(ID.old,'אשדוד','COMPLETED',33830);
   state.members[TOKEN.old]={publicId:ID.old,member:{...pledged,orderState:'LOCKED',linkedGroupPublicIds:[ID.next]}};
   state.members[TOKEN.next]={publicId:ID.next,member:{status:'PLEDGED',pledgedTotalAgorot:8610,cartCheck:'OK',cart:[line]}};
   state.linked=[{groupPublicId:ID.next,memberToken:TOKEN.next}];
   await receipts([ID.old,TOKEN.old,Date.now()]);await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.next)+'&&!widget.querySelector("[data-mine]").hidden');
   assert.deepEqual(await stored(),[ID.old,ID.next].sort(),'both receipts on this device');
   assert.equal(state.requests.filter(r=>r.endsWith('/member/linked')).length,1,'fetched once');
   const view=await panel();assert.deepEqual([view.update,view.another,view.locked],[true,false,false],'the new order is open and editable');
   // Next visit: both receipts are already here; nothing is fetched again.
   const before=state.requests.length;await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.next));
   assert.equal(state.requests.slice(before).filter(r=>r.endsWith('/member/linked')).length,0);
   // A transferred order (old receipt reads WITHDRAWN + linked) behaves the same.
   reset();
   state.groups[ID.old]=aggregate(ID.old,'אשדוד','COMPLETED',33830);
   state.members[TOKEN.old]={publicId:ID.old,member:{status:'WITHDRAWN',pledgedTotalAgorot:0,cartCheck:'OK',cart:[],linkedGroupPublicIds:[ID.next]}};
   state.members[TOKEN.next]={publicId:ID.next,member:{status:'PLEDGED',pledgedTotalAgorot:28240,cartCheck:'OK',cart:[line]}};
   state.linked=[{groupPublicId:ID.next,memberToken:TOKEN.next}];
   await receipts([ID.old,TOKEN.old,Date.now()]);await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.next)+'&&!widget.querySelector("[data-mine]").hidden');
  });

  await t.test('current-backend responses (no order fields): the page behaves exactly as before — no new requests or buttons',async()=>{
   reset();state.members[TOKEN.open]={publicId:ID.open,member:pledged};
   state.groups[ID.old]=aggregate(ID.old,'אשדוד','COMPLETED');state.members[TOKEN.old]={publicId:ID.old,member:pledged};
   await receipts([ID.open,TOKEN.open,Date.now()],[ID.old,TOKEN.old,Date.now()-1000]);await tab.go();
   await tab.wait('widget.group?.publicId==='+JSON.stringify(ID.open)+'&&!widget.querySelector("[data-mine]").hidden');
   const view=await panel();
   assert.deepEqual([view.update,view.another,view.locked,view.withdraw],[true,false,false,true]);
   assert.equal(state.requests.filter(r=>/\/orders$|\/member\/linked$/.test(r)).length,0,'no request the current backend does not have');
   assert.equal(await tab.ev('widget.querySelectorAll("[data-another-dialog][open]").length'),0);
  });
 }finally{
  for(const ws of sockets)ws.close();chrome?.kill();server.close();await sleep(200);
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
