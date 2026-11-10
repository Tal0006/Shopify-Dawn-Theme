// Phase 2 of the legacy-library removal: jQuery, Bootstrap JS, the jQuery plugin collection and script.js are gone;
// their live behaviours (back-to-top, classic fixed header when sticky is off, mobile menu outside tap) run on
// storefront.js. Static checks always run; the browser part renders the real header with liquidjs (NODE_PATH).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const {headerPage,Liquid}=require('./helpers/header-fixture.cjs');

test('Contract: legacy scripts deleted and unreferenced; no jQuery or Bootstrap JS API left',()=>{
 const removed=['jquery.min.js','bootstrap.bundle.min.js','jquery-plugin-collection.js','script.js'];
 for(const file of removed)assert.equal(fs.existsSync(path.join(root,'assets',file)),false,file);
 const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
 const sources=['layout','sections','snippets','templates','config','assets'].flatMap(walk).filter(f=>/\.(liquid|json|js|css)$/.test(f));
 for(const source of sources){
  const text=read(source);
  for(const file of removed)assert.ok(!text.includes("'"+file+"'"),source+' loads '+file);
  if(source.endsWith('.js')&&source.startsWith('assets/'))assert.doesNotMatch(text,/\bjQuery\b|\$\(|\bnew WOW\b|owlCarousel|\bbootstrap\.(Modal|Collapse|Dropdown|Tooltip)/,source);
 }
 for(const file of walk('sections').concat(walk('snippets'),walk('layout')).filter(f=>f.endsWith('.liquid')))assert.doesNotMatch(read(file),/data-bs-[a-z]+=/,file+' relies on Bootstrap JS');
 const strings=read('layout/theme.liquid').match(/window\.themeStrings = {([^\n]*)};/)[1];
 assert.deepEqual([...strings.matchAll(/(\w+): {{/g)].map(m=>m[1]),['required','invalidEmail','quantityError','backToTop']);
});

test('Browser: back-to-top, classic fixed header, mobile menu taps',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)',timeout:180000},async t=>{
 const pages={sticky:await headerPage({sticky:true}),plain:await headerPage({sticky:false})};
 const a11yEngine=new Liquid();a11yEngine.registerFilter('t',key=>key);
 const a11yMenu=await a11yEngine.parseAndRender(read('snippets/accessibility-menu.liquid').replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''),{});
 const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/assets/')){const f=path.join(root,'assets',decodeURIComponent(req.url.slice(8).split('?')[0]));if(fs.existsSync(f)){res.end(fs.readFileSync(f));return;}res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(req.url.includes('plain')?pages.plain:pages.sticky);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-legacy-'));
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
  const load=async(width,{plain=false}={})=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:base+(plain?'plain':'')+'?load='+(++loads)});await wait('document.readyState==="complete"');
   await ev(`window.Shopify={routes:{root:'/'}};window.themeStrings={backToTop:'חזרה לראש העמוד',required:'',invalidEmail:'',quantityError:''};window.fetch=async()=>new Response('{"items":[]}');`);
   await ev(read('assets/storefront.js'));
   // accessibility.js runs against the real widget markup (snippets/accessibility-menu.liquid).
   await ev(`document.querySelectorAll('body > .a11y-launcher').forEach(n=>n.remove());document.body.insertAdjacentHTML('beforeend',${JSON.stringify(a11yMenu)})`);
   await ev(read('assets/accessibility.js'));
  };
  const tap=async(x,y)=>{for(const type of ['mousePressed','mouseReleased'])await call('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});await sleep(80);};
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});

  await t.test('Back-to-top: hidden near the top, fades in after 1000px, labelled, scrolls to the top',async()=>{
   await load(1280);
   assert.equal(await ev('getComputedStyle(document.querySelector(".back-to-top")).display'),'none');
   assert.equal(await ev('document.querySelectorAll(".back-to-top").length'),1);
   await ev('scrollTo(0,1400)');await wait('getComputedStyle(document.querySelector(".back-to-top")).display==="block"');
   const shown=await ev('(()=>{const b=document.querySelector(".back-to-top"),c=getComputedStyle(b),r=b.getBoundingClientRect();return {display:c.display,label:b.getAttribute("aria-label"),fading:b.getAnimations().length>0,icon:b.querySelector("i").className,hidden:b.querySelector("i").getAttribute("aria-hidden"),right:Math.round(document.documentElement.clientWidth-r.right),bottom:Math.round(innerHeight-r.bottom),size:Math.round(r.width)}})()');
   assert.deepEqual(shown,{display:'block',label:'חזרה לראש העמוד',fading:true,icon:'theme-icon',hidden:'true',right:15,bottom:15,size:45},'same position and size as style.css');
   await ev('document.querySelector(".back-to-top").click()');
   await wait('scrollY===0');
   await wait('getComputedStyle(document.querySelector(".back-to-top")).display==="none"');
  });
  await t.test('Back-to-top with reduced motion: no fade, instant jump, focus on the skip link',async()=>{
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await load(390);
   await ev('scrollTo(0,1400)');await wait('getComputedStyle(document.querySelector(".back-to-top")).display==="block"');
   assert.deepEqual(await ev('[getComputedStyle(document.querySelector(".back-to-top")).display,document.querySelector(".back-to-top").getAnimations().length]'),['block',0]);
   await ev('document.querySelector(".back-to-top").click()');
   assert.equal(await ev('scrollY'),0);
   assert.equal(await ev('document.activeElement.className'),'a11y-skip-link');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  });
  await t.test('Classic fixed header only when "header צף" is off',async()=>{
   await load(1280,{plain:true});
   await ev('scrollTo(0,400)');await sleep(100);
   // Wait for the short slide-in (fadeInDown) to finish before measuring.
   await wait('document.querySelector(".site-header").getAnimations().every(a=>a.playState!=="running")');
   const plain=await ev('(()=>{const h=document.querySelector(".site-header");return {cls:["header-fixed","fadeInDown","animated"].every(c=>h.classList.contains(c)),position:getComputedStyle(h).position,top:Math.round(h.getBoundingClientRect().top)}})()');
   // Identical to the old script: same classes and position. (A header ancestor creates the containing block for
   // fixed elements, so this classic mode never stuck on screen before either; the page header simply scrolls away.)
   assert.deepEqual({cls:plain.cls,position:plain.position},{cls:true,position:'fixed'});
   await ev('scrollTo(0,100)');await sleep(100);
   assert.equal(await ev('document.querySelector(".site-header").classList.contains("header-fixed")'),false);
   await load(1280);await ev('scrollTo(0,400)');await sleep(300);
   assert.equal(await ev('document.querySelector(".site-header").classList.contains("header-fixed")'),false,'sticky header never gets the classic fixed classes');
  });
  await t.test('Mobile menu: taps inside (even on empty space) keep it open; a tap outside closes it',async()=>{
   await load(390);
   await ev('document.querySelector(".open-btn").click()');await wait('document.querySelector(".navigation-holder").classList.contains("slideInn")');
   await sleep(400);
   const menu=await ev('(()=>{const r=document.querySelector("#navbar").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom}})()');
   // Empty space near the bottom of the open menu.
   await tap((menu.left+menu.right)/2,menu.bottom-20);
   assert.equal(await ev('document.querySelector(".navigation-holder").classList.contains("slideInn")'),true,'inside tap keeps the menu open');
   // Outside the menu (the menu opens from the inline-start side; tap the other side of the screen).
   const outsideX=menu.left>20?10:Math.min(385,menu.right+20);
   await tap(outsideX,600);
   assert.deepEqual(await ev('[document.querySelector(".navigation-holder").classList.contains("slideInn"),document.querySelector(".open-btn").classList.contains("x-close")]'),[false,false]);
   // Close button and Escape still close it.
   await ev('document.querySelector(".open-btn").click()');await wait('document.querySelector(".navigation-holder").classList.contains("slideInn")');
   await ev('document.querySelector(".menu-close").click()');await wait('!document.querySelector(".navigation-holder").classList.contains("slideInn")');
   await ev('document.querySelector(".open-btn").click()');await wait('document.querySelector(".navigation-holder").classList.contains("slideInn")');
   await sleep(400);
   for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
   await wait('!document.querySelector(".navigation-holder").classList.contains("slideInn")');
  });
  await t.test('Accessibility pause still works without jQuery',async()=>{
   await load(1280);
   assert.equal(await ev('typeof window.jQuery'),'undefined');
   await ev('localStorage.setItem("punky-accessibility-v1",JSON.stringify({motion:true}))');
   await load(1280);
   assert.equal(await ev('document.documentElement.hasAttribute("data-a11y-paused")'),true);
   await ev('localStorage.removeItem("punky-accessibility-v1")');
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
