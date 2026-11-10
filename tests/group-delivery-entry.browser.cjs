const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
test('Group Delivery entry point browser coverage',{timeout:90000},async t=>{
const css=fs.readFileSync(path.join(root,'sections/group-delivery-promo.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/group-delivery-entry.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/group-delivery.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-discovery-styles.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/product-card-badges.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'sections/single-product.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/cart-drawer.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
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






  const tr=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,''));
  const escape=value=>String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const raw=fs.readFileSync(path.join(root,'sections/group-delivery-promo.liquid'),'utf8');
  const promo=raw.slice(raw.indexOf('<section'),raw.indexOf('</section>')+10)
   .replace(/{% if section.settings.\w+ != blank %}[\s\S]*?{% else %}([\s\S]*?){% endif %}/g,'$1')
   .replace(/{{ section.id }}/g,'promo-fixture').replace(/{{ delivery_page.url }}/g,'/pages/group-delivery')
   .replace(/{{ '([^']+)' \| t }}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr)));
  const entry=fs.readFileSync(path.join(root,'snippets/group-delivery-entry.liquid'),'utf8');
  const anchor=context=>entry.slice(entry.indexOf('<a class='),entry.indexOf('</a>')+4)
   .replace(/{{ context \| escape }}/g,context).replace(/{{ delivery_page.url }}/g,'/pages/group-delivery')
   .replace(/{% if request.path[\s\S]*?{% endif %}/g,'')
   .replace(/{% if context == 'footer' %}([\s\S]*?){% else %}([\s\S]*?){% endif %}/g,(_m,footer,nav)=>context==='footer'?footer:nav)
   .replace(/{{ '([^']+)' \| t }}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr)));
  await ev('document.querySelector("main").setAttribute("data-storefront-home","");document.querySelector("main").innerHTML='+JSON.stringify(promo)+';document.querySelector("footer").className="storefront-footer";document.querySelector("footer").innerHTML='+JSON.stringify(anchor('footer'))+';document.querySelector("header nav").innerHTML='+JSON.stringify(anchor('navigation')));
  await t.test('All three semantic entry links target the same public storefront page',async()=>{
   assert.deepEqual(await ev('[...document.querySelectorAll(".group-delivery-promo__cta,.group-delivery-entry")].map(a=>a.getAttribute("href"))'),Array(3).fill('/pages/group-delivery'));
   assert.equal(await ev('document.querySelectorAll("main h2").length'),1);
   assert.ok(await ev('document.querySelector(".group-delivery-promo__approval").textContent.includes('+JSON.stringify(tr.group_delivery_entry.approval)+')'));
   assert.equal(await ev('document.querySelector("main").textContent.includes("{%")'),false);
  });
  await t.test('Promo, footer and links fit requested RTL widths and clear floating controls',async()=>{
   await ev("const controls=document.createElement('div');controls.innerHTML='<style>.a11y-launcher{position:fixed;inset-inline-end:16px;bottom:16px;width:52px;height:52px}fankee-shopping-assistant [data-launch]{position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px}@media(max-width:991px){fankee-shopping-assistant{display:none}}</style><button class=\"a11y-launcher\">Accessibility</button><fankee-shopping-assistant><button data-launch>Assistant</button></fankee-shopping-assistant>';document.body.append(controls)");
   for(const width of [320,360,375,390,768,1024,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:600,deviceScaleFactor:1,mobile:false});
    const m=await ev('(()=>{const promo=document.querySelector(".group-delivery-promo"),cta=promo.querySelector("a"),r=cta.getBoundingClientRect(),s=promo.querySelector(".group-delivery-promo__surface").getBoundingClientRect();return {overflow:document.documentElement.scrollWidth>innerWidth,rtl:getComputedStyle(promo).direction,height:r.height,inside:r.left>=s.left&&r.right<=s.right,full:innerWidth>=768||Math.abs(r.width-(s.width-38))<3};})()');
    assert.equal(m.overflow,false,'overflow '+width);assert.equal(m.rtl,'rtl');assert.ok(m.height>=44);assert.equal(m.inside,true);assert.equal(m.full,true);
    const safe=await ev('(()=>{const a=document.querySelector(".group-delivery-promo__cta").getBoundingClientRect();return [...document.querySelectorAll(".a11y-launcher,fankee-shopping-assistant [data-launch]")].filter(n=>n.getBoundingClientRect().width).every(n=>{const b=n.getBoundingClientRect();return a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom;});})()');
    assert.equal(safe,true,'controls '+width);
   }
  });
  await t.test('Existing reveal system and reduced motion work without new requests',async()=>{
   await ev(fs.readFileSync(path.join(root,'assets/storefront-motion.js'),'utf8'));
   assert.equal(await ev('document.querySelector(".group-delivery-promo__surface").hasAttribute("data-storefront-reveal")'),true);
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.equal(await ev('getComputedStyle(document.querySelector(".group-delivery-promo__cta"),"::before").display'),'none');
   await ev('document.querySelector(".group-delivery-promo__cta").focus()');
   assert.equal(await ev('document.activeElement.matches(".group-delivery-promo__cta")'),true);
  });
 }finally{
  ws?.close();chrome?.kill();
  await new Promise(r=>server.close(r));await sleep(500);
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-predictive-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
