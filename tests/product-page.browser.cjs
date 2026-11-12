const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Product page browser coverage',{timeout:90000},async t=>{
const productHTML=function productHTML(id='11'){
const alternate=id==='22',min=alternate?2:1,step=alternate?2:1;
return `<section class="product-page section-padding" data-product-page data-section-id="product-main" data-product-id="100" data-product-url="/products/fixture" data-variant-error="Variant error" data-variant-updated="Variant updated"><div class="container"><p class="sr-only" data-product-status role="status"></p><div class="product-page__layout"><div class="product-page__gallery" data-product-gallery><div class="product-page__stage">${['a','b'].map(image=>`<div class="product-page__image" data-product-image="${image}" ${image===(alternate?'b':'a')?'':'hidden'}><img width="80" height="120" alt="Product" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='120'%3E%3Crect x='10' y='10' width='60' height='100' fill='%23135541'/%3E%3C/svg%3E"></div>`).join('')}</div><div class="product-page__thumbnails">${['a','b'].map(image=>`<button type="button" data-product-image-target="${image}" aria-pressed="${image===(alternate?'b':'a')}">${image}</button>`).join('')}</div></div><div data-product-purchase class="product-page__purchase"><p class="product-page__vendor">Brand</p><h1>Product title</h1><div class="product-page__price"><div class="catalog-price">${alternate?'29.90':'15.90'}</div></div><p class="product-page__availability" data-available="true">Available</p><form data-card-cart class="catalog-product-form storefront-validated-form" action="/he/cart/add"><label>Size / Scent<select name="id" data-product-variant data-current-variant="${id}"><option value="11" ${!alternate?'selected':''}>Size: 1 / Scent: Baby</option><option value="22" ${alternate?'selected':''}>Size: 2 / Scent: Lavender</option><option value="33" disabled>Unavailable</option></select></label><div data-quantity-controls class="catalog-quantity"><button type="button" data-quantity-change="-1" disabled>-</button><input name="quantity" type="number" min="${min}" step="${step}" max="8" value="${min}"><button type="button" data-quantity-change="1">+</button></div><button name="add" class="theme-btn product-page__add" data-pending-label="Adding">Add</button><p data-card-feedback data-error="Add error" data-success="Added" data-refresh-error="Stale"></p></form><a data-product-whatsapp data-message="Question: Product title" hidden>WhatsApp</a></div><div class="product-page__accordions"><details open><summary>Description</summary><div>Real product content</div></details></div></div></div></section>`;
};
const css=fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
const html='<html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>'+['theme.css','storefront.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('')+css+'</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn">Menu</button><nav class="navigation-holder"><button class="menu-close">Close</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-labelledby="cart-title" data-cart-added="Added"><button class="mini-cart-close">Close</button><p data-cart-status></p><div class="mini-cart-items"><h2 id="cart-title">Cart</h2></div></dialog></div></header><main>'+productHTML()+'</main><footer><a data-store-whatsapp href="https://wa.me/123456789">Chat</a></footer></body></html>';
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


  await ev('window.productHTML='+productHTML.toString());
  await ev(`window.Shopify={routes:{root:'/he/'}};window.calls=[];window.failure=false;window.slow=false;window.count=0;
  window.fetch=async(input,options={})=>{const url=new URL(String(input),location.origin);calls.push({url:url.href,body:options.body?JSON.parse(options.body):null});if(options.method==='POST'){count+=JSON.parse(options.body).items[0].quantity;return new Response(JSON.stringify({sections:{header:'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn" aria-label="Cart '+count+'"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items"><h2 id="cart-title">Cart</h2><p>Product '+count+'</p></div></div></header>'}}));}const variant=url.searchParams.get('variant');await new Promise(r=>setTimeout(r,slow&&variant==='22'?350:40));if(failure)throw Error('Offline');return new Response(productHTML(variant),{headers:{'Content-Type':'text/html'}});};
  window.page=document.querySelector('[data-product-page]');window.choose=id=>{const select=page.querySelector('[data-product-variant]');select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));};`);
  await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
  await ev(fs.readFileSync(path.join(root,'assets/product-page.js'),'utf8'));
  await t.test('Desktop RTL info is on right, gallery on left, and small images do not upscale',async()=>{
    const result=await ev('({info:page.querySelector("[data-product-purchase]").getBoundingClientRect().left,gallery:page.querySelector("[data-product-gallery]").getBoundingClientRect().left,imageWidth:page.querySelector("img").getBoundingClientRect().width})');
    assert.ok(result.info>result.gallery);assert.ok(result.imageWidth<=80);
  });
  await t.test('Keyboard thumbnail selection exposes active state and changes the main image',async()=>{
    await ev('page.querySelectorAll("[data-product-image-target]")[1].focus()');
    for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
    assert.equal(await ev('page.querySelector("[data-product-image]:not([hidden])").dataset.productImage'),'b');
    assert.equal(await ev('document.activeElement.getAttribute("aria-pressed")'),'true');
  });
  await t.test('WhatsApp uses existing configured URL and includes product title/URL; absent config hides action',async()=>{
    const url=new URL(await ev('page.querySelector("[data-product-whatsapp]").href'));
    assert.equal(url.hostname,'wa.me');assert.ok(url.searchParams.get('text').includes('Product title'));assert.ok(url.searchParams.get('text').includes('/products/fixture?variant=11'));
    await ev('document.querySelector("[data-store-whatsapp]").removeAttribute("href");document.dispatchEvent(new CustomEvent("shopify:section:load"))');
    assert.equal(await ev('page.querySelector("[data-product-whatsapp]").hidden'),true);
    await ev('document.querySelector("[data-store-whatsapp]").href="https://wa.me/123456789";document.dispatchEvent(new CustomEvent("shopify:section:load"))');
  });
  await t.test('Variant selection refreshes server price, quantity rules, gallery, and URL without navigation',async()=>{
    await ev('page.querySelector("[name=quantity]").value=5;choose("22")');await wait('!page.hasAttribute("aria-busy")');
    assert.equal(await ev('page.querySelector(".catalog-price").textContent'),'29.90');
    assert.equal(await ev('page.querySelector("[name=quantity]").value'),'6');
    assert.equal(await ev('page.querySelector("[name=quantity]").step'),'2');
    assert.equal(await ev('page.querySelector("[data-product-image]:not([hidden])").dataset.productImage'),'b');
    assert.equal(await ev('new URL(location.href).searchParams.get("variant")'),'22');
    assert.equal(await ev('document.activeElement.hasAttribute("data-product-variant")'),true);
    assert.equal(await ev('page.querySelector("option:disabled").disabled'),true);
  });
  await t.test('Failed variant requests restore the previous selection and purchase action',async()=>{
    await ev('failure=true;choose("11")');await wait('!page.hasAttribute("aria-busy")');
    assert.equal(await ev('page.querySelector("[name=id]").value'),'22');assert.equal(await ev('page.querySelector("[name=add]").disabled'),false);
    assert.equal(await ev('page.querySelector("[data-product-status]").textContent'),'Variant error');await ev('failure=false');
  });
  await t.test('Rapid variant requests ignore stale HTML and recover from consecutive failures',async()=>{
    await ev('slow=true;choose("22");choose("11")');await wait('!page.hasAttribute("aria-busy")');await sleep(400);
    assert.equal(await ev('page.querySelector("[name=id]").value'),'11');assert.equal(await ev('page.querySelector("[name=add]").disabled'),false);
    await ev('failure=true;choose("22");choose("11")');await wait('!page.hasAttribute("aria-busy")');assert.equal(await ev('page.querySelector("[name=add]").disabled'),false);await ev('failure=false;slow=false');
  });
  await t.test('Quantity buttons honor limits; selected variant/quantity add stays on page',async()=>{
    await ev('choose("22")');await wait('!page.hasAttribute("aria-busy")');
    await ev('window.qty=page.querySelector("[name=quantity]");qty.value=2;qty.dispatchEvent(new Event("change",{bubbles:true}))');
    assert.equal(await ev('page.querySelector("[data-quantity-change]").disabled'),true);
    await ev('page.querySelectorAll("[data-quantity-change]")[1].click()');assert.equal(await ev('qty.value'),'4');
    await ev('window.add=page.querySelector("[name=add]");add.focus();add.click()');await wait('!page.querySelector("form").hasAttribute("aria-busy")');
    assert.equal(await ev('document.querySelector("dialog").open'),false);assert.equal(await ev('count'),4);
    assert.equal(await ev('calls.at(-1).body.items[0].id'),'22');
    await ev('document.querySelector(".mini-cart-close").click()');
  });
  await t.test('Mobile gallery precedes purchase, no overflow, and details remain semantic',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
    const result=await ev('({gallery:page.querySelector("[data-product-gallery]").getBoundingClientRect().top,info:page.querySelector("[data-product-purchase]").getBoundingClientRect().top,overflow:document.documentElement.scrollWidth>innerWidth})');
    assert.ok(result.gallery<result.info);assert.equal(result.overflow,false);
    await ev('page.querySelector("summary").click()');assert.equal(await ev('page.querySelector("details").open'),false);
    if(process.env.PRODUCT_SCREENSHOT_PATH){const shot=await call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.PRODUCT_SCREENSHOT_PATH,Buffer.from(shot.data,'base64'));}
  });
  await t.test('Product-card regular/sale/sold-out states and long Hebrew titles fit small screens',async()=>{
    const cards=[{title:'מרכך כביסה בייבי',old:'',price:'39.90 ₪',badge:''},
      {title:'חומר ניקוי מרוכז בניחוח מלון בוטיק לבית עם תיאור עברי ארוך במיוחד שלא צריך להרחיב את הכרטיס',old:'79.90 ₪',price:'39.90 ₪',badge:'50% הנחה'},
      {title:'מוצר שאזל מהמלאי',old:'',price:'29.90 ₪',badge:'אזל מהמלאי',sold:true}];
    const html='<section class="catalog-home catalog-section container" id="CardFixtures"><div class="catalog-grid">'+cards.map((c,i)=>'<article class="catalog-card '+(c.sold?'catalog-card--sold-out':'')+'"><a class="catalog-card__image" href="#fixture"><img alt="אריזת מוצר" width="100" height="160" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22160%22%3E%3Crect x=%2220%22 y=%2210%22 width=%2260%22 height=%22140%22 fill=%22%23086b7b%22/%3E%3C/svg%3E"><div class="catalog-card__badges">'+(c.badge?'<span class="catalog-card__badge '+(c.sold?'catalog-card__badge--quiet':'catalog-card__badge--sale')+'">'+c.badge+'</span>':'')+'</div></a><div class="catalog-card__content"><h3><a href="#fixture">'+c.title+'</a></h3><div class="catalog-price"><bdi>'+c.price+'</bdi>'+(c.old?'<s><bdi>'+c.old+'</bdi></s>':'')+'</div><p class="catalog-availability">'+(c.sold?'אזל מהמלאי':'זמין במלאי')+'</p><button class="theme-btn" '+(c.sold?'disabled':'')+'>'+(c.sold?'אזל מהמלאי':'הוספה לסל')+'</button></div></article>').join('')+'</div></section>';
    await ev('document.querySelector("main").insertAdjacentHTML("beforeend",'+JSON.stringify(html)+')');
    for(const width of [320,360,375,390,1440]){
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
      const metrics=await ev(`[...document.querySelectorAll('#CardFixtures .catalog-card')].map(c=>{
        const image=c.querySelector('img'),badge=c.querySelector('.catalog-card__badge'),button=c.querySelector('button');
        return {buttonFit:button.scrollWidth<=button.clientWidth,tap:button.getBoundingClientRect().height,
         title:c.querySelector('h3').getBoundingClientRect().height,
         packagingClear:!badge||badge.getBoundingClientRect().bottom<=image.getBoundingClientRect().top,
         fit:getComputedStyle(image).objectFit,sold:button.disabled};
      })`);
      assert.ok(metrics.every(m=>m.buttonFit&&m.tap>=44&&m.packagingClear&&m.fit==='contain'),'card bounds at '+width);
      assert.ok(metrics.every(m=>m.title<=49));assert.equal(metrics[2].sold,true);
      assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
    }
    assert.equal(await ev('document.querySelectorAll("#CardFixtures .catalog-card:first-child s").length'),0);
    assert.equal(await ev('document.querySelectorAll("#CardFixtures .catalog-card:nth-child(2) s").length'),1);
    await ev('document.querySelector("#CardFixtures .catalog-card").scrollIntoView({block:"center"})');
    if(await ev('matchMedia("(hover:hover) and (pointer:fine)").matches')){
      const point=await ev('(()=>{const r=document.querySelector("#CardFixtures .catalog-card").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(260);
      assert.ok(await ev('new DOMMatrixReadOnly(getComputedStyle(document.querySelector("#CardFixtures .catalog-card")).transform).m42<=-2'));
    }
  });
  await t.test('Shared teal slide, disabled/loading states and product layout remain safe at all widths',async()=>{
    await ev('page.querySelector("h1").textContent="מרכך כביסה מרוכז בניחוח בייבי עם כותרת עברית ארוכה לבדיקת תצוגה";page.querySelector("button[name=add]").textContent="הוספה לסל"');
    for(const width of [320,360,375,390,768,1440,1600]){
      await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
      assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      assert.ok(await ev('(()=>{const b=page.querySelector("button[name=add]");return b.scrollWidth<=b.clientWidth&&b.getBoundingClientRect().height>=44})()'));
      assert.equal(await ev('getComputedStyle(page.querySelector("button[name=add]")).color'),'rgb(255, 255, 255)');
    }
    await ev('page.querySelector("button[name=add]").scrollIntoView({block:"center"})');
    const button='page.querySelector("button[name=add]")';
    await ev(button+'.focus()');
    assert.equal(await ev('getComputedStyle('+button+').outlineStyle'),'solid');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});await sleep(280);
    if(await ev('matchMedia("(hover:hover) and (pointer:fine)").matches')){
      assert.ok(await ev('new DOMMatrixReadOnly(getComputedStyle('+button+',"::before").transform).m41>0'));
      const point=await ev('(()=>{const r='+button+'.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
      await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await sleep(280);
      assert.ok(await ev('Math.abs(new DOMMatrixReadOnly(getComputedStyle('+button+',"::before").transform).m41)<1'));
    }
    await ev(button+'.disabled=true');await sleep(240);
    assert.equal(await ev('getComputedStyle('+button+').backgroundColor'),'rgb(237, 241, 242)');
    await ev(button+'.setAttribute("aria-busy","true")');await sleep(240);
    assert.equal(await ev('getComputedStyle('+button+').backgroundColor'),'rgb(11, 101, 113)');
    await ev(button+'.disabled=false;'+button+'.removeAttribute("aria-busy")');
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.equal(await ev('getComputedStyle('+button+',"::before").display'),'none');
    await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
