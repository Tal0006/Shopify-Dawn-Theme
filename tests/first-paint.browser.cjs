// First-paint performance round: no preloader, fewer render-blocking stylesheets (accessibility panel non-blocking),
// swap fonts, right-sized images, no entrance animations above the fold, and no forced layouts while loading.
// Static contracts always run; the browser part renders the real header with liquidjs (NODE_PATH) and traces load.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const {headerPage,Liquid}=require('./helpers/header-fixture.cjs');
const themeFiles=dirs=>dirs.flatMap(dir=>fs.existsSync(path.join(root,dir))?fs.readdirSync(path.join(root,dir)).map(f=>dir+'/'+f):[]);

test('Contract: no preloader anywhere; nothing waits on it',()=>{
 assert.equal(fs.existsSync(path.join(root,'assets/preloader.png')),false);
 for(const file of themeFiles(['layout','sections','snippets','assets','templates']).filter(f=>/\.(liquid|js|css)$/.test(f)))
  assert.doesNotMatch(read(file),/preloader/i,file);
});

test('Contract: render-blocking CSS is theme.css, storefront.css and the small accessibility.css; the panel loads without blocking',()=>{
 const layout=read('layout/theme.liquid');
 const head=layout.slice(0,layout.indexOf('</head>'));
 const blocking=[...head.matchAll(/{{-?\s*'([\w.-]+\.css)'\s*\|\s*asset_url\s*\|\s*stylesheet_tag\s*-?}}/g)].map(m=>m[1]);
 // base.css only on the customer account pages (Dawn templates); the noscript fallback is not a blocking link.
 const noscript=[...head.matchAll(/<noscript>[\s\S]*?<\/noscript>/g)].map(m=>m[0]).join('');
 const outside=blocking.filter(file=>!noscript.includes(`'${file}'`));
 assert.deepEqual(outside,['theme.css','storefront.css','base.css','accessibility.css']);
 // The only other <link rel="stylesheet"> is the non-blocking accessibility panel (media="print" until loaded).
 assert.deepEqual(head.match(/<link[^>]+rel="stylesheet"[^>]*>/g),[`<link rel="stylesheet" href="{{ 'accessibility-panel.css' | asset_url }}" media="print" onload="this.onload=null;this.media='all'">`]);
 assert.match(head,/media="print" onload="this\.onload=null;this\.media='all'">\s*<noscript>{{ 'accessibility-panel\.css' \| asset_url \| stylesheet_tag }}<\/noscript>/);
 assert.ok(head.indexOf("'accessibility.css'")<head.indexOf("'accessibility-panel.css'"),'same cascade position as before: right after accessibility.css');
 assert.doesNotMatch(head,/fonts\.shopifycdn\.com/,'no unused preconnect: this layout loads no Shopify-hosted fonts');
 // The panel file holds only panel and preference-mode rules; everything visible before JavaScript stays blocking.
 const panel=read('assets/accessibility-panel.css').replace(/\/\*[\s\S]*?\*\//g,'');
 for(const selector of panel.match(/^[^{}\n]+(?=\s*{)/gm))assert.match(selector.trim(),/^(\.a11y-(panel|text-controls|status|grayscale-overlay)|html\[data-a11y-(text|links|contrast)\])/,selector);
 const critical=read('assets/accessibility.css');
 for(const keep of ['.a11y-skip-link','.a11y-launcher','html[data-a11y-paused]','.storefront-header .submenu-toggle','prefers-reduced-motion'])assert.ok(critical.includes(keep),'blocking part keeps '+keep);
 // theme.css merges the Bootstrap subset and the former style.css in their original order.
 const theme=read('assets/theme.css');
 assert.ok(theme.startsWith('@charset "UTF-8";'));
 assert.ok(theme.indexOf('/* bootstrap-subset:end */')<theme.indexOf('/* ===== Legacy template styles (formerly style.css) ===== */'));
 for(const gone of ['style.css','bootstrap-subset.css'])assert.equal(fs.existsSync(path.join(root,'assets',gone)),false,gone+' merged into theme.css');
});

test('Contract: every web font swaps (text never invisible) and Shopify font filters ask for swap',()=>{
 for(const file of themeFiles(['assets']).filter(f=>f.endsWith('.css'))){
  for(const face of read(file).match(/@font-face\s*{[^}]*}/g)||[])assert.match(face,/font-display:\s*swap/,file+': '+face.slice(0,80));
 }
 for(const file of themeFiles(['layout','sections','snippets']).filter(f=>f.endsWith('.liquid'))){
  for(const call of read(file).match(/\|\s*font_face[^}]*}}/g)||[])assert.match(call,/font_display:\s*'swap'/,file);
 }
});

test('Contract: above-the-fold images are found early and sized for the layout',()=>{
 const hero=read('sections/hero-section.liquid');
 assert.match(hero,/'storefront-hero-image'[^}]*sizes: '\(min-width: 1200px\) 600px, \(min-width: 992px\) 50vw, 100vw', loading: 'eager', fetchpriority: 'high', preload: true/);
 assert.match(hero,/hero_logo_width = section\.settings\.left_image\.aspect_ratio \| times: 110 \| ceil/,'hero logo sized from its 110px max height');
 assert.doesNotMatch(hero,/loading: 'lazy'/);
 assert.match(read('sections/header.liquid'),/widths: '100, 200, 300, 400', sizes: '\(max-width: 709px\) 128px, \(max-width: 991px\) 156px, 164px'/);
 const card=read('snippets/product-card.liquid');
 assert.match(card,/card_sizes \| default: '\(min-width: 1400px\) 200px, \(min-width: 992px\) 260px, calc\(50vw - 30px\)'/);
 assert.match(card,/widths: '200, 300, 360, 450, 600', sizes: card_image_sizes/);
 for(const file of ['sections/cart-recommendations.liquid','sections/recently-viewed.liquid','sections/product-recommendations.liquid'])
  for(const call of read(file).match(/{% render 'product-card'[^%]*%}/g))assert.match(call,/card_sizes: '\(min-width: 992px\) 260px, \(min-width: 600px\) 42vw, 78vw'/,file);
 assert.match(read('sections/category-navigation.liquid'),/widths: '180, 300, 360, 450, 600', sizes: '\(min-width: 1200px\) 268px, \(min-width: 992px\) 23vw, calc\(50vw - 20px\)'/);
 // No large CSS background images in the hero.
 for(const css of [read('assets/storefront.css'),read('assets/theme.css'),read('snippets/storefront-design.liquid')])
  for(const rule of css.match(/[^{}]*hero[^{}]*{[^}]*}/g)||[])assert.doesNotMatch(rule,/url\(/,rule.slice(0,80));
});

test('Contract: no entrance animation on the hero; reveal and review transitions only run when content is revealed',()=>{
 const design=read('snippets/storefront-design.liquid');
 assert.doesNotMatch(design,/storefront-entrance/);
 assert.doesNotMatch(design,/:is\(\[data-storefront-home\], \[data-storefront-collection\], \[data-storefront-discovery\]\) \[data-storefront-reveal\] { transition:/);
 assert.match(read('snippets/google-review-cta.liquid'),/\.google-review-cta\[data-review-reveal=entered\] { transition:/);
 const bar=read('snippets/announcement-bar.liquid');
 assert.match(bar,/\.announcement-bar__message { grid-area: 1 \/ 1; margin: 0; padding-block: 8px; overflow-wrap: anywhere; }/,'first message paints without a fade');
 assert.match(bar,/\[data-announcement\]\[data-rotated\] \.announcement-bar__message { animation: fk-fade/);
 assert.doesNotMatch(read('assets/storefront-motion.js'),/getBoundingClientRect/,'reveal setup takes positions from the observer');
});

test('Browser: header page loads without forced layouts from theme scripts, without load-time animations, and keeps the announcement fade for rotations',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)',timeout:180000},async t=>{
 const page=await headerPage({sticky:true});
 const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/assets/')){const f=path.join(root,'assets',decodeURIComponent(req.url.slice(8).split('?')[0]));if(fs.existsSync(f)){res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(fs.readFileSync(f));return;}res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');
  // Theme scripts load the way the layout loads them (deferred).
  res.end(page.replace('</head>','<script>window.Shopify={routes:{root:"/"}};window.themeStrings={backToTop:"",required:"",invalidEmail:"",quantityError:""};</script><script src="/assets/storefront.js" defer></script></head>'));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port+'/';
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-first-paint-'));
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
  let id=0;const pending=new Map();let chunks=[];let traced=null;
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
   else if(m.method==='Tracing.dataCollected')chunks.push(...m.params.value);else if(m.method==='Tracing.tracingComplete')traced?.();});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true});

  await t.test('No forced layout from storefront.js while loading, and nothing animates on first paint',async()=>{
   chunks=[];
   await call('Tracing.start',{categories:'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.animations',transferMode:'ReportEvents'});
   await call('Page.navigate',{url:base+'?trace'});await wait('document.readyState==="complete"');
   await sleep(800);
   await call('Tracing.end');await new Promise(r=>traced=r);
   const forced=chunks.filter(e=>(e.name==='Layout'||e.name==='UpdateLayoutTree')&&(e.args?.beginData?.stackTrace||e.args?.stackTrace)).map(e=>(e.args.beginData?.stackTrace||e.args.stackTrace)[0]).filter(f=>/storefront\.js/.test(f.url));
   assert.deepEqual(forced.map(f=>`${f.functionName}:${f.lineNumber+1}`),[],'layout reads in storefront.js during load');
   const animations=chunks.filter(e=>e.name==='Animation'&&e.ph==='b').map(e=>e.args?.data?.name||'');
   assert.deepEqual(animations,[],'animations while loading');
   // The deferred first checks still ran (sticky header measured, back-to-top hidden at the top).
   await wait('document.documentElement.style.getPropertyValue("--header-expanded-height")!==""');
   assert.equal(await ev('getComputedStyle(document.querySelector(".back-to-top")).display'),'none');
  });
  await t.test('Announcement bar: first message without animation; rotating fades the next one in',async()=>{
   assert.deepEqual(await ev('[...document.querySelectorAll(".announcement-bar__message")].flatMap(m=>m.getAnimations()).length'),0);
   assert.equal(await ev('document.querySelector("[data-announcement]").hasAttribute("data-rotated")'),false);
   await ev('document.querySelector("[data-announcement-next]").click()');
   await wait('document.querySelector("[data-announcement]").hasAttribute("data-rotated")');
   assert.equal(await ev('[...document.querySelectorAll(".announcement-bar__message:not([hidden])")].flatMap(m=>m.getAnimations()).map(a=>a.animationName).join()'),'fk-fade');
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
