import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {deflateSync,crc32} from 'node:zlib';
import {createApp} from '../src/server.js';
import {Importer} from '../src/importer.js';
import {CompositeProductImageProvider,SerpApiProductImageProvider} from '../src/images.js';
import type {ProductCatalogProduct} from '../src/catalog.js';
import {adminEnv} from './auth-helpers.js';
const chromePath=process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const code='7290108356472';
const metadata={barcode:code,title:"מקסימה ג'ל כביסה מרוכז בייבי",manufacturer:'סנו',source:'cheapersal'};
const found='https://images.example.com/found.jpg',manual='https://images.example.com/manual.jpg';
/** Solid 96x96 PNG served through DevTools interception; Chrome never reaches the network. */
function png(size=96){
  const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length);head.write(type,4,'ascii');
    const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,crc]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  const rows=Buffer.alloc((size*3+1)*size,0x90);for(let y=0;y<size;y++)rows[y*(size*3+1)]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
test('Hebrew admin UI requires per-image confirmation for discovery-only and manual images',{timeout:60000,skip:!existsSync(chromePath)},async()=>{
  const valid={validate:async(value:unknown)=>({imageUrl:String(value)})};
  const search=new SerpApiProductImageProvider('ui-test-key',async()=>new Response(JSON.stringify({images_results:[{original:found,
    title:"סנו מקסימה ג'ל כביסה מרוכז בייבי 1.5 ליטר",link:'https://shop.example.co.il/product/'+code,original_width:800,original_height:800}]})),valid);
  const created:ProductCatalogProduct[]=[];
  const importer=new Importer({lookupByBarcode:async()=>({...metadata})},{currency:async()=>'ILS',findBarcode:async()=>undefined,
    create:async p=>{created.push(structuredClone(p));return {id:'gid://shopify/Product/5',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/5'};}},
  new CompositeProductImageProvider([search],valid),valid);
  const selections:unknown[][]=[],previews:unknown[][]=[];
  const select=importer.selectImage.bind(importer),preview=importer.preview.bind(importer);
  importer.selectImage=async(...args)=>{selections.push(args);return select(...args);};
  importer.preview=async(...args)=>{previews.push(args);return preview(...args);};
  const server=createServer();
  server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const port=(server.address() as AddressInfo).port,origin='http://127.0.0.1:'+port;
  const app=createApp(importer,port,adminEnv);server.on('request',(req,res)=>app(req,res));
  const profile=mkdtempSync(join(tmpdir(),'fankee-policy-'));
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='',ws:WebSocket|undefined;
  chrome.stderr.on('data',data=>stderr+=data.toString());
  try{
    for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(stderr);i++)await sleep(50);
    const endpoint=stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];assert.ok(endpoint,'Headless Chrome must start');
    const tab=await(await fetch('http://'+new URL(endpoint).host+'/json/new?about:blank',{method:'PUT'})).json();
    ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws!.addEventListener('open',r,{once:true}));
    let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(value:any)=>void}>();
    const call=(method:string,params:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws!.send(JSON.stringify({id:n,method,params}));});
    const image=png().toString('base64');
    ws.addEventListener('message',event=>{
      const message=JSON.parse(String(event.data));
      if(message.id){const item=pending.get(message.id)!;pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);}
      else if(message.method==='Fetch.requestPaused')call('Fetch.fulfillRequest',{requestId:message.params.requestId,responseCode:200,
        responseHeaders:[{name:'Content-Type',value:'image/png'}],body:image}).catch(()=>{});
    });
    const ev=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true});if(result.exceptionDetails)throw Error('Browser fixture evaluation failed: '+expression);return result.result.value;};
    const until=async(expression:string,label:string)=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}assert.fail('Timed out waiting for '+label);};
    await call('Fetch.enable',{patterns:[{urlPattern:'https://images.example.com/*'}]});
    await call('Page.enable');await call('Page.navigate',{url:origin+'/login'});
    await until('document.readyState==="complete"&&!!document.querySelector("#password")','login form');
    await ev('document.querySelector("#username").value='+JSON.stringify(adminEnv.IMPORTER_USERNAME)+';document.querySelector("#password").value='+JSON.stringify(adminEnv.IMPORTER_PASSWORD)+';document.querySelector("button[type=submit]").click()');
    await until('document.readyState==="complete"&&!!document.querySelector("#barcode")','importer UI');
    await ev('document.querySelector("#barcode").value="'+code+'";document.querySelector("#price").value="15.90";document.querySelector("#search").click()');
    await until('!document.querySelector("#preview").hidden','preview');
    const card=await ev('document.querySelector(".candidate").innerText');
    assert.match(card,/תמונה לבדיקה/);assert.match(card,/תמונה נמצאה דרך: shop\.example\.co\.il/);assert.match(card,/ספק: Google \/ SerpAPI/);
    assert.equal(await ev('document.querySelector("#image").hidden'),true,'Discovery-only image is not attached automatically');
    await until('document.querySelector(".candidate img").complete&&document.querySelector(".candidate img").naturalWidth===96&&!document.querySelector(".candidate input").disabled','candidate thumbnail');
    await ev('document.querySelector(".candidate input").click()');
    await until('!document.querySelector("#candidate-review").hidden','review panel');
    assert.equal(await ev('document.querySelector("#review-warning").textContent'),'נמצאה תמונה בחיפוש, אך המקור אינו מאושר לשימוש אוטומטי.');
    assert.match(await ev('document.querySelector("#candidate-review").innerText'),/המקור אינו ברשימת המקורות המאושרים לשימוש אוטומטי\.[\s\S]*יש לוודא שיש הרשאה/);
    assert.equal(await ev('document.activeElement.id'),'review-title');
    assert.equal(await ev('document.querySelector("#use-image").disabled'),true);
    await ev('document.querySelector("#use-image").click()');await sleep(100);
    assert.equal(selections.length,0,'Choosing a discovery-only candidate sends nothing before confirmation');
    await ev('document.querySelector("#review-approved").click()');
    assert.equal(await ev('document.querySelector("#use-image").disabled'),false);
    await ev('document.querySelector("#use-image").click()');
    await until('document.querySelector("#image-status").textContent==="השימוש בתמונה אושר ידנית"','confirmed image status');
    assert.deepEqual(selections[0].slice(1),[0,true]);
    assert.equal(await ev('document.querySelector("#image-origin").textContent'),'תמונה נמצאה דרך: shop.example.co.il');
    assert.equal(await ev('document.querySelector("#image").getAttribute("src")'),found);
    assert.equal(await ev('document.querySelector("#candidate-review").hidden'),true);
    // Manual URL: the confirmation appears, is unchecked, and blocks the request until checked.
    await ev('const m=document.querySelector("#manual-image");m.value='+JSON.stringify(manual)+';m.dispatchEvent(new Event("input",{bubbles:true}))');
    assert.equal(await ev('document.querySelector("#manual-approval").hidden'),false);
    assert.equal(await ev('document.querySelector("#manual-image-approved").checked'),false);
    const before=previews.length;
    await ev('document.querySelector("#search").click()');await sleep(100);
    assert.equal(previews.length,before,'Unconfirmed manual image is not submitted');
    assert.match(await ev('document.querySelector("#message").textContent'),/יש לאשר/);
    assert.equal(await ev('document.activeElement.id'),'manual-image-approved');
    // The earlier confirmation is not carried into the new preview, so the confirmed manual URL is used.
    await ev('document.querySelector("#manual-image-approved").click();document.querySelector("#search").click()');
    await until('!document.querySelector("#preview").hidden&&document.querySelector("#image").getAttribute("src")==='+JSON.stringify(manual),'manual preview');
    assert.equal(previews.at(-1)![3],true);
    assert.equal(await ev('document.querySelector("#image-status").textContent'),'השימוש בתמונה אושר ידנית');
    await ev('document.querySelector("#confirm").click()');
    await until('!document.querySelector("#result").hidden','import result');
    assert.equal(created[0].imageUrl,manual);
    assert.equal(await ev('document.querySelector("#manual-image-approved").checked'),false,'Approval does not carry over to the next product');
  }finally{
    ws?.close();chrome.kill();await new Promise<void>(r=>server.close(()=>r()));await sleep(300);
    if(resolve(profile).startsWith(join(resolve(tmpdir()),'fankee-policy-')))try{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
});
