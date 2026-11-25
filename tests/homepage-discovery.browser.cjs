// Homepage product discovery and category navigation: "more products" tile, view-all texts, product counts, promotions
// first, sub-category chips, the mobile carousel, collection-page category links, and add to cart from a carousel card.
// Static checks always run; Liquid rendering and browser checks need liquidjs (NODE_PATH) and Chrome (CHROME_PATH).
// SCREENSHOT_DIR=<folder> also saves screenshots of every tested width.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const json=file=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,''));
const he=json('locales/he.default.json');
const schemaOf=file=>JSON.parse(read(file).match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
const SECTIONS=['sections/featured-collection.liquid','sections/main-collection.liquid'];

test('Contract: configurable collections, texts in both locales, templates use declared settings only',()=>{
 const locales=['locales/he.schema.json','locales/en.default.schema.json'].map(json);
 for(const file of SECTIONS)for(const key of (read(file).match(/"t:[\w.-]+/g)||[]).map(k=>k.slice(1)))for(const locale of locales)assert.equal(typeof key.slice(2).split('.').reduce((a,k)=>a?.[k],locale),'string',file+' '+key);
 // No collection handle is written in Liquid: only in the editable templates.
 for(const file of [...SECTIONS,'snippets/category-chips.liquid','sections/category-navigation.liquid'])assert.doesNotMatch(read(file),/collections\[|[֐-׿]/,file);
 const index=json('templates/index.json'),featured=schemaOf(SECTIONS[0]);
 const ids=new Set(featured.settings.map(s=>s.id)),limit=featured.settings.find(s=>s.id==='subcategories').limit;
 const rows=Object.values(index.sections).filter(s=>s.type==='featured-collection'&&s.settings.collection);
 assert.ok(rows.length>=3);
 for(const row of rows){
  for(const id of Object.keys(row.settings))assert.ok(ids.has(id),id);
  assert.equal(row.settings.show_view_all,true);assert.match(row.settings.view_all_text,/^לכל /,'every featured collection has its own link text');
  assert.ok(row.settings.product_limit>=4&&row.settings.product_limit<=8,'4-8 products per collection');
  assert.ok((row.settings.subcategories||[]).length<=limit);
 }
 const main=json('templates/collection.json').sections.main,declared=schemaOf(SECTIONS[1]);
 assert.deepEqual(main.block_order.slice().sort(),Object.keys(main.blocks).sort());
 for(const block of Object.values(main.blocks))for(const id of Object.keys(block.settings))assert.ok(declared.blocks[0].settings.some(s=>s.id===id),id);
 // The collection page lists the same main categories as the homepage rows.
 assert.deepEqual(Object.values(main.blocks).map(b=>b.settings.collection).sort(),rows.map(r=>r.settings.collection).sort());
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
const SKIP=Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)';
function engine(globals={}){
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid',globals});
 const body=(tag,end)=>({parse(token,remain){this.tpls=[];const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',t=>this.tpls.push(t)).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(ctx,emitter){if(tag)yield* tag.call(this,ctx,emitter);}});
 for(const name of ['doc','stylesheet','schema'])liquid.registerTag(name,body(null,'end'+name));
 liquid.registerTag('paginate',body(function*(ctx,emitter){yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);},'endpaginate'));
 liquid.registerTag('form',body(function*(ctx,emitter){emitter.write('<form method="post" action="/cart/add" class="catalog-card__form" data-card-cart>');yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');},'endform'));
 liquid.registerFilter('t',(key,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));let v=key.split('.').reduce((a,k)=>a?.[k],he);
  if(v&&typeof v==='object')v=o.count===1&&v.one?v.one:v.other;if(typeof v!=='string')return key;
  for(const [k,val] of Object.entries(o))v=v.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),val);return v;});
 liquid.registerFilter('money',c=>'₪'+(Number(c)/100).toFixed(2));
 liquid.registerFilter('image_url',img=>img?.src||img);
 liquid.registerFilter('image_tag',(src,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));return `<img src="${src}" alt="${o.alt??''}" sizes="${o.sizes||''}" loading="${o.loading||''}" width="300" height="300">`;});
 return liquid;
}
let seq=0;
const product=(title,o={})=>{const id=++seq,variant={id:500+id,quantity_rule:{min:1,increment:1,max:null},inventory_management:null,inventory_policy:'deny',inventory_quantity:0};
 return {id,title,url:'/products/p'+id,available:true,variants:[variant],selected_or_first_available_variant:variant,requires_selling_plan:false,featured_image:null,price:1590,compare_at_price:null,price_varies:false,compare_at_price_varies:false,tags:[],vendor:'פאנקי',...o};};
const collection=(title,count,products=[])=>({title,handle:title,url:'/collections/'+title,products_count:count,all_products_count:count,products,filters:[],sort_options:[],image:null,description:''});
const titles=html=>[...html.matchAll(/<h[23]><a href="[^"]*">([^<]+)<\/a>/g)].map(m=>m[1]);
const featured=(liquid,settings,id='f')=>liquid.parseAndRender(read(SECTIONS[0]),{section:{id,settings:{heading:'כביסה',product_limit:8,max_sold_out:2,show_view_all:true,show_count:true,mobile_layout:'carousel',...settings}},cart:{items:[]},request:{page_type:'index'}});

test('Screen-reader labels: product names are escaped once (the Shopify t filter already escapes its values)',async()=>{
 const files=['sections','snippets','layout'].flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(f=>f.endsWith('.liquid')).map(f=>dir+'/'+f));
 for(const file of files)assert.doesNotMatch(read(file),/\| t: \w+: [\w.]*(title|name) \| escape(?!_once)/,file);
 if(!Liquid)return;
 // Like Shopify: t escapes interpolated values, so a second plain escape would print &amp;#39;.
 const liquid=new Liquid();liquid.registerFilter('t',(key,[,v])=>'הוספה: '+v.replace(/&/g,'&amp;').replace(/'/g,'&#39;'));
 assert.equal(await liquid.parseAndRender("{{ 'x' | t: title: name | escape_once }}",{name:"ג'ל"}),'הוספה: ג&#39;ל');
});

test('Liquid: featured collection',{skip:SKIP},async t=>{
 const liquid=engine();
 const eighteen=()=>Array.from({length:18},(_,i)=>product('מוצר '+(i+1)));
 await t.test('8 of 18 shown; count, view-all text and a "10 more products" tile, all to the collection',async()=>{
  const html=await featured(liquid,{collection:collection('כביסה',18,eighteen()),view_all_text:'לכל מוצרי הכביסה'});
  assert.equal(titles(html).length,8);
  assert.match(html,/catalog-section-header__count">18 מוצרים</);
  assert.match(html,/<a class="catalog-section-header__link" href="\/collections\/כביסה">לכל מוצרי הכביסה<\/a>/);
  assert.match(html,/<a class="catalog-more" href="\/collections\/כביסה"><span class="catalog-more__count">עוד 10 מוצרים<\/span> <span class="catalog-more__text">לכל מוצרי הכביסה<\/span><\/a>/);
  assert.equal((html.match(/data-card-cart/g)||[]).length,8,'every card keeps the AJAX form');
 });
 await t.test('Automatic text when none is set; singular; no tile when everything is shown or links are off',async()=>{
  const nine=Array.from({length:9},(_,i)=>product('מוצר '+i));
  const html=await featured(liquid,{collection:collection('כביסה',9,nine)});
  assert.match(html,/לכל המוצרים בקטגוריית כביסה/);assert.match(html,/עוד מוצר אחד/);
  assert.doesNotMatch(await featured(liquid,{collection:collection('כביסה',8,nine.slice(0,8))}),/catalog-more"/);
  const off=await featured(liquid,{collection:collection('כביסה',9,nine),show_view_all:false,show_count:false});
  assert.doesNotMatch(off,/class="catalog-more"|catalog-section-header__link"|catalog-section-header__count/);
  assert.doesNotMatch(await featured(liquid,{collection:collection('ריק',0,[])}),/class="catalog-more"|catalog-section-header__count/,'empty collection: no tile, no zero count');
  assert.equal((await featured(liquid,{})).trim(),'','no collection chosen: nothing');
  assert.match(await featured(liquid,{collection:collection('x',9,nine),view_all_text:'<b>x</b>'}),/&lt;b&gt;x&lt;\/b&gt;/);
 });
 await t.test('Promotions first among in-stock products, each product once; sold-out promotions never jump ahead',async()=>{
  const list=[product('רגיל א'),product('אזל במבצע',{available:false,compare_at_price:2000}),product('מבצע א',{compare_at_price:2000}),product('תגית',{tags:['מבצע']}),product('רגיל ב'),product('מבצע ב',{compare_at_price:1600})];
  const c=collection('x',6,list);
  assert.deepEqual(titles(await featured(liquid,{collection:c})),['מבצע א','מבצע ב','רגיל א','תגית','רגיל ב','אזל במבצע']);
  assert.deepEqual(titles(await featured(liquid,{collection:c,promotion_tag:'מבצע'})),['מבצע א','תגית','מבצע ב','רגיל א','רגיל ב','אזל במבצע']);
  assert.deepEqual(titles(await featured(liquid,{collection:c,product_limit:2})),['מבצע א','מבצע ב']);
  const html=await featured(liquid,{collection:c});assert.match(html,/catalog-card__badge--discount/);assert.match(html,/<s><bdi>₪20.00/);
 });
 await t.test('Sub-category chips: labelled list, empty collections skipped, nothing when none is left',async()=>{
  const html=await featured(liquid,{collection:collection('כביסה',1,[product('x')]),subcategories:[collection("ג'ל כביסה",12),collection('ריק',0)]});
  assert.match(html,/<ul class="category-chips" role="list" aria-label="תתי־קטגוריות: כביסה">/);
  assert.equal((html.match(/class="category-chip"/g)||[]).length,1);
  assert.doesNotMatch(await featured(liquid,{collection:collection('כביסה',1,[product('x')]),subcategories:[collection('ריק',0)]}),/category-chips"/);
 });
 await t.test('Category tiles show the product count; empty collections stay out of the collection list',async()=>{
  const nav=await liquid.parseAndRender(read('sections/category-navigation.liquid'),{section:{settings:{},blocks:[{settings:{collection:collection('כביסה',18)}},{settings:{collection:collection('גדול',70)}},{settings:{}}]},request:{}});
  assert.match(nav,/<span>כביסה <small class="catalog-category__count">18 מוצרים<\/small><\/span>/);assert.match(nav,/70 מוצרים<\/small>/);
  const list=await liquid.parseAndRender(read('sections/main-list-collections.liquid'),{collections:[collection('כביסה',26),collection('ריק',0)],paginate:{pages:1}});
  assert.equal((list.match(/class="catalog-category"/g)||[]).length,1);
 });
});

test('Liquid: collection page category links',{skip:SKIP},async()=>{
 const laundry=collection('כביסה',26),gel=collection('גל',12),stain=collection('מסיר',10),cleaning=collection('ניקיון',34),floors=collection('רצפות',12),all=collection('הכול',152),other=collection('אחר',3);
 const blocks=[{settings:{collection:laundry,subcategories:[gel,stain]}},{settings:{collection:cleaning,subcategories:[floors,stain]}},{settings:{}}];
 const nav=async(current,withBlocks=blocks)=>{const liquid=engine({settings:{catalog_collection:all},collection:current,routes:{}});
  return (await liquid.parseAndRender(read(SECTIONS[1]),{section:{id:'m',settings:{product_limit:24},blocks:withBlocks},collection:current,settings:{catalog_collection:all},cart:{items:[]},request:{page_type:'collection'},paginate:{pages:1}})).match(/<nav class="collection-page__nav"[\s\S]*?<\/nav>/)?.[0]||'';};
 const links=html=>[...html.matchAll(/href="\/collections\/([^"]+)"(?: aria-current="(\w+)")?/g)].map(m=>m[2]?m[1]+':'+m[2]:m[1]);
 assert.deepEqual(links(await nav(laundry)),['כביסה:page','ניקיון','הכול','כביסה:page','גל','מסיר'],'main category: its sub-categories, "all" current');
 assert.deepEqual(links(await nav(floors)),['כביסה','ניקיון:true','הכול','ניקיון','רצפות:page','מסיר'],'sub-category: its parent is marked and linked');
 assert.deepEqual(links(await nav(stain)),['כביסה:true','ניקיון','הכול','כביסה','גל','מסיר:page'],'listed twice: the first parent');
 assert.deepEqual(links(await nav(other)),['כביסה','ניקיון','הכול'],'unlisted collection: main categories only');
 assert.deepEqual(links(await nav(all)),['כביסה','ניקיון','הכול:page']);
 assert.match(await nav(floors),/aria-label="מעבר בין קטגוריות"/);assert.match(await nav(floors),/aria-label="תתי־קטגוריות: ניקיון"/);
 assert.equal(await nav(laundry,[]),'','no blocks: no navigation, as before');
});

test('Liquid: collection page order is discounted in stock, in stock, sold out; a chosen sort is kept',{skip:SKIP},async()=>{
 const list=[product('רגיל'),product('אזל במבצע',{available:false,compare_at_price:2000}),product('מבצע',{compare_at_price:2000}),product('תגית',{tags:['מבצע']})];
 const run=sort=>engine().parseAndRender(read(SECTIONS[1]),{section:{id:'m',settings:{product_limit:24},blocks:[]},collection:{...collection('x',4,list),default_sort_by:'most-relevant',sort_by:sort},settings:{},cart:{items:[]},request:{page_type:'collection'},paginate:{pages:1}});
 assert.deepEqual(titles(await run('')),['מבצע','רגיל','תגית','אזל במבצע'],'a promotion tag alone is not a discount');
 assert.deepEqual(titles(await run('most-relevant')),['מבצע','רגיל','תגית','אזל במבצע']);
 assert.deepEqual(titles(await run('price-ascending')),['רגיל','מבצע','תגית','אזל במבצע']);
});

test('Browser: layout at every width, RTL, touch targets, carousel and add to cart',{skip:SKIP,timeout:240000},async t=>{
 const liquid=engine();
 const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" rx="30" fill="#bfe9ee"/></svg>');
 const names=['מקסימה קריסטל נואר ג׳ל כביסה','מרכך כביסה אולטרה פרש 4 ליטר','אבקת כביסה תינוקלין','מקסימה קפסולות לכביסה פלורל ברסט'];
 const list=n=>Array.from({length:n},(_,i)=>product(names[i%4],{featured_image:{src:svg},compare_at_price:i===0?2500:null}));
 const chips=['ג׳ל כביסה','אבקת כביסה','מרכך כביסה','מסיר כתמים','קפסולות'].map(x=>collection(x,5));
 const a=await featured(liquid,{collection:collection('כביסה',26,list(26)),view_all_text:'לכל מוצרי הכביסה',subcategories:chips},'a');
 const b=await featured(liquid,{heading:'חד־פעמי',product_limit:7,collection:collection('חד',9,list(9)),view_all_text:'לכל המוצרים החד־פעמיים'},'b');
 const g=await featured(liquid,{heading:'רשת',collection:collection('רשת',26,list(26)),mobile_layout:'grid'},'g');
 const laundry=collection('כביסה',26),catalog=collection('כל המוצרים',152);
 const page=await engine({settings:{catalog_collection:catalog}}).parseAndRender(read(SECTIONS[1]),{section:{id:'m',settings:{product_limit:24},blocks:[{settings:{collection:laundry,subcategories:chips}},...['ניקיון כללי','טואלטיקה','חד פעמי'].map(x=>({settings:{collection:collection(x,9)}}))]},collection:laundry,settings:{catalog_collection:catalog},cart:{items:[]},request:{page_type:'collection'},paginate:{pages:1}});
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)?.[1]||'';
 const css=[read('tests/fixtures/bootstrap-5.0.1.min.css'),...['theme.css','storefront.css','accessibility.css'].map(f=>read('assets/'+f)),...['snippets/storefront-design.liquid','snippets/product-card.liquid','snippets/product-card-badges.liquid','snippets/category-chips.liquid','sections/featured-collection.liquid','sections/main-collection.liquid'].map(block)].join('\n');
 const html=`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><header class="storefront-header" data-cart-section="header"><button class="open-btn" type="button">תפריט</button><nav class="navigation-holder"><button class="menu-close" type="button">סגירה</button></nav><div class="mini-cart"><button class="cart-toggle-btn" data-count-label="Cart __COUNT__"><span class="cart-count">0</span></button><dialog class="mini-cart-content cart-drawer" aria-label="סל" data-cart-error="שגיאה" data-cart-updated="עודכן" data-cart-stale="Stale"><button class="mini-cart-close">x</button><p data-cart-status role="status"></p><div class="mini-cart-items"></div></dialog></div></header><main data-storefront-home><div class="shopify-section" id="A">${a}</div><div class="shopify-section" id="B">${b}</div><div class="shopify-section" id="G">${g}</div></main><div id="C">${page}</div></body></html>`;
 const server=http.createServer((_q,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-discovery-'));
 const exe=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
 let chrome,ws;
 try{
  let stderr='';
  chrome=spawn(exe,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  chrome.stderr.on('data',d=>stderr+=d.toString());chrome.on('error',()=>{});
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr);i++)await sleep(100);
  const browserWS=stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];assert.ok(browserWS,'Headless Chrome did not start');
  const tab=await(await fetch('http://'+new URL(browserWS).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async(expression,tries=200)=>{for(let i=0;i<tries;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const load=async width=>{
   await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:width<768});
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await wait('document.readyState==="complete"');
   if(process.env.SCREENSHOT_DIR){const shot=await call('Page.captureScreenshot',{captureBeyondViewport:true});fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR,'home-'+width+'.png'),Buffer.from(shot.data,'base64'));}
  };
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  // For a section: distinct card columns, whether the last row is full, and the tile's shape.
  const layout=sel=>ev(`(()=>{const g=document.querySelector('${sel} .catalog-grid'),kids=[...g.children].map(e=>e.getBoundingClientRect()),cards=[...g.querySelectorAll('.catalog-card')].map(e=>e.getBoundingClientRect()),more=g.querySelector('.catalog-more')?.getBoundingClientRect(),box=g.getBoundingClientRect();
   const bottom=Math.max(...kids.map(k=>Math.round(k.top))),last=kids.filter(k=>Math.abs(k.top-bottom)<2);
   return {columns:new Set(cards.map(c=>Math.round(c.left))).size,rows:new Set(cards.map(c=>Math.round(c.top))).size,lastRowFull:Math.abs(Math.max(...last.map(k=>k.right))-box.right)<2&&Math.abs(Math.min(...last.map(k=>k.left))-box.left)<2,more:more&&{w:Math.round(more.width),h:Math.round(more.height)},card:Math.round(cards[0].width),scrolls:g.scrollWidth>g.clientWidth+2};})()`);
  const common=async width=>{
   assert.equal(await ev('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),true,'no horizontal page scroll at '+width);
   assert.equal(await ev('[...document.querySelectorAll(".category-chip,.catalog-more,.catalog-section-header__link")].every(e=>e.getBoundingClientRect().height>=44)'),true,'44px targets at '+width);
   assert.equal(await ev('[...document.querySelectorAll(".catalog-card")].every(c=>c.scrollWidth<=c.clientWidth+1)'),true,'no card content is cut at '+width);
   assert.equal(await ev('getComputedStyle(document.querySelector(".catalog-grid")).direction'),'rtl');
  };
  for(const [width,columns] of [[1440,4],[1280,4],[1024,4],[768,3]])await t.test(width+'px: '+columns+' columns, the tile completes the last row',async()=>{
   await load(width);await common(width);
   for(const sel of ['#A','#B']){const l=await layout(sel);assert.equal(l.columns,columns,sel);assert.equal(l.lastRowFull,true,sel+' '+JSON.stringify(l));assert.equal(l.scrolls,false);}
   if(width>=992)assert.ok((await layout('#A')).more.h<=90,'8 products + a slim full-width bar');
  });
  for(const width of [390,320])await t.test(width+'px: one sideways row with a visible next card; the tile is last; grid mode still available',async()=>{
   await load(width);await common(width);
   const l=await layout('#A');assert.equal(l.rows,1);assert.equal(l.scrolls,true);assert.ok(l.card>=150);
   // RTL: the row starts on the right, and part of another card is visible on the left edge.
   const edge=await ev(`(()=>{const g=document.querySelector('#A .catalog-grid'),b=g.getBoundingClientRect(),c=[...g.querySelectorAll('.catalog-card')].map(e=>e.getBoundingClientRect());return {first:c[0].right<=b.right&&c[0].right>b.right-30,peek:c.some(r=>r.left<b.left&&r.right>b.left+8)};})()`);
   assert.deepEqual(edge,{first:true,peek:true});
   await ev(`document.querySelector('#A .catalog-more').focus()`);
   await wait(`(()=>{const g=document.querySelector('#A .catalog-grid').getBoundingClientRect(),m=document.querySelector('#A .catalog-more').getBoundingClientRect();return m.left>=g.left-1&&m.right<=g.right+1;})()`);
   // Collection page: both link rows scroll sideways inside themselves; the current category is marked.
   assert.deepEqual(await ev('[...document.querySelectorAll("#C .category-chips")].map(u=>new Set([...u.children].map(l=>Math.round(l.getBoundingClientRect().top))).size)'),[1,1]);
   assert.equal(await ev('document.querySelectorAll("#C .category-chip[aria-current=page]").length'),2);
   const grid=await layout('#G');assert.equal(grid.columns,2);assert.equal(grid.scrolls,false);assert.equal(grid.lastRowFull,true);
  });
  await t.test('Add to cart from a carousel card: AJAX, no navigation, no drawer, the row stays where it was',async()=>{
   await load(390);
   await ev(`window.Shopify={routes:{root:'/'}};window.cartQty={};window.calls=[];
    const header=()=>'<header class="storefront-header"><div class="mini-cart"><button class="cart-toggle-btn"><span class="cart-count">1</span></button><div class="mini-cart-items"><p>1</p></div></div></header>';
    window.fetch=async(url,o={})=>{url=String(url);const body=o.body?JSON.parse(o.body):null;calls.push({url,body});
     if(url.endsWith('cart.js'))return new Response(JSON.stringify({items:Object.entries(cartQty).map(([id,q])=>({variant_id:Number(id),quantity:q,key:id+':k'}))}));
     if(url.endsWith('cart/add.js')){for(const i of body.items)cartQty[i.id]=(cartQty[i.id]||0)+Number(i.quantity);return new Response(JSON.stringify({items:body.items.map(i=>({id:Number(i.id),variant_id:Number(i.id),quantity:cartQty[i.id]})),sections:{header:header()}}));}
     return new Response('{}');};window.stay=1;`);
   await ev(read('assets/storefront.js'));
   const scroll=await ev(`(()=>{const g=document.querySelector('#A .catalog-grid');g.style.scrollBehavior='auto';g.querySelectorAll('.catalog-card')[4].scrollIntoView({block:'center',inline:'start'});return Math.round(g.scrollLeft);})()`);
   assert.ok(scroll<-100,'RTL scroll position');
   await ev(`document.querySelectorAll('#A .catalog-card')[4].querySelector('[name=add]').click()`);
   await wait(`!document.querySelectorAll('#A .catalog-card')[4].querySelector('[data-card-in-cart]').hidden`);
   const after=await ev(`({added:calls.filter(c=>c.url.endsWith('add.js')).length,stay:window.stay,drawer:document.querySelector('.cart-drawer').open,count:document.querySelector('.cart-count').textContent,scroll:Math.round(document.querySelector('#A .catalog-grid').scrollLeft)})`);
   assert.equal(after.added,1);assert.equal(after.stay,1);assert.equal(after.drawer,false);assert.equal(after.count,'1');assert.ok(Math.abs(after.scroll-scroll)<3,'scroll kept: '+scroll+' / '+after.scroll);
  });
 }finally{
  ws?.close();chrome?.kill();server.closeAllConnections();server.close();await sleep(300);
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}
 }
});
