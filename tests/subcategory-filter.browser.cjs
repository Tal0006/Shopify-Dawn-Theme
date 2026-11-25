// In-page subcategories (assets/subcategory-filter.js, snippets/category-chips.liquid, sections/category-products.liquid):
// choosing a chip replaces the products in place, on the homepage rows and on collection pages. The real sections are
// rendered with liquidjs by a local server that answers like Shopify's Section Rendering API (pages, sorting, filters);
// the real storefront.js and subcategory-filter.js run in Chrome. No Shopify requests.
// Needs liquidjs (NODE_PATH) and Chrome (CHROME_PATH). SCREENSHOT_DIR=<folder> also saves screenshots.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=json('locales/he.default.json'),en=json('locales/en.json');
let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';

test('Contract: links without JavaScript, no page navigation, no hardcoded products, texts in both languages',()=>{
 const js=read('assets/subcategory-filter.js'),chips=read('snippets/category-chips.liquid'),results=read('sections/category-products.liquid');
 assert.doesNotMatch(js,/location\.(assign|replace|href\s*=)|pushState|innerHTML|insertAdjacentHTML|eval\(|setInterval|[֐-׿]/);
 assert.match(js,/history\.replaceState\(\{\.\.\.history\.state/,'other history state is kept');
 for(const source of [chips,results])assert.doesNotMatch(source,/collections\[|[֐-׿]/);
 assert.match(chips,/<li><a class="category-chip" href="{{ chip\.url }}"/);
 for(const key of ['all','all_label','loading','loaded','show_more','load_error','retry'])for(const locale of [he,en])assert.equal(typeof locale.collection_page[key],'string',key);
 assert.equal(he.collection_page.all,'כל המוצרים');
 assert.ok(he.collection_page.all_label.startsWith(he.collection_page.all),'accessible name starts with the visible text');
 const layout=read('layout/theme.liquid');
 assert.match(layout,/{% if request\.page_type == 'index' or request\.page_type == 'collection' %}\s*<script src="{{ 'subcategory-filter\.js' \| asset_url }}" defer><\/script>\s*{% endif %}/);
 // Both sections expose the same results area, and only sections with subcategories become interactive.
 for(const file of ['sections/featured-collection.liquid','sections/main-collection.liquid']){const s=read(file);assert.match(s,/id="SubcategoryResults-{{ section\.id }}" data-subcategory-results/,file);assert.match(s,/{% if [^%]+%} data-subcategory-root="{{ section\.id }}"/,file);}
});

// ---- Fixture: Liquid engine whose paginate tag really pages, like Shopify's.
function engine(globals,request){
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid',globals});
 const body=(end,render,init)=>({parse(token,remain){this.args=token.args;this.tpls=[];init?.call(this,token);const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',t=>this.tpls.push(t)).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(ctx,emitter){if(render)yield* render.call(this,ctx,emitter);}});
 for(const name of ['doc','stylesheet','schema'])liquid.registerTag(name,body('end'+name));
 liquid.registerTag('paginate',body('endpaginate',function*(ctx,emitter){
  const [,owner,by]=this.args.match(/^([\w.]+)\.products by ([\w.]+)/);
  const collection=yield this.liquid.evalValue(owner,ctx),size=Number(yield this.liquid.evalValue(by,ctx));
  const all=collection.products,pages=Math.max(1,Math.ceil(all.length/size)),current=Math.min(pages,request.page||1);
  const link=n=>{const p=new URLSearchParams(request.search);p.set('page',n);return request.path+'?'+p;};
  const paginate={pages,current_page:current,parts:Array.from({length:pages},(_,i)=>i+1===current?{title:current,is_link:false}:{title:i+1,is_link:true,url:link(i+1)}),next:current<pages?{url:link(current+1)}:null,previous:current>1?{url:link(current-1)}:null};
  collection.products=all.slice((current-1)*size,current*size);ctx.push({paginate});
  try{yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);}finally{ctx.pop();collection.products=all;}
 }));
 liquid.registerTag('form',body('endform',function*(ctx,emitter){const id=yield this.liquid.evalValue('card_form_id',ctx);emitter.write(`<form method="post" action="/cart/add" id="${id}" class="catalog-card__form" data-card-cart>`);yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');}));
 liquid.registerFilter('t',(key,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));let v=key.split('.').reduce((a,k)=>a?.[k],he);if(v&&typeof v==='object')v=o.count===1&&v.one?v.one:v.other;if(typeof v!=='string')return key;for(const [k,val] of Object.entries(o))v=v.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),val);return v;});
 liquid.registerFilter('money',c=>'₪'+(Number(c)/100).toFixed(2));
 liquid.registerFilter('image_url',img=>img?.src||img);
 liquid.registerFilter('image_tag',(src,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));return `<img src="${src}" alt="${o.alt??''}" width="300" height="300">`;});
 return liquid;
}
const variantOf=id=>({id,quantity_rule:{min:1,increment:1,max:null},inventory_management:'shopify',inventory_policy:'deny',inventory_quantity:20});
let seq=0;
const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="30" fill="#bfe9ee"/></svg>');
const product=(title,o={})=>{const id=++seq,variant=variantOf(500+id);return {id,title,handle:'p'+id,url:'/products/p'+id,available:true,variants:[variant],selected_or_first_available_variant:variant,requires_selling_plan:false,featured_image:{src:svg},price:1590,compare_at_price:null,price_varies:false,compare_at_price_varies:false,tags:[],vendor:'פאנקי',...o};};
const list=(name,n,o)=>Array.from({length:n},(_,i)=>product(name+' '+(i+1),o?.(i)||{}));
const collection=(title,handle,products,image)=>({title,handle,url:'/collections/'+handle,products,products_count:products.length,all_products_count:products.length,filters:[],sort_options:[],default_sort_by:'manual',sort_by:'',image:image?{src:svg}:null,description:''});
function catalog(){
 seq=0;
 const soft=list('מרכך',18,i=>({available:i!==0,compare_at_price:i===17?2500:null})),gel=list("ג'ל",5),powder=list('אבקה',60),ghost=list('נעלם',1);
 const shared=soft[3]; // one product in two subcategories and in both rows
 const laundry=collection('כביסה','laundry',[...gel,...soft,...powder],true);
 return {laundry,soft:collection('מרכך כביסה','soft',soft),gel:collection("ג'ל כביסה",'gel',[shared,...gel]),powder:collection('אבקת כביסה','powder',powder),ghost:collection('ריקה','ghost',ghost),none:collection('אפס','none',[]),
  cleaning:collection('ניקוי כללי','cleaning',list('ניקוי',20).concat(shared),true),floors:collection('רצפות','floors',[...list('רצפה',4),shared]),all:collection('הכול','all',list('כל',3))};
}

test('Liquid: a homepage row and its results section',{skip:SKIP},async()=>{
 const c=catalog(),liquid=engine({settings:{}},{path:'/collections/soft',search:''});
 const render=(col,page)=>engine({settings:{}},{path:col.url,search:'section_id=category-products',page}).parseAndRender(read('sections/category-products.liquid'),{collection:col,section:{id:'category-products'},cart:{items:[]},request:{page_type:'collection'}});
 const titles=h=>[...h.matchAll(/<h3><a href="[^"]*">([^<]+)<\/a>/g)].map(m=>m[1].replace('&#39;',"'"));
 const soft=titles(await render(c.soft));
 assert.equal(soft.length,18,'every product of the subcategory, h3 under the row heading');
 assert.equal(soft[0],'מרכך 18','discounted first');assert.equal(soft[17],'מרכך 1','sold out last');
 assert.match(await render(c.soft),/data-results-count="18" data-results-text="18 מוצרים">/);
 const first=await render(c.powder),second=await render(c.powder,2);
 assert.equal(titles(first).length,48);assert.equal(titles(second).length,12);assert.match(first,/data-results-next="\/collections\/powder\?section_id=category-products&amp;page=2"/);assert.doesNotMatch(second,/data-results-next/);
 assert.match(await render(c.none),/<div class="catalog-grid"><p>|<div class="catalog-grid">\s*<p>/,'empty state');
 const row=s=>liquid.parseAndRender(read('sections/featured-collection.liquid'),{section:{id:'r',settings:{collection:c.laundry,product_limit:8,max_sold_out:2,show_view_all:true,show_count:true,mobile_layout:'carousel',...s}},cart:{items:[]},request:{page_type:'index'}});
 const html=await row({subcategories:[c.soft,c.none]});
 assert.match(html,/data-subcategory-root="r" data-subcategory-mode="row" data-subcategory-section="category-products" data-subcategory-limit="8"/);
 assert.deepEqual([...html.matchAll(/data-subcategory="([^"]+)"/g)].map(m=>m[1]),['כביסה','מרכך כביסה'],'parent first, empty collections left out');
 assert.doesNotMatch(await row({}),/data-subcategory-root|category-chip/,'no subcategories: the row is unchanged');
});

test('Browser: choosing subcategories in place',{skip:SKIP,timeout:240000},async t=>{
 const c=catalog(),cart={},log=[];let failNext=0,delay={};
 const bySlug=Object.fromEntries(Object.values(c).map(x=>[x.handle,x]));
 const cartLines=()=>Object.entries(cart).filter(([,q])=>q>0).map(([id,q])=>({variant_id:Number(id),id:Number(id),quantity:q,key:id+':k'}));
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)?.[1]||'';
 const css=[read('tests/fixtures/bootstrap-5.0.1.min.css'),...['theme.css','storefront.css','accessibility.css'].map(f=>read('assets/'+f)),...['snippets/storefront-design.liquid','snippets/product-card.liquid','snippets/product-card-badges.liquid','snippets/category-chips.liquid','sections/featured-collection.liquid','sections/main-collection.liquid'].map(block)].join('\n');
 const header='<header class="storefront-header" data-cart-section="header"><button class="open-btn" type="button">תפריט</button><nav class="navigation-holder"><button class="menu-close" type="button">סגירה</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-label="סל" data-cart-error="שגיאה" data-cart-updated="עודכן" data-cart-stale="Stale"><button class="mini-cart-close">x</button><p data-cart-status role="status"></p><div class="mini-cart-items"></div></dialog></div></header>';
 const shell=(main,js=true)=>`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${header}<main data-storefront-home style="min-height:2400px">${main}</main><script>window.Shopify={routes:{root:'/'}};window.born=Math.random();</script>${js?'<script src="/assets/storefront.js"></script><script src="/assets/subcategory-filter.js"></script>':''}</body></html>`;
 const scope=(col,request)=>({cart:{items:cartLines()},request:{page_type:request.path==='/'?'index':'collection'},routes:{},settings:{catalog_collection:c.all},collection:col});
 // Shopify's snippets see the section; liquidjs needs it as a global.
 const row=(id,col,subs,request)=>engine({settings:{catalog_collection:c.all},section:{id},cart:{items:cartLines()}},request).parseAndRender(read('sections/featured-collection.liquid'),{...scope(col,request),section:{id,settings:{collection:col,product_limit:8,max_sold_out:2,show_view_all:true,show_count:true,mobile_layout:'carousel',subcategories:subs}}});
 const mainSection=(col,request)=>engine({settings:{catalog_collection:c.all},section:{id:'m'},cart:{items:cartLines()},request:{page_type:'collection'}},request).parseAndRender(read('sections/main-collection.liquid'),{...scope(col,request),section:{id:'m',settings:{product_limit:24},blocks:[{settings:{collection:c.laundry,subcategories:[c.soft,c.gel,c.powder,c.ghost]}},{settings:{collection:c.cleaning,subcategories:[c.floors]}}]}});
 // Like Shopify: sorting and the availability filter apply to whatever collection is asked for.
 const view=(col,params)=>{let products=[...col.products];if(params.get('filter.v.availability')==='1')products=products.filter(p=>p.available);const sort=params.get('sort_by')||'';if(sort==='title-descending')products.reverse();
  return {...col,products,products_count:products.length,sort_by:sort,sort_options:[{value:'manual',name:'מומלצים'},{value:'title-descending',name:'שם'}],filters:[{type:'list',param_name:'filter.v.availability',label:'זמינות',active_values:params.get('filter.v.availability')?[{value:'1',url_to_remove:col.url+'?section_id=m'}]:[],min_value:{},max_value:{},values:[{param_name:'filter.v.availability',value:'1',label:'במלאי',count:products.length,active:params.get('filter.v.availability')==='1'}]}]};};
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://x'),params=url.searchParams;
  const html=x=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(x);},data=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));};
  try{
   if(url.pathname.startsWith('/assets/')){res.setHeader('Content-Type','text/javascript');return res.end(read(url.pathname.slice(1)));}
   if(url.pathname==='/cart.js')return data({items:cartLines(),item_count:cartLines().length});
   if(url.pathname.startsWith('/cart/')){let b='';for await(const part of req)b+=part;b=JSON.parse(b||'{}');if(url.pathname.endsWith('add.js'))for(const i of b.items)cart[i.id]=(cart[i.id]||0)+Number(i.quantity);if(url.pathname.endsWith('change.js'))cart[String(b.id).split(':')[0]]=Number(b.quantity);return data({items:b.items?.map(i=>({id:Number(i.id),variant_id:Number(i.id),quantity:cart[i.id]}))||cartLines(),sections:{header}});}
   if(url.pathname.startsWith('/products/'))return html(shell('<h1>מוצר</h1>'));
   const request={path:url.pathname,search:url.search.slice(1),page:Number(params.get('page'))||1};
   const col=bySlug[url.pathname.split('/')[2]],section=params.get('section_id');
   if(section){
    log.push(decodeURIComponent(req.url));
    if(failNext>0){failNext--;res.statusCode=500;return res.end('x');}
    if(delay[col.handle])await sleep(delay[col.handle]);
    const shown=col.handle==='ghost'?{...col,products:[],products_count:0}:col;
    if(section==='category-products')return html('<div id="shopify-section-category-products">'+await engine({settings:{},section:{id:'category-products'},cart:{items:cartLines()},request:{page_type:'collection'}},request).parseAndRender(read('sections/category-products.liquid'),{...scope(shown,request),section:{id:'category-products'}})+'</div>');
    return html('<div id="shopify-section-m">'+await mainSection(view(shown,params),request)+'</div>');
   }
   if(col)return html(shell(await mainSection(view(col,params),request),!params.has('nojs')));
   if(url.pathname==='/')return html(shell('<div id="A">'+await row('A',c.laundry,[c.soft,c.gel,c.powder,c.ghost],request)+'</div><div id="B">'+await row('B',c.cleaning,[c.floors],request)+'</div>',!params.has('nojs')));
   res.statusCode=404;res.end();
  }catch(error){console.error(error);res.statusCode=500;res.end(String(error));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port,profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-subcategory-'));
 let chrome,ws;
 try{
  let stderr='';
  chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',d=>stderr+=d);chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\S+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\S+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(expression,tries=240)=>{for(let i=0;i<tries;i++){try{if(await ev(expression))return;}catch{}await sleep(25);}throw Error('Timeout: '+expression);};
  const key=async(name,code,n)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:n,...(type==='keyDown'?{text:name==='Enter'?'\r':name}:{})});};
  const load=async(url,width=1280)=>{await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<768});await call('Page.navigate',{url:'about:blank'});await wait('location.href==="about:blank"');await call('Page.navigate',{url:base+url});await wait('location.href!=="about:blank"');await wait('document.readyState==="complete"');log.length=0;delay={};return ev('window.born');};
  const shot=async name=>{if(process.env.SCREENSHOT_DIR){const s=await call('Page.captureScreenshot');fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR,'subcategory-'+name+'.png'),Buffer.from(s.data,'base64'));}};
  await call('Page.enable');await call('Runtime.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  const sel=s=>`document.querySelector('${s} [data-subcategory-root]')`;
  const state=(s='#A')=>ev(`(()=>{const r=${s==='page'?"document.querySelector('[data-subcategory-root]')":sel(s)},g=r.querySelector('[data-subcategory-results]'),ids={};document.querySelectorAll('[id]').forEach(e=>{const i=e.getAttribute('id');ids[i]=(ids[i]||0)+1;});
   return{chip:[...r.querySelectorAll('[aria-pressed=true]')].map(a=>a.textContent.trim()).join(),titles:[...g.querySelectorAll('.catalog-card h2 a,.catalog-card h3 a')].map(a=>a.textContent.trim()),count:(r.querySelector('[data-subcategory-count],.collection-page__count')||{}).textContent,more:g.querySelector('.catalog-more')?.textContent.trim(),url:location.pathname+location.search,born:window.born,h1:document.querySelector('h1')?.textContent,dup:Object.keys(ids).filter(i=>ids[i]>1),over:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,status:r.querySelector('[data-subcategory-status]').textContent,error:!r.querySelector('[data-subcategory-error]').hidden};})()`);
  const R=s=>s==='page'?"document.querySelector('[data-subcategory-root]')":sel(s);
  const click=(s,name)=>ev(`[...${R(s)}.querySelectorAll('[data-subcategory]')].find(a=>a.textContent.trim()===${JSON.stringify(name)}).click()`);
  const settled=s=>wait(`!${R(s)}.hasAttribute('data-subcategory-loading')`);
  const pick=async(s,name)=>{await click(s,name);await settled(s);return state(s);};

  for(const width of [1280,390])await t.test('Homepage '+width+'px: products change in place, steps, restore; the other row is untouched',async()=>{
   const born=await load('/',width),first=await state(),other=await state('#B');
   assert.equal(first.chip,'כל המוצרים');assert.equal(first.titles.length,8);
   const top=await ev(`(()=>{scrollTo(0,120);return ${sel('#A')}.querySelector('.category-chips').getBoundingClientRect().top})()`);
   let s=await pick('#A','מרכך כביסה');
   assert.equal(s.chip,'מרכך כביסה');assert.equal(s.titles.length,8);assert.ok(s.titles.every(x=>x.startsWith('מרכך')));assert.equal(s.titles[0],'מרכך 18');assert.equal(s.count,'18 מוצרים');assert.match(s.more,/עוד 10 מוצרים/);
   assert.equal(s.url,'/');assert.equal(s.born,born,'the page was not reloaded');assert.deepEqual(s.dup,[]);assert.equal(s.over,false);assert.match(s.status,/מרכך כביסה \(18\)/);
   assert.ok(Math.abs(await ev(`${sel('#A')}.querySelector('.category-chips').getBoundingClientRect().top`)-top)<2,'the chips stay where they were');await shot('home-'+width);
   await ev(`${sel('#A')}.querySelector('[data-subcategory-more]').click()`);assert.equal((await state()).titles.length,16);assert.equal(await ev('document.activeElement.textContent.trim()'),(await state()).titles[8],'focus moves to the first new product');
   await ev(`${sel('#A')}.querySelector('[data-subcategory-more]').click()`);s=await state();assert.equal(s.titles.length,18);assert.equal(s.more,undefined);assert.equal(new Set(s.titles).size,18);
   assert.equal(log.length,1,'one request for the whole subcategory');
   s=await pick('#A',"ג'ל כביסה");assert.equal(s.titles.length,6);assert.equal(s.more,undefined);
   await pick('#A','מרכך כביסה');await click('#A','מרכך כביסה');assert.equal(log.length,2,'kept results and repeated clicks need no request');
   s=await pick('#A','כל המוצרים');assert.deepEqual([s.titles,s.count,s.more],[first.titles,first.count,first.more]);assert.equal(log.length,2);
   assert.deepEqual((await state('#B')).titles,other.titles);s=await pick('#B','רצפות');assert.equal(s.titles.length,5);await pick('#A',"ג'ל כביסה");s=await state();assert.deepEqual(s.dup,[],'one product in two rows: no duplicate form ids');
  });
  await t.test('Larger subcategory: 8 at a time, the second page is fetched only when needed, no duplicates',async()=>{
   await load('/');let s=await pick('#A','אבקת כביסה');assert.equal(s.count,'60 מוצרים');
   for(let n=16;n<=48;n+=8){await ev(`${sel('#A')}.querySelector('[data-subcategory-more]').click()`);await wait(`${sel('#A')}.querySelectorAll('.catalog-card').length===${n}`);}
   assert.equal(log.length,1);await ev(`(()=>{const b=${sel('#A')}.querySelector('[data-subcategory-more]');b.click();b.click();})()`);await wait(`${sel('#A')}.querySelectorAll('.catalog-card').length===56`);
   assert.equal(log.length,2);assert.match(log[1],/page=2/);await ev(`${sel('#A')}.querySelector('[data-subcategory-more]').click()`);await wait(`${sel('#A')}.querySelectorAll('.catalog-card').length===60`);
   s=await state();assert.equal(new Set(s.titles).size,60);assert.equal(s.more,undefined);
  });
  await t.test('Quick switching: the last choice wins even when an earlier answer arrives later',async()=>{
   await load('/');delay={soft:500,powder:250};await click('#A','מרכך כביסה');await click('#A','אבקת כביסה');await click('#A',"ג'ל כביסה");await settled('#A');await sleep(700);
   let s=await state();assert.equal(s.chip,"ג'ל כביסה");assert.equal(s.titles.length,6);
   delay={soft:400};await click('#A','מרכך כביסה');assert.equal(await ev(`${sel('#A')}.querySelector('[data-subcategory-results]').getAttribute('aria-busy')`),'true');assert.equal((await state()).status,he.collection_page.loading);
   await click('#A','כל המוצרים');await sleep(700);s=await state();assert.equal(s.chip,'כל המוצרים');assert.equal(s.titles.length,8);assert.equal(await ev(`${sel('#A')}.querySelector('[data-subcategory-results]').hasAttribute('aria-busy')`),false);
  });
  await t.test('Empty result, error and retry',async()=>{
   await load('/');let s=await pick('#A','ריקה');assert.equal(s.titles.length,0);assert.match(await ev(`${sel('#A')}.querySelector('[data-subcategory-results]').textContent`),new RegExp(he.sections.collection_template.empty));
   const before=await pick('#A',"ג'ל כביסה");failNext=1;s=await pick('#A','מרכך כביסה');
   assert.equal(s.error,true);assert.equal(s.chip,"ג'ל כביסה",'the chip matches what is on screen');assert.deepEqual(s.titles,before.titles);
   assert.equal(await ev(`${sel('#A')}.querySelector('[data-subcategory-error]').getAttribute('role')`),'alert');await shot('error');
   await ev(`${sel('#A')}.querySelector('[data-subcategory-retry]').click()`);await settled('#A');s=await state();assert.equal(s.error,false);assert.equal(s.chip,'מרכך כביסה');assert.equal(s.titles.length,8);
  });
  await t.test('Cart: adding from an in-page card, and quantities stay right after switching',async()=>{
   const born=await load('/');await pick('#A','מרכך כביסה');const v=await ev(`${sel('#A')}.querySelector('[data-subcategory-results] [data-card-cart] [name=id]').value`);
   const card=`${sel('#A')}.querySelector('[data-variant-id="${v}"]')`,inCart=async()=>ev(`${card}.hidden?0:Number(${card}.querySelector('[data-card-in-cart-count]').textContent)`);
   await ev(`${card}.closest('form').querySelector('[name=add]').click()`);await wait(`!${card}.hidden`);assert.equal(cart[v],1);assert.equal(await inCart(),1);assert.equal(await ev('window.born'),born);assert.equal(await ev(`document.querySelector('.cart-drawer').open`),false);
   await pick('#A','כל המוצרים');await pick('#A','מרכך כביסה');assert.equal(await inCart(),1,'still in the cart');
   await ev(`${card}.querySelector('[data-card-line-change="-1"]').click()`);await wait(`${card}.hidden`);assert.equal(cart[v],0);
   await pick('#A',"ג'ל כביסה");await pick('#A','מרכך כביסה');assert.equal(await inCart(),0,'removed stays removed');
   // A product of the original row, in the cart at page load, removed elsewhere while another subcategory was shown.
   const g=c.laundry.products[0].variants[0].id;cart[g]=1;await load('/');const first=`${sel('#A')}.querySelector('[data-variant-id="${g}"]')`;assert.equal(await ev(`${first}.hidden`),false);
   await pick('#A','מרכך כביסה');cart[g]=0;await ev(`new Promise(r=>{document.addEventListener('storefront:cart:updated',()=>r(1),{once:true});window.dispatchEvent(new Event('focus'));})`);
   await pick('#A','כל המוצרים');assert.equal(await ev(`${first}.hidden`),true,'the restored card follows the cart');
  });
  await t.test('Keyboard and screen readers: buttons with a pressed state, Space and Enter, focus stays, other clicks are left alone',async()=>{
   const born=await load('/');
   assert.deepEqual(await ev(`[...${sel('#A')}.querySelectorAll('[data-subcategory]')].map(a=>[a.getAttribute('role'),a.getAttribute('aria-pressed'),a.hasAttribute('aria-current'),!!document.getElementById(a.getAttribute('aria-controls')),a.hasAttribute('data-no-prefetch'),a.getBoundingClientRect().height>=44])`),[true,false,false,false,false].map(p=>['button',String(p),false,true,true,true]));
   await ev(`${sel('#A')}.querySelectorAll('[data-subcategory]')[1].focus()`);await key(' ','Space',32);await settled('#A');let s=await state();assert.equal(s.chip,'מרכך כביסה');assert.equal(await ev('document.activeElement.textContent.trim()'),'מרכך כביסה');
   await ev(`${sel('#A')}.querySelectorAll('[data-subcategory]')[2].focus()`);await key('Enter','Enter',13);await settled('#A');s=await state();assert.equal(s.chip,"ג'ל כביסה");assert.equal(s.born,born);
   for(const init of ['ctrlKey:true','metaKey:true','shiftKey:true','button:1'])assert.equal(await ev(`(()=>{let taken;addEventListener('click',e=>{taken=e.defaultPrevented;e.preventDefault();},{once:true});${sel('#A')}.querySelectorAll('[data-subcategory]')[1].dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,${init}}));return taken;})()`),false,init);
  });
  await t.test('Reload and Back keep the choice; the address never changes and no history entry is added',async()=>{
   await load('/');const entries=await ev('history.length');await ev(`history.replaceState({mine:1},'')`);await pick('#A','מרכך כביסה');await pick('#B','רצפות');assert.equal(await ev('history.length'),entries);assert.equal(await ev('history.state.mine'),1);
   await call('Page.reload');await sleep(300);await wait(`document.readyState==='complete'&&${sel('#A')}.querySelector('[aria-pressed=true]')?.textContent.trim()==='מרכך כביסה'`);await settled('#A');await settled('#B');assert.equal((await state()).count,'18 מוצרים');assert.equal((await state('#B')).chip,'רצפות');
   await ev(`${sel('#A')}.querySelector('.catalog-card h3 a').click()`);await wait('location.pathname.startsWith("/products/")');await ev('history.back()');await wait(`location.pathname==='/'&&document.readyState==='complete'&&${sel('#A')}.querySelector('[aria-pressed=true]')?.textContent.trim()==='מרכך כביסה'`);await settled('#A');assert.equal((await state()).count,'18 מוצרים');
   await pick('#A','כל המוצרים');await call('Page.reload');await sleep(400);await wait('document.readyState==="complete"');assert.equal((await state()).chip,'כל המוצרים');
  });
  for(const width of [1280,390])await t.test('Collection page '+width+'px: results, sorting, filters and pages change in place; the heading stays',async()=>{
   const born=await load('/collections/laundry',width),first=await state('page');assert.equal(first.titles.length,24);
   let s=await pick('page','מרכך כביסה');assert.equal(s.titles.length,18);assert.equal(s.url,'/collections/laundry');assert.equal(s.born,born);assert.equal(s.h1,'כביסה');assert.deepEqual(s.dup,[]);assert.equal(s.over,false);assert.match(s.count,/18/);await shot('page-'+width);
   const submit=x=>ev(`(()=>{const f=${R('page')}.querySelector('.catalog-filters');${x};f.requestSubmit();})()`);
   await submit(`f.querySelector('select').value='title-descending'`);await settled('page');s=await state('page');assert.equal(s.born,born);assert.equal(s.titles[0],'מרכך 18');assert.equal(await ev(`${R('page')}.querySelector('select').value`),'title-descending');assert.equal(await ev('document.activeElement.className'),'collection-page__count');
   await submit(`f.querySelector('[type=checkbox]').checked=true`);await settled('page');s=await state('page');assert.equal(s.titles.length,17,'sold out left out');
   s=await pick('page','אבקת כביסה');assert.match(log.at(-1),/sort_by=title-descending/);assert.match(log.at(-1),/filter\.v\.availability=1/,'sorting and filters stay on when switching');assert.equal(s.titles.length,24);
   await ev(`${R('page')}.querySelector('.catalog-pagination a[href*="page=3"]').click()`);await settled('page');s=await state('page');assert.equal(s.titles.length,12,'page 3 of 60');assert.equal(s.born,born);assert.equal(s.url,'/collections/laundry');assert.equal(s.chip,'אבקת כביסה');
   assert.equal(await ev(`document.querySelectorAll('[data-subcategory-results] a[href*=section_id]').length`),0,'links never point at a bare section');
   await ev(`[...${R('page')}.querySelectorAll('.catalog-active-filters a')].pop().click()`);await settled('page');s=await state('page');assert.equal(s.titles.length,24);assert.equal(s.born,born);
   s=await pick('page','כל המוצרים');assert.deepEqual(s.titles,first.titles);assert.equal(s.count,first.count);
   // Outside the subcategory view everything navigates as before.
   await ev(`${R('page')}.querySelector('.catalog-pagination a[href*="page=2"]').click()`);await wait('location.search.includes("page=2")&&document.readyState==="complete"');
   await ev(`[...document.querySelectorAll('.collection-page__nav > .category-chips:first-child a')].find(a=>a.textContent.trim()==='ניקוי כללי').click()`);await wait('location.pathname==="/collections/cleaning"&&document.readyState==="complete"');
  });
  await t.test('Direct link to a subcategory: its own page as before; from there the heading follows the choice',async()=>{
   const born=await load('/collections/soft');let s=await state('page');assert.equal(s.chip,'מרכך כביסה');assert.equal(s.h1,'מרכך כביסה');assert.equal(log.length,0);
   s=await pick('page','כל המוצרים');assert.equal(s.h1,'כביסה');assert.equal(s.titles.length,24);assert.equal(s.url,'/collections/soft');assert.equal(s.born,born);
   await ev(`${R('page')}.querySelector('.catalog-pagination a[href*="page=2"]').click()`);await settled('page');assert.equal((await state('page')).h1,'כביסה');
   await call('Page.reload');await sleep(300);await wait(`document.readyState==='complete'&&document.querySelector('h1').textContent==='כביסה'`);
   s=await pick('page','מרכך כביסה');assert.equal(s.h1,'מרכך כביסה');assert.equal(s.titles.length,18);
   await load('/collections/soft?filter.v.availability=1');s=await state('page');assert.equal(s.titles.length,17);await pick('page',"ג'ל כביסה");assert.match(log.at(-1),/availability=1/);s=await pick('page','מרכך כביסה');assert.equal(s.titles.length,17,'the filtered page the shopper opened');
  });
  await t.test('Narrow screens: chips scroll inside their row, the chosen chip comes into view, no page overflow',async()=>{
   for(const width of [320,768]){await load('/',width);const s=await pick('#A','ריקה');assert.equal(s.over,false,String(width));const r=await ev(`(()=>{const u=${sel('#A')}.querySelector('.category-chips'),b=u.getBoundingClientRect(),c=u.querySelector('[aria-pressed=true]').getBoundingClientRect();return c.left>=b.left-1&&c.right<=b.right+1;})()`);assert.equal(r,true,'chosen chip visible at '+width);}
  });
  await t.test('Without JavaScript the chips are links to the collections',async()=>{
   await load('/?nojs=1');assert.deepEqual(await ev(`[...document.querySelectorAll('#A [data-subcategory]')].map(a=>a.getAttribute('href')+(a.getAttribute('aria-current')||'')+(a.getAttribute('role')||''))`),['/collections/laundrypage','/collections/soft','/collections/gel','/collections/powder','/collections/ghost']);
   await ev(`document.querySelectorAll('#A [data-subcategory]')[1].click()`);await wait('location.pathname==="/collections/soft"');
  });
  assert.deepEqual(errors,[]);
 }finally{
  ws?.close();chrome?.kill();server.closeAllConnections();server.close();await sleep(300);
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
});
