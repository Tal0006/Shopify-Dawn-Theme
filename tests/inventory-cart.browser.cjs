const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Inventory and post-add browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
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






  const tr=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8')).storefront;
  const esc=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const meta=(id,stock,finite=true)=>'<span class="inventory-limit" data-inventory-variant="'+id+'" data-inventory-finite="'+finite+'" data-inventory-stock="'+stock+'" data-inventory-cart="0" data-inventory-one="'+esc(tr.inventory_one)+'" data-inventory-many="'+esc(tr.inventory_many.replace('{{ count }}','__COUNT__'))+'" data-inventory-full="'+esc(tr.inventory_full)+'" data-inventory-changed="'+esc(tr.inventory_changed)+'" role="status" aria-live="polite"></span>';
  const form=(id,stock,finite=true)=>'<form data-card-cart action="/he/cart/add"><input name="id" value="'+id+'" type="hidden"><div data-quantity-controls><button type="button" data-quantity-change="-1">-</button><input name="quantity" type="number" min="1" step="1" value="1"><button type="button" data-quantity-change="1">+</button></div>'+meta(id,stock,finite)+'<button name="add" class="theme-btn" data-pending-label="Adding">Add</button><p data-card-feedback data-success="Added" data-error="Failed" data-refresh-error="Stale" role="status"></p></form>';
  const bundle='<section data-bundle data-product-id="100" data-currency="ILS" data-locale="he"><form data-card-cart data-bundle-cart action="/he/cart/add"><input name="id" value="11" type="hidden"><div class="bundle-section__items">'+[11,22].map(id=>'<article '+(id===11?'data-bundle-main':'')+'><input name="bundle_variant" type="checkbox" value="'+id+'" data-price="100" '+(id===11?'data-bundle-main-choice':'')+' checked>'+meta(id,id===11?1:0,id===11)+'</article>').join('')+'</div><bdi data-bundle-total></bdi><button name="add" data-pending-label="Adding" disabled>Add bundle</button><p data-card-feedback data-success="Added" data-error="Failed" data-refresh-error="Stale"></p></form></section>';
  await ev('document.querySelector("main").innerHTML='+JSON.stringify('<section data-product-page data-product-id="100"><div data-product-purchase>'+form(11,1)+'</div></section>'+form(11,1)+form(22,0,false)+bundle)+';document.body.insertAdjacentHTML("beforeend",'+JSON.stringify('<div data-cart-toast hidden data-success="'+esc(tr.cart_toast_success)+'"><p data-cart-toast-message role="status" aria-live="polite"></p></div>')+')');
  await ev("\nwindow.items=[];window.calls=[];window.rejectNext=false;window.snapshot='';\nwindow.fetch=async(input,options={})=>{\n const url=new URL(input,location.origin);\n if(url.pathname.endsWith('/cart.js'))return new Response(JSON.stringify({items,item_count:items.reduce((n,line)=>n+line.quantity,0)}));\n if(options.method==='POST'){\n  const body=JSON.parse(options.body);calls.push(body);\n  if(rejectNext){rejectNext=false;return new Response(JSON.stringify({description:window.rejectionDescription||'Only limited stock is available'}),{status:422});}\n  for(const line of body.items){const old=items.find(item=>String(item.variant_id)===line.id);if(old)old.quantity+=line.quantity;else items.push({variant_id:line.id,quantity:line.quantity});}\n  const count=items.reduce((n,line)=>n+line.quantity,0);\n  return new Response(JSON.stringify({items:body.items,sections:{header:'<header class=\"storefront-header\"><div class=\"mini-cart\"><button class=\"cart-toggle-btn\" aria-label=\"Cart\"><span class=\"cart-count\">'+count+'</span></button><div class=\"mini-cart-items\">Items</div></div></header>'}}));\n }\n return new Response(snapshot,{headers:{'Content-Type':'text/html'}});\n};\nwindow.pageForm=document.querySelector('main form');window.cardForm=document.querySelectorAll('main form')[1];window.freeForm=document.querySelectorAll('main form')[2];window.bundleForm=document.querySelector('[data-bundle-cart]');\nwindow.reset=(stock,cart=0)=>{items=cart?[{variant_id:'11',quantity:cart}]:[];document.querySelectorAll('[data-inventory-variant=\"11\"]').forEach(node=>node.dataset.inventoryStock=stock);document.dispatchEvent(new CustomEvent('shopify:section:load',{bubbles:true}));window.dispatchEvent(new Event('focus'));};\n");
  await ev(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));
  await ev(fs.readFileSync(path.join(root,'assets/product-page.js'),'utf8'));
  await ev(fs.readFileSync(path.join(root,'assets/frequently-bought-together.js'),'utf8'));
  await t.test('Inventory one disables increase and rejects quantity two before POST',async()=>{
   assert.equal(await ev('pageForm.querySelector("[name=quantity]").max'),'1');
   assert.equal(await ev('pageForm.querySelector("[data-quantity-change=\\"1\\"]").disabled'),true);
   assert.equal(await ev('pageForm.querySelector("[data-inventory-variant]").textContent'),tr.inventory_one);
   await ev('pageForm.querySelector("[name=quantity]").value=2;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
   await wait('!pageForm.hasAttribute("aria-busy")');assert.equal(await ev('calls.length'),0);
  });
  await t.test('Desktop/mobile add updates product/card limits, badge and toast without opening or scrolling',async()=>{
   for(const width of [390,1440]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<992});
    await ev('reset(1)');await sleep(80);await ev('pageForm.querySelector("[name=quantity]").value=1;window.beforeY=scrollY;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
    await wait('!pageForm.hasAttribute("aria-busy")');
    assert.equal(await ev('items[0].quantity'),1);assert.equal(await ev('cardForm.querySelector("[name=add]").disabled'),true);
    assert.equal(await ev('cardForm.querySelector("[data-inventory-variant]").textContent'),tr.inventory_full);
    assert.equal(await ev('document.querySelector(".cart-count").textContent'),'1');assert.equal(await ev('document.querySelector("dialog").open'),false);
    assert.equal(await ev('scrollY'),await ev('beforeY'));assert.equal(await ev('document.querySelector("[data-cart-toast-message]").textContent'),tr.cart_toast_success);
   }
  });
  await t.test('Partial cart sums all variant lines and leaves only one additional unit',async()=>{
   await ev('reset(3)');await sleep(80);await ev('items=[{variant_id:"11",quantity:1},{variant_id:"11",quantity:1}];pageForm.querySelector("[name=quantity]").value=2;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');
   await wait('!pageForm.hasAttribute("aria-busy")');
   assert.equal(await ev('pageForm.querySelector("[name=quantity]").max'),'1');
   assert.equal(await ev('pageForm.querySelector("[data-inventory-variant]").textContent'),tr.inventory_one);
   await ev('pageForm.querySelector("[name=quantity]").value=1;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await wait('!pageForm.hasAttribute("aria-busy")');
   assert.equal(await ev('pageForm.querySelector("[name=add]").disabled'),true);
  });
  await t.test('Untracked/continue-selling inventory is not artificially capped',async()=>{
   await ev('freeForm.querySelector("[name=quantity]").value=20;freeForm.requestSubmit()');await wait('!freeForm.hasAttribute("aria-busy")');
   assert.equal(await ev('freeForm.querySelector("[name=quantity]").hasAttribute("max")'),false);
   assert.equal(await ev('freeForm.querySelector("[name=add]").disabled'),false);
   assert.equal(await ev('freeForm.querySelector("[data-inventory-variant]").textContent'),'');
  });
  await t.test('Shopify stock race refreshes limits, shows friendly feedback and never retries mutation',async()=>{
   for(const description of ['Only limited stock is available',"You can't add more of this item to the cart."]){
    await ev('window.rejectionDescription='+JSON.stringify(description));
   await ev('reset(3)');await sleep(80);await ev('pageForm.querySelector("[name=quantity]").value=2;window.snapshot='+JSON.stringify(meta(11,1))+';rejectNext=true;window.before=calls.length;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await wait('!pageForm.hasAttribute("aria-busy")');
   assert.equal(await ev('calls.length'),await ev('before+1'));assert.equal(await ev('pageForm.querySelector("[name=quantity]").max'),'1');
   assert.equal(await ev('document.querySelector("[data-cart-toast-message]").textContent'),tr.inventory_one);
   }
  });
  await t.test('Bundle blocks exhausted selected items; deselecting them permits other selections',async()=>{
   await ev('reset(1,1)');await sleep(80);await ev('pageForm.querySelector("[name=quantity]").value=1;pageForm.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))');await wait('!pageForm.hasAttribute("aria-busy")');
   assert.equal(await ev('bundleForm.querySelector("[name=add]").disabled'),true);
   await ev('bundleForm.querySelector("[value=\\"11\\"][name=bundle_variant]").checked=false;bundleForm.dispatchEvent(new Event("change",{bubbles:true}))');
   assert.equal(await ev('bundleForm.querySelector("[name=add]").disabled'),false);
   await ev('bundleForm.requestSubmit()');await wait('!bundleForm.hasAttribute("aria-busy")');
   assert.deepEqual(await ev('calls.at(-1).items'),[{id:'22',quantity:1}]);
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
