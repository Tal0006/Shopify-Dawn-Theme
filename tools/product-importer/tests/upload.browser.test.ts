import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import sharp from 'sharp';
import {createApp} from '../src/server.js';
import {Importer} from '../src/importer.js';
import {CompositeProductImageProvider} from '../src/images.js';
import {ProductImageProcessor} from '../src/upload-image.js';
import type {ImageUploadFile} from '../src/shopify.js';
import type {ProductCatalogProduct} from '../src/catalog.js';
import {adminEnv} from './auth-helpers.js';
const chromePath=process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const code='7290000289380';
test('Upload UI: permission gate, original/processed comparison, choices, mobile layout and Shopify draft',{timeout:90000,skip:!existsSync(chromePath)},async()=>{
  const profile=mkdtempSync(join(tmpdir(),'fankee-upload-'));
  const file=join(profile,'product-photo.jpg');
  writeFileSync(file,await sharp({create:{width:900,height:1200,channels:3,background:'#f3f3f0'}})
    .composite([{input:{create:{width:300,height:700,channels:3,background:'#d7262e'}},left:250,top:250},
      {input:{create:{width:300,height:250,channels:3,background:'#ffd21f'}},left:250,top:500}]).jpeg({quality:92}).toBuffer());
  const created:ProductCatalogProduct[]=[],uploaded:ImageUploadFile[]=[];
  const importer=new Importer({lookupByBarcode:async()=>({barcode:code,title:'מסיר שומנים פאנקי',source:'cheapersal'})},
    {currency:async()=>'ILS',findBarcode:async()=>undefined,
      uploadImage:async f=>{uploaded.push(f);return 'https://shopify-staged-uploads.storage.googleapis.com/tmp/ui';},
      create:async p=>{created.push(structuredClone(p));return {id:'gid://shopify/Product/3',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/3'};}},
    new CompositeProductImageProvider([]),undefined,{uploads:new ProductImageProcessor()});
  const server=createServer();
  server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const port=(server.address() as AddressInfo).port,origin='http://127.0.0.1:'+port;
  let uploadRequests=0;
  const app=createApp(importer,port,adminEnv);
  server.on('request',(req,res)=>{if(req.method==='POST'&&req.url==='/api/image-upload')uploadRequests++;app(req,res);});
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+join(profile,'chrome'),'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='',ws:WebSocket|undefined;
  chrome.stderr.on('data',data=>stderr+=data.toString());
  try{
    for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(stderr);i++)await sleep(50);
    const endpoint=stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];assert.ok(endpoint,'Headless Chrome must start');
    const tab=await(await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'})).json();
    ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws!.addEventListener('open',r,{once:true}));
    let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(value:any)=>void}>();
    ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id){const item=pending.get(m.id)!;pending.delete(m.id);m.error?item.reject(m.error):item.resolve(m.result);}});
    const call=(method:string,params:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws!.send(JSON.stringify({id:n,method,params}));});
    const ev=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('Browser evaluation failed: '+expression);return r.result.value;};
    const until=async(expression:string,label:string)=>{for(let i=0;i<400;i++){if(await ev(expression))return;await sleep(25);}assert.fail('Timed out waiting for '+label);};
    await call('Emulation.setDeviceMetricsOverride',{width:360,height:780,deviceScaleFactor:2,mobile:true});
    await call('Page.enable');await call('DOM.enable');await call('Page.navigate',{url:origin+'/login'});
    await until('document.readyState==="complete"&&!!document.querySelector("#password")','login');
    await ev('document.querySelector("#username").value='+JSON.stringify(adminEnv.IMPORTER_USERNAME)+';document.querySelector("#password").value='+JSON.stringify(adminEnv.IMPORTER_PASSWORD)+';document.querySelector("button[type=submit]").click()');
    await until('document.readyState==="complete"&&!!document.querySelector("#product-upload")','importer');
    assert.equal(await ev('document.querySelector("label[for=product-upload]").textContent'),'תמונת מוצר');
    assert.match(await ev('document.querySelector("#upload-help").textContent'),/המערכת תסיר את הרקע ותתאים אותה אוטומטית לאתר/);
    assert.equal(await ev('document.querySelector("#product-upload").accept'),'image/jpeg,image/png,image/webp');
    const {root}=await call('DOM.getDocument');
    const {nodeId}=await call('DOM.querySelector',{nodeId:root.nodeId,selector:'#product-upload'});
    await call('DOM.setFileInputFiles',{nodeId,files:[file]});
    await ev('document.querySelector("#product-upload").dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await ev('document.querySelector("#upload-approval").hidden'),false);
    assert.equal(await ev('document.querySelector("#upload-approved").checked'),false);
    await ev('document.querySelector("#barcode").value="'+code+'";document.querySelector("#price").value="20.00";document.querySelector("#search").click()');
    await sleep(150);
    assert.equal(uploadRequests,0,'No upload before the permission checkbox');
    assert.equal(await ev('document.activeElement.id'),'upload-approved');
    await ev('document.querySelector("#upload-approved").click();document.querySelector("#search").click()');
    await until('!!document.querySelector("#upload-processed").getAttribute("src")&&document.querySelector("#upload-processed").complete&&document.querySelector("#upload-processed").naturalWidth===1200','processed preview');
    assert.equal(uploadRequests,1);
    assert.equal(await ev('document.querySelector("#upload-processed-info").textContent.startsWith("1200×1200 · PNG")'),true);
    assert.match(await ev('document.querySelector("#upload-processed-info").textContent'),/רקע שקוף/);
    assert.match(await ev('document.querySelector("#upload-original-info").textContent'),/^900×1200 · JPEG/);
    assert.match(await ev('getComputedStyle(document.querySelector(".checker")).backgroundImage'),/conic-gradient/);
    assert.equal(await ev('document.querySelector("#use-processed").getAttribute("aria-pressed")'),'true');
    assert.equal(await ev('document.querySelector("#image-status").textContent'),'השימוש בתמונה אושר ידנית');
    for(const label of ['השתמש בתמונה המותאמת','השתמש בתמונה המקורית','בחר תמונה אחרת','המשך ללא תמונה'])
      assert.ok(await ev('[...document.querySelectorAll(".upload-actions button")].some(b=>b.textContent==='+JSON.stringify(label)+'&&!b.hidden)'),label);
    // Mobile: no horizontal overflow, previews scaled down, large tap targets.
    assert.ok(await ev('document.documentElement.scrollWidth<=360'),'no horizontal overflow at 360px: '+await ev(
      '"sw="+document.documentElement.scrollWidth+" cw="+document.documentElement.clientWidth+" iw="+innerWidth+" "+[...document.querySelectorAll("body *")].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX!=="hidden").map(e=>e.tagName+"#"+e.id+":"+e.scrollWidth+"/"+e.clientWidth).slice(0,8).join(" ")'));
    assert.ok(await ev('document.querySelector("#upload-processed").getBoundingClientRect().width<=330'),'1200px image shown as a thumbnail');
    assert.ok(await ev('[...document.querySelectorAll(".upload-actions button:not([hidden])")].every(b=>b.getBoundingClientRect().height>=44)'));
    await ev('document.querySelector("#use-original").click()');
    await until('document.querySelector("#use-original").getAttribute("aria-pressed")==="true"','original selected');
    await ev('document.querySelector("#use-processed").click()');
    await until('document.querySelector("#use-processed").getAttribute("aria-pressed")==="true"','processed selected again');
    await ev('document.querySelector("#confirm").click()');
    await until('!document.querySelector("#result").hidden','import result');
    assert.equal(uploaded.length,1);assert.equal(uploaded[0].mimeType,'image/png');
    assert.equal(created[0].imageUrl,'https://shopify-staged-uploads.storage.googleapis.com/tmp/ui');
    assert.equal(await ev('document.querySelector("#upload-approved").checked'),false,'Approval is not kept for the next product');
    assert.equal(importer.stats().uploads,0,'Upload released after import');
  }finally{
    ws?.close();chrome.kill();await new Promise<void>(r=>server.close(()=>r()));await sleep(300);
    if(resolve(profile).startsWith(join(resolve(tmpdir()),'fankee-upload-')))try{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
});
