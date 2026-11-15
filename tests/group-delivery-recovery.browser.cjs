// Membership recovery by emailed one-time code on the Group Delivery page, in real headless Chrome against a stateful
// fake service over HTTP: ALREADY_JOINED without a receipt -> offer -> code -> new device receipt -> member state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');

test('Group Delivery membership recovery',{timeout:240000},async t=>{
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
  .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ routes.cart_add_url }}/g,'/he/cart/add').replace(/{{ routes.all_products_collection_url }}/g,'/collections/all').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
  .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ area }}','__AREA__').replace('{{ count }}','__COUNT__').replace('{{ amount }}','__AMOUNT__').replace('{{ target }}','__TARGET__').replace('{{ seconds }}','__SECONDS__').replace('{{ old_price }}','__OLD__').replace('{{ new_price }}','__NEW__').replace('{{ old_quantity }}','__OLD__').replace('{{ new_quantity }}','__NEW__').replace('{{ quantity }}','__QUANTITY__')))
  .replace(/{%-?[\s\S]*?-?%}/g,'');
 // The real accessibility launcher footprint, so the layout reserves space for it as on the storefront.
 const page=()=>'<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+theme+css+
  '.a11y-launcher{position:fixed;inset-inline-end:12px;inset-block-end:12px;width:52px;height:52px}</style></head><body><main>'+markup()+'</main><button class="a11y-launcher" type="button">נגישות</button><a id="away" href="/other">דף אחר</a><script src="/assets/group-delivery.js" defer></script></body></html>';

 const AREAS=[{publicId:'6f1a2c00-0002-4a00-8000-0000000000a2',name:'אשדוד'},{publicId:'6f1a2c00-0003-4a00-8000-0000000000a3',name:'אשקלון'}];
 const ID={ashdod:'bbbbbbbb-0000-4000-8000-000000000001',ashkelon:'bbbbbbbb-0000-4000-8000-000000000002'};
 const aggregate=(publicId,areaName,status)=>({publicId,areaName,status,participantCount:4,currency:'ILS',thresholdAgorot:50000,pledgedTotalAgorot:30000,remainingAmountAgorot:20000,progressPercent:60,expiresAt:'2050-01-01T00:00:00.000Z'});
 const line={variantId:'101',title:'אבקת כביסה',quantity:1,storedUnitAgorot:1590,currentUnitAgorot:1590,available:true,restorableQuantity:1,maxAvailableQuantity:100,priceChanged:false,reason:'AVAILABLE'};
 const pledged={status:'PLEDGED',pledgedTotalAgorot:1590,cartCheck:'OK',cart:[line]},withdrawn={status:'WITHDRAWN',pledgedTotalAgorot:0,cartCheck:'OK',cart:[]};
 const DANA={email:'dana@example.test',phone:'0501234567'},CODE='482913',OLD_TOKEN='c'.repeat(64);
 const state={};
 const reset=()=>Object.assign(state,{requests:[],bodies:[],groups:{[ID.ashdod]:aggregate(ID.ashdod,'אשדוד','OPEN'),[ID.ashkelon]:aggregate(ID.ashkelon,'אשקלון','OPEN')},
  members:{[OLD_TOKEN]:{publicId:ID.ashkelon,member:pledged}},challenges:{},ttl:600,cooldown:60,lastStart:0,startError:null,memberAfter:pledged,completeOnVerify:false});
 reset();
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://x');let body='';req.on('data',c=>body+=c);req.on('end',()=>{
   const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+';charset=utf-8','Access-Control-Allow-Origin':'*'});res.end(typeof data==='string'?data:JSON.stringify(data));};
   const json=body?JSON.parse(body):null;
   if(url.pathname.startsWith('/api/v1/')){state.requests.push(req.method+' '+url.pathname);state.bodies.push(json);}
   if(url.pathname==='/'||url.pathname==='/pages/group-delivery')return send(200,page(),'text/html');
   if(url.pathname==='/other')return send(200,'<!doctype html><html><head><meta charset="utf-8"></head><body><p id="other">דף אחר</p></body></html>','text/html');
   if(url.pathname==='/assets/group-delivery.js')return send(200,fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8'),'text/javascript');
   if(url.pathname==='/he/cart.js')return send(200,{currency:'ILS',total_price:1590,items:[{variant_id:101,quantity:1,properties:{}}]});
   if(url.pathname==='/api/v1/areas')return send(200,{areas:AREAS});
   if(url.pathname==='/api/v1/groups/find')return send(200,{group:state.groups[ID.ashdod],canCreateOnJoin:false,withinStandardRadius:false,validatedPledgeAgorot:1590});
   let m;
   if((m=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/join$/))){
    if(json.email.toLowerCase()===DANA.email)return send(409,{code:'ALREADY_JOINED',error:'x'});
    const token=crypto.randomBytes(32).toString('hex');state.members[token]={publicId:m[1],member:pledged};return send(201,{group:state.groups[m[1]],memberToken:token,validatedPledgeAgorot:1590});
   }
   if((m=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/recovery\/start$/))){
    if(state.startError)return send(state.startError.status,{code:state.startError.code});
    if(Date.now()-state.lastStart<state.cooldown*1000)return send(429,{code:'RATE_LIMITED'});
    state.lastStart=Date.now();
    for(const c of Object.values(state.challenges))c.closed=true;
    const challengeId=crypto.randomUUID(),match=json.email.toLowerCase()===DANA.email&&json.phone===DANA.phone;
    state.challenges[challengeId]={group:m[1],match,attempts:0,closed:false};
    return send(200,{ok:true,message:'generic',challengeId,expiresInSeconds:state.ttl,resendAfterSeconds:state.cooldown});
   }
   if((m=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/recovery\/verify$/))){
    const c=state.challenges[json.challengeId];
    if(!c||c.group!==m[1]||c.closed)return send(400,{code:'INVALID_OR_EXPIRED_CODE'});
    if(c.attempts>=5)return send(429,{code:'TOO_MANY_ATTEMPTS'});
    if(json.code!==CODE||!c.match){c.attempts++;return send(c.attempts>=5?429:400,{code:c.attempts>=5?'TOO_MANY_ATTEMPTS':'INVALID_OR_EXPIRED_CODE'});}
    c.closed=true;
    if(state.completeOnVerify)state.groups[m[1]]={...state.groups[m[1]],status:'COMPLETED'};
    const token=crypto.randomBytes(32).toString('hex');state.members[token]={publicId:m[1],member:state.memberAfter};
    return send(200,{memberToken:token,group:state.groups[m[1]],member:{status:state.memberAfter.status}});
   }
   if((m=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})\/member$/))){const entry=state.members[(req.headers.authorization||'').replace('Bearer ','')];
    return entry&&entry.publicId===m[1]?send(200,{member:entry.member}):send(401,{code:'MEMBER_AUTH_REQUIRED'});}
   if((m=url.pathname.match(/^\/api\/v1\/groups\/([0-9a-f-]{36})$/))&&req.method==='GET')return state.groups[m[1]]?send(200,{group:state.groups[m[1]]}):send(404,{code:'GROUP_NOT_FOUND'});
   if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET, POST'});return res.end();}
   send(404,{code:'NOT_FOUND'});
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 const prefix='fankee-group-delivery:'+origin+':receipt:';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-recovery-'));
 let chrome,stderr='';const sockets=new Set();
 try{
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const debug='http://'+new URL(stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1]).host;
  const openTab=async()=>{
   const target=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
   const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));sockets.add(ws);
   let id=0;const pending=new Map();
   ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
   const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
   const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;};
   const wait=async(expression,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await ev(expression))return;}catch{}await sleep(30);}throw Error('Timeout: '+expression);};
   await call('Page.enable');
   const size=(width,height=900,mobile=width<768,scale=1)=>call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile});
   await size(1280);
   const ready='!!window.widget&&widget.areas?.length>0&&!widget.hasAttribute("aria-busy")';
   const go=async()=>{await call('Page.navigate',{url:origin+'/pages/group-delivery'});await wait('document.readyState==="complete"');await ev('window.widget=document.querySelector("fankee-group-delivery")');await wait(ready);};
   const close=async()=>{ws.close();sockets.delete(ws);await fetch(debug+'/json/close/'+target.id);};
   const key=async(key,code=key,keyCode=0)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&key==='Enter'?{text:'\r'}:{})});};
   return {call,ev,wait,go,close,ready,size,key};
  };
  let tab=await openTab();
  await tab.go();
  await tab.ev('localStorage.setItem("fankee-a11y","{\\"contrast\\":\\"high\\"}");document.cookie="cart=c1; path=/"');
  const receipts=(...list)=>tab.ev('(()=>{for(const k of Object.keys(localStorage))if(k.startsWith('+JSON.stringify(prefix)+'))localStorage.removeItem(k);'+
   list.map(([id,token,savedAt])=>'localStorage.setItem('+JSON.stringify(prefix+id)+','+JSON.stringify(JSON.stringify({publicId:id,memberToken:token,savedAt}))+');').join('')+'})()');
  const stored=()=>tab.ev('Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('+JSON.stringify(prefix)+')).map(k=>[k.slice('+prefix.length+'),JSON.parse(localStorage.getItem(k))]))');
  const idle=()=>tab.wait('!widget.hasAttribute("aria-busy")');
  const otp=()=>tab.ev('({box:!widget.querySelector("[data-otp]").hidden,offer:!widget.querySelector("[data-otp-offer]").hidden,form:!widget.querySelector("[data-otp-form]").hidden,join:!widget.querySelector("[data-join-group]").hidden,error:widget.querySelector("[data-otp-error]").textContent,focus:document.activeElement?.dataset&&Object.keys(document.activeElement.dataset)[0]||document.activeElement?.tagName})');
  const startCount=()=>state.requests.filter(r=>r.endsWith('/recovery/start')).length,verifyCount=()=>state.requests.filter(r=>r.endsWith('/recovery/verify')).length;
  // Search Ashdod, type Dana's details, join -> ALREADY_JOINED.
  const alreadyJoined=async(who=DANA)=>{
   await tab.go();
   await tab.ev('{const i=widget.querySelector("[data-area-input]");i.focus();i.value="אשד";i.dispatchEvent(new Event("input",{bubbles:true}));for(const key of ["ArrowDown","Enter"])i.dispatchEvent(new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));}');
   await tab.wait('widget.area?.name==="אשדוד"');
   await tab.ev('widget.querySelector("[data-find-group]").requestSubmit()');await tab.wait(tab.ready+'&&!widget.querySelector("[data-group-panel]").hidden');
   await tab.ev('{const f=widget.querySelector("[data-join-group]");f.querySelector("[name=email]").value='+JSON.stringify(who.email)+';f.querySelector("[name=phone]").value='+JSON.stringify(who.phone)+';f.requestSubmit();}');
   await tab.wait('!widget.querySelector("[data-otp]").hidden&&!widget.hasAttribute("aria-busy")');
  };
  const requestCode=async()=>{await tab.ev('widget.querySelector("[data-otp-start]").click()');await tab.wait('!widget.querySelector("[data-otp-form]").hidden&&!widget.hasAttribute("aria-busy")');};
  const typeCode=async code=>{await tab.ev('{const i=widget.querySelector("[data-otp-input]");i.value='+JSON.stringify(code)+';i.dispatchEvent(new Event("input",{bubbles:true}));}');};
  const submitCode=async()=>{await tab.ev('widget.querySelector("[data-otp-form]").requestSubmit(widget.querySelector("[data-otp-verify]"))');await idle();};

  await t.test('already joined without a receipt: the recovery offer, and Back keeps the typed details',async()=>{
   reset();await receipts();await alreadyJoined();
   assert.deepEqual(await otp(),{box:true,offer:true,form:false,join:false,error:'',focus:'otpTitle'});
   assert.deepEqual(await tab.ev('[widget.querySelector("[data-otp-title]").textContent,widget.querySelector("[data-otp-offer] p").textContent,widget.querySelector("[data-otp-start]").textContent,widget.querySelector("[data-otp-back]").textContent]'),
    ['כבר קיימת הצטרפות עם הפרטים האלה','אם זו ההצטרפות שלך, ניתן לשחזר את הגישה באמצעות קוד אימות שיישלח למייל.','שחזור הצטרפות','חזרה']);
   assert.equal(await tab.ev('widget.querySelector("[data-group-message]").textContent'),'','no duplicate error text under the offer');
   assert.ok(!/לשונית|כרטיסייה|הדפדפן והמכשיר שבהם/.test(await tab.ev('document.body.innerText')),'never refers to the original tab or device');
   await tab.ev('widget.querySelector("[data-otp-back]").click()');
   assert.deepEqual(await otp(),{box:false,offer:true,form:false,join:true,error:'',focus:'joinButton'});
   assert.deepEqual(await tab.ev('[widget.querySelector("[name=email]").value,widget.querySelector("[name=phone]").value]'),[DANA.email,DANA.phone]);
   assert.equal(startCount(),0,'nothing is requested until the shopper asks');
  });

  await t.test('request a code: generic confirmation, code field, resend cooldown; no email shown',async()=>{
   reset();await receipts();await alreadyJoined();await requestCode();
   const body=state.bodies[state.requests.lastIndexOf('POST /api/v1/groups/'+ID.ashdod+'/recovery/start')];
   assert.deepEqual(body,{email:DANA.email,phone:DANA.phone});
   const o=await otp();assert.equal(o.form,true);assert.equal(o.focus,'otpInput','focus moves to the code field');
   assert.equal(await tab.ev('document.getElementById("GroupOtpSent-fixture").textContent'),'אם הפרטים תואמים להצטרפות קיימת, קוד אימות נשלח למייל.');
   assert.equal(await tab.ev('document.getElementById("GroupOtpHint-fixture").textContent'),'הזינו את קוד האימות בן 6 הספרות שנשלח למייל.');
   assert.ok(!(await tab.ev('document.body.innerText')).includes(DANA.email),'the email address is never displayed');
   const field=await tab.ev('(()=>{const i=widget.querySelector("[data-otp-input]");return {autocomplete:i.autocomplete,inputmode:i.inputMode,type:i.type,label:i.labels[0]?.textContent,described:i.getAttribute("aria-describedby").split(" ").every(id=>document.getElementById(id))}})()');
   assert.deepEqual(field,{autocomplete:'one-time-code',inputmode:'numeric',type:'text',label:'קוד אימות',described:true});
   const resend=await tab.ev('(()=>{const b=widget.querySelector("[data-otp-resend]");return {disabled:b.getAttribute("aria-disabled"),wait:widget.querySelector("[data-otp-wait]").textContent,live:widget.querySelector("[data-otp-wait]").getAttribute("aria-live")}})()');
   assert.equal(resend.disabled,'true');assert.match(resend.wait,/^אפשר לבקש קוד חדש בעוד (60|59) שניות\.$/);assert.equal(resend.live,null,'the countdown is not announced every second');
   const before=startCount();await tab.ev('widget.querySelector("[data-otp-resend]").click()');await idle();
   assert.equal(startCount(),before,'resend is inert during the cooldown');
  });

  await t.test('wrong, malformed and expired codes; paste of formatted digits',async()=>{
   reset();await receipts();await alreadyJoined();await requestCode();
   await typeCode('111111');await submitCode();
   assert.equal((await otp()).error,g.error_code_invalid);
   assert.deepEqual(await tab.ev('[widget.querySelector("[data-otp-input]").getAttribute("aria-invalid"),widget.querySelector("[data-otp-error]").getAttribute("role"),document.activeElement===widget.querySelector("[data-otp-input]")]'),['true','alert',true]);
   assert.deepEqual(await stored(),{},'no receipt');
   await typeCode('9');
   assert.equal((await otp()).error,'','typing clears the error');
   const verifies=verifyCount();
   await typeCode('12');await submitCode();
   assert.equal((await otp()).error,g.recovery_format);assert.equal(verifyCount(),verifies,'format checked locally');
   // Real paste through the browser input pipeline: spaces and Arabic-Indic digits become 6 ASCII digits.
   await tab.ev('{const i=widget.querySelector("[data-otp-input]");i.value="";i.focus();}');
   await tab.call('Input.insertText',{text:'٤٨٢ 913'});
   assert.equal(await tab.ev('widget.querySelector("[data-otp-input]").value'),CODE);
   await tab.ev('widget.recovery.expiresAt=Date.now()-1');await submitCode();
   assert.equal((await otp()).error,g.recovery_expired);assert.equal(verifyCount(),verifies,'an expired code is not sent');
  });

  await t.test('five wrong codes lock the code; a new code after the cooldown works',async()=>{
   reset();state.cooldown=1;await receipts();await alreadyJoined();await requestCode();
   for(let i=0;i<5;i++){await typeCode('00000'+i);await submitCode();}
   assert.equal((await otp()).error,g.error_too_many_attempts);
   const verifies=verifyCount();await typeCode(CODE);await submitCode();
   assert.equal(verifyCount(),verifies,'locked locally: no further attempts on this code');
   assert.equal((await otp()).error,g.error_too_many_attempts);
   await tab.wait('widget.querySelector("[data-otp-resend]").getAttribute("aria-disabled")==="false"',4000);
   assert.equal(await tab.ev('widget.querySelector("[data-otp-wait]").textContent'),'');
   const first=await tab.ev('widget.recovery.challengeId');
   await tab.ev('widget.querySelector("[data-otp-resend]").focus();widget.querySelector("[data-otp-resend]").click()');await idle();
   assert.notEqual(await tab.ev('widget.recovery.challengeId'),first,'a new code replaces the locked one');
   assert.equal((await otp()).focus,'otpInput');
   // Keyboard only: Enter in the code field submits.
   await tab.ev('widget.querySelector("[data-otp-input]").focus()');await tab.call('Input.insertText',{text:CODE});await tab.key('Enter','Enter',13);
   await tab.wait('!widget.querySelector("[data-mine]").hidden&&!widget.hasAttribute("aria-busy")');
  });

  await t.test('success: a new receipt in the existing format, other receipts untouched, own delivery shown',async()=>{
   reset();await receipts([ID.ashkelon,OLD_TOKEN,1000]);await alreadyJoined();await requestCode();
   await typeCode(CODE);await submitCode();
   assert.deepEqual(await tab.ev('[!widget.querySelector("[data-otp]").hidden,!widget.querySelector("[data-join-group]").hidden,widget.recovery,widget.querySelector("[data-otp-input]").value]'),[false,true,null,''],'recovery closed; nothing kept');
   assert.equal((await otp()).focus,'groupTitle','focus moves to the restored delivery');
   assert.equal(await tab.ev('widget.querySelector("[data-group-message]").textContent'),'זהו, הגישה להצטרפות שוחזרה.');
   assert.deepEqual(await tab.ev('({mine:!widget.querySelector("[data-mine]").hidden,group:widget.group.publicId,contact:widget.querySelector("[data-contact-fields]").hidden,email:widget.querySelector("[name=email]").value,button:widget.querySelector("[data-join-button]").textContent})'),
    {mine:true,group:ID.ashdod,contact:true,email:'',button:g.update});
   const saved=await stored();
   assert.deepEqual(Object.keys(saved).sort(),[ID.ashdod,ID.ashkelon].sort());
   assert.deepEqual(saved[ID.ashkelon],{publicId:ID.ashkelon,memberToken:OLD_TOKEN,savedAt:1000},'the other group\'s receipt is unchanged');
   assert.deepEqual(Object.keys(saved[ID.ashdod]).sort(),['memberToken','publicId','savedAt']);assert.match(saved[ID.ashdod].memberToken,/^[a-f0-9]{64}$/);
   assert.deepEqual(await tab.ev('[localStorage.getItem("fankee-a11y"),document.cookie.includes("cart=c1")]'),['{"contrast":"high"}',true]);
   assert.equal(await tab.ev('Object.keys(localStorage).concat(Object.keys(sessionStorage)).some(k=>/dana|0501234567/.test(k+localStorage.getItem(k)+sessionStorage.getItem(k)))'),false,'contacts are never stored');
   // Close and reopen the browser tab: the recovered receipt takes part in the returning-device start-up.
   await tab.close();tab=await openTab();await tab.go();
   assert.deepEqual(await tab.ev('({mine:!widget.querySelector("[data-mine]").hidden,group:widget.group?.publicId,others:[...widget.querySelectorAll("[data-resume-list] button")].map(b=>b.textContent)})'),
    {mine:true,group:ID.ashdod,others:[g.show_membership.replace('{{ area }}','אשקלון')]},'newest (recovered) membership shown, the other active one listed');
  });

  await t.test('withdrawn membership: access restored, shown inactive, renewal stays explicit',async()=>{
   reset();state.memberAfter=withdrawn;await receipts();await alreadyJoined();await requestCode();await typeCode(CODE);await submitCode();
   assert.deepEqual(await tab.ev('({mine:!widget.querySelector("[data-mine]").hidden,notice:widget.querySelector("[data-resume]").hidden?null:widget.querySelector("[data-resume-text]").textContent,member:widget.querySelector("[data-member-pledge]").textContent,button:widget.querySelector("[data-join-button]").textContent,withdraw:widget.querySelector("[data-withdraw]").hidden})'),
    {mine:false,notice:g.membership_inactive,member:g.withdrawn_state,button:g.update,withdraw:true});
   assert.equal(state.requests.filter(r=>r.endsWith('/update-pledge')).length,0,'not reactivated automatically');
  });

  await t.test('group completed between the code and its verification: history only',async()=>{
   reset();state.completeOnVerify=true;await receipts();await alreadyJoined();await requestCode();await typeCode(CODE);await submitCode();
   assert.deepEqual(await tab.ev('({mine:!widget.querySelector("[data-mine]").hidden,notice:widget.querySelector("[data-resume-text]").textContent,primary:widget.querySelector("[data-resume-primary]").textContent,status:widget.group.status,button:widget.querySelector("[data-join-button]").disabled})'),
    {mine:false,notice:g.previous_completed,primary:g.search_new,status:'COMPLETED',button:true});
   assert.equal(state.requests.filter(r=>/\/(join|update-pledge)$/.test(r)&&!r.includes('/groups/'+ID.ashdod+'/join')).length,0,'not moved to another delivery');
   assert.ok((await stored())[ID.ashdod],'the historical receipt is kept');
  });

  await t.test('recovery unavailable or rate limited: a clear message and nothing stored',async()=>{
   reset();state.startError={status:503,code:'RECOVERY_UNAVAILABLE'};await receipts();await alreadyJoined();
   await tab.ev('widget.querySelector("[data-otp-start]").click()');await idle();
   assert.equal(await tab.ev('widget.querySelector("[data-group-message]").textContent'),g.error_recovery_unavailable);
   assert.equal((await otp()).offer,true,'the offer stays; the shopper can try again later');
   state.startError=null;state.cooldown=0;await requestCode();state.startError={status:429,code:'RATE_LIMITED'};
   await tab.ev('widget.querySelector("[data-otp-resend]").click()');await idle();
   assert.equal((await otp()).error,g.error_rate_limited);
   assert.deepEqual(await stored(),{});
  });

  await t.test('a back/forward restore or a new area search closes recovery and drops the typed details',async()=>{
   reset();await receipts();await alreadyJoined();await requestCode();
   await tab.ev('dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true}))');await tab.wait(tab.ready+'&&widget.querySelector("[data-otp]").hidden');
   assert.equal(await tab.ev('widget.recovery'),null);
   await alreadyJoined();
   await tab.ev('{const i=widget.querySelector("[data-area-input]");i.value="אשק";i.dispatchEvent(new Event("input",{bubbles:true}));}');
   assert.equal((await otp()).box,false);assert.equal(await tab.ev('widget.recovery'),null);
  });

  await t.test('mobile (iPhone-size, 320/360/390/768): no overflow, 44px targets, 16px+ code field',async()=>{
   reset();state.cooldown=60;
   for(const [width,height,scale] of [[320,640,2],[360,740,3],[390,844,3],[768,1024,2]]){
    await tab.size(width,height,width<768,scale);
    for(const step of ['offer','code']){
     await receipts();state.lastStart=0;await alreadyJoined();if(step==='code')await requestCode();
     const m=await tab.ev(`(()=>{const box=widget.querySelector("[data-otp]"),input=widget.querySelector("[data-otp-input]"),visible=[...box.querySelectorAll("button,input")].filter(e=>e.getClientRects().length);
      const launcher=document.querySelector(".a11y-launcher").getBoundingClientRect(),overlaps=visible.filter(e=>{const r=e.getBoundingClientRect();return r.left<launcher.right&&r.right>launcher.left;});
      return {overflow:document.documentElement.scrollWidth>innerWidth,small:visible.filter(e=>e.getBoundingClientRect().height<43.5).map(e=>e.textContent||e.name),font:parseFloat(getComputedStyle(input).fontSize),boxFits:box.getBoundingClientRect().right<=innerWidth+0.5&&box.getBoundingClientRect().left>=-0.5,wait:${step==='code'}?widget.querySelector("[data-otp-wait]").getBoundingClientRect().height>0:true,overlaps:overlaps.length}})()`);
     assert.deepEqual({...m,font:m.font>=16},{overflow:false,small:[],font:true,boxFits:true,wait:true,overlaps:0},width+'px '+step);
    }
   }
   await tab.size(1280);
  });
 }finally{
  for(const ws of sockets)ws.close();chrome?.kill();server.close();await sleep(200);
  try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
