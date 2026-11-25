// The category menu: main categories at the top level, each name a link to its full collection, with a button beside it
// for the sub-categories. Real header section, CSS and storefront.js (tests/helpers/header-fixture.cjs), no Shopify.
// Needs liquidjs (NODE_PATH) and Chrome (CHROME_PATH). SCREENSHOT_DIR=<folder> also saves screenshots.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const {headerPage,Liquid,root}=require('./helpers/header-fixture.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
const link=(title,handle,links=[])=>({title,url:handle.startsWith('/')?handle:'/collections/'+handle,active:false,current:false,links});
const MENU={links:[
 link('טיפוח אישי','care',['תרחיץ פנים','דאודורנטים','נקה 7','אל סבון','החלקה','כיף','מוצרי תינוקות'].map((t,i)=>link(t,'care-'+i))),
 link('כביסה','laundry',["ג'ל כביסה",'אבקת כביסה','מרכך כביסה','מסיר כתמים'].map((t,i)=>link(t,'laundry-'+i))),
 link('ניקוי כללי','cleaning',['רצפות','ניקוי כלים'].map((t,i)=>link(t,'cleaning-'+i))),
 link('חד פעמי','disposables'),
 link('כל המוצרים','all'),
 link('צרו קשר','/pages/contact'),
]};
test('Category menu: linked names, separate sub-category buttons, its own row on desktop, accordion on mobile',{skip:SKIP,timeout:180000},async t=>{
 const page=await headerPage({menu:MENU}),current=await headerPage();
 const js=fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8');
 const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');const file=path.join(root,'assets',path.basename(req.url.split('?')[0]));res.end(fs.existsSync(file)?fs.readFileSync(file):'');return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(req.url==='/current'?current:page);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-menu-'));
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
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const key=async(name,code,keyCode)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&name==='Enter'?{text:'\r'}:{})});};
  const load=async(width,url='/')=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<992});
   await call('Page.navigate',{url:origin+url});await wait('document.readyState==="complete"');
   if(!await ev('!!document.querySelector("script[src*=storefront]")'))await ev(js);
   await sleep(250);
  };
  const shot=async name=>{if(process.env.SCREENSHOT_DIR){const s=await call('Page.captureScreenshot');fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR,name+'.png'),Buffer.from(s.data,'base64'));}};
  await call('Page.enable');await call('Runtime.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  const top='#navbar > ul > li';

  await t.test('Every main category name is a real link; sub-categories have a named button',async()=>{
   await load(1280);
   assert.deepEqual(await ev(`[...document.querySelectorAll('${top}')].map(li=>[li.querySelector(':scope > a')?.textContent.trim(),li.querySelector(':scope > a')?.getAttribute('href'),!!li.querySelector(':scope > button')])`),
    [['טיפוח אישי','/collections/care',true],['כביסה','/collections/laundry',true],['ניקוי כללי','/collections/cleaning',true],['חד פעמי','/collections/disposables',false],['כל המוצרים','/collections/all',false],['צרו קשר','/pages/contact',false]]);
   assert.deepEqual(await ev(`[...document.querySelectorAll('[data-mega-trigger]')].map(b=>b.getAttribute('aria-label'))`),['תתי־קטגוריות: טיפוח אישי','תתי־קטגוריות: כביסה','תתי־קטגוריות: ניקוי כללי']);
   assert.equal(await ev('document.querySelectorAll("#navbar a[href=\\"#\\"]").length'),0);
  });
  for(const width of [992,1024,1280,1440,1920])await t.test(width+'px: one menu row under the search, right to left, inside the page; panels stay on screen',async()=>{
   await load(width);await shot('menu-'+width);
   const r=await ev(`(()=>{const li=[...document.querySelectorAll('${top}')].map(e=>e.getBoundingClientRect()),search=document.querySelector('fankee-predictive-search').getBoundingClientRect(),cart=document.querySelector('.cart-toggle-btn').getBoundingClientRect();
    return {rows:new Set(li.map(x=>Math.round(x.top))).size,rtl:li.every((x,i)=>!i||x.right<=li[i-1].left+1),inside:li.every(x=>x.left>=0&&x.right<=innerWidth),below:li[0].top>=search.bottom-2,cart:cart.left>=0&&cart.bottom<=li[0].top+2,over:document.documentElement.scrollWidth<=document.documentElement.clientWidth+1,targets:[...document.querySelectorAll('${top} > a, ${top} > button')].every(e=>e.getBoundingClientRect().height>=44&&e.getBoundingClientRect().width>=24)};})()`);
   assert.deepEqual(r,{rows:1,rtl:true,inside:true,below:true,cart:true,over:true,targets:true});
   for(let i=0;i<3;i++){await ev(`document.querySelectorAll('[data-mega-trigger]')[${i}].click()`);
    const p=await ev(`(()=>{const open=[...document.querySelectorAll('[data-mega-panel]')].filter(p=>!p.hidden),r=open[0].getBoundingClientRect();return {open:open.length,inside:r.left>=0&&r.right<=innerWidth,height:r.bottom<=innerHeight};})()`);
    assert.deepEqual(p,{open:1,inside:true,height:true},'panel '+i);if(i===0)await shot('menu-open-'+width);}
  });
  await t.test('Keyboard: Enter on the button opens, ArrowDown enters the list, Escape returns to the button; the link navigates',async()=>{
   await load(1280);
   await ev('document.querySelector("[data-mega-trigger]").focus()');await key('Enter','Enter',13);
   assert.equal(await ev('document.querySelector("[data-mega-trigger]").getAttribute("aria-expanded")'),'true');
   await key('ArrowDown','ArrowDown',40);assert.equal(await ev('document.activeElement.textContent.trim()'),'תרחיץ פנים');
   await key('Escape','Escape',27);assert.equal(await ev('document.activeElement.hasAttribute("data-mega-trigger")&&document.querySelector("[data-mega-panel]").hidden'),true);
   await ev(`document.querySelector('${top} > a').click()`);await wait('location.pathname==="/collections/care"');
  });
  for(const width of [390,320])await t.test(width+'px: drawer with links and accordion buttons, no overflow',async()=>{
   await load(width);await ev('document.querySelector(".open-btn").click()');await sleep(400);
   const r=await ev(`(()=>{const rows=[...document.querySelectorAll('${top}')].map(li=>{const a=li.querySelector(':scope > a').getBoundingClientRect(),b=li.querySelector(':scope > button')?.getBoundingClientRect();return a.height>=44&&(!b||(b.width>=44&&b.height>=44&&Math.abs(b.top-a.top)<8&&b.right<=a.left+2));});return {rows:rows.every(Boolean),over:document.documentElement.scrollWidth<=innerWidth};})()`);
   assert.deepEqual(r,{rows:true,over:true});
   await ev('document.querySelector("[data-mega-trigger]").click()');await sleep(100);await shot('menu-'+width);
   const p=await ev(`(()=>{const p=document.querySelector('[data-mega-panel]'),r=p.getBoundingClientRect(),nav=document.querySelector('#navbar').getBoundingClientRect(),li=p.closest('li').querySelector('a').getBoundingClientRect();return {open:!p.hidden,inside:r.left>=nav.left-1&&r.right<=nav.right+1,below:r.top>=li.bottom-2,links:[...p.querySelectorAll('.nav-mega-group a')].length};})()`);
   assert.deepEqual(p,{open:true,inside:true,below:true,links:7});
  });
  await t.test("Today's menu (up to 4 items) is unchanged: no extra row",async()=>{
   await load(1280,'/current');
   assert.equal(await ev('!!document.querySelector(".storefront-header--nav-row")'),false);
   assert.deepEqual(errors,[]);
  });
 }finally{
  ws?.close();chrome?.kill();server.closeAllConnections();server.close();await sleep(300);
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
});
