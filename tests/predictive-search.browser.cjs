const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Header predictive search browser coverage',{timeout:90000},async t=>{
 const source=fs.readFileSync(path.join(root,'snippets/predictive-search.liquid'),'utf8');
 const translations=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,''));
 const escaped=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const css=fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/predictive-search-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 // The submit icon comes from snippets/theme-icon.liquid: expand it the same way (markup and its stylesheet).
 const iconSource=fs.readFileSync(path.join(root,'snippets/theme-icon.liquid'),'utf8');
 const iconCss=iconSource.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const icon=name=>`<i class="theme-icon" aria-hidden="true"><svg viewBox="0 0 512 512" width="1em" height="1em" fill="currentColor" focusable="false"><path d="${iconSource.match(new RegExp(`when '${name}'\\s+assign icon_path = '([^']+)'`))[1]}"/></svg></i>`;
 const markup=source.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'')
  .replace(/{% render 'predictive-search-styles' %}/g,'')
  .replace(/{% render 'theme-icon', icon: '([\w-]+)' %}/g,(_m,name)=>icon(name))
  .replace(/{{ routes.search_url }}/g,'/he/search').replace(/{{ routes.predictive_search_url }}/g,'/he/search/suggest')
  .replace(/{{ search_id }}/g,'HeaderSearch-fixture').replace(/{{ search.terms \| escape }}/g,'')
  .replace(/{{ '([^']+)' \| t[^}]*}}/g,(_m,key)=>escaped(key.split('.').reduce((o,k)=>o[k],translations).replace('{{ count }}','__COUNT__')));
 const html='<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><script id="shopify-features" type="application/json">{"predictiveSearch":false}</script><style>'+
 fs.readFileSync(path.join(root,'assets/storefront.css'),'utf8')+css+iconCss+'</style></head><body><header class="storefront-header"><div class="container-fluid"><div class="row"><a class="navbar-brand" href="#">פאנקי</a><div class="mobail-menu"><button>תפריט</button></div><nav id="navbar" class="navigation-holder"></nav><div class="storefront-header-tools">'+markup+
 '<div class="mini-cart"><button class="cart-toggle-btn" id="outside">סל</button></div></div></div></div></header><main><h1>מוצרים לבית</h1></main></body></html>';
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-predictive-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws,call,ev,tab;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const debug='http://'+new URL(browserWS).host;
  tab=await(await fetch(debug+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<120;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  await call('Page.enable');await call('Page.bringToFront');await call('Emulation.setFocusEmulationEnabled',{enabled:true});await call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});
  await wait('document.readyState==="complete"');
  await ev(`window.widget=document.querySelector('fankee-predictive-search');window.input=widget.querySelector('input[name=q]');window.calls=[];window.mode='products';window.delay=0;window.activations=[];window.submitted=false;
  window.fragment=q=>'<div data-predictive-fragment>'+(q==='empty'?'<p class="predictive-search__empty">לא מצאנו מוצרים עבור החיפוש הזה<small>נסו לחפש בשם מוצר, מותג או קטגוריה</small></p><ul role="listbox"></ul>':'<ul role="listbox" class="predictive-search__list">'+[0,1].map(i=>'<li role="presentation"><a role="option" href="/products/'+i+'" class="predictive-search__option"><span class="predictive-search__image">□</span><div><span class="predictive-search__title">'+q.replace(/[<>&]/g,'')+' מוצר '+i+'</span><div class="catalog-price"><bdi>15.90 ₪</bdi><s>20.00 ₪</s></div><span class="predictive-search__meta">'+(i?'אזל מהמלאי':'במלאי')+'</span></div></a></li>').join('')+'</ul>')+'</div>';
  window.fetch=async(url,options={})=>{const u=new URL(url);calls.push({url:String(url),signal:options.signal});if(mode==='offline')throw Error('Offline');if(mode==='417'&&u.pathname.endsWith('/suggest'))return new Response('',{status:417});const q=u.searchParams.get('q');await new Promise(r=>setTimeout(r,q==='older'?800:delay));return new Response(fragment(q),{status:200});};
  widget.addEventListener('click',e=>{const a=e.target.closest('a[role=option]');if(a){e.preventDefault();activations.push(a.getAttribute('href'));}});
  widget.querySelector('form').addEventListener('submit',e=>{submitted=!e.defaultPrevented;e.preventDefault();});
  window.typeQuery=q=>{input.focus();input.value=q;input.dispatchEvent(new Event('input',{bubbles:true}));};
  window.key=k=>input.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));`);
  await ev(fs.readFileSync(path.join(root,'assets/predictive-search.js'),'utf8'));
  await t.test('Two characters, debounce and Hebrew locale normal-search fallback',async()=>{
   await ev('typeQuery("ס")');await sleep(360);assert.equal(await ev('calls.length'),0);
   await ev('typeQuery("סנ");typeQuery("סנו");window.debouncePending=widget.timer!==null;window.inputCalls=calls.length');assert.equal(await ev('debouncePending'),true);assert.equal(await ev('inputCalls'),0);
   await wait('widget.querySelectorAll("[role=option]").length===2&&widget.querySelector("[data-search-loading]").hidden');
   const url=new URL(await ev('calls[0].url'));assert.equal(url.pathname,'/he/search');assert.equal(url.searchParams.get('q'),'סנו');assert.equal(url.searchParams.get('section_id'),'predictive-search');assert.equal(url.searchParams.get('type'),'product');
   assert.equal(await ev('input.getAttribute("aria-expanded")'),'true');assert.ok(await ev('widget.textContent.includes("15.90 ₪")'));
  });
  await t.test('Keyboard arrows, selected Enter, Escape and native unselected submit',async()=>{
   await ev('key("ArrowDown")');assert.equal(await ev('document.getElementById(input.getAttribute("aria-activedescendant")).getAttribute("aria-selected")'),'true');
   await ev('key("ArrowUp");key("Enter")');assert.deepEqual(await ev('activations'),['/products/1']);
   await ev('key("Escape")');await sleep(360);assert.equal(await ev('input.getAttribute("aria-expanded")'),'false');
   await ev('input.blur();input.focus()');await sleep(400);await wait('input.getAttribute("aria-expanded")==="true"&&widget.querySelector("[data-search-loading]").hidden');
   await ev('widget.querySelector("form").requestSubmit()');assert.equal(await ev('submitted'),true);
  });
  await t.test('Native supported route and 417 switch to normal Shopify results',async()=>{
   await ev('widget.nativeSupported=true;mode="products";typeQuery("native")');await wait('calls.some(c=>new URL(c.url).searchParams.get("q")==="native")');await wait('widget.querySelector("[data-search-loading]").hidden');
   const u=new URL(await ev('calls.at(-1).url'));assert.equal(u.pathname,'/he/search/suggest');assert.equal(u.searchParams.get('resources[limit]'),'6');assert.equal(u.searchParams.get('resources[type]'),'product');
   await ev('mode="417";typeQuery("fallback")');await wait('calls.filter(c=>new URL(c.url).searchParams.get("q")==="fallback").length===2');await wait('widget.querySelector("[data-search-results]").textContent.includes("fallback")');assert.equal(await ev('widget.nativeSupported'),false);
  });
  await t.test('Stale responses are ignored even when aborted fetch mock resolves',async()=>{
   await ev('mode="products";typeQuery("older")');await wait('calls.some(c=>new URL(c.url).searchParams.get("q")==="older")');
   await ev('typeQuery("newer")');await wait('widget.querySelector("[data-search-results]").textContent.includes("newer")');await sleep(650);
   assert.ok(await ev('widget.querySelector("[data-search-results]").textContent.includes("newer")'));
   assert.equal(await ev('calls.find(c=>new URL(c.url).searchParams.get("q")==="older").signal.aborted'),true);
  });
  await t.test('No results, loading, error and all-results URL remain usable',async()=>{
   await ev('delay=250;typeQuery("empty")');await wait('!widget.querySelector("[data-search-loading]").hidden');assert.equal(await ev('widget.querySelector("[data-search-results]").getAttribute("aria-busy")'),'true');
   await wait('widget.querySelector("[data-search-results]").textContent.includes("לא מצאנו מוצרים עבור החיפוש הזה")');
   const u=new URL(await ev('widget.querySelector("[data-search-all]").href'));assert.equal(u.pathname,'/he/search');assert.equal(u.searchParams.get('q'),'empty');
   await ev('delay=0;mode="offline";typeQuery("failed")');await wait('widget.querySelector("[data-search-results]").textContent.includes("לא ניתן לטעון")');assert.equal(await ev('input.disabled'),false);
  });
  await t.test('Mobile RTL viewport has no horizontal overflow; Tab and outside focus close predictably',async()=>{
   await call('Emulation.setDeviceMetricsOverride',{width:375,height:700,deviceScaleFactor:1,mobile:false});
   await ev('mode="products";typeQuery("מוצר")');await wait('widget.querySelector("[data-search-results]").textContent.includes("מוצר")');
   const bounds=await ev('(()=>{const r=widget.querySelector("[data-search-panel]").getBoundingClientRect();return {x:r.x,right:r.right,width:innerWidth,doc:document.documentElement.scrollWidth,dir:getComputedStyle(widget).direction};})()');
   assert.ok(bounds.x>=0&&bounds.right<=bounds.width+1);assert.ok(bounds.doc<=bounds.width+1);assert.equal(bounds.dir,'rtl');
   await ev('input.focus()');await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
   assert.equal(await ev('document.activeElement.tagName'),'BUTTON');
   await ev('widget.querySelector("[role=option]").focus()');await ev('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await sleep(350);assert.equal(await ev('document.activeElement===input'),true);assert.equal(await ev('input.getAttribute("aria-expanded")'),'false');
   await ev('typeQuery("mobile")');await wait('widget.querySelector("[data-search-results]").textContent.includes("mobile")');
   if(process.env.PREDICTIVE_SCREENSHOT_PATH){const image=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.PREDICTIVE_SCREENSHOT_PATH,Buffer.from(image.data,'base64'));}
   await ev('document.getElementById("outside").focus()');await wait('input.getAttribute("aria-expanded")==="false"');
  });

  await t.test('Clear button is accessible, cancels pending search, and restores input focus',async()=>{
   await ev('typeQuery("clear-me")');
   assert.equal(await ev('widget.querySelector("[data-search-clear]").hidden'),false);
   assert.ok(await ev('widget.querySelector("[data-search-clear]").getAttribute("aria-label").length>0'));
   await ev('widget.querySelector("[data-search-clear]").click()');
   assert.equal(await ev('input.value'),'');
   assert.equal(await ev('document.activeElement===input'),true);
   assert.equal(await ev('widget.querySelector("[data-search-clear]").hidden'),true);
   assert.equal(await ev('input.getAttribute("aria-expanded")'),'false');
   await sleep(220);
   assert.equal(await ev('calls.some(c=>new URL(c.url).searchParams.get("q")==="clear-me")'),false);
  });
  await t.test('Product and supplied collection groups share one keyboard listbox',async()=>{
   await ev(`
    window.originalFragment=fragment;
    window.fragment=q=>{
     const doc=new DOMParser().parseFromString(originalFragment(q),'text/html');
     const list=doc.querySelector('[role=listbox]');
     const options=[...doc.querySelectorAll('[role=option]')];
     if(options.length){
      options[0].querySelector('div').insertAdjacentHTML('beforeend','<div class="catalog-card__badges"><span class="catalog-card__badge catalog-card__badge--sale">20% discount</span></div>');
      options[1].classList.add('predictive-search__option--unavailable');
      options[1].querySelector('.predictive-search__title').textContent='Long Hebrew product title '.repeat(10);
     }
     if(q==='groups'){
      list.setAttribute('role','group');list.setAttribute('aria-label','Products');
      const box=doc.createElement('div');box.setAttribute('role','listbox');
      list.before(box);box.append(list);
      box.insertAdjacentHTML('beforeend','<h3 class="predictive-search__heading">Categories</h3><ul role="group" aria-label="Categories"><li role="presentation"><a role="option" class="predictive-search__option predictive-search__option--collection" href="/collections/cleaning">Cleaning</a></li></ul>');
     }
     return doc.body.innerHTML;
    };
    mode='products';typeQuery('groups');
   `);
   await wait('!widget.panel.hidden&&!widget.results.hasAttribute("aria-busy")&&widget.querySelectorAll("[role=option]").length===3');
   assert.equal(await ev('widget.querySelectorAll("[role=listbox]").length'),1);
   assert.equal(await ev('widget.querySelectorAll("[role=group]").length'),2);
   await ev('key("ArrowDown");key("ArrowDown");key("ArrowDown");key("Enter")');
   assert.equal(await ev('activations.at(-1)'),'/collections/cleaning');
   assert.equal(await ev('document.getElementById(input.getAttribute("aria-activedescendant")).getAttribute("aria-selected")'),'true');
  });
  await t.test('Premium result rows stay contained at seven widths and respect reduced motion',async()=>{
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    await ev('typeQuery("groups")');await wait('!widget.panel.hidden&&!widget.results.hasAttribute("aria-busy")&&widget.querySelectorAll("[role=option]").length===3');
    const m=await ev(`(()=>{
     const panel=widget.querySelector('[data-search-panel]'),r=panel.getBoundingClientRect();
     const images=[...widget.querySelectorAll('.predictive-search__image')];
     return {page:document.documentElement.scrollWidth,viewport:innerWidth,left:r.left,right:r.right,overflow:panel.scrollWidth>panel.clientWidth,dir:getComputedStyle(panel).direction,heights:[...widget.querySelectorAll('[role=option], [data-search-clear]')].map(n=>n.getBoundingClientRect().height),targets:[...widget.querySelectorAll('[role=option], [data-search-clear]')].every(n=>n.getBoundingClientRect().height>=44),thumbs:images.every(n=>Math.abs(n.getBoundingClientRect().width-54)<0.5)};
    })()`);
    assert.ok(m.page<=m.viewport+1,JSON.stringify({width,...m}));
    assert.ok(m.left>=0&&m.right<=m.viewport+1,JSON.stringify({width,...m}));
    assert.equal(m.overflow,false);assert.equal(m.dir,'rtl');assert.equal(m.targets,true,JSON.stringify({width,...m}));assert.equal(m.thumbs,true,JSON.stringify({width,...m}));
    await ev('key("Escape")');assert.equal(await ev('input.getAttribute("aria-expanded")'),'false');
   }
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await ev('typeQuery("groups")');await wait('!widget.panel.hidden&&!widget.results.hasAttribute("aria-busy")&&widget.querySelectorAll("[role=option]").length===3');
   assert.equal(await ev('getComputedStyle(widget.querySelector("[data-search-panel]")).animationName'),'none');
   assert.equal(await ev('getComputedStyle(widget.querySelector(".predictive-search__spinner")).animationName'),'none');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  });
  await t.test('Theme Editor disconnect aborts requests and reconnect adds one listener set',async()=>{
   await ev('typeQuery("disconnect")');await wait('calls.some(c=>new URL(c.url).searchParams.get("q")==="disconnect")');
   await ev('const parent=widget.parentNode;widget.remove();parent.prepend(widget);calls=[];typeQuery("reconnect")');await wait('calls.length===1');await sleep(350);assert.equal(await ev('calls.length'),1);
   await ev('typeQuery("")');await sleep(350);assert.equal(await ev('input.getAttribute("aria-expanded")'),'false');
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
