// Card reservation UI (Cardcom) for the Group Delivery section: consent gate, disabled button, redirect to Cardcom's
// page, verification after return (pending / success / failure), changed-pledge consent and cancellation. The service
// and Cardcom are mocked; the redirect is intercepted (CDP Fetch, answered 204 so the page stays) and never leaves.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Group delivery card reservation UI',{timeout:120000,skip:!fs.existsSync(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')},async t=>{
 const block=file=>fs.readFileSync(path.join(root,file),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=block('sections/group-delivery.liquid')+block('snippets/storefront-design.liquid');
 const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>'+['theme.css','storefront.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('')+css+'</style></head><body><main></main></body></html>';
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-reserve-'));
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
  let id=0;const pending=new Map(),navigations=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
   if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(!p)return;m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);return;}
   // The Cardcom redirect: recorded and answered 204 (the browser stays on the page; nothing leaves the machine).
   if(m.method==='Fetch.requestPaused'){navigations.push(m.params.request.url);ws.send(JSON.stringify({id:++id,method:'Fetch.fulfillRequest',params:{requestId:m.params.requestId,responseCode:204}}));}
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(expression,label=expression)=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+label);};
  await call('Page.enable');await call('Fetch.enable',{patterns:[{urlPattern:'https://secure.cardcom.solutions/*',requestStage:'Request'}]});
  await call('Emulation.setDeviceMetricsOverride',{width:360,height:780,deviceScaleFactor:2,mobile:true});
  const origin='http://127.0.0.1:'+server.address().port;
  await call('Page.navigate',{url:origin+'/pages/group-delivery'});await wait('document.readyState==="complete"');
  const tr=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,''));
  const gd=tr.group_delivery;
  const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const raw=fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8');
  const errorKeys=Object.fromEntries(raw.match(/assign group_errors = '([^']+)'/)[1].split(',').map(entry=>entry.split(':')));
  const errors=Object.fromEntries(Object.entries(errorKeys).map(([code,key])=>[code,gd[key]]));
  const labels=Object.fromEntries(Object.entries(gd.status).map(([key,value])=>[key.toUpperCase(),value]));
  const markup=raw.slice(raw.indexOf('<fankee-group-delivery'),raw.indexOf('</fankee-group-delivery>')+25)
   .replace(/<script type="application\/json" data-group-labels>[\s\S]*?<\/script>/,'<script type="application/json" data-group-labels>'+JSON.stringify(labels)+'</script>')
   .replace(/<script type="application\/json" data-group-errors>[\s\S]*?<\/script>/,'<script type="application/json" data-group-errors>'+JSON.stringify(errors)+'</script>')
   .replace(/{{ group_delivery_service_url \| escape }}/g,'https://groups.example.test')
   .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ routes.cart_add_url }}/g,'/he/cart/add').replace(/{{ routes.all_products_collection_url }}/g,'/collections/all').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
   .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ area }}','__AREA__').replace('{{ count }}','__COUNT__').replace('{{ amount }}','__AMOUNT__').replace('{{ target }}','__TARGET__').replace('{{ old_price }}','__OLD__').replace('{{ new_price }}','__NEW__').replace('{{ old_quantity }}','__OLD__').replace('{{ new_quantity }}','__NEW__').replace('{{ quantity }}','__QUANTITY__').replace('{{ old_amount }}','__OLD__').replace('{{ new_amount }}','__NEW__')));
  const script=fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8');
  const R='33333333-3333-4333-8333-333333333333',G='44444444-4444-4444-8444-444444444444',TOKEN='c'.repeat(64);
  // Mock service state lives on window and survives remounts (a remount stands in for the return from Cardcom).
  await ev(`
   window.requests=[];window.quantity=2;window.reservationStatus='PENDING_RESERVATION';window.reservationDelay=0;
   window.memberPayment={status:'CARD_RESERVED',approvedAmountAgorot:25000,pendingAmountAgorot:null,card:null};
   window.group={publicId:${JSON.stringify(G)},areaName:'אשדוד',status:'OPEN',participantCount:1,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:25000,remainingAmountAgorot:25000,progressPercent:50,expiresAt:'2050-01-01T00:00:00.000Z',cardReservation:true};
   window.areaList=[{publicId:'6f1a2c00-0001-4a00-8000-0000000000a1',name:'באר שבע'},{publicId:'6f1a2c00-0002-4a00-8000-0000000000a2',name:'אשדוד'}];
   const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
   window.fetch=async(input,options={})=>{
    const url=new URL(input,location.origin),body=options.body?JSON.parse(options.body):null;requests.push({path:url.pathname,method:options.method||'GET',body,auth:options.headers?.Authorization||null});
    if(url.pathname==='/he/cart.js')return json({currency:'ILS',total_price:12500*quantity,items:[{variant_id:101,quantity,properties:{}}]});
    if(url.pathname==='/api/v1/areas')return json({areas:areaList});
    if(url.pathname==='/api/v1/groups/find')return json({group:null,canCreateOnJoin:true,withinStandardRadius:null,validatedPledgeAgorot:12500*quantity,cardReservationRequired:true});
    if(url.pathname==='/api/v1/groups/reserve')return json({reservation:{id:${JSON.stringify(R)},status:'PENDING_RESERVATION',expiresAt:'2050-01-01T00:00:00.000Z'},redirectUrl:'https://secure.cardcom.solutions/EA/LPC6/abc',memberToken:${JSON.stringify(TOKEN)},validatedPledgeAgorot:12500*quantity},201);
    if(url.pathname==='/api/v1/reservations/'+${JSON.stringify(R)}){
     if(reservationDelay)await new Promise(r=>setTimeout(r,reservationDelay));
     const reserved=reservationStatus==='CARD_RESERVED';
     return json({reservation:{id:${JSON.stringify(R)},status:reservationStatus,reason:reservationStatus==='RESERVATION_FAILED'?'DECLINED':null,groupPublicId:reserved?group.publicId:null,expiresAt:'2050-01-01T00:00:00.000Z'},...(reserved?{group}:{})});
    }
    if(url.pathname.endsWith('/cancel'))return json({reservation:{id:${JSON.stringify(R)},status:'CANCELED',reason:'SHOPPER_CANCELED',groupPublicId:null,expiresAt:'2050-01-01T00:00:00.000Z'}});
    if(url.pathname.endsWith('/member'))return json({member:{status:memberPayment.status==='CANCELED'?'WITHDRAWN':'PLEDGED',pledgedTotalAgorot:memberPayment.status==='CANCELED'?0:memberPayment.approvedAmountAgorot,cartCheck:'OK',cart:[{variantId:'101',title:'אבקת כביסה',quantity:2,storedUnitAgorot:12500,currentUnitAgorot:12500,available:true,restorableQuantity:2,maxAvailableQuantity:100,priceChanged:false,reason:'AVAILABLE'}],payment:memberPayment}});
    if(url.pathname.endsWith('/update-pledge')){memberPayment={...memberPayment,status:'CONSENT_REQUIRED',pendingAmountAgorot:12500*quantity};return json({group,validatedPledgeAgorot:25000,consentRequired:{approvedAmountAgorot:25000,newAmountAgorot:12500*quantity}});}
    if(url.pathname.endsWith('/confirm-pledge')){memberPayment={status:'CARD_RESERVED',approvedAmountAgorot:body.amountAgorot,pendingAmountAgorot:null,card:null};group={...group,pledgedTotalAgorot:body.amountAgorot};return json({group,validatedPledgeAgorot:body.amountAgorot});}
    if(url.pathname.endsWith('/withdraw')){memberPayment={status:'CANCELED',approvedAmountAgorot:0,pendingAmountAgorot:null,card:null};group={...group,participantCount:0,pledgedTotalAgorot:0,remainingAmountAgorot:50000,progressPercent:0};return json({group,member:{status:'WITHDRAWN',pledgedTotalAgorot:0}});}
    if(url.pathname==='/api/v1/groups/'+group.publicId)return json({group});
    return json({code:'NOT_FOUND'},404);
   };
  `);
  // Mount (or re-mount after "returning" with ?gd_result=...): fresh markup, the real client script, fast polling.
  const mount=async(search='')=>{
   // Fast, bounded polling (set before the element connects once the class exists), and widget always the new element.
   await ev('{const C=customElements.get("fankee-group-delivery");if(C){C.verifyAttempts=3;C.verifyInterval=40;}}history.replaceState(null,"","/pages/group-delivery'+search+'");document.querySelector("main").innerHTML='+JSON.stringify(markup)+';window.widget=document.querySelector("fankee-group-delivery")');
   await ev(script);
   await ev('customElements.get("fankee-group-delivery").verifyAttempts=3;customElements.get("fankee-group-delivery").verifyInterval=40');
   await wait('!widget.hasAttribute("aria-busy")','mounted');
  };
  const money=agorot=>ev('new Intl.NumberFormat("he",{style:"currency",currency:"ILS"}).format('+agorot+'/100)');
  const q=selector=>'widget.querySelector('+JSON.stringify(selector)+')';
  await ev('localStorage.clear();sessionStorage.clear()');
  await mount();
  await t.test('consent checkbox gates the reservation button; amount and no-charge text are shown',async()=>{
   await ev('widget.selectArea(widget.areas[1]);'+q('[data-find-group] button[type=submit]')+'.click()');
   await wait('!widget.hasAttribute("aria-busy")&&!'+q('[data-reserve]')+'.hidden','reserve block');
   assert.equal(await ev(q('[data-notice]')+'.textContent'),gd.notice_card);
   assert.equal(await ev(q('[data-reserve] h3')+'.textContent'),gd.reserve_title);
   assert.match(await ev(q('[data-reserve]')+'.textContent'),new RegExp(gd.reserve_no_charge.replace('.','\\.')));
   assert.equal(await ev(q('[data-reserve-total]')+'.textContent'),gd.reserve_amount.replace('{{ amount }}',await money(25000)));
   assert.equal(await ev(q('[data-join-button]')+'.textContent'),gd.reserve_button);
   assert.equal(await ev(q('[data-reserve-consent]')+'.checked'),false);
   assert.equal(await ev(q('[data-join-button]')+'.disabled'),true,'disabled until consent');
   assert.equal(await ev(q('[data-reserve] label.group-delivery__consent')+'.textContent.trim()'),gd.reserve_consent);
   await ev(q('[name=email]')+'.value="shopper@example.test";'+q('[name=phone]')+'.value="0501234567";'+q('[data-reserve-consent]')+'.click()');
   assert.equal(await ev(q('[data-join-button]')+'.disabled'),false);
   await ev(q('[data-reserve-consent]')+'.click()');
   assert.equal(await ev(q('[data-join-button]')+'.disabled'),true,'unticking disables again');
   // Mobile: no horizontal overflow, 44 px button, consent box keeps its size.
   assert.ok(await ev('document.documentElement.scrollWidth<=360'),'no horizontal overflow at 360px');
   assert.ok(await ev(q('[data-join-button]')+'.getBoundingClientRect().height>=44'));
   assert.ok(await ev(q('[data-reserve-consent]')+'.getBoundingClientRect().width>=20'));
  });
  await t.test('redirect initiation: consent and amount sent, Cardcom page opened, only a reservation receipt stored',async()=>{
   await ev(q('[data-reserve-consent]')+'.click();'+q('[data-join-button]')+'.click()');
   await wait('requests.some(r=>r.path==="/api/v1/groups/reserve")','reserve request');
   await wait('!widget.hasAttribute("aria-busy")');
   for(let i=0;i<40&&!navigations.length;i++)await sleep(25);
   assert.deepEqual(navigations,['https://secure.cardcom.solutions/EA/LPC6/abc']);
   const reserve=await ev('requests.find(r=>r.path==="/api/v1/groups/reserve").body');
   assert.deepEqual(reserve.consent,{accepted:true,amountAgorot:25000});
   assert.deepEqual(Object.keys(reserve).sort(),['areaPublicId','consent','email','lines','phone'],'no card fields are ever sent');
   const stored=JSON.parse(await ev('localStorage.getItem("fankee-group-delivery:https://groups.example.test:reservation")'));
   assert.deepEqual(Object.keys(stored).sort(),['memberToken','publicId','reservationId','savedAt']);
   assert.equal(stored.reservationId,R);
   assert.equal(await ev('widget.message.textContent'),gd.reserve_redirecting);
  });
  await t.test('pending state after return: verifying, then a bounded check with "check again"',async()=>{
   await ev('reservationStatus="PENDING_RESERVATION";reservationDelay=150;requests.length=0');
   const mounting=mount('?gd_result=success');
   await wait(q('[data-verify]')+'&&!'+q('[data-verify]')+'.hidden&&'+q('[data-verify-text]')+'.textContent==='+JSON.stringify(gd.reserve_verifying),'verifying text');
   await mounting;
   assert.equal(await ev('location.search'),'','return marker removed from the URL');
   assert.equal(await ev(q('[data-verify-text]')+'.textContent'),gd.reserve_pending);
   assert.equal(await ev(q('[data-verify-primary]')+'.textContent'),gd.reserve_check_again);
   assert.equal(await ev('requests.filter(r=>r.path==="/api/v1/reservations/'+R+'").length'),3,'bounded polling');
   assert.equal(await ev('requests.find(r=>r.path==="/api/v1/reservations/'+R+'").auth'),'Bearer '+TOKEN);
   // Cardcom confirms meanwhile: "check again" completes it.
   await ev('reservationStatus="CARD_RESERVED";reservationDelay=0;'+q('[data-verify-primary]')+'.click()');
   await wait(q('[data-verify]')+'.dataset.state==="success"','success state');
   assert.equal(await ev(q('[data-verify-text]')+'.textContent'),gd.reserve_success);
   await wait('!widget.hasAttribute("aria-busy")&&!'+q('[data-group-panel]')+'.hidden','group shown');
   assert.equal(await ev('localStorage.getItem("fankee-group-delivery:https://groups.example.test:reservation")'),null,'pending reservation cleared');
   assert.equal(JSON.parse(await ev('localStorage.getItem("fankee-group-delivery:https://groups.example.test:receipt:'+G+'")')).memberToken,TOKEN);
   assert.equal(await ev(q('[data-mine]')+'.hidden'),false,'shown as the shopper\'s own delivery');
   assert.equal(await ev(q('[data-member-payment]')+'.textContent'),gd.payment_reserved);
   assert.equal(await ev(q('[data-withdraw]')+'.textContent'),gd.cancel_join);
   assert.equal(await ev(q('[data-reserve]')+'.hidden'),true,'no second reservation for an active member');
  });
  await t.test('changed pledge needs explicit consent before it counts',async()=>{
   await ev('quantity=3;requests.length=0;'+q('[data-join-button]')+'.click()');
   await wait('!widget.hasAttribute("aria-busy")&&!'+q('[data-consent-change]')+'.hidden','consent block');
   assert.equal(await ev(q('[data-consent-change-text]')+'.textContent'),gd.consent_changed.replace('{{ old_amount }}',await money(25000)).replace('{{ new_amount }}',await money(37500)));
   assert.equal(await ev('widget.message.textContent'),gd.error_amount_changed);
   assert.equal(await ev(q('[data-consent-change-confirm]')+'.disabled'),true);
   assert.equal(await ev(q('[data-consent-change-confirm]')+'.textContent'),gd.consent_confirm);
   await ev(q('[data-consent-change-check]')+'.click()');
   assert.equal(await ev(q('[data-consent-change-confirm]')+'.disabled'),false);
   await ev(q('[data-consent-change-confirm]')+'.click()');
   await wait('!widget.hasAttribute("aria-busy")&&'+q('[data-consent-change]')+'.hidden','consent confirmed');
   assert.deepEqual(await ev('requests.find(r=>r.path.endsWith("/confirm-pledge")).body'),{confirm:true,amountAgorot:37500});
   assert.equal(await ev('widget.message.textContent'),gd.consent_confirmed);
  });
  await t.test('cancel button: confirmation, then "canceled and not charged"',async()=>{
   await ev(q('[data-withdraw]')+'.click()');
   await wait(q('[data-withdraw-dialog]')+'.open');
   assert.equal(await ev(q('[data-withdraw-text]')+'.textContent'),gd.cancel_text);
   await ev(q('[data-withdraw-confirm]')+'.click()');
   await wait('!widget.hasAttribute("aria-busy")&&!'+q('[data-withdraw-dialog]')+'.open');
   assert.equal(await ev('widget.message.textContent'),gd.canceled_no_charge);
   assert.equal(await ev(q('[data-withdraw]')+'.hidden'),true);
  });
  await t.test('charge started or done: no self-service cancellation, the status is explained',async()=>{
   await ev('memberPayment={status:"CHARGED",approvedAmountAgorot:37500,pendingAmountAgorot:null,card:null};group={...group,status:"APPROVED"}');
   await mount();
   await wait('!'+q('[data-group-panel]')+'.hidden');
   assert.equal(await ev(q('[data-member-payment]')+'.textContent'),gd.payment_charged);
   assert.equal(await ev(q('[data-withdraw]')+'.hidden'),true);
  });
  await t.test('failure state after return: card not charged, try again',async()=>{
   await ev('localStorage.clear();memberPayment={status:"CARD_RESERVED",approvedAmountAgorot:25000,pendingAmountAgorot:null,card:null};group={...group,status:"OPEN"};reservationStatus="RESERVATION_FAILED";requests.length=0;'+
    'localStorage.setItem("fankee-group-delivery:https://groups.example.test:reservation",JSON.stringify({reservationId:'+JSON.stringify(R)+',memberToken:'+JSON.stringify(TOKEN)+',publicId:null,savedAt:Date.now()}))');
   await mount('?gd_result=failed');
   await wait(q('[data-verify]')+'.dataset.state==="failed"','failed state');
   assert.equal(await ev(q('[data-verify-text]')+'.textContent'),gd.reserve_failed);
   assert.deepEqual(await ev('requests.find(r=>r.path==="/api/v1/reservations/'+R+'").body'),{returned:'failed'},'the failure return is reported to the service');
   assert.equal(await ev('localStorage.getItem("fankee-group-delivery:https://groups.example.test:reservation")'),null);
   assert.equal(await ev('Object.keys(localStorage).filter(k=>k.includes(":receipt:")).length'),0,'no membership receipt');
   assert.equal(await ev(q('[data-verify-primary]')+'.textContent'),gd.reserve_retry);
   assert.ok(!(await ev('document.body.textContent')).includes('DECLINED'),'no technical Cardcom detail shown');
  });
 }finally{
  try{ws?.close();}catch{}chrome?.kill();await new Promise(r=>server.close(r));await sleep(300);
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
 }
});
