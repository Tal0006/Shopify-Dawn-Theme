import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../src/server.js';
import {Importer} from '../src/importer.js';
import {adminEnv} from './auth-helpers.js';
const chromePath=process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test('Native browser login preserves same-origin POST without a login CSRF field',{timeout:30000,skip:!existsSync(chromePath)},async()=>{
  const server=createServer();
  server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const port=(server.address() as AddressInfo).port,origin='http://127.0.0.1:'+port;
  const importer=new Importer({lookupByBarcode:async()=>{throw Error('No provider call expected');}},
    {currency:async()=>'ILS',findBarcode:async()=>undefined,create:async()=>{throw Error('No import expected');}});
  const app=createApp(importer,port,adminEnv);
  let post:{origin:string|undefined; status:number}|undefined;
  server.on('request',(req,res)=>{
    if(req.method==='POST' && req.url==='/login')res.on('finish',()=>{post={origin:req.headers.origin,status:res.statusCode};});
    app(req,res);
  });
  const profile=mkdtempSync(join(tmpdir(),'fankee-login-'));
  const chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='',ws:WebSocket|undefined;
  chrome.stderr.on('data',data=>stderr+=data.toString());
  try{
    for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(stderr);i++)await sleep(50);
    const endpoint=stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];assert.ok(endpoint,'Headless Chrome must start');
    const debug='http://'+new URL(endpoint).host;
    const tab=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
    ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws!.addEventListener('open',r,{once:true}));
    let id=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(value:any)=>void}>();
    ws.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){const item=pending.get(message.id)!;pending.delete(message.id);message.error?item.reject(message.error):item.resolve(message.result);}});
    const call=(method:string,params:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws!.send(JSON.stringify({id:n,method,params}));});
    const ev=async(expression:string)=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true});if(result.exceptionDetails)throw Error('Browser fixture evaluation failed');return result.result.value;};
    await call('Page.enable');await call('Page.navigate',{url:origin+'/login'});
    for(let i=0;i<100&&!await ev('document.readyState==="complete"&&!!document.querySelector("#password")');i++)await sleep(25);
    await ev('document.querySelector("#username").value='+JSON.stringify(adminEnv.IMPORTER_USERNAME)+';document.querySelector("#password").value='+JSON.stringify(adminEnv.IMPORTER_PASSWORD)+';document.querySelector("button[type=submit]").click()');
    for(let i=0;i<100&&!post;i++)await sleep(25);
    assert.ok(post,'Login POST must reach the server');
    assert.equal(post.origin,origin,'Native form must send its actual same-origin Origin');
    assert.equal(post.status,303,'Valid native login must redirect to protected UI');
  }finally{
    ws?.close();chrome.kill();await new Promise<void>(r=>server.close(()=>r()));await sleep(300);
    if(resolve(profile).startsWith(join(resolve(tmpdir()),'fankee-login-')))try{rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
  }
});
