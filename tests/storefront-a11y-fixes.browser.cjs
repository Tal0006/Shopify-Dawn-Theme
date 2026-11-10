// Regression checks for the product card, image, menu, head and Group Delivery page accessibility fixes.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const he=JSON.parse(read('locales/he.default.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));

test('Product cards: sold-out text once, named add button, image link out of tab order',()=>{
 const card=read('snippets/product-card.liquid'),badges=read('snippets/product-card-badges.liquid');
 const soldOut=/'products\.product\.sold_out' \| t/g;
 assert.equal((badges.match(soldOut)||[]).length,0,'no sold-out badge on the image');
 assert.equal((card.match(/<p class="catalog-availability">[^\n]*'products\.product\.sold_out' \| t/g)||[]).length,1,'availability line');
 assert.match(card,/{% if card_product\.available == false %}\s*{% render 'back-in-stock-trigger', bis_product: card_product %}/,'sold-out cards offer a back-in-stock request instead of a dead button');
 assert.match(card,/<a href="{{ card_product\.url }}" class="catalog-card__image" tabindex="-1" aria-hidden="true">/);
 assert.doesNotMatch(card,/class="catalog-card__image"[^>]*aria-label/);
 assert.match(card,/name="add" aria-label="{{ 'storefront\.add_to_cart_label' \| t: title: card_product\.title \| escape }}"/);
 assert.equal(he.storefront.add_to_cart_label,'הוספה לסל: {{ title }}');
 assert.ok(he.storefront.add_to_cart_label.startsWith(he.products.product.add_to_cart),'accessible name starts with the visible label');
 // The card image keeps a meaningful alt (image alt, else product title).
 assert.match(card,/assign card_image_alt = card_product\.featured_image\.alt \| default: card_product\.title/);
});

test('Images: meaningful alt for content, alt="" + aria-hidden for decoration',()=>{
 const files=['layout','sections','snippets'].flatMap(dir=>fs.readdirSync(path.join(root,dir)).map(file=>dir+'/'+file)).filter(file=>file.endsWith('.liquid'));
 // Liquid tags are blanked first (e.g. srcset loops with ">=" comparisons); output tags count as non-empty text.
 for(const file of files)for(const img of read(file).replace(/{%[\s\S]*?%}/g,'').replace(/{{[\s\S]*?}}/g,'X').match(/<img\b[^>]*>/g)||[]){
  const alt=img.match(/\balt="([^"]*)"/);
  assert.ok(alt,file+': img without alt '+img.slice(0,80));
  if(alt[1]==='')assert.match(img,/aria-hidden="true"/,file+': decorative image must be aria-hidden '+img.slice(0,80));
 }
 for(const [file,wrapper] of [['sections/category-navigation.liquid','catalog-category__media'],['snippets/predictive-search-products.liquid','predictive-search__image'],['snippets/bundle-product.liquid','bundle-item__image']]){
  assert.match(read(file),new RegExp('class="'+wrapper+'[^"]*"[^>]*aria-hidden="true"'),file+': thumbnail next to its own visible title is decorative');
 }
 const header=read('sections/header.liquid');
 assert.match(header,/assign header_logo_alt = header_logo\.alt \| default: shop\.name/);assert.match(header,/alt: header_logo_alt/);
});

test('Head: theme-color, https og:image, no non-standard meta names',()=>{
 const layout=read('layout/theme.liquid'),meta=read('snippets/meta-tags.liquid');
 assert.match(layout,/<meta name="theme-color" content="#0b6571">/);
 assert.match(read('assets/storefront.css'),/--fk-teal-700: #0b6571;[\s\S]*--fk-primary: var\(--fk-teal-700\);/,'theme-color is the primary token');
 assert.match(meta,/<meta property="og:image" content="https:{{ page_image/);assert.doesNotMatch(meta,/content="http:/);
 assert.doesNotMatch(layout+meta,/<meta [^>]*name="meta-/);
});

test('Group Delivery page: no footer self-link; review heading exposed once',()=>{
 const entry=read('snippets/group-delivery-entry.liquid');
 assert.match(entry,/{% if context == 'footer' and request\.path == delivery_page\.url %}{% assign delivery_present = true %}{% endif %}/);
 const cta=read('snippets/google-review-cta.liquid');
 assert.doesNotMatch(cta,/data-review-cta[^>]*(role="group"|aria-labelledby)/);
 assert.equal((cta.match(/<h2 /g)||[]).length,1);
});

test('Spelling: visible theme copy uses "חד־פעמי" (maqaf); handles are untouched',()=>{
 const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
 const files=['layout','locales','sections','snippets','templates','config'].flatMap(walk).filter(f=>/\.(liquid|json)$/.test(f));
 for(const file of files)for(const line of read(file).split(/\r?\n/)){
  for(const m of line.matchAll(/חד[\s\-\u2010-\u2015]פעמי/g)){
   assert.match(line,/"collection": "חד-פעמי-1"/,file+': non-standard spelling in '+line.trim().slice(0,80));
  }
 }
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
test('Menu groups with a "#" URL: heading text on desktop, one labelled disclosure button on mobile',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)',timeout:120000},async t=>{
 const engine=new Liquid();
 engine.registerFilter('t',key=>key.split('.').reduce((a,k)=>a?.[k],he)??key);
 const menu={links:[
  {title:'קטלוג',url:'#',active:false,current:false,links:[
   {title:'כביסה',url:'#',current:false,links:[{title:'מרכך כביסה',url:'/collections/softener',current:false,links:[]},{title:'אבקת כביסה',url:'/collections/powder',current:false,links:[]}]},
   {title:'ניקיון כללי',url:'/collections/cleaning',current:false,links:[{title:'ניקוי כלים',url:'/collections/dishes',current:false,links:[]}]},
   {title:'מבצעים',url:'#',current:false,links:[]}
  ]},
  {title:'צור קשר',url:'/pages/contact',active:false,current:false,links:[]}
 ]};
 const nav=await engine.parseAndRender(read('snippets/navigation-links.liquid'),{menu,section:{id:'header'},settings:{catalog_collection:{url:'/collections/all'}},routes:{all_products_collection_url:'/collections/all'}});
 assert.doesNotMatch(nav,/href="#"/,'no fake links');
 assert.equal((nav.match(/nav-group-toggle--labelled/g)||[]).length,1);
 assert.match(nav,/<button class="nav-group-toggle submenu-toggle nav-group-toggle--labelled" type="button" data-group-trigger aria-expanded="false" aria-controls="NavSubmenu-header-1-Group-1"><span>כביסה<\/span>/);
 assert.match(nav,/<a href="\/collections\/cleaning" >ניקיון כללי<\/a>/,'real URLs stay links');
 assert.match(nav,/<span class="nav-mega-group-label">מבצעים<\/span>/,'"#" without children is plain text');
 const css=['bootstrap-subset.css','style.css','storefront.css'].map(file=>read('assets/'+file)).join('');
 const html=`<!doctype html><html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><header class="storefront-header" data-cart-section="header"><div class="header-area"><button class="open-btn" type="button">תפריט</button><nav class="navigation-holder"><button class="menu-close" type="button">סגירה</button><div id="navbar"><ul class="nav navbar-nav">${nav}</ul></div></nav><div class="mini-cart"><button class="cart-toggle-btn" type="button" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer"><button class="mini-cart-close" type="button">x</button><div class="mini-cart-items"></div></dialog></div></div></header><main><h1>חנות</h1></main></body></html>`;
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-nav-'));
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
  const load=async width=>{await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<992});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await sleep(300);await ev('window.Shopify={routes:{root:"/"}}');await ev(read('assets/storefront.js'));};
  await call('Page.enable');
  await t.test('Desktop: heading text visible, labelled button hidden, children always listed',async()=>{
   await load(1280);
   const r=await ev('(()=>{const g=document.querySelector(".nav-mega-group");const vis=n=>!!n&&getComputedStyle(n).display!=="none";return {label:vis(g.querySelector(".nav-mega-group-label--desktop")),button:vis(g.querySelector(".nav-group-toggle--labelled")),children:!g.querySelector(".nav-mega-children").hidden,labelColor:getComputedStyle(g.querySelector(".nav-mega-group-label--desktop")).fontWeight}})()');
   assert.deepEqual(r,{label:true,button:false,children:true,labelColor:'700'});
  });
  await t.test('Mobile: one 48px disclosure button with the group name toggles its list',async()=>{
   await load(390);
   await ev('document.querySelector("[data-mega-trigger]").click()');
   const before=await ev('(()=>{const g=document.querySelector(".nav-mega-group"),b=g.querySelector(".nav-group-toggle--labelled"),vis=n=>getComputedStyle(n).display!=="none";return {label:vis(g.querySelector(".nav-mega-group-label--desktop")),name:b.textContent.trim(),expanded:b.getAttribute("aria-expanded"),hidden:g.querySelector(".nav-mega-children").hidden,height:b.getBoundingClientRect().height,buttons:g.querySelectorAll(".nav-mega-group-heading button").length}})()');
   assert.deepEqual({...before,height:before.height>=44},{label:false,name:'כביסה',expanded:'false',hidden:true,height:true,buttons:1});
   await ev('document.querySelector(".nav-group-toggle--labelled").click()');
   assert.deepEqual(await ev('[document.querySelector(".nav-group-toggle--labelled").getAttribute("aria-expanded"),document.querySelector(".nav-mega-children").hidden]'),['true',false]);
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
