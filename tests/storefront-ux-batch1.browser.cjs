// Storefront UX batch 1: native page transitions/prefetch, shipping line, footer hours (RTL ranges), homepage
// in-stock grids, related product/cart recommendations, contact page. (Shopping Assistant unavailable products are
// covered in tests/shopping-assistant.browser.cjs and tools/shopping-assistant/tests/core.test.ts.)
// 1. Contracts always run. 2. Liquid rendering uses liquidjs (set NODE_PATH to an install, like
// tests/free-shipping.browser.cjs) with Shopify-like filters and stubbed product cards. 3. Browser checks use headless
// Chrome (CHROME_PATH or the default Windows path). Nothing here talks to Shopify.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),{test}=require('node:test'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const locale=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=locale('locales/he.default.json'),en=locale('locales/en.json');
const strip=source=>source.replace(/{% doc %}[\s\S]*?{% enddoc %}/g,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/g,'').replace(/{% schema %}[\s\S]*?{% endschema %}/g,'');
const text=html=>html.replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
const CHROME=process.env.CHROME_PATH||['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(fs.existsSync);

// ---- 1. Contracts --------------------------------------------------------------------------------------------------
test('Contracts: navigation is native-only, settings exist, placements and strings are in place',()=>{
 const nav=read('snippets/page-navigation.liquid');
 assert.match(read('layout/theme.liquid'),/{% render 'page-navigation' %}/);
 // No JavaScript: no click handlers, no history/router code, so navigation can never be intercepted.
 const scripts=[...strip(nav).matchAll(/<script\b([^>]*)>/g)].map(m=>m[1]);
 assert.deepEqual(scripts.map(s=>s.match(/type="([^"]+)"/)?.[1]),['speculationrules']);
 assert.doesNotMatch(strip(nav),/addEventListener|preventDefault|history\.|location\.|startViewTransition|prerender/);
 const rules=JSON.parse(strip(nav).match(/<script type="speculationrules"[^>]*>([\s\S]*?)<\/script>/)[1]);
 assert.deepEqual(Object.keys(rules),['prefetch'],'prefetch only, never prerender');
 assert.equal(rules.prefetch[0].eagerness,'moderate');
 assert.match(strip(nav),/@view-transition { navigation: auto; }/);
 assert.match(strip(nav),/@media \(prefers-reduced-motion: reduce\) { @view-transition { navigation: none; } }/);
 assert.match(strip(nav),/html\[data-a11y-paused\]::view-transition-group\(\*\)/);
 // Settings: shipping fee and toggle; customer-service hours; labels in both schema locales.
 const schema=JSON.parse(read('config/settings_schema.json'));
 const setting=id=>schema.flatMap(g=>g.settings||[]).find(s=>s.id===id);
 assert.deepEqual([setting('shipping_fee').type,setting('shipping_fee').default],['number',20]);
 assert.deepEqual([setting('shipping_disclosure_enabled').type,setting('shipping_disclosure_enabled').default],['checkbox',true]);
 assert.equal(setting('customer_service_hours').type,'textarea');assert.equal(setting('customer_service_hours').default,undefined,'no invented hours');
 for(const file of ['locales/he.schema.json','locales/en.default.schema.json']){const l=JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,'')); // Shopify adds a comment header when it syncs these files.
  for(const key of ['shipping_fee','shipping_fee_info','disclosure_enabled'])assert.equal(typeof l.free_shipping_editor[key],'string',file+' '+key);
  for(const key of ['service_hours','service_hours_info'])assert.equal(typeof l.business_details_editor[key],'string',file+' '+key);}
 // Shipping line near the purchase controls and in both carts.
 assert.match(read('sections/single-product.liquid'),/{% endform %}[\s\S]{0,400}{% render 'shipping-disclosure', context: 'product' %}/);
 assert.match(read('sections/main-cart.liquid'),/{% render 'shipping-disclosure', context: 'cart' %}/);
 assert.match(read('snippets/cart-drawer.liquid'),/{% render 'shipping-disclosure', context: 'drawer' %}/);
 assert.doesNotMatch(strip(read('snippets/shipping-disclosure.liquid')),/\b20\b|\b150\b/,'amounts come from settings');
 for(const l of [he,en])for(const key of ['fee_html','free','free_over_html','delivery_time_html','policy'])assert.equal(typeof l.shipping_disclosure[key],'string',key);
 assert.match(he.shipping_disclosure.delivery_time_html,/<bdi dir="ltr">1–2<\/bdi>/);
 // Footer: the old free-text hours are no longer printed.
 assert.doesNotMatch(read('snippets/business-details.liquid'),/settings\.business_hours\b(?!_)/);
 // Homepage grid scans past Liquid's 50-product default.
 assert.match(read('sections/featured-collection.liquid'),/{%- paginate chosen_collection\.products by 100 -%}/);
 // Contact page heading and strings.
 assert.match(read('sections/contact-form.liquid'),/'storefront\.contact_heading' \| t/);
 assert.equal(he.storefront.contact_heading,'צרו קשר');
 assert.equal(he.shopping_assistant.unavailable_group,'קיימים אצלנו אך לא זמינים כרגע');assert.equal(he.shopping_assistant.unavailable_label,'לא זמין כרגע');
});

// ---- 2. Liquid rendering ---------------------------------------------------------------------------------------------
let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
const CARD='<article class="catalog-card{% if card_product.available == false %} catalog-card--sold-out{% endif %}" data-handle="{{ card_product.handle }}">{{ card_product.title }}</article>';
function engine(lang=he){
 // Snippets are read from the theme with {% doc %}/{% stylesheet %} removed; product cards are stubbed.
 const files=name=>{const base=path.basename(name,'.liquid');
  if(base==='product-card')return CARD;if(base==='product-discovery-styles')return '';
  const file=['snippets','sections'].map(dir=>path.join(root,dir,base+'.liquid')).find(fs.existsSync);if(!file)throw Error('missing '+name);return strip(fs.readFileSync(file,'utf8'));};
 const liquid=new Liquid({fs:{exists:async()=>true,existsSync:()=>true,readFile:async f=>files(f),readFileSync:f=>files(f),resolve:(dir,file)=>file,contains:()=>true,sep:'/'},relativeReference:false,extname:'.liquid'});
 const lookup=key=>key.split('.').reduce((a,k)=>a?.[k],lang);
 liquid.registerFilter('t',(key,...args)=>{let value=lookup(key);assert.equal(typeof value,'string',key);for(const [k,v] of args.filter(Array.isArray))value=value.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),v);return value;});
 liquid.registerFilter('money',cents=>'₪'+(Number(cents)/100).toFixed(2));
 // {% paginate %} only limits the page in Shopify; here the body renders over the whole array.
 liquid.registerTag('paginate',{parse(token,remain){this.tpls=[];const stream=this.liquid.parser.parseStream(remain).on('tag:endpaginate',()=>stream.stop()).on('template',t=>this.tpls.push(t)).on('end',()=>{throw Error('paginate not closed');});stream.start();},
  *render(ctx,emitter){yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);}});
 return (source,scope,globals={})=>liquid.parseAndRender(strip(source),scope,{globals});
}
const product=(id,handle,available=true,collections=[])=>({id,handle,title:handle,available,collections});
const coll=(handle,count,products=[])=>({handle,products_count:count,products,title:handle,url:'/collections/'+handle});

test('Liquid: shipping line from settings, policy link, LTR range, toggles',{skip:SKIP},async()=>{
 const render=engine(),source=read('snippets/shipping-disclosure.liquid');
 const base={shipping_disclosure_enabled:true,shipping_fee:20,free_shipping_threshold:150,free_shipping_enabled:true};
 const out=async(settings={},shop={shipping_policy:{body:'<p>policy</p>',url:'/policies/shipping-policy'}},context='product')=>render(source,{context},{settings:{...base,...settings},shop});
 const html=await out();
 assert.equal(text(html),'משלוח 20 ₪ · חינם מעל 150 ₪ · אספקה בדרך כלל תוך 1–2 ימי עסקים · מדיניות משלוחים ואזורי חלוקה');
 assert.match(html,/<bdi dir="ltr">1–2<\/bdi>/);assert.match(html,/<a href="\/policies\/shipping-policy">/);assert.match(html,/shipping-disclosure--product/);
 assert.equal(text(await out({},{shipping_policy:{body:''}})),'משלוח 20 ₪ · חינם מעל 150 ₪ · אספקה בדרך כלל תוך 1–2 ימי עסקים','no policy, no link');
 assert.match(text(await out({shipping_fee:19.9})),/^משלוח 19\.9 ₪/);
 assert.equal(text(await out({free_shipping_enabled:false},{shipping_policy:{body:''}})),'משלוח 20 ₪ · אספקה בדרך כלל תוך 1–2 ימי עסקים','no free-shipping claim when the meter is off');
 assert.equal(text(await out({shipping_fee:0},{shipping_policy:{body:''}})),'משלוח חינם · אספקה בדרך כלל תוך 1–2 ימי עסקים');
 assert.equal((await out({shipping_disclosure_enabled:false})).trim(),'');
 assert.equal((await out({shipping_fee:null})).trim(),'');
 assert.match(await out({},undefined,'cart'),/shipping-disclosure--cart/);
});

test('Liquid: footer shows online orders 24/7 and only configured service hours, with LTR ranges',{skip:SKIP},async()=>{
 const render=engine(),source=read('snippets/business-details.liquid');
 const base={business_legal_name:'פאנקי',business_phone:'054-000-0000',business_email:'shop@example.test',business_hours:'ראשון–חמישי: 24 שעות\nשישי: 06:00–14:00\nשבת: סגור'};
 const none=await render(source,{},{settings:{...base,customer_service_hours:''}});
 assert.match(none,/<p data-business-orders><span class="business-details__label">הזמנות באתר:<\/span> <bdi dir="ltr">24\/7<\/bdi><\/p>/);
 assert.doesNotMatch(none,/24 שעות|שישי|שבת|שירות לקוחות|data-business-service/,'old free-text hours and invented service hours are not shown');
 const hours=await render(source,{},{settings:{...base,customer_service_hours:'ראשון–חמישי: 09:00–17:00\nשישי: 09:00 - 13:00\nשבת: סגור\n<script>x</script>'}});
 assert.match(hours,/שירות לקוחות:/);
 assert.match(hours,/ראשון–חמישי: <bdi dir="ltr">09:00–17:00<\/bdi>/);
 assert.match(hours,/שישי: <bdi dir="ltr">09:00 - 13:00<\/bdi>/,'a spaced range stays one LTR run');
 assert.match(hours,/<span class="business-details__hours-line">שבת: סגור<\/span>/);
 assert.match(hours,/&lt;script&gt;x&lt;\/script&gt;/);assert.doesNotMatch(hours,/<script>/);
});

test('Liquid: homepage grids show in-stock products and sold-out ones only to fill a short grid',{skip:SKIP},async()=>{
 const render=engine(),source=read('sections/featured-collection.liquid');
 const handles=html=>[...html.matchAll(/data-handle="([^"]+)"/g)].map(m=>m[1]);
 const run=(products,settings={})=>render(source,{section:{settings:{heading:'כביסה',product_limit:8,max_sold_out:2,show_view_all:false,collection:coll('laundry',products.length,products),...settings},id:'s'}},{request:{design_mode:false}});
 // Enough stock: 3 sold-out products first in the collection, 9 in stock after → 8 in-stock cards, none sold out.
 const many=[...[1,2,3].map(n=>product(n,'out-'+n,false)),...Array.from({length:9},(_,i)=>product(10+i,'in-'+(i+1)))];
 const enough=await run(many);
 assert.deepEqual(handles(enough),['in-1','in-2','in-3','in-4','in-5','in-6','in-7','in-8']);assert.doesNotMatch(enough,/catalog-card--sold-out/);
 // Short grid: 5 in stock, 4 sold out → 5 in stock first, then at most 2 sold-out to fill.
 const few=[product(1,'out-1',false),product(2,'in-1'),product(3,'out-2',false),product(4,'in-2'),product(5,'in-3'),product(6,'out-3',false),product(7,'in-4'),product(8,'in-5'),product(9,'out-4',false)];
 assert.deepEqual(handles(await run(few)),['in-1','in-2','in-3','in-4','in-5','out-1','out-2']);
 assert.deepEqual(handles(await run(few,{max_sold_out:0})),['in-1','in-2','in-3','in-4','in-5'],'0 hides sold-out products');
 // In-stock products beyond position 50 are found (the section scans up to 100).
 const deep=[...Array.from({length:55},(_,i)=>product(i+1,'out-'+i,false)),...Array.from({length:8},(_,i)=>product(100+i,'late-'+i))];
 assert.deepEqual(handles(await run(deep)),Array.from({length:8},(_,i)=>'late-'+i));
});

// A small catalog: laundry (conditioners/softeners), disposables (plates), plus broad and sale collections.
function catalog(){
 const all=coll('all',500),catalogColl=coll('כל-המוצרים',300),sale=coll('summer-sale',20),big=coll('household',150);
 const laundry=coll('laundry',6),softeners=coll('softeners',3),disposables=coll('disposables',8);
 const p={};
 const make=(id,handle,available,cols)=>{p[handle]=product(id,handle,available,cols);for(const c of cols)c.products.push(p[handle]);return p[handle];};
 make(1,'conditioner',true,[all,catalogColl,big,laundry,softeners,sale]);
 make(2,'softener-b',true,[all,catalogColl,big,laundry,softeners]);
 make(3,'softener-out',false,[all,catalogColl,laundry,softeners]);
 make(4,'detergent',true,[all,catalogColl,big,laundry]);
 make(5,'stain-remover',true,[all,catalogColl,laundry]);
 make(6,'plates',true,[all,catalogColl,big,disposables,sale]);
 make(7,'cups',true,[all,catalogColl,disposables]);
 make(8,'laundry-bag',true,[all,catalogColl,laundry]);
 return {p,collections:Object.fromEntries([all,catalogColl,sale,big,laundry,softeners,disposables].map(c=>[c.handle,c])),settings:{catalog_collection:catalogColl}};
}

test('Liquid: product recommendations start from the product category, in stock, without the product itself',{skip:SKIP},async()=>{
 const render=engine(),source=read('sections/product-recommendations.liquid'),{p,collections,settings}=catalog();
 const section={id:'rec',settings:{heading:'',product_limit:4}};
 const page=await render(source,{section,product:p.conditioner,recommendations:{performed:false}},{settings,collections,routes:{product_recommendations_url:'/recommendations/products'}});
 // Categories: smallest first; all/catalog/sale/oversized collections are not categories.
 assert.match(page,/data-rec-categories=",softeners,laundry,"/);
 const ids=[...page.matchAll(/data-rec-id="(\d+)"/g)].map(m=>m[1]);
 assert.deepEqual(ids,['2','4','5','8'],'softeners first, then laundry; current and sold-out products excluded; limit 4');
 assert.doesNotMatch(page,/data-handle="plates"|data-handle="cups"|data-handle="conditioner"/);
 assert.match(page,/data-rec-current="1"/);assert.doesNotMatch(page,/<section[^>]*\bhidden\b[^>]*data-rec-current/);
 // A product without categories: the section starts hidden and waits for Shopify's recommendations.
 const lonely=await render(source,{section,product:product(9,'lonely',true,[collections.all]),recommendations:{performed:false}},{settings,collections,routes:{product_recommendations_url:'/r'}});
 assert.match(lonely,/data-rec-categories=",,"/);assert.match(lonely,/data-storefront-discovery hidden>/);
 // Endpoint render: in-stock candidates only, each tagged with its categories.
 const endpoint=await render(source,{section,recommendations:{performed:true,products:[p.plates,p['softener-out'],p['stain-remover'],p.plates]}},{settings,collections});
 assert.deepEqual([...endpoint.matchAll(/data-rec-id="(\d+)" data-rec-collections="([^"]*)"/g)].map(m=>m[1]+m[2]),['6,disposables,','5,laundry,']);
});

test('Liquid: cart recommendations keep in-stock, related products that are not in the cart',{skip:SKIP},async()=>{
 const render=engine(),source=read('sections/cart-recommendations.liquid'),{p,collections,settings}=catalog();
 const cart={item_count:1,items:[{product_id:1,product:p.conditioner}]};
 const html=await render(source,{section:{id:'cart',settings:{}},recommendations:{performed:true,products:[p.plates,p.conditioner,p['softener-out'],p['softener-b'],p.cups,p.detergent]}},{settings,collections,cart,routes:{product_recommendations_url:'/r'}});
 assert.deepEqual([...html.matchAll(/data-handle="([^"]+)"/g)].map(m=>m[1]),['softener-b','detergent'],'plates/cups unrelated, conditioner in cart, softener-out sold out');
 // No category information at all: in-stock recommendations not in the cart, as before.
 const bare=await render(source,{section:{id:'cart',settings:{}},recommendations:{performed:true,products:[p.plates,p.cups]}},{settings,collections,cart:{item_count:1,items:[{product_id:99,product:product(99,'x',true,[])},{product_id:98,product:product(98,'y',true,[])}]},routes:{product_recommendations_url:'/r'}});
 assert.deepEqual([...bare.matchAll(/data-handle="([^"]+)"/g)].map(m=>m[1]),['plates','cups']);
});

// ---- 3. Browser ---------------------------------------------------------------------------------------------------------
test('Browser: prefetch rules, transitions, no interception, RTL ranges and related-recommendation merging',{skip:CHROME?SKIP:'Chrome not installed (set CHROME_PATH)',timeout:120000},async t=>{
 const render=engine();
 const nav=strip(read('snippets/page-navigation.liquid'));
 const shipping=await render(read('snippets/shipping-disclosure.liquid'),{context:'product'},{settings:{shipping_disclosure_enabled:true,shipping_fee:20,free_shipping_threshold:150,free_shipping_enabled:true},shop:{shipping_policy:{body:''}}});
 const footer=await render(read('snippets/business-details.liquid'),{},{settings:{customer_service_hours:'שישי: 06:00–14:00\nראשון–חמישי: 09:00 - 17:00'}});
 const {p,collections,settings}=catalog(),recSource=read('sections/product-recommendations.liquid'),section={id:'rec',settings:{heading:'',product_limit:4}};
 const recPage=await render(recSource,{section,product:p.conditioner,recommendations:{performed:false}},{settings,collections,routes:{product_recommendations_url:'/recommendations/products'}});
 // Shopify's "related" list: an unrelated product first, the current product, a duplicate of a page card and a new related one.
 const recEndpoint=await render(recSource,{section,recommendations:{performed:true,products:[p.plates,p.conditioner,p.detergent,p['laundry-bag'],p['softener-out']]}},{settings,collections});
 const storefront=read('assets/storefront.js'),merge=storefront.slice(storefront.indexOf('const relatedRecommendations'),storefront.indexOf('function recommendations(root)'));
 assert.ok(merge.length>200,'merge function found');
 const page='<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">'+nav+'<style>body{font:16px/1.5 Arial;margin:20px}</style></head><body><main>'+
  '<a id="product" href="/products/conditioner">product</a> <a id="checkout" href="/checkout">checkout</a> <a id="cartlink" href="/cart">cart</a> <a id="external" href="https://example.org/x">external</a> <a id="blank" href="/pages/about" target="_blank">blank</a>'+
  '<div id="shipping">'+shipping+'</div><div id="footer">'+footer+'</div>'+recPage+'</main>'+
  '<script>window.__endpoint='+JSON.stringify(recEndpoint)+';window.fetch=async url=>{window.__fetched=url;return new Response(window.__endpoint);};'+merge+';window.__merge=relatedRecommendations;</script></body></html>';
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(req.url==='/'?page:'<h1>'+req.url+'</h1>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-ux1-'));
 const chrome=spawn(CHROME,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let ws;
 try{
  let stderr='';chrome.stderr.on('data',b=>stderr+=b);
  for(let i=0;i<100&&!/ws:\/\/\S+/.test(stderr);i++)await sleep(100);
  const host=new URL(stderr.match(/ws:\/\/\S+/)[0]).host;
  const tab=await(await fetch('http://'+host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),console_=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(String(e.data));if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
   if(m.method==='Log.entryAdded')console_.push(m.params.entry.text);if(m.method==='Runtime.exceptionThrown')console_.push('EXCEPTION '+m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||'').slice(0,200)+' @'+(m.params.exceptionDetails.url||''));});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,m=>m.error?reject(Error(method+': '+m.error.message)):resolve(m.result));ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails).slice(0,400));return r.result.value;};
  const origin='http://127.0.0.1:'+server.address().port;
  await call('Page.enable');await call('Runtime.enable');await call('Log.enable');
  await call('Page.navigate',{url:origin+'/'});
  for(let i=0;i<100&&!(await ev('document.readyState==="complete"'));i++)await sleep(50);

  await t.test('speculation rules parse and only plain storefront pages are eligible for prefetch',async()=>{
   assert.equal(await ev('HTMLScriptElement.supports("speculationrules")'),true);
   assert.ok(!console_.some(m=>/speculation/i.test(m)),'no rule errors: '+console_.join(' | '));
   // Evaluate the rule set with the browser's own URLPattern and selector matching.
   const verdicts=await ev(`(()=>{const rules=JSON.parse(document.querySelector('script[type=speculationrules]').textContent).prefetch[0].where.and;
    const match=(p,href)=>[].concat(p).some(x=>new URLPattern(x,location.origin).test(href));
    const eligible=(href,attrs={})=>{const a=document.createElement('a');a.href=href;for(const [k,v] of Object.entries(attrs))a.setAttribute(k,v);
     return a.origin===location.origin&&match(rules[0].href_matches,a.href)&&!match(rules[1].not.href_matches,a.href)&&!a.matches(rules[2].not.selector_matches);};
    const urls={'/products/conditioner':{},'/collections/laundry':{},'/pages/about':{},'/':{},'/en/products/x':{},'/collections/laundry?page=2':{},
     '/cart':{},'/cart/add?id=1':{},'/cart/clear':{},'/en/cart':{},'/checkout':{},'/checkouts/abc':{},'/account/logout':{},'/en/account':{},'/admin/products':{},'/apps/reviews':{},
     '/services/login_with_shop':{},'/search?q=x':{},'/password':{},'https://example.org/products/x':{},'/products/y#download':{download:''},'/products/z':{target:'_blank'},'/products/n':{rel:'nofollow'},'/products/p':{'data-no-prefetch':''}};
    return Object.fromEntries(Object.entries(urls).map(([u,a])=>[u,eligible(new URL(u,location.origin).href,a)]));})()`);
   for(const url of ['/products/conditioner','/collections/laundry','/pages/about','/','/en/products/x','/collections/laundry?page=2'])assert.equal(verdicts[url],true,url);
   for(const [url,ok] of Object.entries(verdicts))if(!['/products/conditioner','/collections/laundry','/pages/about','/','/en/products/x','/collections/laundry?page=2'].includes(url))assert.equal(ok,false,url+' must never be prefetched');
  });

  await t.test('cross-document view transitions are declared, and off for reduced motion',async()=>{
   const rules=await ev(`[...document.styleSheets].flatMap(s=>[...s.cssRules]).map(r=>r.constructor.name+':'+(r.navigation||(r.media?r.media.mediaText:'')))`);
   assert.ok(rules.includes('CSSViewTransitionRule:auto'),rules.join(','));
   assert.ok(rules.some(r=>/^CSSMediaRule:.*prefers-reduced-motion: reduce/.test(r)));
  });

  await t.test('checkout, cart, external and new-tab links are never intercepted',async()=>{
   const prevented=await ev(`['product','checkout','cartlink','external','blank'].map(id=>{const a=document.getElementById(id);let seen=null;
    const spy=e=>{seen=e.defaultPrevented;e.preventDefault();};window.addEventListener('click',spy);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));window.removeEventListener('click',spy);return seen;})`);
   assert.deepEqual(prevented,[false,false,false,false,false]);
  });

  await t.test('RTL: shipping "1–2" and service-hour ranges keep their visual order',async()=>{
   // x(container, whole, part): screen x of `part` inside the text node that contains `whole`.
   const order=await ev(`(()=>{const x=(node,whole,part)=>{const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let n;
     while((n=walker.nextNode())){const i=n.textContent.indexOf(whole);if(i>=0){const r=document.createRange(),k=i+whole.indexOf(part);r.setStart(n,k);r.setEnd(n,k+part.length);return r.getBoundingClientRect().left;}}return null;};
    const s=document.getElementById('shipping'),f=document.getElementById('footer');
    return {one:x(s,'1–2','1'),two:x(s,'1–2','2'),six:x(f,'06:00–14:00','06:00'),fourteen:x(f,'06:00–14:00','14:00'),nine:x(f,'09:00 - 17:00','09:00'),seventeen:x(f,'09:00 - 17:00','17:00'),dir:getComputedStyle(s.querySelector('p')).direction};})()`);
   assert.equal(order.dir,'rtl');
   assert.ok(order.one<order.two,'1 is left of 2 ("1–2", not "2–1"): '+JSON.stringify(order));
   assert.ok(order.six<order.fourteen&&order.nine<order.seventeen,'start time on the left: '+JSON.stringify(order));
  });

  await t.test('related recommendations: Shopify suggestions that share a category first, unrelated/current/sold-out never',async()=>{
   await ev('__merge(document.querySelector("[data-rec-current]"))');
   for(let i=0;i<40&&!(await ev('!!window.__fetched'));i++)await sleep(25);await sleep(50);
   const shown=await ev('[...document.querySelectorAll("[data-rec-grid] > [data-rec-id] [data-handle]")].map(e=>e.dataset.handle)');
   // detergent and laundry-bag (laundry, in stock) come first; then the page's same-category cards; limit 4.
   assert.deepEqual(shown,['detergent','laundry-bag','softener-b','stain-remover']);
   assert.ok(!shown.includes('plates')&&!shown.includes('conditioner')&&!shown.includes('softener-out'));
   assert.equal(await ev('document.querySelector("[data-rec-current]").hidden'),false);
   assert.match(await ev('window.__fetched'),/product_id=1&limit=10&intent=related/);
  });
  assert.ok(!console_.some(m=>m.startsWith('EXCEPTION')),console_.join(' | '));
  await t.test('a real click on a checkout link navigates normally',async()=>{
   await call('Page.navigate',{url:origin+'/'});for(let i=0;i<100&&!(await ev('document.readyState==="complete"').catch(()=>false));i++)await sleep(50);
   await call('Runtime.evaluate',{expression:'setTimeout(()=>document.getElementById("checkout").click(),0)'});
   let pathname='';for(let i=0;i<80&&pathname!=='/checkout';i++){await sleep(50);pathname=await ev('location.pathname').catch(()=>'');}
   assert.equal(pathname,'/checkout');
  });
 }finally{ws?.close();chrome.kill();server.close();await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}}
});
