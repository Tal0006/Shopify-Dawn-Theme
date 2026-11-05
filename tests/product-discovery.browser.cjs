const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Product discovery browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>'+['bootstrap.min.css','style.css','storefront.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('')+css+'</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="cart-title" data-cart-added="Added"><button class="mini-cart-close">Close</button><p data-cart-status></p><div class="mini-cart-items"><h2 id="cart-title">Cart</h2></div></dialog></div></header><main></main><footer><a data-store-whatsapp href="https://wa.me/123456789">Chat</a></footer></body></html>';
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



  const historySource=fs.readFileSync(path.join(root,'assets/recently-viewed.js'),'utf8');
  const sectionHTML=handle=>`<section class="product-discovery container" data-storefront-discovery data-recently-viewed data-current-handle="${handle}" data-search-url="/he/search" data-section-id="recent" hidden><h2>Recently viewed</h2><div class="product-discovery__grid" tabindex="0" role="region" aria-label="Recently viewed"></div></section>`;
  await ev('window.sectionHTML='+sectionHTML.toString());
  await ev(`
    localStorage.clear();window.historyRequests=[];window.historyFail=false;
    window.fetch=async input=>{
      const url=new URL(input,location.origin);historyRequests.push(url.href);
      if(historyFail)throw Error('Offline');
      return new Response('<section data-recently-viewed><div class="product-discovery__grid">'+url.searchParams.get('q').split('|').filter(h=>h!=='deleted').map(h=>'<div data-history-handle="'+h+'"><article class="catalog-card"><a class="catalog-card__image" href="/products/'+h+'">Image</a><div class="catalog-card__content"><h3>'+h+'</h3><p>39.90</p><button type="button" class="theme-btn">Add</button></div></article></div>').join('')+'</div></section>');
    };
    document.querySelector('main').innerHTML=sectionHTML('first');
  `);
  await ev(historySource);
  await t.test('First visit stores only a handle and has no empty shell or fetch',async()=>{
    assert.deepEqual(await ev('JSON.parse(localStorage.getItem("fankee:recently-viewed:v1"))'),['first']);
    await ev(historySource);
    assert.equal(await ev('historyRequests.length'),0);
    assert.equal(await ev('document.querySelector("[data-recently-viewed]").hidden'),true);
  });
  const visit=async handle=>{
    await ev('document.querySelector("main").innerHTML=sectionHTML('+JSON.stringify(handle)+');document.dispatchEvent(new CustomEvent("shopify:section:load",{detail:{},bubbles:true}))');
    // Theme Editor events target the rendered wrapper.
    await ev('document.querySelector("main").dispatchEvent(new CustomEvent("shopify:section:load",{bubbles:true}))');
    await sleep(100);
  };
  await t.test('Second visit batches fresh cards, excludes current and deduplicates revisits',async()=>{
    await visit('second');
    assert.deepEqual(await ev('[...document.querySelectorAll("[data-history-handle]")].map(n=>n.dataset.historyHandle)'),['first']);
    await visit('first');
    assert.deepEqual(await ev('JSON.parse(localStorage.getItem("fankee:recently-viewed:v1"))'),['first','second']);
    assert.deepEqual(await ev('[...document.querySelectorAll("[data-history-handle]")].map(n=>n.dataset.historyHandle)'),['second']);
    assert.equal(await ev('new URL(historyRequests[0]).pathname'),'/he/search');
  });
  await t.test('Ten handle cap, corrupt storage, deleted products and failures are safe',async()=>{
    await ev('localStorage.setItem("fankee:recently-viewed:v1",JSON.stringify(["deleted",...Array.from({length:14},(_,i)=>"item-"+i),"item-0"]))');
    await visit('third');
    assert.equal(await ev('JSON.parse(localStorage.getItem("fankee:recently-viewed:v1")).length'),10);
    assert.equal(await ev('document.querySelectorAll("[data-history-handle]").length'),9);
    await ev('localStorage.setItem("fankee:recently-viewed:v1","broken")');
    await visit('fourth');assert.equal(await ev('document.querySelector("[data-recently-viewed]").hidden'),true);
    await ev('historyFail=true');await visit('fifth');
    assert.equal(await ev('document.querySelector("[data-recently-viewed]").hidden'),true);
    await ev('historyFail=false;localStorage.setItem("fankee:recently-viewed:v1",JSON.stringify(["one","two","three","four"]))');
    await visit('sixth');
  });
  await t.test('RTL native scrolling and four-column desktop fit all requested widths',async()=>{
    for(const width of [320,360,375,390,768,1024,1440,1600]){
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<768});
      const m=await ev(`(()=>{const g=document.querySelector('.product-discovery__grid'),s=getComputedStyle(g);return {overflow:document.documentElement.scrollWidth>innerWidth,direction:s.direction,snap:s.scrollSnapType,scroll:g.scrollWidth>g.clientWidth,iw:innerWidth,w:g.clientWidth,sw:g.scrollWidth,auto:s.gridAutoColumns,flow:s.gridAutoFlow,hidden:g.closest('.product-discovery').hidden,children:g.children.length,cols:s.gridTemplateColumns.split(' ').length};})()`);
      assert.equal(m.overflow,false,'page overflow '+width);assert.equal(m.direction,'rtl');
      if(width<992){assert.equal(m.scroll,true,JSON.stringify({width,...m}));assert.ok(m.snap.startsWith('inline'));}
      else assert.equal(m.cols,4);
    }

    await call('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await ev('document.querySelector(".product-discovery__grid").scrollLeft=-100');
    assert.ok(await ev('document.querySelector(".product-discovery__grid").scrollLeft<0'));
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await ev('getComputedStyle(document.querySelector(".catalog-card")).animationName'),'none');
  });
  await t.test('Native recommendations load shared card HTML and keep empty responses hidden',async()=>{
    await ev(`
      document.querySelector('main').insertAdjacentHTML('beforeend','<section data-product-recommendations data-url="/recommendations/products?product_id=1" hidden></section>');
      window.fetch=async()=>new Response('<section data-product-recommendations><div class="product-discovery__grid"><article class="catalog-card catalog-card--sold-out"><button disabled>Sold out</button></article><article class="catalog-card"><s>79.90</s><strong>39.90</strong><form data-card-cart><input name="id" value="123"><button name="add" data-pending-label="Adding">Add</button><p data-card-feedback data-success="Added" data-error="Error" data-refresh-error="Added"></p></form></article></div></section>');
    `);
    await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
    await wait('!document.querySelector("[data-product-recommendations]").hidden');
    assert.equal(await ev('document.querySelectorAll("[data-product-recommendations] .catalog-card").length'),2);
    assert.equal(await ev('document.querySelector("[data-product-recommendations] button").disabled'),true);
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:900,deviceScaleFactor:1,mobile:true});
    await ev(`
      window.Shopify={routes:{root:'/he/'}};window.addCalls=0;
      window.fetch=async(input,options={})=>{
        if(String(input).endsWith('/cart/add.js')){addCalls++;return new Response(JSON.stringify({items:[{id:123}],sections:{header:'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">1</span></button><div class="mini-cart-items">One item</div></div></header>'}}));}
        return new Response(JSON.stringify({item_count:1}));
      };
      document.querySelector('[data-product-recommendations] form').requestSubmit(document.querySelector('[data-product-recommendations] button[name=add]'));
    `);
    await wait('document.querySelector("[data-product-recommendations] form").getAttribute("aria-busy")!=="true"');
    assert.equal(await ev('addCalls'),1);
    assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');
    assert.equal(await ev('document.querySelector("dialog").open'),false);

    await ev(`
      window.fetch=async()=>new Response('<section data-product-recommendations hidden></section>');
      document.querySelector('main').insertAdjacentHTML('beforeend','<div id="empty-rec"><section data-product-recommendations data-url="/recommendations/products?product_id=2" hidden></section></div>');
      document.querySelector('#empty-rec').dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));
    `);
    await sleep(80);
    assert.equal(await ev('document.querySelector("#empty-rec section").hidden'),true);
  });

 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
