// Phase 3 of the legacy-library removal: themify icons became inline SVG (snippets/theme-icon.liquid), animate.css
// became one local fadeInDown, and full Bootstrap CSS became a generated subset (tests/helpers/bootstrap-subset.cjs).
// Also covers the back-to-top position next to the other floating controls. Static checks always run; the browser
// part renders the real header with liquidjs (NODE_PATH).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const {headerPage,Liquid}=require('./helpers/header-fixture.cjs');
const bootstrap=require('./helpers/bootstrap-subset.cjs');

const themeFiles=()=>['layout','sections','snippets','blocks','templates','config','assets'].flatMap(dir=>fs.existsSync(path.join(root,dir))?fs.readdirSync(path.join(root,dir)).map(f=>dir+'/'+f):[]);

test('Contract: legacy CSS libraries and icon font deleted and unreferenced',()=>{
 const removed=['bootstrap.min.css','animate.css','themify-icons.css','themify.eot','themify.ttf','themify.woff','owl.carousel.css','owl.theme.css','owl.transitions.css'];
 for(const file of removed)assert.equal(fs.existsSync(path.join(root,'assets',file)),false,file+' should be deleted');
 for(const file of themeFiles().filter(f=>/\.(liquid|json|js|css)$/.test(f))){
  const text=read(file);
  for(const name of removed)assert.ok(!text.includes(name),`${file} still references ${name}`);
  assert.doesNotMatch(text,/font-family:\s*['"]?themify|class="ti-|['"]ti-[a-z-]+['"]/,`${file} still uses the themify icon font`);
 }
 // The subset now lives in theme.css (merged with the legacy styles; see tests/first-paint.browser.cjs).
 assert.match(read('layout/theme.liquid'),/'theme\.css' \| asset_url/);
});

test('Contract: the Bootstrap subset is generated from the current markup and keeps the grid, navbar and utilities in use',()=>{
 const committed=bootstrap.committedRegion();
 assert.ok(committed,'bootstrap-subset markers missing in assets/theme.css');
 assert.equal(committed,bootstrap.build(),'the Bootstrap region of assets/theme.css is out of date: run node tests/helpers/bootstrap-subset.cjs --write');
 assert.match(committed,/Licensed under MIT/,'license header kept');
 for(const selector of ['.row{','.container-fluid','.col-lg-4{','.col-md-6{','.navbar-expand-lg .navbar-collapse{','.collapse:not(.show){','.d-lg-none{','.list-unstyled{','.visually-hidden','.align-items-center{','.mb-lg-0{','.pt-0{'])
  assert.ok(committed.includes(selector),'subset keeps '+selector);
 // Classes the theme never uses are gone.
 for(const selector of ['.btn-primary{','.modal-backdrop{','.carousel-control-prev{','.col-xxl-12{'])assert.ok(!committed.includes(selector),'subset drops '+selector);
 assert.deepEqual(bootstrap.requiredClasses('.a .b:not(.c)>[class*=d]'),['a','b']);
});

test('Contract: theme-icon snippet draws each icon; the back-to-top arrow in storefront.js uses the same path',()=>{
 const snippet=read('snippets/theme-icon.liquid');
 const paths=Object.fromEntries([...snippet.matchAll(/when '([\w-]+)'\s+assign icon_path = '([^']+)'/g)].map(m=>[m[1],m[2]]));
 assert.deepEqual(Object.keys(paths).sort(),['arrow-up','close','search','user']);
 for(const d of Object.values(paths))assert.match(d,/^M[\d. LQZM-]+Z$/);
 assert.ok(read('assets/storefront.js').includes(`<path d="${paths['arrow-up']}"/>`));
 assert.match(snippet,/aria-hidden="true"/);
 for(const [file,name] of [['snippets/predictive-search.liquid','search'],['sections/header.liquid','close'],['sections/header.liquid','user']])
  assert.ok(read(file).includes(`{% render 'theme-icon', icon: '${name}' %}`),`${file} renders the ${name} icon`);
 assert.ok(read('assets/shopping-assistant.js').includes(".back-to-top')]"),'the assistant launcher also steps around back-to-top');
});

test('Browser: icons, back-to-top stacking, local fadeInDown',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)',timeout:240000},async t=>{
 // Real floating WhatsApp, accessibility launcher and assistant launcher markup next to the real header.
 const engine=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid',globals:{settings:{floating_whatsapp_enabled:true,floating_whatsapp_number:'+972 50-123-4567'},shop:{name:'פאנקי'}}});
 for(const tag of ['doc','stylesheet'])engine.registerTag(tag,{parse(token,remain){const s=this.liquid.parser.parseStream(remain);s.on('tag:end'+tag,()=>s.stop()).on('template',()=>{});s.start();},*render(){}});
 engine.registerFilter('t',key=>key);
 const whatsapp=(await engine.renderFile('floating-whatsapp',{})).trim();
 assert.match(whatsapp,/class="floating-whatsapp"/);
 const a11yMenu=await engine.parseAndRender(read('snippets/accessibility-menu.liquid'),{});
 const assistant=read('snippets/shopping-assistant.liquid');
 const launcher=await engine.parseAndRender(assistant.match(/<button type="button" class="shopping-assistant__launcher"[\s\S]*?<\/button>/)[0].replace(' hidden',''),{});
 const block=f=>(read(f).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)||['',''])[1];
 const extras=`<style>${block('snippets/shopping-assistant.liquid')}</style><fankee-shopping-assistant dir="rtl">${launcher}</fankee-shopping-assistant>`;
 const bar='<div class="product-sticky-atc" data-sticky-atc hidden><div class="product-sticky-atc__info"><p class="product-sticky-atc__title">מוצר</p><p class="product-sticky-atc__price">₪10.00</p></div><button type="button" class="theme-btn product-sticky-atc__add">הוספה לסל</button></div>';
 const pages={
  sticky:await headerPage({sticky:true}),
  plain:await headerPage({sticky:false}),
 };
 const withControls=(html,{wa})=>html.replace('<button class="a11y-launcher" type="button">נגישות</button>','').replace('</body>',(wa?whatsapp:'')+bar+extras+'</body>');
 pages.wa=withControls(pages.sticky,{wa:true});pages.nowa=withControls(pages.sticky,{wa:false});
 const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/assets/')){const f=path.join(root,'assets',decodeURIComponent(req.url.slice(8).split('?')[0]));if(fs.existsSync(f)){res.end(fs.readFileSync(f));return;}res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(pages[new URL(req.url,'http://x').pathname.slice(1)]||pages.sticky);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-legacy-css-'));
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
  const load=async(page,width,{a11y=false}={})=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:base+page+'?load='+(++loads)});await wait('document.readyState==="complete"');
   await ev(`window.Shopify={routes:{root:'/'}};window.themeStrings={backToTop:'חזרה לראש העמוד',required:'',invalidEmail:'',quantityError:''};window.fetch=async()=>new Response('{"items":[]}');`);
   await ev(read('assets/storefront.js'));
   if(a11y){await ev(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(a11yMenu)})`);await ev(read('assets/accessibility.js'));}
  };
  await call('Page.enable');

  await t.test('Header icons are 1em inline SVGs in the current text colour, hidden from assistive technology',async()=>{
   for(const width of [390,1280]){
    await load('sticky',width);
    const icons=await ev(`[...document.querySelectorAll('.theme-icon')].map(i=>{const r=i.getBoundingClientRect(),c=getComputedStyle(i),svg=i.querySelector('svg');return {where:i.parentElement.className||i.parentElement.type,w:r.width,h:r.height,font:parseFloat(c.fontSize),hidden:i.getAttribute('aria-hidden'),fill:svg.getAttribute('fill'),path:svg.querySelector('path').getAttribute('d').length>50}})`);
    assert.deepEqual(icons.map(i=>i.where).sort(),['back-to-top','menu-close','storefront-account','submit'],'search submit, menu close, account and back-to-top icons');
    // Hidden icons (back-to-top near the top, the drawer's close button on desktop) have no box to measure.
    assert.ok(icons.filter(i=>i.w).length>=2,'visible icons measured');
    for(const icon of icons){if(icon.w)assert.equal(icon.w,icon.font,icon.where);if(icon.h)assert.equal(icon.h,icon.font,icon.where);assert.equal(icon.hidden,'true');assert.equal(icon.fill,'currentColor');assert.ok(icon.path);}
    assert.equal(await ev('document.querySelectorAll("[class^=ti-],[class*=\\" ti-\\"]").length'),0);
   }
  });

  const rect=sel=>`(()=>{const n=document.querySelector(${JSON.stringify(sel)});if(!n||getComputedStyle(n).display==='none')return null;const r=n.getBoundingClientRect();return {l:r.left,r:r.right,t:r.top,b:r.bottom,cx:(r.left+r.right)/2}})()`;
  const overlap=(a,b)=>a&&b&&a.l<b.r&&a.r>b.l&&a.t<b.b&&a.b>b.t;
  const controls=async()=>({btt:await ev(rect('.back-to-top')),wa:await ev(rect('.floating-whatsapp')),a11y:await ev(rect('.a11y-launcher')),assistant:await ev(rect('.shopping-assistant__launcher')),bar:await ev(rect('.product-sticky-atc'))});
  const showBack=async()=>{await ev('scrollTo(0,1400)');await wait('getComputedStyle(document.querySelector(".back-to-top")).display==="block"');await wait('document.querySelector(".back-to-top").getAnimations().length===0');};
  const showBar=async()=>{await ev(`(()=>{const bar=document.querySelector('[data-sticky-atc]');bar.hidden=false;document.documentElement.setAttribute('data-sticky-atc-visible','');document.documentElement.style.setProperty('--sticky-atc-height',bar.offsetHeight+'px');})()`);await sleep(450);};

  await t.test('Back-to-top sits centred above WhatsApp with a 10px gap and clears every other floating control',async()=>{
   for(const width of [360,390,768,1280]){
    await load('wa',width,{a11y:true});await showBack();
    const c=await controls();
    assert.ok(c.btt&&c.wa&&c.a11y&&c.assistant,'all controls on screen at '+width);
    assert.ok(Math.abs(c.btt.cx-c.wa.cx)<=0.5,`centred on WhatsApp at ${width}: ${c.btt.cx} vs ${c.wa.cx}`);
    assert.ok(Math.abs(c.wa.t-c.btt.b-10)<=0.5,`10px gap at ${width}: ${c.wa.t-c.btt.b}`);
    for(const other of ['wa','a11y','assistant'])assert.ok(!overlap(c.btt,c[other]),`no overlap with ${other} at ${width}`);
    assert.ok(c.btt.r>width/2,'RTL: in the WhatsApp (right) corner');
    if(width<768){
     await showBar();
     const s=await controls();
     assert.ok(s.btt.b<=s.bar.t-12+0.5&&s.wa.b<=s.bar.t,'above the sticky add-to-cart bar at '+width);
     assert.ok(Math.abs(s.wa.t-s.btt.b-10)<=0.5,'still 10px above the raised WhatsApp button at '+width);
     for(const other of ['wa','a11y','bar'])assert.ok(!overlap(s.btt,s[other]),`no overlap with ${other} over the bar at ${width}`);
    }
   }
  });
  await t.test('Without WhatsApp: the original corner (15px), and above the sticky bar on mobile product pages',async()=>{
   await load('nowa',1280);await showBack();
   const c=await controls();
   assert.deepEqual({right:Math.round(await ev('document.documentElement.clientWidth')-c.btt.r),bottom:Math.round(760-c.btt.b)},{right:15,bottom:15});
   await load('nowa',390);await showBack();await showBar();
   const s=await controls();
   assert.ok(Math.abs(s.bar.t-s.btt.b-12)<=0.5,'12px above the bar');
  });
  await t.test('LTR storefront: back-to-top follows WhatsApp to the left corner, clear of the accessibility launcher',async()=>{
   await load('wa',1280,{a11y:true});await ev('document.documentElement.dir="ltr"');await showBack();
   const c=await controls();
   assert.ok(c.btt.l<640&&Math.abs(c.btt.cx-c.wa.cx)<=0.5&&!overlap(c.btt,c.a11y));
  });

  await t.test('Classic fixed header slides in with the local fadeInDown, but not with reduced motion or "stop animations"',async()=>{
   const animations='document.querySelector(".site-header").getAnimations().map(a=>({name:a.animationName,duration:a.effect.getTiming().duration}))';
   await load('plain',1280);await ev('scrollTo(0,400)');await wait('document.querySelector(".site-header").classList.contains("header-fixed")');
   assert.deepEqual(await ev(animations),[{name:'header-fade-in-down',duration:1000}]);
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await load('plain',1280);await ev('scrollTo(0,400)');await wait('document.querySelector(".site-header").classList.contains("header-fixed")');
   assert.deepEqual(await ev(animations),[]);
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await load('plain',1280);await ev('document.documentElement.setAttribute("data-a11y-paused","")');await ev('scrollTo(0,400)');await wait('document.querySelector(".site-header").classList.contains("header-fixed")');
   assert.deepEqual(await ev(animations),[]);
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
