// Card quantity stepper and in-cart controls, mobile sticky add-to-cart, announcement bar, deals, collection
// ordering, structured data, performance attributes and the back-in-stock WhatsApp option.
// Static checks always run; Liquid rendering and browser checks need liquidjs (NODE_PATH) and Chrome.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=json('locales/he.default.json'),en=json('locales/en.json');

test('Contract: wiring, settings, structured data and performance attributes',()=>{
 const layout=read('layout/theme.liquid');
 assert.match(layout,/{% render 'announcement-bar' %}\s*{% section 'header' %}/,'announcement bar above the header');
 assert.match(layout,/request\.page_type == 'product' or request\.page_type == 'collection' -%}\s*{% render 'breadcrumb-structured-data' %}/);
 assert.match(layout,/request\.page_type == 'index' -%}\s*{% render 'business-structured-data' %}/);
 // No preloader: real content paints first (tests/first-paint.browser.cjs); all external scripts deferred.
 assert.doesNotMatch(layout,/preloader/i);
 for(const tag of layout.match(/<script src=[^>]*>/g)||[])assert.match(tag,/\bdefer\b/,tag);
 // Hero image preloaded with high priority; content images lazy below the fold with srcset; raw images sized.
 assert.match(read('sections/hero-section.liquid'),/'storefront-hero-image'[^}]*loading: 'eager', fetchpriority: 'high', preload: true/);
 for(const file of ['sections/feature-section.liquid','sections/shop-now.liquid'])assert.match(read(file),/image_tag: widths: '[^']+', sizes: '[^']+', loading: 'lazy'/,file);
 for(const file of ['sections/about-us.liquid','sections/content.liquid','sections/feature-section.liquid','sections/shop-now.liquid'])
  for(const img of read(file).match(/<img\b[\s\S]*?>/g)||[]){assert.match(img,/width="\d+"/,file);assert.match(img,/height="\d+"/,file);assert.match(img,/loading="lazy"/,file);}
 // Product page: sticky bar inside the purchase region (re-rendered with the variant).
 const product=read('sections/single-product.liquid');
 assert.ok(product.indexOf("{% render 'product-sticky-atc'")>product.indexOf('data-product-purchase'));
 // Homepage deals after the categories; collection pages put in-stock products first.
 const index=json('templates/index.json');assert.equal(index.order[index.order.indexOf('categories')+1],'deals');
 assert.match(read('sections/main-collection.liquid'),/{% if card_product\.available %}{% render 'product-card'[\s\S]*{% unless card_product\.available %}{% render 'product-card'/);
 // Settings.
 const groups=Object.fromEntries(json('config/settings_schema.json').map(g=>[g.name,g]));
 assert.deepEqual(groups['t:announcement_editor.settings'].settings.filter(i=>i.id).map(i=>i.id),['announcement_enabled','announcement_interval','announcement_1_text','announcement_1_link','announcement_2_text','announcement_2_link','announcement_3_text','announcement_3_link']);
 assert.ok(groups['t:business_details_editor.settings'].settings.some(i=>i.id==='business_hours_schema'));
 // Back-in-stock: Hebrew email keys, fixed body, WhatsApp option.
 const bis=read('snippets/back-in-stock.liquid');
 for(const key of ['contact[מוצר]','contact[קישור]','contact[שם]','contact[טלפון]'])assert.ok(bis.includes('name="'+key+'"'),key);
 assert.match(bis,/name="contact\[body\]" value="{{ 'back_in_stock\.message' \| t \| escape }}"/);assert.equal(he.back_in_stock.message,'בקשת עדכון חזרה למלאי');
 assert.match(bis,/data-back-in-stock-whatsapp/);assert.equal(he.back_in_stock.whatsapp,'עדכנו אותי בוואטסאפ');
 // Schema/locale keys resolve; new storefront groups exist in both locales.
 const schemaLocales=['locales/he.schema.json','locales/en.default.schema.json'].map(json);
 for(const file of ['config/settings_schema.json','sections/deals.liquid'])for(const key of read(file).match(/t:[\w.-]+/g)||[])for(const locale of schemaLocales)assert.equal(typeof key.slice(2).split('.').reduce((a,k)=>a?.[k],locale),'string',file+' '+key);
 for(const group of ['announcement','deals','breadcrumbs'])assert.deepEqual(Object.keys(he[group]).sort(),Object.keys(en[group]).sort(),group);
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
// liquidjs with Shopify-like tags/filters so the real snippets render unmodified.
// globals mirror Shopify objects that every snippet can read (render isolates only local variables).
function engine(globals={}){
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid',globals});
 const ignore=end=>({parse(token,remain){const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',()=>{}).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(){}});
 liquid.registerTag('doc',ignore('enddoc'));liquid.registerTag('stylesheet',ignore('endstylesheet'));liquid.registerTag('schema',ignore('endschema'));
 liquid.registerTag('form',{parse(token,remain){this.id=(token.args.match(/id: (\w+)/)||[])[1];this.tpls=[];const stream=this.liquid.parser.parseStream(remain);stream.on('tag:endform',()=>stream.stop()).on('template',tpl=>this.tpls.push(tpl)).on('end',()=>{throw Error('endform missing');});stream.start();},
  *render(ctx,emitter){const id=this.id?yield this.liquid.evalValue(this.id,ctx):'';emitter.write(`<form method="post" action="/cart/add" id="${id}" class="catalog-card__form" data-card-cart>`);yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');}});
 const lookup=key=>key.split('.').reduce((a,k)=>a?.[k],he);
 liquid.registerFilter('t',(key,...args)=>{let v=lookup(key);if(typeof v!=='string')return key;for(const [k,val] of args.filter(Array.isArray))v=v.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),val);return v;});
 liquid.registerFilter('money',c=>'₪'+(Number(c)/100).toFixed(2));
 liquid.registerFilter('image_url',(img)=>'//cdn.example/'+(img?.src||img));
 liquid.registerFilter('image_tag',(src,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));return `<img src="${src}" alt="${o.alt??''}" loading="${o.loading||''}" width="100" height="100">`;});
 liquid.registerFilter('payment_type_svg_tag',()=>'');
 liquid.registerFilter('newline_to_br',v=>String(v).replace(/\r?\n/g,'<br />\n'));
 return liquid;
}

test('Liquid: structured data, deals, announcement bar and sale badges',{skip:SKIP},async t=>{
 const liquid=engine();
 await t.test('BreadcrumbList: home > collection > product, valid JSON',async()=>{
  const ctx={shop:{url:'https://fanakee.com'},routes:{root_url:'/'},request:{page_type:'product'},product:{title:'סנו "Javel"',url:'/products/sano',collections:[{title:'ניקיון',url:'/collections/clean'}]}};
  const data=JSON.parse((await liquid.renderFile('breadcrumb-structured-data',ctx)).match(/<script[^>]*>([\s\S]*)<\/script>/)[1]);
  assert.equal(data['@type'],'BreadcrumbList');
  assert.deepEqual(data.itemListElement.map(i=>[i.position,i.name,i.item]),[[1,'דף הבית','https://fanakee.com/'],[2,'ניקיון','https://fanakee.com/collections/clean'],[3,'סנו "Javel"','https://fanakee.com/products/sano']]);
  const col=JSON.parse((await liquid.renderFile('breadcrumb-structured-data',{...ctx,request:{page_type:'collection'},product:null,collection:{title:'כביסה',url:'/collections/laundry'}})).match(/<script[^>]*>([\s\S]*)<\/script>/)[1]);
  assert.deepEqual(col.itemListElement.map(i=>i.position),[1,2]);
 });
 await t.test('Store JSON-LD from business settings; nothing without address or phone',async()=>{
  const settings={business_legal_name:'פאנקי בע"מ',business_id:'516000000',business_address:'רחוב הדוגמה 1\nבאר שבע',business_phone:'054-3966168',business_email:'info@fanakee.com',business_hours_schema:'Su-Th 09:00-18:00\n\nFr 09:00-13:00\n'};
  const data=JSON.parse((await liquid.renderFile('business-structured-data',{settings,shop:{name:'פאנקי',url:'https://fanakee.com'}})).match(/<script[^>]*>([\s\S]*)<\/script>/)[1]);
  assert.equal(data['@type'],'Store');assert.equal(data.name,'פאנקי בע"מ');assert.equal(data.telephone,'054-3966168');assert.equal(data.email,'info@fanakee.com');assert.equal(data.taxID,'516000000');
  assert.deepEqual(data.address,{'@type':'PostalAddress',streetAddress:'רחוב הדוגמה 1, באר שבע',addressCountry:'IL'});
  assert.deepEqual(data.openingHours,['Su-Th 09:00-18:00','Fr 09:00-13:00']);
  assert.equal((await liquid.renderFile('business-structured-data',{settings:{business_email:'x@y.z'},shop:{name:'פאנקי',url:'https://fanakee.com'}})).trim(),'');
 });
 await t.test('Deals: only in-stock products with a uniform compare-at price; hidden when none',async()=>{
  const source=read('sections/deals.liquid').replace(/{% render 'product-card', card_product: card_product, refined_card: true %}/,'[{{ card_product.title }}]');
  const p=(title,o)=>({title,available:true,price_varies:false,compare_at_price_varies:false,price:1000,compare_at_price:1500,...o});
  const products=[p('a'),p('b',{available:false}),p('c',{compare_at_price:null}),p('d',{compare_at_price:900}),p('e',{price_varies:true}),p('f')];
  const html=await liquid.parseAndRender(source,{section:{id:'d',settings:{product_limit:8},shopify_attributes:''},collections:{all:{products}},request:{}});
  assert.deepEqual([...html.matchAll(/\[(\w)\]/g)].map(m=>m[1]),['a','f']);assert.match(html,/<h2 id="DealsHeading-d">מבצעים<\/h2>/);
  assert.equal((await liquid.parseAndRender(source,{section:{id:'d',settings:{product_limit:8}},collections:{all:{products:[p('x',{available:false})]}},request:{}})).trim(),'');
 });
 await t.test('Card sale badges: "מבצע" and a left-to-right "-X%"',async()=>{
  const html=await liquid.renderFile('product-card-badges',{card_product:{available:true,price_varies:false,compare_at_price_varies:false,price:750,compare_at_price:1000,tags:[]}});
  assert.match(html,/catalog-card__badge--sale">מבצע<\/span>/);assert.match(html,/catalog-card__badge--discount"><bdi dir="ltr">-25%<\/bdi>/);
 });
 await t.test('Announcement bar: filled messages only, optional links, nothing when disabled or empty',async()=>{
  const settings={announcement_enabled:true,announcement_interval:4,announcement_1_text:'משלוח חינם מ-150 ₪',announcement_1_link:'/pages/shipping',announcement_2_text:'',announcement_3_text:'איסוף עצמי מבאר שבע'};
  const html=await liquid.renderFile('announcement-bar',{settings});
  assert.equal((html.match(/data-announcement-item/g)||[]).length,2);assert.match(html,/<a href="\/pages\/shipping">משלוח חינם מ-150 ₪<\/a>/);
  assert.match(html,/data-interval="4"/);assert.equal((html.match(/data-announcement-item hidden/g)||[]).length,1);
  assert.equal((await liquid.renderFile('announcement-bar',{settings:{...settings,announcement_enabled:false}})).trim(),'');
  assert.equal((await liquid.renderFile('announcement-bar',{settings:{announcement_enabled:true}})).trim(),'');
  assert.doesNotMatch(await liquid.renderFile('announcement-bar',{settings:{announcement_enabled:true,announcement_1_text:'אחת'}}),/data-announcement-toggle/,'one message: no rotation controls');
 });
});

test('Browser: card in-cart controls, sticky bar, announcement bar, back-in-stock WhatsApp',{skip:SKIP,timeout:240000},async t=>{
 const liquid=engine({settings:{floating_whatsapp_enabled:true,floating_whatsapp_number:'972543966168'},shop:{name:'פאנקי',url:'https://fanakee.com'},routes:{root_url:'/'},pages:{}});
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['theme.css','storefront.css','accessibility.css','accessibility-panel.css'].map(file=>read('assets/'+file)).join('')+['snippets/storefront-design.liquid','snippets/product-card.liquid','snippets/product-card-badges.liquid','snippets/announcement-bar.liquid','snippets/product-sticky-atc.liquid','snippets/floating-whatsapp.liquid','snippets/back-in-stock.liquid','snippets/back-in-stock-trigger.liquid','snippets/inventory-limit.liquid'].map(block).join('');
 const variant={id:501,quantity_rule:{min:1,increment:1,max:null},inventory_management:null,inventory_policy:'deny',inventory_quantity:0};
 const product={id:5,title:'סנו Javel לימון',url:'/products/sano',available:true,variants:[variant],selected_or_first_available_variant:variant,requires_selling_plan:false,featured_image:null,price:1590,compare_at_price:null,price_varies:false,compare_at_price_varies:false,tags:[],vendor:'פאנקי'};
 const card=await liquid.renderFile('product-card',{card_product:product,section:{id:'grid'},request:{page_type:'index'},cart:{items:[]}});
 const sticky=await liquid.renderFile('product-sticky-atc',{sticky_product:product,sticky_variant:{...variant,price:1590,available:true}});
 const announcement=await liquid.renderFile('announcement-bar',{settings:{announcement_enabled:true,announcement_interval:3,announcement_1_text:'הודעה ראשונה',announcement_2_text:'הודעה שנייה',announcement_2_link:'/pages/a',announcement_3_text:'הודעה שלישית'}});
 const dialogSource=read('snippets/back-in-stock.liquid').replace(/{% form 'contact', id: 'BackInStockForm', class: '([^']+)' %}/,'<form method="post" action="/contact#BackInStockForm" id="BackInStockForm" class="$1">').replace('{% endform %}','</form>');
 const dialog=await liquid.parseAndRender(dialogSource,{form:{},customer:null,settings:{floating_whatsapp_number:'972543966168'}});
 const whatsapp=await liquid.renderFile('floating-whatsapp',{shop:{name:'פאנקי'},settings:{floating_whatsapp_enabled:true,floating_whatsapp_number:'972543966168'}});
 const trigger=await liquid.renderFile('back-in-stock-trigger',{bis_product:{title:'אבקת כביסה',url:'/products/powder',has_only_default_variant:true},shop:{url:'https://fanakee.com'},pages:{},routes:{root_url:'/'}});
 const html=`<!doctype html><html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body>
${announcement}
<header class="storefront-header" data-cart-section="header"><button class="open-btn" type="button">תפריט</button><nav class="navigation-holder"><button class="menu-close" type="button">סגירה</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-label="סל" data-cart-error="שגיאה" data-cart-updated="עודכן" data-cart-stale="Stale"><button class="mini-cart-close">x</button><p data-cart-status role="status"></p><div class="mini-cart-items"></div></dialog></div></header>
<main><div class="catalog-grid" style="max-width:360px"><article class="catalog-card">${card}</article><article class="catalog-card catalog-card--sold-out"><h3>אבקת כביסה</h3>${trigger}</article></div>
<section class="product-page" data-product-page><div data-product-purchase><form data-card-cart action="/cart/add" class="catalog-product-form"><input type="hidden" name="id" value="777"><input type="hidden" name="quantity" value="1"><button type="submit" name="add" class="theme-btn product-page__add" data-pending-label="..">הוספה לסל</button><p data-card-feedback data-success="נוסף" data-error="שגיאה" data-refresh-error="x"></p></form>${sticky}</div></section>
<div style="height:2200px"></div></main>
${dialog}${whatsapp}<button class="a11y-launcher" type="button">נגישות</button>
</body></html>`;
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-round5-'));
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
  const wait=async(expression,tries=200)=>{for(let i=0;i<tries;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const key=async(name,code,keyCode)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:keyCode,...(type==='keyDown'&&name==='Enter'?{text:'\r'}:{})});};
  const load=async(width=1280)=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:760,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await wait('document.readyState==="complete"');
   // Shopify cart simulation: add.js / change.js mutate one line; every mutation returns the header section.
   await ev(`window.Shopify={routes:{root:'/'}};window.cartQty={};window.calls=[];window.fail=false;
    const header=()=>{const count=Object.values(cartQty).reduce((a,b)=>a+b,0);return '<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn"><span class="cart-count">'+count+'</span></button><div class="mini-cart-items"><p>'+count+'</p></div></div></header>';};
    window.fetch=async(url,o={})=>{url=String(url);const body=o.body?JSON.parse(o.body):null;calls.push({url,body});await new Promise(r=>setTimeout(r,40));
     if(url.endsWith('cart.js'))return new Response(JSON.stringify({items:Object.entries(cartQty).filter(([,q])=>q>0).map(([id,q])=>({variant_id:Number(id),quantity:q,key:id+':k'}))}));
     if(fail)return new Response('{}',{status:422});
     if(url.endsWith('cart/add.js')){for(const item of body.items)cartQty[item.id]=(cartQty[item.id]||0)+Number(item.quantity);return new Response(JSON.stringify({items:body.items.map(i=>({id:Number(i.id),variant_id:Number(i.id),quantity:cartQty[i.id]})),sections:{header:header()}}));}
     if(url.endsWith('cart/change.js')){cartQty[body.id]=body.quantity;return new Response(JSON.stringify({sections:{header:header()}}));}
     return new Response('{}');};`);
   await ev(read('assets/storefront.js'));
  };
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});

  await t.test('Card: stepper sets the quantity, then the card shows and changes the cart quantity without the drawer',async()=>{
   await load(390);
   const before=await ev('(()=>{const c=document.querySelector(".catalog-card");const s=c.querySelector("[data-card-buy] .catalog-card__stepper");return {buy:!c.querySelector("[data-card-buy]").hidden,inCart:!c.querySelector("[data-card-in-cart]").hidden,label:s.getAttribute("aria-label"),buttons:[...s.querySelectorAll("button")].map(b=>[b.getAttribute("aria-label"),Math.round(b.getBoundingClientRect().height)]),overflow:c.scrollWidth>c.clientWidth+1}})()');
   assert.deepEqual(before,{buy:true,inCart:false,label:'כמות עבור סנו Javel לימון',buttons:[['הקטנת הכמות של סנו Javel לימון',44],['הגדלת הכמות של סנו Javel לימון',44]],overflow:false});
   await ev('const plus=document.querySelector("[data-card-buy] [data-quantity-change=\\"1\\"]");plus.click();plus.click()');
   assert.equal(await ev('document.querySelector("[data-card-buy] [name=quantity]").value'),'3');
   await ev('document.querySelector("[data-card-buy] [name=add]").focus()');await key('Enter','Enter',13);
   await wait('!document.querySelector("[data-card-in-cart]").hidden');
   const after=await ev('(()=>{const p=document.querySelector("[data-card-in-cart]");return {count:p.querySelector("[data-card-in-cart-count]").textContent,buy:document.querySelector("[data-card-buy]").hidden,focus:document.activeElement.dataset.cardLineChange,drawer:document.querySelector(".cart-drawer").open,added:calls.find(c=>c.url.endsWith("add.js"))?.body?.items?.[0]}})()');
   assert.deepEqual(after,{count:'3',buy:true,focus:'1',drawer:false,added:{id:'501',quantity:3}});
   await key('Enter','Enter',13);await wait('document.querySelector("[data-card-in-cart-count]").textContent==="4"');
   assert.deepEqual(await ev('calls.filter(c=>c.url.endsWith("change.js")).map(c=>[c.body.id,c.body.quantity])'),[['501',4]]);
   assert.equal(await ev('document.querySelector(".catalog-card [data-card-feedback]").textContent'),'בסל: 4');
   assert.equal(await ev('document.querySelector(".cart-count").textContent'),'4','header cart refreshed from the same response');
   // Minus down to zero removes the line and returns to the add state with focus on the add button.
   for(const q of ['3','2','1']){await ev('document.querySelector("[data-card-line-change=\\"-1\\"]").click()');await wait('document.querySelector("[data-card-in-cart-count]").textContent==='+JSON.stringify(q));}
   await ev('document.querySelector("[data-card-line-change=\\"-1\\"]").focus()');await key('Enter','Enter',13);
   await wait('!document.querySelector("[data-card-buy]").hidden');
   assert.deepEqual(await ev('[document.querySelector("[data-card-in-cart]").hidden,document.activeElement.name,document.querySelector(".catalog-card [data-card-feedback]").textContent]'),[true,'add','הוסר מהסל']);
  });
  await t.test('Card: a failed cart change keeps the quantity and reports the error',async()=>{
   await ev('document.querySelector("[data-card-buy] [name=quantity]").value="1";document.querySelector("[data-card-buy] [name=add]").click()');await wait('!document.querySelector("[data-card-in-cart]").hidden');
   await ev('fail=true;document.querySelector("[data-card-line-change=\\"1\\"]").click()');await wait('!document.querySelector("[data-card-in-cart]").hasAttribute("aria-busy")');
   await sleep(100);
   assert.deepEqual(await ev('[document.querySelector("[data-card-in-cart-count]").textContent,document.querySelector(".catalog-card [data-card-feedback]").textContent]'),['1',he.storefront.cart_add_error]);
   await ev('fail=false');
  });
  await t.test('Mobile sticky bar: appears after the main button scrolls away, submits the main form, lifts floating buttons',async()=>{
   await load(390);
   assert.equal(await ev('document.querySelector("[data-sticky-atc]").hidden'),true,'hidden while the main button is reachable');
   await ev('const b=document.querySelector(".product-page__add");scrollTo(0,b.getBoundingClientRect().bottom+scrollY+200)');
   await wait('!document.querySelector("[data-sticky-atc]").hidden');
   const m=await ev(`(()=>{const bar=document.querySelector("[data-sticky-atc]").getBoundingClientRect(),hit=n=>{const r=n.getBoundingClientRect();return !(r.right<=bar.left||r.left>=bar.right||r.bottom<=bar.top||r.top>=bar.bottom)};
    return {bottom:Math.round(innerHeight-bar.bottom),flag:document.documentElement.hasAttribute("data-sticky-atc-visible"),overlap:[...document.querySelectorAll(".a11y-launcher,.floating-whatsapp")].filter(hit).length,title:document.querySelector(".product-sticky-atc__title").textContent,price:document.querySelector(".product-sticky-atc__price").textContent.trim(),label:document.querySelector("[data-sticky-atc-add]").getAttribute("aria-label"),height:document.querySelector("[data-sticky-atc-add]").getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
   assert.deepEqual({...m,height:m.height>=44},{bottom:0,flag:true,overlap:0,title:'סנו Javel לימון',price:'₪15.90',label:'הוספה לסל: סנו Javel לימון',height:true,overflow:false});
   await ev('document.querySelector("[data-sticky-atc-add]").click()');
   await wait('calls.some(c=>c.url.endsWith("add.js")&&c.body.items[0].id==="777")');
   await ev('scrollTo(0,0)');await wait('document.querySelector("[data-sticky-atc]").hidden');
   assert.equal(await ev('document.documentElement.hasAttribute("data-sticky-atc-visible")'),false);
   await load(1280);await ev('scrollTo(0,1500)');await sleep(300);
   assert.equal(await ev('getComputedStyle(document.querySelector("[data-sticky-atc]")).display'),'none','desktop never shows the bar');
  });
  await t.test('Announcement bar: rotates, pauses on request, manual navigation, honours stop-animations',async()=>{
   await load(1280);
   const shown=()=>ev('[...document.querySelectorAll("[data-announcement-item]")].findIndex(i=>!i.hidden)');
   const controls=await ev('[...document.querySelectorAll(".announcement-bar__control")].map(b=>[b.hidden,b.getAttribute("aria-label"),Math.round(b.getBoundingClientRect().width)])');
   assert.deepEqual(controls,[[false,'ההודעה הקודמת',44],[false,'ההודעה הבאה',44],[false,'עצירת החלפת ההודעות',44]]);
   assert.equal(await shown(),0);
   await wait('[...document.querySelectorAll("[data-announcement-item]")].findIndex(i=>!i.hidden)===1',200);
   assert.equal(await ev('document.querySelector("[data-announcement-live]").getAttribute("aria-live")'),'off','automatic changes are not announced');
   await ev('document.querySelector("[data-announcement-toggle]").click()');
   assert.equal(await ev('document.querySelector("[data-announcement-toggle]").getAttribute("aria-pressed")'),'true');
   const paused=await shown();await sleep(3400);assert.equal(await shown(),paused,'paused');
   await ev('document.querySelector("[data-announcement-next]").click()');
   assert.equal(await shown(),(paused+1)%3);assert.equal(await ev('document.querySelector("[data-announcement-live]").getAttribute("aria-live")'),'polite');
   await load(1280);
   await ev('document.documentElement.setAttribute("data-a11y-paused","")');await sleep(50);
   const state=await ev('[document.querySelector("[data-announcement-toggle]").getAttribute("aria-pressed"),document.querySelector("[data-announcement-toggle]").disabled]');
   assert.deepEqual(state,['true',true]);
   const still=await shown();await sleep(3400);assert.equal(await shown(),still,'no rotation while animations are stopped');
  });
  await t.test('Back-in-stock: WhatsApp option opens a chat with the product named',async()=>{
   await load(1280);
   await ev('document.querySelector("[data-back-in-stock]").click()');await wait('document.querySelector("#BackInStockDialog").open');
   const link=await ev('(()=>{const a=document.querySelector("[data-back-in-stock-whatsapp]");return {href:a.href,target:a.target,rel:a.rel,text:a.textContent.trim(),label:a.getAttribute("aria-label")}})()');
   const url=new URL(link.href);
   assert.equal(url.origin+url.pathname,'https://wa.me/972543966168');
   assert.equal(url.searchParams.get('text'),'שלום, אשמח לעדכון כשהמוצר "אבקת כביסה" יחזור למלאי.\nhttps://fanakee.com/products/powder');
   assert.deepEqual([link.target,link.rel,link.text],['_blank','noopener noreferrer','עדכנו אותי בוואטסאפ']);assert.ok(link.label.startsWith(link.text));
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
