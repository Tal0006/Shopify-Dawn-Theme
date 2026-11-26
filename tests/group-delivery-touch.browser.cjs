// Group Delivery settlement picker with real touch gestures (mobile Chrome emulation, CDP touch input): swiping
// scrolls the list and never selects or closes it; only a deliberate tap selects. Real section markup, CSS and
// assets/group-delivery.js; the service is mocked (no Shopify or Render requests). Needs Chrome (CHROME_PATH).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
// The live service's 13 settlements (GET /api/v1/areas), in its order: more than the list shows at once.
const NAMES=['אמציה','בני דקלים','כרמי קטיף','מרכז שפירא','נגוהות','נטע','שקף','באר שבע','אשדוד','אשקלון','נתיבות','אופקים','שדרות'];
const AREAS=NAMES.map((name,i)=>({publicId:'6f1a2c00-00'+String(i+10)+'-4a00-8000-0000000000'+String(i+10),name}));

test('Group delivery settlement picker: touch scrolling, taps, outside taps, keyboard',{timeout:180000},async t=>{
 const tr=JSON.parse(read('locales/he.default.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
 const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const raw=read('sections/group-delivery.liquid');
 const labels=Object.fromEntries(Object.entries(tr.group_delivery.status).map(([key,value])=>[key.toUpperCase(),value]));
 const errorKeys=Object.fromEntries(raw.match(/assign group_errors = '([^']+)'/)[1].split(',').map(entry=>entry.split(':')));
 const markup=raw.slice(raw.indexOf('<fankee-group-delivery'),raw.indexOf('</fankee-group-delivery>')+25)
  .replace(/<script type="application\/json" data-group-labels>[\s\S]*?<\/script>/,'<script type="application/json" data-group-labels>'+JSON.stringify(labels)+'</script>')
  .replace(/<script type="application\/json" data-group-errors>[\s\S]*?<\/script>/,'<script type="application/json" data-group-errors>'+JSON.stringify(Object.fromEntries(Object.entries(errorKeys).map(([c,k])=>[c,tr.group_delivery[k]])))+'</script>')
  .replace(/{{ group_delivery_service_url \| escape }}/g,'https://groups.example.test')
  .replace(/{{ routes.cart_url }}/g,'/he/cart').replace(/{{ routes.cart_add_url }}/g,'/he/cart/add').replace(/{{ section.id }}/g,'fixture').replace(/{{ request.locale.iso_code }}/g,'he')
  .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace(/{{ (\w+) }}/g,(_n,v)=>'__'+v.toUpperCase()+'__')));
 const css=[read('assets/theme.css'),read('assets/storefront.css'),block('snippets/storefront-design.liquid'),block('sections/group-delivery.liquid')].join('\n');
 // Content above and below the section makes the page scroll too, as on the store.
 const page='<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><header style="height:160px">כותרת</header><main>'+markup+'<div style="height:1600px" data-after>תוכן נוסף</div></main><select data-other><option>1</option><option>2</option></select></body></html>';
 const server=http.createServer((req,res)=>{
  if(req.url==='/assets/group-delivery.js'){res.setHeader('Content-Type','text/javascript');return res.end(read('assets/group-delivery.js'));}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(page.replace('</body>',`<script>window.calls=[];window.fetch=async(input,o={})=>{const u=new URL(input,location.origin);calls.push({path:u.pathname,body:o.body?JSON.parse(o.body):null});
   if(u.pathname.endsWith('/api/v1/areas'))return new Response(JSON.stringify({areas:${JSON.stringify(AREAS)}}));
   if(u.pathname.endsWith('/he/cart.js'))return new Response(JSON.stringify({currency:'ILS',total_price:1590,items:[{variant_id:101,quantity:1,properties:{}}]}));
   if(u.pathname.endsWith('/groups/find'))return new Response(JSON.stringify({group:null,canCreateOnJoin:true,withinStandardRadius:false,validatedPledgeAgorot:1590}));
   return new Response('{}',{status:404});};</script><script src="/assets/group-delivery.js"></script></body>`));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-gd-touch-'));
 let chrome,ws;
 try{
  let stderr='';
  chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',d=>stderr+=d);chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\S+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\S+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(expression,tries=200)=>{for(let i=0;i<tries;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const frames=()=>ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await call('Page.enable');await call('Runtime.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  const W='widget',input=W+'.querySelector("[data-area-input]")',list=W+'.querySelector("[data-area-list]")';
  const load=async width=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:740,deviceScaleFactor:2,mobile:true});
   await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
   await call('Page.navigate',{url:'about:blank'});await wait('location.href==="about:blank"');
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
   await wait('location.href!=="about:blank"&&document.readyState==="complete"&&!!document.querySelector("fankee-group-delivery")?.areas?.length');
   await ev(`window.widget=document.querySelector('fankee-group-delivery');window.changes=0;${input}.addEventListener('input',()=>changes++)`);
   await ev(`${input}.scrollIntoView({block:'start'});scrollBy(0,-20)`);await frames();
  };
  const box=async sel=>ev(`(()=>{const r=${sel}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:r.top,bottom:r.bottom,left:r.left,right:r.right,h:r.height}})()`);
  // A finger: down, moves in small steps (like a real swipe), up. `hold` waits before lifting (a slow swipe ends at rest).
  const swipe=async(x,y1,y2,{steps=10,stepMs=16,hold=0}={})=>{
   await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:y1}]});
   for(let i=1;i<=steps;i++){await sleep(stepMs);await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y1+(y2-y1)*i/steps}]});}
   if(hold)await sleep(hold);
   await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(350);await frames();
  };
  const tap=async(x,y)=>{await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await sleep(60);await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(300);await frames();};
  const state=()=>ev(`({open:!${list}.hidden,expanded:${input}.getAttribute('aria-expanded'),value:${input}.value,area:${W}.area?.name||null,scroll:Math.round(${list}.scrollTop),max:${list}.scrollHeight-${list}.clientHeight,options:${list}.children.length})`);
  const openByTap=async()=>{await ev(`(()=>{const r=${input}.getBoundingClientRect();if(r.top<0||r.bottom>innerHeight-300)scrollBy(0,r.top-60);})()`);await frames();const b=await box(input);await tap(b.x,b.y);await wait('!'+list+'.hidden');return box(list);};
  const optionBox=name=>box(`[...${list}.children].find(o=>o.textContent===${JSON.stringify(name)})`);

  for(const width of [390,320])await t.test(width+'px: swipes scroll the list without selecting or closing; a tap selects',async()=>{
   await load(width);
   let l=await openByTap(),s=await state();
   assert.equal(s.open,true);assert.equal(s.options,13);assert.ok(s.max>100,'the list is taller than its box: '+s.max);
   assert.ok(l.top>=0&&l.bottom<=740&&l.left>=0&&l.right<=width,'the list is inside the screen: '+JSON.stringify(l));
   const pageY=await ev('scrollY');
   // Slow swipe up (finger moves up: the list scrolls down), starting on an option.
   await swipe(l.x,l.bottom-30,l.top+40,{steps:14,stepMs:30,hold:120});
   s=await state();assert.equal(s.open,true,'still open after a slow swipe');assert.equal(s.area,null,'nothing selected by a slow swipe');assert.equal(s.value,'');assert.ok(s.scroll>40,'the list scrolled: '+s.scroll);
   assert.equal(await ev('scrollY'),pageY,'the page did not scroll with the list');
   // Fast swipe, then swipe back down, then several in a row: still open, nothing selected.
   await swipe(l.x,l.bottom-20,l.top+20,{steps:4,stepMs:8});s=await state();assert.equal(s.open,true);assert.equal(s.area,null);
   const atBottom=s.scroll;
   await swipe(l.x,l.top+30,l.bottom-30,{steps:6});s=await state();assert.equal(s.open,true);assert.equal(s.area,null);assert.ok(s.scroll<atBottom,'swiping down scrolls back up');
   for(let i=0;i<4;i++){await swipe(l.x,l.bottom-30,l.top+30,{steps:5,stepMs:12});await swipe(l.x,l.top+40,l.bottom-60,{steps:5,stepMs:12});}
   s=await state();assert.equal(s.open,true);assert.equal(s.area,null);
   // To the very bottom: the last settlement can be reached; the page still did not move.
   for(let i=0;i<3;i++)await swipe(l.x,l.bottom-20,l.top+20,{steps:6});
   s=await state();assert.equal(s.open,true);assert.ok(s.max-s.scroll<=2,'reached the bottom: '+s.scroll+'/'+s.max);assert.equal(await ev('scrollY'),pageY,'overscroll at the end does not move the page');
   // A deliberate tap on the last option selects exactly it and closes the list.
   const last=await optionBox('שדרות');assert.ok(last.top>=l.top-1&&last.bottom<=l.bottom+1,'the last option is visible');
   await tap(last.x,last.y);s=await state();
   assert.deepEqual([s.open,s.expanded,s.value,s.area],[false,'false','שדרות','שדרות']);
   assert.equal(await ev(`${W}.querySelector('[data-area-selected]').textContent`),tr.group_delivery.area_selected.replace('{{ area }}','שדרות'));
   assert.deepEqual(errors,[]);
  });

  await t.test('A swipe that starts on the selected option, and a tap that stops a scroll, select nothing',async()=>{
   await load(390);let l=await openByTap();
   const target=await optionBox('אמציה');
   await swipe(target.x,target.y,target.y-160,{steps:8,stepMs:20});let s=await state();assert.equal(s.area,null);assert.equal(s.open,true);
   // While the list is still moving (as after a fling), a touch only stops it: it does not choose the option under it.
   // (The list is moved in small steps, as momentum scrolling does; a frame-based smooth scroll is too slow to rely on here.)
   await ev(`${list}.scrollTop=0;window.glide=setInterval(()=>{${list}.scrollTop+=6;},16)`);await sleep(120);
   assert.ok(await ev(`${list}.scrollTop>0`),'the list is moving');
   const o=await box(list);await tap(o.x,o.y);await ev('clearInterval(glide)');s=await state();
   assert.equal(s.open,true,'the list stays open');assert.equal(s.area,null,'a touch that stops the scroll selects nothing');
   // Once it is at rest, the same tap is a choice.
   await sleep(600);const at=await box(list);await tap(at.x,at.y);s=await state();assert.equal(s.open,false);assert.ok(s.area,'a tap on a list at rest selects');
  });

  await t.test('Reopening keeps the choice and shows it; outside taps close; page scroll with the list open keeps it open',async()=>{
   await load(390);let l=await openByTap();
   for(let i=0;i<2;i++)await swipe(l.x,l.bottom-20,l.top+20,{steps:6});
   const ashkelon=await optionBox('אשקלון');await tap(ashkelon.x,ashkelon.y);
   let s=await state();assert.deepEqual([s.open,s.area],[false,'אשקלון']);
   // Reopen: the whole list, the chosen settlement marked and scrolled into view.
   l=await openByTap();s=await state();assert.equal(s.open,true);assert.equal(s.options,13);
   assert.equal(await ev(`${list}.querySelector('[aria-selected=true]').textContent`),'אשקלון');
   const chosen=await optionBox('אשקלון');assert.ok(chosen.top>=l.top-1&&chosen.bottom<=l.bottom+1,'the chosen settlement is visible');
   // Tapping the field again while open does not rebuild or rescroll the list.
   const before=await ev(list+'.scrollTop'),node=await ev(`${list}.children[0].dataset.marker='1'`);
   const f=await box(input);await tap(f.x,f.y);s=await state();assert.equal(s.open,true);assert.equal(await ev(list+'.scrollTop'),before);assert.equal(await ev(`${list}.children[0].dataset.marker`),'1','not re-rendered');
   // Scrolling the page with a finger outside the list does not close it.
   const after=await box('document.querySelector("[data-after]")');await swipe(20,Math.min(700,after.top+300),Math.min(700,after.top+300)-120,{steps:6});
   s=await state();assert.equal(s.open,true,'a page swipe outside the list does not close it');assert.equal(s.area,'אשקלון');
   // A tap outside closes it and keeps the selection.
   await tap(20,720);s=await state();assert.deepEqual([s.open,s.area,s.value],[false,'אשקלון','אשקלון']);
   // Repeated open/close.
   for(let i=0;i<4;i++){await openByTap();await tap(20,720);s=await state();assert.equal(s.open,false);}
   assert.equal(s.area,'אשקלון');assert.equal(await ev('changes'),0,'no input events from touch');
  });

  for(const width of [390,320])await t.test(width+'px: typing on the on-screen keyboard, then a tap: the field shows the tapped name',async()=>{
   // Phone keyboards keep the typed letters "in progress" (an IME composition) until they commit them. Writing the
   // name while the letters are still composing let the keyboard put its letters back afterwards.
   for(const [typed,choice] of [['אש','אשקלון'],['ש','שדרות'],['נ','נתיבות']]){
    await load(width);await openByTap();
    await call('Input.imeSetComposition',{text:typed,selectionStart:typed.length,selectionEnd:typed.length});await frames();
    assert.ok((await ev(`[...${list}.children].map(o=>o.textContent)`)).includes(choice),'filtered list shows '+choice);
    const o=await optionBox(choice);await tap(o.x,o.y);
    // What the keyboard does next: it commits the letters it was composing (on blur, or on its next key).
    await call('Input.insertText',{text:''}).catch(()=>{});await ev(`${input}.blur()`);await frames();await sleep(150);
    const s=await state(),shown=await ev(`({value:${input}.value,id:${W}.area?.publicId||null,label:${W}.querySelector('[data-area-selected]').textContent})`);
    assert.equal(shown.value,choice,'the field shows the tapped settlement (typed "'+typed+'")');
    assert.equal(shown.id,AREAS[NAMES.indexOf(choice)].publicId,'the chosen id matches the shown name');
    assert.equal(s.open,false);assert.match(shown.label,new RegExp(choice));
   }
  });
  await t.test('Safari-like: no click after a tap, the name still appears; a ghost click on the search button is swallowed',async()=>{
   const seen=async choice=>({value:await ev(input+'.value'),id:await ev(W+'.area?.publicId||null'),open:!(await ev(list+'.hidden')),label:await ev(`${W}.querySelector('[data-area-selected]').textContent`),want:AREAS[NAMES.indexOf(choice)].publicId});
   for(const width of [390,320]){
    await load(width);
    // Safari on iOS may send no click after a touch: block every click, so only the tap itself can choose.
    await ev(`window.clicks=0;addEventListener('click',e=>{clicks++;e.stopImmediatePropagation();e.preventDefault();},true)`);
    let l=await openByTap();await swipe(l.x,l.bottom-20,l.top+20,{steps:6});
    const o=await optionBox('אשקלון');await tap(o.x,o.y);let r=await seen('אשקלון');
    assert.deepEqual([r.value,r.id,r.open],['אשקלון',r.want,false],'tap without click at '+width);assert.match(r.label,/אשקלון/);
   }
   // Ghost click: the option chosen lies over the search button; the browser's click for that tap must not search.
   await load(390);await ev(`window.searchClicks=0;${W}.querySelector('[data-find-group] button[type=submit]').addEventListener('click',()=>searchClicks++)`);
   let l=await openByTap();
   const spot=await ev(`(()=>{const b=${W}.querySelector('[data-find-group] button[type=submit]').getBoundingClientRect();for(const o of ${list}.children){const r=o.getBoundingClientRect(),l=${list}.getBoundingClientRect();const top=Math.max(r.top,b.top,l.top),bottom=Math.min(r.bottom,b.bottom,l.bottom),left=Math.max(r.left,b.left),right=Math.min(r.right,b.right);if(bottom-top>8&&right-left>8)return {x:(left+right)/2,y:(top+bottom)/2,name:o.textContent};}return null})()`);
   assert.ok(spot,'fixture: an open option covers the search button');
   await ev('calls.length=0');await tap(spot.x,spot.y);await sleep(300);
   assert.equal(await ev(input+'.value'),spot.name,'the tapped name is shown');assert.equal(await ev('searchClicks'),0,'the search button did not get the tap');
   assert.equal(await ev(`calls.filter(c=>c.path.endsWith('/groups/find')).length`),0,'no search was started');
   // The next real tap on the button works again.
   const b=await box(`${W}.querySelector('[data-find-group] button[type=submit]')`);await sleep(800);await tap(b.x,b.y);await wait('searchClicks===1');
   // Screen readers activate an option with a click and no pointer.
   await load(390);await openByTap();await ev(`[...${list}.children].find(o=>o.textContent==='נטע').click()`);
   assert.equal(await ev(input+'.value'),'נטע');assert.equal(await ev(list+'.hidden'),true);
  });
  await t.test('Typing still filters; keyboard still works; the chosen settlement is what the search sends',async()=>{
   await load(390);await openByTap();
   await ev(`${input}.value='אש';${input}.dispatchEvent(new Event('input',{bubbles:true}))`);
   assert.deepEqual(await ev(`[...${list}.children].map(o=>o.textContent)`),['אשדוד','אשקלון']);
   const key=k=>ev(`${input}.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true,cancelable:true}))`);
   await key('ArrowDown');await key('ArrowDown');await key('Enter');let s=await state();assert.deepEqual([s.open,s.area],[false,'אשקלון']);
   await key('ArrowDown');s=await state();assert.equal(s.open,true);await key('Escape');s=await state();assert.equal(s.open,false);
   // Required: an unknown name is not accepted; the chosen settlement's id is what the search sends.
   await ev(`calls.length=0;${W}.querySelector('[data-find-group]').requestSubmit()`);await wait(`calls.some(c=>c.path.endsWith('/groups/find'))`);
   const find=await ev(`calls.find(c=>c.path.endsWith('/groups/find')).body`);
   assert.equal(find.areaPublicId,AREAS[NAMES.indexOf('אשקלון')].publicId);
   await ev(`${input}.value='לא קיים';${input}.dispatchEvent(new Event('input',{bubbles:true}));calls.length=0;${W}.querySelector('[data-find-group]').requestSubmit()`);await sleep(300);
   assert.equal(await ev(`calls.filter(c=>c.path.endsWith('/groups/find')).length`),0,'an unknown name is not searched');
  });

  await t.test('Desktop mouse: click selects, wheel scrolls without selecting, outside click closes; other selects untouched',async()=>{
   await call('Emulation.setTouchEmulationEnabled',{enabled:false});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
   await call('Page.navigate',{url:'about:blank'});await wait('location.href==="about:blank"');await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
   await wait('location.href!=="about:blank"&&document.readyState==="complete"&&!!document.querySelector("fankee-group-delivery")?.areas?.length');await ev(`window.widget=document.querySelector('fankee-group-delivery')`);
   const mouse=async(type,x,y,extra={})=>call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1,...extra});
   const f=await box(input);await mouse('mousePressed',f.x,f.y);await mouse('mouseReleased',f.x,f.y);await wait('!'+list+'.hidden');
   const l=await box(list);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:l.x,y:l.y});await sleep(50);await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:l.x,y:l.y,deltaX:0,deltaY:300});await wait(list+'.scrollTop>0');await sleep(300);
   let s=await state();assert.equal(s.open,true);assert.equal(s.area,null);assert.ok(s.scroll>0);
   const o=await optionBox('נתיבות');await mouse('mousePressed',o.x,o.y);await mouse('mouseReleased',o.x,o.y);await wait(list+'.hidden');s=await state();
   assert.deepEqual([s.open,s.area],[false,'נתיבות']);assert.equal(await ev(`document.activeElement===${input}`),true,'focus stays in the field');
   // Measured again: opening moved the page so the list fits on screen.
   const g=await box(input);await mouse('mousePressed',g.x,g.y);await mouse('mouseReleased',g.x,g.y);await wait('!'+list+'.hidden');await mouse('mousePressed',20,780);await mouse('mouseReleased',20,780);await wait(list+'.hidden');
   s=await state();assert.equal(s.open,false);assert.equal(await ev('document.querySelector("[data-other]").value'),'1');
   assert.deepEqual(errors,[]);
  });
 }finally{
  ws?.close();chrome?.kill();server.closeAllConnections();server.close();await sleep(300);
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
});
