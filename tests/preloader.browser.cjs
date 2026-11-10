const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
// The storefront must never stay covered: verifies the real layout markup, controller and style.css rules.
test('Preloader never leaves the storefront covered',{timeout:90000},async t=>{
 const layout=fs.readFileSync(path.join(root,'layout/theme.liquid'),'utf8');
 const noscript=layout.match(/<noscript>\s*<style>\s*\.preloader\s*{[\s\S]*?<\/noscript>/)?.[0];
 assert.ok(noscript,'no-JS preloader fallback missing from layout');
 assert.match(noscript,/\.preloader\s*{\s*display:\s*none\s*!important;?\s*}/,'no-JS fallback must hide the preloader');
 const block=layout.slice(layout.indexOf('<!-- start preloader -->'),layout.indexOf('<!-- end preloader -->')).replace(/{{ 'preloader.png' \| asset_url }}/,'/preloader.png');
 assert.ok(block.includes('data-preloader-done'),'inline preloader controller missing from layout');
 const withoutController=block.replace(/<script>[\s\S]*?<\/script>/,'');
 const css=fs.readFileSync(path.join(root,'assets/style.css'),'utf8');
 const page=(body,extra='')=>'<!doctype html><html dir="rtl" lang="he"><head><style>'+css+'</style>'+noscript+'</head><body><div class="page-wrapper">'+body+'<main><h1>Storefront</h1><button id="probe">Buy</button></main></div>'+extra+'</body></html>';
 const routes={
  '/normal':page(block),
  // Legacy scripts fail and media never finishes, so window.load cannot fire.
  '/broken':page(block,'<script src="/missing.js" defer></script><script>throw Error("legacy failure")</script><img src="/hang.png" alt="">'),
  '/no-controller':page(withoutController,'<img src="/hang.png" alt="">')
 };
 const hanging=new Set();
 const server=http.createServer((req,res)=>{
  if(req.url==='/hang.png'){hanging.add(res);return;}
  if(!routes[req.url]){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type','text/html;charset=utf-8');res.end(routes[req.url]);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-predictive-'));
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
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async(expression,ms)=>{const end=Date.now()+ms;while(Date.now()<end){if(await ev(expression))return true;await sleep(50);}return false;};
  // Covered means the overlay still paints and intercepts the page.
  const covered='(()=>{const p=document.querySelector(".preloader"),s=p&&getComputedStyle(p);return !!s&&s.display!=="none"&&s.visibility!=="hidden"&&document.elementFromPoint(innerWidth/2,innerHeight/2)?.closest(".preloader")!==null})()';
  const open=async route=>{await call('Page.navigate',{url:origin+route});await until('document.readyState!=="loading"',5000);};
  await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true});
  await t.test('Normal load hides the overlay after load and releases legacy WOW start',async()=>{
   await open('/normal');
   assert.ok(await until('!'+covered,3000),'overlay still covering after load');
   assert.ok(await until('document.querySelector(".preloader").hidden',2000));
   assert.equal(await ev('typeof window.fankeePreloader?.done?.then'),'function');
  });
  await t.test('Failing legacy scripts and never-ending media cannot keep the page covered',async()=>{
   await open('/broken');
   assert.equal(await ev('document.readyState==="complete"'),false,'fixture media should still be loading');
   assert.ok(await until('!'+covered,800),'overlay must lift at DOM ready, without waiting for media or legacy scripts');
   assert.equal(await ev('document.readyState==="complete"'),false);
  });
  await t.test('CSS failsafe reveals the page even when the inline controller never runs',async()=>{
   await open('/no-controller');
   assert.ok(await ev(covered));
   assert.ok(await until('!'+covered,6500),'CSS failsafe did not reveal the storefront');
  });
  await t.test('Reduced motion shows no overlay',async()=>{
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await open('/broken');
   assert.equal(await ev(covered),false);
   assert.equal(await ev('getComputedStyle(document.querySelector(".preloader")).display'),'none');
   await call('Emulation.setEmulatedMedia',{features:[]});
  });
  await t.test('Disabled JavaScript shows the storefront immediately',async()=>{
   await call('Emulation.setScriptExecutionDisabled',{value:true});
   await open('/no-controller');
   assert.equal(await ev(covered),false);
   assert.equal(await ev('getComputedStyle(document.querySelector(".preloader")).display'),'none');
   await call('Emulation.setScriptExecutionDisabled',{value:false});
  });
 }finally{
  for(const res of hanging)res.destroy();
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
