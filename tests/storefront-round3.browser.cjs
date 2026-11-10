// Sold-out ordering, back-in-stock requests, cart note, cart suggestions, business details, contact phone,
// floating WhatsApp, shopping-assistant promo and Group Delivery guide.
// Static contract checks always run; Liquid rendering and browser checks need liquidjs (NODE_PATH) and Chrome.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=json('locales/he.default.json'),en=json('locales/en.json');
const schemaOf=file=>JSON.parse(read(file).match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
const strip=source=>source.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'').replace(/{% schema %}[\s\S]*?{% endschema %}/,'');

test('Contract: settings, templates, fields and labels',()=>{
 const featured=schemaOf('sections/featured-collection.liquid').settings.find(item=>item.id==='max_sold_out');
 assert.deepEqual([featured.type,featured.min,featured.max,featured.default],['range',0,4,2]);
 // Back in stock: one dialog per page on Shopify's contact form; email required (Shopify), phone optional.
 assert.equal((read('layout/theme.liquid').match(/{% render 'back-in-stock' %}/g)||[]).length,1);
 const dialog=read('snippets/back-in-stock.liquid');
 assert.match(dialog,/{% form 'contact', id: 'BackInStockForm'/);
 for(const field of ['contact[name]','contact[email]','contact[phone]','contact[product]','contact[product_url]','contact[body]'])assert.ok(dialog.includes('name="'+field+'"'),field);
 assert.match(dialog,/name="contact\[email\]"[^>]*required/);assert.doesNotMatch(dialog.match(/<input id="BackInStockPhone"[^>]*>/)[0],/required/);
 for(const id of ['BackInStockName','BackInStockEmail','BackInStockPhone'])assert.match(dialog,new RegExp('<label for="'+id+'">'));
 assert.match(read('snippets/product-card.liquid'),/{% render 'back-in-stock-trigger', bis_product: card_product %}/);
 assert.match(read('sections/single-product.liquid'),/{% unless selected_variant\.available %}{% render 'back-in-stock-trigger', bis_product: product, bis_variant: selected_variant/);
 assert.equal(he.back_in_stock.button,'עדכנו אותי כשחוזר למלאי');
 assert.ok(he.back_in_stock.button_label.startsWith(he.back_in_stock.button),'accessible name starts with the visible label');
 // Free shipping copy and threshold.
 assert.equal(he.free_shipping.remaining,'עוד {{ amount }} למשלוח חינם');assert.equal(he.free_shipping.reached,'מגיע לך משלוח חינם!');
 assert.equal(json('config/settings_schema.json').find(g=>g.name==='t:free_shipping_editor.settings').settings.find(i=>i.id==='free_shipping_threshold').default,150);
 // Order note on the cart page and in the drawer, both saved to cart.note.
 assert.equal(he.sections.cart.note,'הערות להזמנה / תיאום משלוח');
 assert.match(read('sections/main-cart.liquid'),/<label for="CartNote-{{ section\.id }}">{{ 'sections\.cart\.note' \| t }}<\/label><textarea id="CartNote-{{ section\.id }}" name="note">/);
 assert.match(read('snippets/cart-drawer.liquid'),/<label class="sr-only" for="DrawerNote-{{ drawer_id }}">{{ 'sections\.cart\.note' \| t }}<\/label>\s*<textarea id="DrawerNote-{{ drawer_id }}" name="note"/);
 // Templates.
 assert.deepEqual(json('templates/cart.json').order,['main','cart_recommendations']);
 const index=json('templates/index.json');assert.equal(index.order[index.order.indexOf('categories')+1],'shopping_assistant_promo');
 assert.deepEqual(json('templates/page.group-delivery.json').order,['main','group_delivery_info']);
 // Global settings.
 const groups=Object.fromEntries(json('config/settings_schema.json').map(g=>[g.name,g]));
 assert.deepEqual(groups['t:business_details_editor.settings'].settings.filter(i=>i.id).map(i=>i.id),['business_legal_name','business_id','business_address','business_phone','business_email','business_hours']);
 assert.deepEqual(groups['t:floating_whatsapp_editor.settings'].settings.map(i=>i.id),['floating_whatsapp_enabled','floating_whatsapp_number']);
 assert.match(read('sections/footer.liquid'),/{% render 'business-details' %}/);
 const data=json('config/settings_data.json');assert.equal(data.current.sections.footer.settings.show_payment_icons,true);assert.equal(data.current.floating_whatsapp_number,'972543966168');
 // Contact page phone is optional.
 const contact=read('sections/contact-form.liquid');const phone=contact.match(/<input type="tel" id="ContactPhone-{{ section\.id }}"[^>]*>/)[0];
 assert.match(phone,/name="contact\[phone\]"/);assert.doesNotMatch(phone,/required/);assert.match(contact,/<label for="ContactPhone-{{ section\.id }}">/);
 // Every schema t: key resolves in both schema locales; all new storefront keys exist in both locales.
 const schemaLocales=['locales/he.schema.json','locales/en.default.schema.json'].map(json);
 const files=['config/settings_schema.json','sections/featured-collection.liquid','sections/cart-recommendations.liquid','sections/shopping-assistant-promo.liquid','sections/group-delivery-info.liquid'];
 for(const file of files)for(const key of read(file).match(/t:[\w.-]+/g)||[])for(const locale of schemaLocales)assert.equal(typeof key.slice(2).split('.').reduce((a,k)=>a?.[k],locale),'string',file+' '+key);
 for(const group of ['back_in_stock','cart_recommendations','business_details','floating_whatsapp','assistant_promo','group_delivery_info'])assert.deepEqual(Object.keys(he[group]).sort(),Object.keys(en[group]).sort(),group);
 assert.ok(schemaLocales[1].group_delivery_info_editor.name.length<=25);
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
function engine(){
 const liquid=new Liquid();
 liquid.registerFilter('t',(key,...args)=>{let v=key.split('.').reduce((a,k)=>a?.[k],he);if(typeof v!=='string')return key;for(const [k,val] of args.filter(Array.isArray))v=v.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),val);return v;});
 liquid.registerFilter('newline_to_br',v=>String(v).replace(/\n/g,'<br>\n'));
 return liquid;
}
const card=source=>source.replace(/{% render 'product-card', card_product: card_product, refined_card: true %}/g,'[{{ card_product.title }}]').replace(/{% render 'product-discovery-styles' %}/,'');

test('Liquid: homepage grids, cart suggestions, business details, WhatsApp, Group Delivery guide',{skip:SKIP},async t=>{
 const liquid=engine();
 await t.test('Available first in collection order, then at most N sold-out',async()=>{
  const section=card(strip(read('sections/featured-collection.liquid')));
  const products='a1 s1 a2 s2 s3 a3 s4 a4'.split(' ').map(title=>({title,available:title[0]==='a'}));
  const render=async settings=>[...(await liquid.parseAndRender(section,{section:{settings:{collection:{products,title:'x',url:'/c'},product_limit:8,max_sold_out:2,show_view_all:false,...settings}}})).matchAll(/\[(\w+)\]/g)].map(m=>m[1]);
  assert.deepEqual(await render({}),['a1','a2','a3','a4','s1','s2']);
  assert.deepEqual(await render({max_sold_out:0}),['a1','a2','a3','a4']);
  assert.deepEqual(await render({product_limit:5}),['a1','a2','a3','a4','s1']);
  assert.deepEqual(await render({product_limit:3}),['a1','a2','a3']);
 });
 await t.test('Cart suggestions: in stock, not in the cart, max 4; empty cart shows best sellers',async()=>{
  const section=card(strip(read('sections/cart-recommendations.liquid')));
  const products=[[1,true],[2,true],[3,false],[4,true],[5,true],[6,true],[7,true]].map(([id,available])=>({id,title:'p'+id,available}));
  const base={section:{id:'rec',settings:{}},routes:{product_recommendations_url:'/recommendations/products'}};
  const withItems=await liquid.parseAndRender(section,{...base,cart:{item_count:1,items:[{product_id:2}]},recommendations:{performed:true,products}});
  assert.deepEqual([...withItems.matchAll(/\[(\w+)\]/g)].map(m=>m[1]),['p1','p4','p5','p6']);
  assert.match(withItems,/data-product-recommendations[^>]*data-url="\/recommendations\/products\?section_id=rec&product_id=2&limit=10&intent=related"/);
  assert.doesNotMatch(withItems.match(/<section[^>]*>/)[0],/hidden/);
  const pending=await liquid.parseAndRender(section,{...base,cart:{item_count:1,items:[{product_id:2}]},recommendations:{performed:false,products:[]}});
  assert.match(pending.match(/<section[^>]*>/)[0],/ hidden/,'hidden until the API answers (storefront.js loads it)');
  const empty=await liquid.parseAndRender(section,{...base,cart:{item_count:0,items:[]},collections:{'best-sellers':{title:'x',products}}});
  assert.deepEqual([...empty.matchAll(/\[(\w+)\]/g)].map(m=>m[1]),['p1','p2','p4','p5']);
  assert.match(empty,/<h2 id="CartRecommendationsHeading-rec">הנמכרים ביותר<\/h2>/);
  assert.equal((await liquid.parseAndRender(section,{...base,cart:{item_count:0,items:[]},collections:{}})).trim(),'','no best-sellers collection, nothing shown');
 });
 await t.test('Business details render only filled fields with tel/mailto links',async()=>{
  const snippet=strip(read('snippets/business-details.liquid'));
  assert.equal((await liquid.parseAndRender(snippet,{settings:{}})).trim(),'');
  const html=await liquid.parseAndRender(snippet,{settings:{business_legal_name:'פאנקי בע"מ',business_phone:'054-396 6168',business_hours:'א׳–ה׳ 09:00–18:00\nו׳ 09:00–13:00'}});
  assert.match(html,/<a href="tel:0543966168" dir="ltr">054-396 6168<\/a>/);assert.match(html,/פאנקי בע&(quot|#34);מ/);assert.match(html,/09:00–18:00<br>/);
  assert.doesNotMatch(html,/mailto|ח\.פ\.|כתובת:/);
 });
 await t.test('Floating WhatsApp: valid 8-15 digit number only, new tab, named',async()=>{
  const snippet=strip(read('snippets/floating-whatsapp.liquid'));
  const render=settings=>liquid.parseAndRender(snippet,{shop:{name:'פאנקי'},settings:{floating_whatsapp_enabled:true,...settings}});
  const html=await render({floating_whatsapp_number:'+972 54-396-6168'});
  assert.match(html,/href="https:\/\/wa\.me\/972543966168" target="_blank" rel="noopener noreferrer" aria-label="צ׳אט בוואטסאפ עם פאנקי \(נפתח בכרטיסייה חדשה\)"/);
  for(const settings of [{floating_whatsapp_number:''},{floating_whatsapp_number:'12345'},{floating_whatsapp_number:'97254abc6168'},{floating_whatsapp_enabled:false,floating_whatsapp_number:'972543966168'}])assert.equal((await render(settings)).trim(),'',JSON.stringify(settings));
 });
 await t.test('Group Delivery guide: default steps; a question appears only with its answer',async()=>{
  const section=strip(read('sections/group-delivery-info.liquid'));
  const html=await liquid.parseAndRender(section,{section:{id:'gd',settings:{faq_3_answer:'לא. אפשר לבטל עד שהקבוצה מגיעה ליעד.'}}});
  assert.equal((html.match(/class="gd-info__step"/g)||[]).length,3);assert.match(html,/איך זה עובד/);assert.match(html,/בוחרים אזור ומצטרפים/);
  assert.deepEqual([...html.matchAll(/<summary>([^<]*)<\/summary>/g)].map(m=>m[1]),['האם ההצטרפות לקבוצה מחייבת?']);
  assert.doesNotMatch(await liquid.parseAndRender(section,{section:{id:'gd',settings:{}}}),/gd-info__faq/,'no unanswered FAQ');
 });
});

test('Browser: back-in-stock dialog, floating buttons, assistant promo and drawer note',{skip:SKIP,timeout:180000},async t=>{
 const liquid=engine();
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['bootstrap.min.css','style.css','storefront.css','accessibility.css'].map(file=>read('assets/'+file)).join('')+['snippets/storefront-design.liquid','snippets/cart-drawer.liquid','snippets/back-in-stock.liquid','snippets/back-in-stock-trigger.liquid','snippets/floating-whatsapp.liquid','sections/shopping-assistant-promo.liquid'].map(block).join('');
 // Shopify-only tags replaced by their static output for the browser fixture.
 const dialogSource=strip(read('snippets/back-in-stock.liquid')).replace(/{% form 'contact', id: 'BackInStockForm', class: '([^']+)' %}/,'<form method="post" action="/contact#BackInStockForm" id="BackInStockForm" class="$1">').replace('{% endform %}','</form>');
 const dialog=await liquid.parseAndRender(dialogSource,{form:{},customer:null});
 const trigger=await liquid.parseAndRender(strip(read('snippets/back-in-stock-trigger.liquid')),{bis_product:{title:'סנו Javel לימון',url:'/products/sano',has_only_default_variant:true},shop:{url:'https://fanakee.com'},pages:{},routes:{root_url:'/'}});
 const whatsapp=await liquid.parseAndRender(strip(read('snippets/floating-whatsapp.liquid')),{shop:{name:'פאנקי'},settings:{floating_whatsapp_enabled:true,floating_whatsapp_number:'972543966168'}});
 const promo=await liquid.parseAndRender(strip(read('sections/shopping-assistant-promo.liquid')),{settings:{shopping_assistant_enabled:true},section:{id:'promo',settings:{}}});
 const html=`<!doctype html><html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>
<header class="storefront-header" data-cart-section="header"><button class="open-btn" type="button">תפריט</button><nav class="navigation-holder"><button class="menu-close" type="button">סגירה</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">1</span></button><dialog class="mini-cart-content cart-drawer" aria-label="סל" data-cart-error="שגיאה" data-cart-updated="עודכן" data-cart-stale="Stale"><button class="mini-cart-close">x</button><p data-cart-status role="status"></p><div class="mini-cart-items"></div></dialog></div></header>
<main><div class="catalog-card catalog-card--sold-out"><h3>סנו Javel לימון</h3>${trigger}</div>${promo}<div style="height:1400px"></div></main>
<footer class="footer-area storefront-footer"><div class="container storefront-footer-inner"><div class="storefront-footer__bottom"><p class="storefront-footer-copyright">© 2026 פאנקי</p></div></div></footer>
${dialog}${whatsapp}
<button class="a11y-launcher" type="button">נגישות</button>
<fankee-shopping-assistant><button type="button" class="shopping-assistant__launcher" data-launch hidden style="position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px">עוזר</button><dialog id="ShoppingAssistantDialog" aria-label="עוזר"><button data-close>x</button><textarea aria-label="רשימה"></textarea></dialog></fankee-shopping-assistant>
</body></html>`;
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-round3-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws,call,ev;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',b=>stderr+=b.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<200;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const key=async(name,code,keyCode)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&name==='Enter'?{text:'\r'}:{})});};
  const load=async width=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await wait('document.readyState==="complete"');
   // Minimal assistant element: same launcher contract as assets/shopping-assistant.js.
   await ev(`window.Shopify={routes:{root:'/'}};window.calls=[];window.fetch=async(url,o={})=>{calls.push({url:String(url),body:o.body?JSON.parse(o.body):null});return new Response('{}',{status:200});};
    customElements.define('fankee-shopping-assistant',class extends HTMLElement{connectedCallback(){const l=this.querySelector('[data-launch]'),d=this.querySelector('dialog');l.hidden=false;this.addEventListener('click',e=>{if(e.target.closest('[data-launch]'))d.showModal();if(e.target.closest('[data-close]'))d.close();});d.addEventListener('close',()=>l.focus());}});`);
   await ev(read('assets/storefront.js'));
  };
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});

  await t.test('Back-in-stock: trigger opens a labelled form with the product, Escape returns focus',async()=>{
   await load(1280);
   const triggerInfo=await ev('(()=>{const b=document.querySelector("[data-back-in-stock]");return {text:b.textContent.trim(),label:b.getAttribute("aria-label"),height:b.getBoundingClientRect().height}})()');
   assert.equal(triggerInfo.text,'עדכנו אותי כשחוזר למלאי');assert.equal(triggerInfo.label,'עדכנו אותי כשחוזר למלאי: סנו Javel לימון');assert.ok(triggerInfo.height>=44);
   await ev('document.querySelector("[data-back-in-stock]").focus()');await key('Enter','Enter',13);
   await wait('document.querySelector("#BackInStockDialog").open');
   const r=await ev('(()=>{const d=document.querySelector("#BackInStockDialog"),f=n=>d.querySelector("[data-back-in-stock-field="+n+"]").value;return {modal:d.matches(":modal"),focus:document.activeElement.id,product:d.querySelector("[data-back-in-stock-product]").textContent,title:f("title"),url:f("url"),body:f("body"),labels:[...d.querySelectorAll("input:not([type=hidden])")].map(i=>i.labels[0]?.textContent.trim()),required:[...d.querySelectorAll("input[required]")].map(i=>i.name),name:document.getElementById(d.getAttribute("aria-labelledby")).textContent}})()');
   assert.equal(r.modal,true);assert.equal(r.focus,'BackInStockName');assert.equal(r.product,'סנו Javel לימון');
   assert.equal(r.url,'https://fanakee.com/products/sano');assert.equal(r.body,'בקשת עדכון חזרה למלאי\nמוצר: סנו Javel לימון\nקישור: https://fanakee.com/products/sano');
   assert.deepEqual(r.labels,['שם','אימייל','טלפון (לא חובה)']);assert.deepEqual(r.required,['contact[name]','contact[email]']);assert.equal(r.name,'עדכון כשהמוצר חוזר למלאי');
   await key('Escape','Escape',27);await wait('!document.querySelector("#BackInStockDialog").open');
   assert.equal(await ev('document.activeElement.matches("[data-back-in-stock]")'),true);
  });
  await t.test('Floating WhatsApp: opposite corner, no overlap, hidden while a dialog is open',async()=>{
   for(const width of [320,360,390,768,1280]){
    await load(width);
    await ev('scrollTo(0,document.documentElement.scrollHeight)');await sleep(50);
    const m=await ev(`(()=>{const w=document.querySelector(".floating-whatsapp").getBoundingClientRect(),hit=b=>!(w.right<=b.left||w.left>=b.right||w.bottom<=b.top||w.top>=b.bottom);
     const others=[...document.querySelectorAll(".a11y-launcher,.shopping-assistant__launcher,.storefront-footer-copyright")].filter(n=>!n.hidden&&getComputedStyle(n).display!=="none").map(n=>[n.className,hit(n.getBoundingClientRect())]);
     return {size:[w.width,w.height],right:w.right>innerWidth/2,others,overflow:document.documentElement.scrollWidth>innerWidth,label:document.querySelector(".floating-whatsapp").getAttribute("aria-label")}})()`);
    assert.ok(m.size[0]>=44&&m.size[1]>=44);assert.equal(m.right,true,'inline-start corner (right in RTL) '+width);
    assert.deepEqual(m.others.filter(([,hit])=>hit),[],'no overlap '+width);assert.equal(m.overflow,false);
   }
   await ev('document.querySelector(".cart-toggle-btn").click()');await wait('document.querySelector(".cart-drawer").open');
   assert.equal(await ev('getComputedStyle(document.querySelector(".floating-whatsapp")).visibility'),'hidden');
  });
  await t.test('Assistant promo appears once the assistant is ready and opens it; focus returns to the promo',async()=>{
   await load(1280);
   await wait('!document.querySelector("[data-assistant-promo]").hidden');
   await ev('document.querySelector("[data-open-shopping-assistant]").focus()');await key('Enter','Enter',13);
   await wait('document.querySelector("#ShoppingAssistantDialog").open');
   await ev('document.querySelector("#ShoppingAssistantDialog [data-close]").click()');await sleep(50);
   assert.equal(await ev('document.activeElement.matches("[data-open-shopping-assistant]")'),true);
  });
  await t.test('Drawer note: saved to cart.note on change, kept while the drawer re-renders',async()=>{
   await load(390);
   await ev(`document.querySelector('.mini-cart-items').innerHTML='<form class="cart-drawer__form"><div class="cart-drawer__lines"></div><footer class="cart-drawer__summary"><details class="cart-drawer__note"><summary>הערות להזמנה / תיאום משלוח</summary><label class="sr-only" for="DrawerNote-h">הערות</label><textarea id="DrawerNote-h" name="note" data-cart-note></textarea></details><p class="cart-drawer__total">x</p></footer></form>';
    document.querySelector('.cart-toggle-btn').click();`);
   await ev('(()=>{const n=document.querySelector("[data-cart-note]");n.closest("details").open=true;n.value="להשאיר ליד הדלת";n.dispatchEvent(new Event("change",{bubbles:true}))})()');
   await wait('calls.some(c=>c.url.endsWith("cart/update.js"))');
   assert.deepEqual(await ev('calls.find(c=>c.url.endsWith("cart/update.js")).body'),{note:'להשאיר ליד הדלת'});
   // An unsaved draft and the open state survive a server re-render (as after a quantity change).
   await ev('(()=>{const n=document.querySelector("[data-cart-note]");n.value="טיוטה שלא נשמרה";n.focus()})()');
   await ev(`(()=>{const fresh='<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn"><span class="cart-count">2</span></button><div class="mini-cart-items"><form class="cart-drawer__form"><footer class="cart-drawer__summary"><details class="cart-drawer__note"><summary>הערות</summary><label class="sr-only" for="DrawerNote-h">הערות</label><textarea id="DrawerNote-h" name="note" data-cart-note>להשאיר ליד הדלת</textarea></details></footer></form></div></div></header>';
     window.fetch=async(url,o={})=>new Response(JSON.stringify({sections:{header:fresh}}));
     document.querySelector('[data-card-cart]')||document.body.insertAdjacentHTML('beforeend','<form data-card-cart action="/cart/add"><input name="id" value="1"><input name="quantity" value="1"><button name="add" data-pending-label="..">add</button><p data-card-feedback data-success="ok" data-error="err" data-refresh-error="stale"></p></form>');})()`);
   await ev('document.querySelector("[data-card-cart]").requestSubmit(document.querySelector("[data-card-cart] [name=add]"))');
   await wait('document.querySelector(".cart-count").textContent==="2"');
   assert.deepEqual(await ev('(()=>{const n=document.querySelector("[data-cart-note]");return [n.value,n.closest("details").open]})()'),['טיוטה שלא נשמרה',true]);
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
