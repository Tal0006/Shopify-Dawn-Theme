// Admin dashboard in headless Chrome (DevTools protocol, no extra dependencies). Skips when Chrome is not installed.
// Set ADMIN_SCREENSHOTS=<folder> to save fixture screenshots (login, dashboard, group, member, mobile).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {adminFixture} from './admin-fixture.js';
const CHROME=process.env.CHROME_PATH||['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('Admin dashboard in the browser',{skip:CHROME?false:'Chrome not installed (set CHROME_PATH)',timeout:240000},async t=>{
 const f=await adminFixture(),ids=await f.seed();
 const profile=mkdtempSync(join(tmpdir(),'fankee-admin-chrome-'));
 const shots=process.env.ADMIN_SCREENSHOTS;if(shots)mkdirSync(shots,{recursive:true});
 let chrome:ChildProcess|undefined,ws:WebSocket|undefined;
 try{
  let stderr='';
  chrome=spawn(CHROME!,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-extensions','--hide-scrollbars','about:blank'],{stdio:['ignore','ignore','pipe']});
  chrome.stderr!.on('data',b=>stderr+=b);
  for(let i=0;i<100&&!/ws:\/\/\S+/.test(stderr);i++)await sleep(100);
  const host=new URL(stderr.match(/ws:\/\/\S+/)![0]).host;
  const tab=await(await fetch('http://'+host+'/json/new?about:blank',{method:'PUT'})).json() as any;
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws!.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map<number,(m:any)=>void>();
  ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){pending.get(m.id)!(m);pending.delete(m.id);}});
  const call=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const n=++id;pending.set(n,m=>m.error?reject(Error(method+': '+m.error.message)):resolve(m.result));ws!.send(JSON.stringify({id:n,method,params}));});
  const ev=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,300));return r.result.value;};
  const wait=async(expression:string,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await ev(expression))return;}catch{}await sleep(50);}throw Error('Timeout: '+expression);};
  const size=(width:number,height=900)=>call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});
  const go=async(path:string)=>{await call('Page.navigate',{url:f.cfg.origin+path});await wait('document.readyState==="complete"&&!!document.querySelector("main")');};
  const shot=async(name:string)=>{
   if(!shots)return;
   const metrics=await ev('({w:innerWidth,h:Math.min(6000,document.documentElement.scrollHeight)})');
   await call('Emulation.setDeviceMetricsOverride',{width:metrics.w,height:metrics.h,deviceScaleFactor:1,mobile:metrics.w<768});await sleep(150);
   writeFileSync(join(shots,name+'.png'),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
   await size(metrics.w);
  };
  const overflow='document.documentElement.scrollWidth>document.documentElement.clientWidth+1';
  await call('Page.enable');await call('Runtime.enable');await size(1440);

  await t.test('login form: labelled fields, generic error, then the dashboard',async()=>{
   await go('/admin');
   assert.deepEqual(await ev('[document.documentElement.lang,document.documentElement.dir,document.title]'),['he','rtl','התחברות · ניהול משלוחים קבוצתיים']);
   assert.deepEqual(await ev('[...document.querySelectorAll("input:not([type=hidden])")].map(i=>!!document.querySelector("label[for="+i.id+"]"))'),[true,true]);
   await shot('admin-login');
   await ev('document.querySelector("#username").value="merchant";document.querySelector("#password").value="nope";document.querySelector(".login form").submit()');
   await wait('document.querySelector(".notice--error")');
   assert.equal(await ev('document.querySelector(".notice--error").textContent'),'שם המשתמש או הסיסמה אינם נכונים.');
   await ev('document.querySelector("#username").value="merchant";document.querySelector("#password").value='+JSON.stringify(f.cfg.password)+';document.querySelector(".login form").submit()');
   await wait('document.querySelector(".metrics")');
   assert.equal(await ev('document.querySelector("h1").textContent'),'לוח בקרה');
   assert.equal(await ev('JSON.stringify({...localStorage})+JSON.stringify({...sessionStorage})+document.cookie'),'{}{}','no session or customer data in script-readable storage');
  });

  await t.test('dashboard: metrics, groups table, sortable headers, no overflow at 1280/1440/1920',async()=>{
   assert.equal(await ev('document.querySelectorAll(".metric").length'),6);
   assert.equal(await ev('document.querySelector(".metric strong").textContent'),'3');
   assert.equal(await ev('document.querySelectorAll(".table--groups tbody tr").length'),5);
   assert.equal(await ev('document.querySelector("th[aria-sort]").textContent.trim().startsWith("נפתחה")'),true);
   assert.equal(await ev('document.querySelectorAll("[role=progressbar][aria-valuenow]").length'),5);
   for(const width of [1280,1440,1920]){await size(width);assert.equal(await ev(overflow),false,'overflow at '+width);}
   await size(1440);await shot('admin-dashboard');
   await ev('location.href=[...document.querySelectorAll("th a")].find(a=>a.textContent.includes("התחייבויות")).href');
   await wait('document.querySelector("th[aria-sort]")?.textContent.includes("התחייבויות")');
   const amounts=await ev('[...document.querySelectorAll(".table--groups tbody tr")].map(r=>Number(r.querySelector("[role=progressbar]").getAttribute("aria-valuenow")))');
   assert.equal(amounts.length,5);
  });

  await t.test('filters and search run on the server; empty results have a clear state',async()=>{
   await go('/admin');
   await ev('document.querySelector("#status").value="THRESHOLD_REACHED";document.querySelector(".filters").requestSubmit()');
   await wait('location.search.includes("status=THRESHOLD_REACHED")&&document.querySelectorAll(".table--groups tbody tr").length===1');
   assert.equal(await ev('document.querySelector(".table--groups tbody .row-link").textContent'),'באר שבע');
   await go('/admin?q=dana');assert.equal(await ev('document.querySelectorAll(".table--groups tbody tr").length'),1);
   assert.equal(await ev('document.querySelector("#q").value'),'dana');
   await go('/admin?q=no-such-customer');
   assert.match(await ev('document.querySelector(".empty").textContent'),/לא נמצאו קבוצות/);
   // The loading state appears as soon as a filter is submitted.
   await go('/admin');await ev('document.querySelector(".filters").dispatchEvent(new Event("submit",{cancelable:true,bubbles:true}))');
   assert.equal(await ev('document.body.hasAttribute("data-loading")&&document.querySelector("main").getAttribute("aria-busy")'),'true');
  });

  await t.test('row click and keyboard both open a group; progress, members and contact actions are present',async()=>{
   await go('/admin?q='+ids.ashdod.slice(0,8));
   await ev('document.querySelector(".table--groups tbody tr td:nth-child(5)").click()');
   await wait('location.pathname==="/admin/groups/'+ids.ashdod+'"');
   assert.equal(await ev('document.querySelector(".meter--large [role=progressbar]").getAttribute("aria-valuenow")'),'75');
   assert.match(await ev('document.querySelector(".meter--large").textContent'),/375\.00.*500\.00/);
   assert.equal(await ev('document.querySelectorAll(".table--members tbody tr").length'),3);
   assert.deepEqual(await ev('[...document.querySelectorAll(".table--members .chip")].map(c=>c.textContent)'),['התחייבות פעילה','התחייבות פעילה','ההתחייבות הוסרה']);
   const links=await ev('[...document.querySelector(".table--members tbody tr").querySelectorAll("a.icon-btn")].map(a=>[a.getAttribute("href"),a.target,a.rel])');
   assert.deepEqual(links,[['mailto:dana@example.test','',''],['tel:+972501234567','',''],['https://wa.me/972501234567','_blank','noopener noreferrer']]);
   const csv=await ev('[...document.querySelectorAll("a[download]")].map(a=>a.getAttribute("href"))');
   assert.deepEqual(csv,['/admin/groups/'+ids.ashdod+'/export.csv','/admin/groups/'+ids.ashdod+'/export-lines.csv']);
   assert.deepEqual(await ev('fetch('+JSON.stringify(csv[0])+').then(r=>[r.status,r.headers.get("content-type")])'),[200,'text/csv; charset=utf-8']);
   await shot('admin-group');
   // Copy buttons appear with JavaScript and announce the copy.
   await ev('navigator.clipboard.writeText=async v=>{window.copied=v}');
   assert.equal(await ev('document.querySelectorAll("[data-copy]:not([hidden])").length>0'),true);
   await ev('document.querySelector(".table--members [data-copy-label=\\"טלפון\\"]").click()');
   await wait('window.copied==="+972501234567"&&document.querySelector("#admin-live").textContent==="טלפון הועתק"');
   // Keyboard: Tab reaches the skip link first; a focused row link opens with Enter.
   await go('/admin');
   await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   assert.equal(await ev('document.activeElement.className'),'skip');
   await ev('document.querySelector(".table--groups .row-link").focus()');
   for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
   await wait('location.pathname.startsWith("/admin/groups/")');
  });

  await t.test('member details: contact actions and the stored cart with product titles',async()=>{
   await go('/admin/groups/'+ids.ashdod);
   await ev('document.querySelector(".table--members .row-link").click()');
   await wait('location.pathname.includes("/members/")&&document.querySelector("#cart-title")');
   assert.equal(await ev('document.querySelector("h1").textContent'),'פרטי לקוח');
   assert.deepEqual(await ev('[...document.querySelectorAll("tbody tr td:first-child")].map(td=>td.textContent.trim())'),['מוצר 1 #1','מוצר 2 #2']);
   assert.match(await ev('document.querySelector("tfoot").textContent'),/סכום התחייבות שנשמר.*250\.00/);
   await shot('admin-member');
  });

  await t.test('mobile: stacked cards, no horizontal overflow, 44px targets',async()=>{
   await size(390,844);
   for(const path of ['/admin','/admin/groups/'+ids.ashdod]){
    await go(path);
    assert.equal(await ev(overflow),false,'overflow '+path);
    assert.equal(await ev('getComputedStyle(document.querySelector("thead")).display'),'none');
    assert.match(await ev('getComputedStyle(document.querySelector("tbody td"),"::before").content'),/אזור|אימייל/);
    const small=await ev('[...document.querySelectorAll("main .btn,main .icon-btn,main input:not([type=hidden]),main select,.topbar a,.topbar button,.pager__link")].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<43.5).map(e=>e.outerHTML.slice(0,60))');
    assert.deepEqual(small,[],'touch targets '+path);
    await shot(path==='/admin'?'admin-mobile-dashboard':'admin-mobile-group');
   }
   await size(1440);
  });

  await t.test('errors and session expiry show friendly pages, never internals',async()=>{
   await go('/admin/groups/00000000-0000-4000-8000-000000000000');
   assert.equal(await ev('document.querySelector("h1").textContent'),'לא נמצא');
   assert.doesNotMatch(await ev('document.body.innerText'),/Error|SELECT|stack/);
   await f.db.query("UPDATE admin_sessions SET expires_at=NOW()-INTERVAL '1 second'");
   await go('/admin/groups/'+ids.ashdod);
   assert.equal(await ev('location.pathname+location.search'),'/admin?expired=1&next='+encodeURIComponent('/admin/groups/'+ids.ashdod));
   assert.match(await ev('document.querySelector(".notice").textContent'),/פג תוקף ההתחברות/);
   assert.equal(await ev('document.querySelector("input[name=next]").value'),'/admin/groups/'+ids.ashdod);
   assert.doesNotMatch(await ev('document.body.innerText'),/@example\.test/);
  });
 }finally{
  ws?.close();chrome?.kill();await f.close();await sleep(200);
  try{rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
