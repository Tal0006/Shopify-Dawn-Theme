const {test} = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.ACCESSIBILITY_PREVIEW_URL || 'http://127.0.0.1:9292';
const debug = process.env.ACCESSIBILITY_DEBUG_URL || 'http://127.0.0.1:9333';
// Requires Shopify theme dev and isolated Chrome with CDP enabled.
test('RTL mega menu desktop and mobile behavior', {timeout:120000}, async t=>{
  const tab=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
  const ws=new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0; const pending=new Map(); const errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const visit=async()=>{await call('Page.navigate',{url:base+'/'});await sleep(1000);for(let i=0;i<50;i++){if(await ev('document.readyState==="complete"&&!!document.querySelector("[data-mega-trigger]")'))return;await sleep(150)}throw Error('Menu preview did not load')};
  const viewport=width=>call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
  const key=async(value,code,num)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:value,code,windowsVirtualKeyCode:num,...(type==='keyDown'&&value==='Enter'?{text:'\r'}:{})})};
  const open=()=>ev('document.querySelector("[data-mega-trigger]").click()');
  try{
    await call('Page.enable');await call('Runtime.enable');
    await viewport(1280);await visit();
    await t.test('Wide RTL panel uses responsive columns and stays within the viewport',async()=>{
      for(const width of [1440,1280,1024]){
        await viewport(width);await visit();await open();
        const result=await ev(`(()=>{const p=document.querySelector('[data-mega-panel]'),r=p.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,columns:getComputedStyle(p.querySelector('.nav-mega-groups')).columnCount,groups:p.querySelectorAll('.nav-mega-group').length,links:p.querySelectorAll('a').length,dir:getComputedStyle(p).direction,hidden:p.hidden,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
        assert.equal(result.hidden,false);assert.equal(result.dir,'rtl');assert.ok(result.w>=600&&result.w<=900);assert.ok(result.x>=15&&result.x+result.w<=width-15);assert.ok(result.y+result.h<=901);assert.equal(result.columns,width>=1200?'3':'2');assert.ok(result.groups>0);assert.equal(result.overflow,false);
      }
    });
    await t.test('Enter/Space opens, ArrowDown enters links, Escape returns focus, outside click closes',async()=>{
      await viewport(1280);await visit();await ev('document.querySelector("[data-mega-trigger]").focus()');await key('Enter','Enter',13);
      assert.equal(await ev('document.querySelector("[data-mega-trigger]").getAttribute("aria-expanded")'),'true');
      await key('ArrowDown','ArrowDown',40);assert.equal(await ev('document.activeElement.tagName'),'A');
      await key('Escape','Escape',27);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),true);assert.ok(await ev('document.activeElement.hasAttribute("data-mega-trigger")'));
      await key(' ','Space',32);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),false);
      await ev('document.querySelector("main").click()');assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),true);
    });
    await t.test('Delayed hover opens, moving into the panel keeps it open, leaving closes',async()=>{
      await visit();await ev('document.querySelector("main").focus({preventScroll:true});window.scrollTo(0,0)');
      const r=await ev('(()=>{const r=document.querySelector("[data-mega-trigger]").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:200});await call('Input.dispatchMouseEvent',{type:'mouseMoved',...r});await sleep(75);
      assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),true);await sleep(150);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),false);
      const p=await ev('(()=>{const r=document.querySelector("[data-mega-panel]").getBoundingClientRect();return{x:r.x+40,y:r.y+40}})()');await call('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await sleep(250);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),false);
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:2,y:600});await sleep(300);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),true);
    });
    await t.test('Link selection preserves Shopify destinations and indicates current links',async()=>{
      await visit();await open();const path=await ev('document.querySelector(".nav-mega-children a").getAttribute("href")');await ev('document.querySelector(".nav-mega-children a").click()');await sleep(1200);for(let n=0;n<30;n++){if(await ev('document.readyState==="complete"&&!!document.querySelector("[data-mega-panel] a[aria-current=page]")'))break;await sleep(150)}
      assert.equal(await ev('decodeURI(location.pathname)'),decodeURI(new URL(path,base).pathname));assert.ok(await ev('document.querySelector("[data-mega-panel] a[aria-current=page]") !== null'));
    });
    await t.test('Mobile drawer has one column, nested accordions, no horizontal overflow, and separate Escape levels',async()=>{
      for(const width of [390,320]){
        await viewport(width);await visit();await ev('document.querySelector(".open-btn").click()');await sleep(400);await open();
        assert.equal(await ev('getComputedStyle(document.querySelector(".nav-mega-groups")).columnCount'),'1');assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),false);assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
        const nested=await ev('document.querySelectorAll("[data-group-trigger]").length');
        if(nested){assert.equal(await ev('document.getElementById(document.querySelector("[data-group-trigger]").getAttribute("aria-controls")).hidden'),true);await ev('document.querySelector("[data-group-trigger]").click()');assert.equal(await ev('document.querySelector("[data-group-trigger]").getAttribute("aria-expanded")'),'true');}
        await ev('document.querySelector("[data-mega-trigger]").focus()');await key('Escape','Escape',27);assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),true);assert.equal(await ev('document.querySelector("#navbar").inert'),false);
        await key('Escape','Escape',27);assert.equal(await ev('document.querySelector("#navbar").inert'),true);
      }
    });
    await t.test('Theme Editor reload initializes new menu controls',async()=>{
      await viewport(1280);await visit();await ev('(()=>{const section=document.querySelector(".storefront-header").parentElement;section.innerHTML=section.innerHTML;section.dispatchEvent(new CustomEvent("shopify:section:load",{bubbles:true}));})()');await open();assert.equal(await ev('document.querySelector("[data-mega-panel]").hidden'),false);assert.equal(await ev('document.querySelector("[data-mega-trigger]").getAttribute("aria-expanded")'),'true');
    });
    assert.deepEqual(errors,[]);
  }finally{ws.close();await fetch(debug+'/json/close/'+tab.id).catch(()=>{})}
});