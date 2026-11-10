// Sticky header (Theme Settings "header צף") with compact state, live cart badge, and the asset cleanup.
// Static checks always run; the browser part renders the real header section with liquidjs (NODE_PATH) in Chrome.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=json('locales/he.default.json');
const pngSize=file=>{const b=fs.readFileSync(path.join(root,'assets',file));return [b.readUInt32BE(16),b.readUInt32BE(20)];};

test('Contract: setting, wiring and asset cleanup',()=>{
 const group=json('config/settings_schema.json').find(g=>g.name==='t:sticky_header_editor.settings');
 assert.deepEqual(group.settings.map(s=>[s.id,s.type,s.default]),[['sticky_header','checkbox',true]]);
 assert.equal(json('locales/he.schema.json').sticky_header_editor.enabled,'header צף');
 assert.match(read('layout/theme.liquid'),/<html\s+class="js"\s+{% if settings\.sticky_header %}data-sticky-header{% endif %}/);
 const header=read('sections/header.liquid');
 assert.equal(JSON.parse(header.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]).class,'header-section');
 assert.match(header,/html\[data-sticky-header\] \.page-wrapper { overflow: clip; }/,'overflow:hidden on .page-wrapper would stop position:sticky');
 assert.match(header,/html\[data-sticky-header\] { scroll-padding-top:/);
 // Announcement bar is outside (above) the sticky header section.
 assert.match(read('layout/theme.liquid'),/{% render 'announcement-bar' %}\s*{% section 'header' %}/);
 // Cart icon is an inline SVG; badge pulse is off under reduced motion and the accessibility pause.
 assert.match(header,/<svg class="cart-toggle-btn__icon"[^>]*aria-hidden="true"/);assert.doesNotMatch(header,/shopping-cart\.png/);
 const design=read('snippets/storefront-design.liquid');
 assert.match(design,/prefers-reduced-motion: reduce\) { \.storefront-header \.cart-count\[data-bump\] { animation: none; } }/);
 assert.match(design,/html\[data-a11y-paused\] \.storefront-header \.cart-count\[data-bump\] { animation: none; }/);
 // Unused images are gone and nothing references them; decorative images are sized for their display.
 const removed=['features1.png','features2.png','features3.png','cta.png','home-hero.png','hero_home.png','logo.png','shopping-cart.png'];
 const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
 const sources=['layout','sections','snippets','templates','config','locales','assets'].flatMap(walk).filter(f=>/\.(liquid|json|css|js)$/.test(f));
 for(const file of removed){
  assert.equal(fs.existsSync(path.join(root,'assets',file)),false,file+' deleted');
  for(const source of sources)assert.ok(!read(source).includes(file),source+' references '+file);
 }
 assert.deepEqual(pngSize('80MG.png'),[200,199]);assert.deepEqual(pngSize('features-right.png'),[200,214]);
 assert.ok(fs.statSync(path.join(root,'assets/80MG.png')).size<30000&&fs.statSync(path.join(root,'assets/features-right.png')).size<30000);
 const feature=read('sections/feature-section.liquid');
 assert.match(feature,/'80MG\.png' \| asset_url }}"\s+class="fk-img-auto"\s+width="90"\s+height="90"/);
 assert.match(feature,/'features-right\.png' \| asset_url }}"\s+class="fk-img-auto"\s+width="100"\s+height="107"/);
 assert.match(read('assets/storefront.css'),/\.fk-img-auto { height: auto; }/);
 for(const f of ['sections/about-us.liquid','sections/content.liquid','sections/feature-section.liquid','sections/shop-now.liquid'])
  for(const img of read(f).match(/<img src="{{ '(shape1|shape3|footer2)\.png'[^>]*>/g)||[])assert.match(img,/class="fk-img-auto"/,f);
});

const {headerPage,Liquid}=require('./helpers/header-fixture.cjs');
test('Browser: sticky header, compact state, overlays, anchors, live badge',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)',timeout:240000},async t=>{
 const pages={sticky:await headerPage({sticky:true}),plain:await headerPage({sticky:false})};
 const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/assets/')){const f=path.join(root,'assets',decodeURIComponent(req.url.slice(8).split('?')[0]));if(fs.existsSync(f)){res.end(fs.readFileSync(f));return;}res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(req.url.includes('plain')?pages.plain:pages.sticky);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-sticky-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws,call,ev;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  let loads=0;
  // A fresh URL per load: same-URL navigations restore the previous scroll position.
  const load=async(width,{plain=false,hash=''}={})=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:base+(plain?'plain':'')+'?load='+(++loads)+hash});await wait('document.readyState==="complete"');
   await ev(`window.Shopify={routes:{root:'/'}};window.layoutShift=0;new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)layoutShift+=e.value}).observe({type:'layout-shift',buffered:false});
    window.cartCount=2;window.fetch=async(url,o={})=>{url=String(url);await new Promise(r=>setTimeout(r,30));if(url.endsWith('cart.js'))return new Response(JSON.stringify({items:[{variant_id:1,quantity:cartCount}]}));
     if(url.endsWith('add.js')){cartCount+=1;return new Response(JSON.stringify({items:[{id:1,variant_id:1,quantity:cartCount}],sections:{header:'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" aria-label="סל '+cartCount+'"><span class="cart-count">'+cartCount+'</span></button><div class="mini-cart-items"><p>'+cartCount+'</p></div></div></header>'}}));}
     return new Response('{}');};`);
   await ev(read('assets/storefront.js'));
  };
  const scrollTo=async y=>{await ev(`scrollTo(0,${y})`);await sleep(150);await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');};
  const state=()=>ev(`(()=>{const h=document.querySelector('.storefront-header').getBoundingClientRect(),a=document.querySelector('.announcement-bar').getBoundingClientRect(),main=document.querySelector('#MainContent');return {top:Math.round(h.top),height:Math.round(h.height),annBottom:Math.round(a.bottom),compact:document.documentElement.hasAttribute('data-header-compact'),shadow:getComputedStyle(document.querySelector('.header-section > .storefront-header')).boxShadow,mainTop:Math.round(main.getBoundingClientRect().top+scrollY),overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});

  for(const width of [360,390,768,1280]){
   await t.test(`Width ${width}: sticks, compacts, shadow, announcement scrolls away, no layout shift`,async()=>{
    await load(width);
    const top=await state();
    // The header keeps its resting design shadow at the top; scrolling adds the stronger "lifted" shadow.
    assert.equal(top.compact,false);assert.doesNotMatch(top.shadow,/6px 20px/);assert.ok(top.annBottom>0,'announcement visible at the top');
    await scrollTo(1500);
    const down=await state();
    assert.equal(down.top,0,'header stuck to the top');assert.ok(down.annBottom<=0,'announcement scrolled away');
    assert.equal(down.compact,true);assert.match(down.shadow,/0px 6px 20px/);
    assert.ok(down.height<=(width<768?60:64),'compact height '+down.height);assert.ok(down.height<top.height,'compact is smaller');
    assert.equal(down.mainTop,top.mainTop,'content position unchanged (no layout shift)');
    // Page content never moves (mainTop above). Only the header's own contents tighten: negligible on phones and
    // desktop; on tablets the search moves up into the compact row once (kept well under the 0.1 "good" CLS limit).
    const cls=await ev('layoutShift');
    // The header padding animates (240ms), so the sampled score varies with machine load; 0.01 is 10x under "good".
    assert.ok(cls<(width>=768&&width<992?0.05:0.01),'layout shift '+cls);
    assert.equal(down.overflow,false);
    // Cart, search and menu (mobile) stay reachable on the compact header.
    const reach=await ev(`(()=>{const hit=sel=>{const n=document.querySelector(sel);if(!n||!n.getClientRects().length)return null;const r=n.getBoundingClientRect();if(!r.width)return null;const at=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return !!at&&(n===at||n.contains(at));};return {cart:hit('.cart-toggle-btn'),search:hit('.storefront-header input[type=search]'),menu:innerWidth<992?hit('.open-btn'):true}})()`);
    assert.deepEqual(reach,{cart:true,search:true,menu:true});
    // The reserved strip below a compact header lets clicks reach the page.
    const below=await ev(`(()=>{const h=document.querySelector('.storefront-header').getBoundingClientRect();const at=document.elementFromPoint(innerWidth/2,h.bottom+4);return !document.querySelector('.header-section').contains(at)})()`);
    assert.equal(below,true);
    await scrollTo(0);
    const back=await state();assert.equal(back.compact,false);assert.equal(back.shadow,top.shadow);
   });
  }
  await t.test('Mobile compact search expands to full width while typing',async()=>{
   await load(390);await scrollTo(1500);
   // A real tap (shifts right after user input are excluded from layout shift, as in the field).
   const box=await ev('(()=>{const r=document.querySelector(".storefront-header input[type=search]").getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()');
   for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x:box[0],y:box[1],button:'left',clickCount:1});
   await sleep(150);
   assert.equal(await ev('document.activeElement.matches(".storefront-header input[type=search]")'),true);
   const r=await ev('(()=>{const s=document.querySelector(".storefront-header input[type=search]").getBoundingClientRect();return {width:Math.round(s.width),mainTop:Math.round(document.querySelector("#MainContent").getBoundingClientRect().top+scrollY)}})()');
   assert.ok(r.width>=300,'search full width '+r.width);
   assert.equal(await ev('layoutShift'),0);
  });
  await t.test('Overlays open above the sticky header: mobile menu, mega menu, cart drawer',async()=>{
   await load(390);await scrollTo(1500);
   await ev('document.querySelector(".open-btn").click()');await sleep(400);
   const menu=await ev('(()=>{const n=document.querySelector("#navbar"),r=n.getBoundingClientRect();const at=document.elementFromPoint(r.left+r.width/2,innerHeight/2);return {open:n.classList.contains("slideInn"),onTop:n.contains(at),height:Math.round(r.height)}})()');
   assert.deepEqual({...menu,height:menu.height>=700},{open:true,onTop:true,height:true});
   await ev('document.querySelector(".menu-close").click()');await sleep(300);
   await ev('document.querySelector(".cart-toggle-btn").click()');await wait('document.querySelector(".cart-drawer").open');
   assert.equal(await ev('(()=>{const d=document.querySelector(".cart-drawer"),r=d.getBoundingClientRect();return d.contains(document.elementFromPoint(r.left+r.width/2,30))})()'),true,'drawer above the header');
   await ev('document.querySelector(".cart-drawer").close()');
   await load(1280);await scrollTo(1500);
   await ev('document.querySelector("[data-mega-trigger]").click()');await sleep(200);
   const mega=await ev('(()=>{const p=document.querySelector("[data-mega-panel]");if(p.hidden)return "hidden";const r=p.getBoundingClientRect();const at=document.elementFromPoint(r.left+Math.min(40,r.width/2),r.top+Math.min(20,r.height/2));return {onTop:p.contains(at),visible:r.height>0,belowHeader:r.top>=document.querySelector(".storefront-header").getBoundingClientRect().top}})()');
   assert.deepEqual(mega,{onTop:true,visible:true,belowHeader:true});
  });
  await t.test('Anchors and the skip link land below the sticky header (scroll-padding-top)',async()=>{
   await load(390,{hash:'#anchor'});await sleep(300);
   const r=await ev('(()=>{const a=document.getElementById("anchor").getBoundingClientRect(),h=document.querySelector(".storefront-header").getBoundingClientRect();return {anchor:Math.round(a.top),header:Math.round(h.bottom)}})()');
   assert.ok(r.anchor>=r.header,'anchor '+r.anchor+' below header '+r.header);
   await load(1280);await scrollTo(2000);
   await ev('document.querySelector("#anchor").scrollIntoView()');await sleep(200);
   const d=await ev('(()=>{const a=document.getElementById("anchor").getBoundingClientRect(),h=document.querySelector(".storefront-header").getBoundingClientRect();return [Math.round(a.top),Math.round(h.bottom)]})()');
   assert.ok(d[0]>=d[1],'desktop anchor below header '+d);
  });
  await t.test('Setting off: the header scrolls away as before',async()=>{
   await load(390,{plain:true});await scrollTo(1500);
   const r=await ev('[Math.round(document.querySelector(".storefront-header").getBoundingClientRect().bottom),document.documentElement.hasAttribute("data-header-compact")]');
   assert.ok(r[0]<=0,'not sticky');assert.equal(r[1],false);
  });
  await t.test('Cart badge updates live from an add and pulses once; no pulse under reduced motion or stop-animations',async()=>{
   await load(390);await scrollTo(1500);
   await ev(`document.body.insertAdjacentHTML('beforeend','<form data-card-cart action="/cart/add"><input type="hidden" name="id" value="1"><input type="hidden" name="quantity" value="1"><button name="add" data-pending-label="..">הוספה</button><p data-card-feedback data-success="נוסף" data-error="שגיאה" data-refresh-error="x"></p></form>')`);
   await ev('document.querySelector("[data-card-cart] [name=add]").click()');
   await wait('document.querySelector(".storefront-header .cart-count").textContent==="3"');
   const badge=await ev('(()=>{const b=document.querySelector(".storefront-header .cart-count");return {bump:b.hasAttribute("data-bump"),animation:getComputedStyle(b).animationName,label:document.querySelector(".cart-toggle-btn").getAttribute("aria-label"),visible:b.getBoundingClientRect().top>=0}})()');
   assert.deepEqual(badge,{bump:true,animation:'fk-bump',label:'סל 3',visible:true});
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await ev('document.querySelector("[data-card-cart] [name=add]").click()');await wait('document.querySelector(".storefront-header .cart-count").textContent==="4"');
   assert.equal(await ev('getComputedStyle(document.querySelector(".storefront-header .cart-count")).animationName'),'none');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await ev('document.documentElement.setAttribute("data-a11y-paused","");document.querySelector("[data-card-cart] [name=add]").click()');await wait('document.querySelector(".storefront-header .cart-count").textContent==="5"');
   assert.equal(await ev('getComputedStyle(document.querySelector(".storefront-header .cart-count")).animationName'),'none');
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
