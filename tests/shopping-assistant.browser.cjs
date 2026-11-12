// Isolated browser fixtures: all API calls mocked; no Shopify requests or cart mutations.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process'),{test}=require('node:test'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));
test('Shopping Assistant browser flows',{timeout:90000},async t=>{
 const source=fs.readFileSync(path.join(root,'snippets/shopping-assistant.liquid'),'utf8');
 const strings=JSON.parse(fs.readFileSync(path.join(root,'locales/he.default.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,'')).shopping_assistant;
 const trustCSS=fs.readFileSync(path.join(root,'sections/trust-benefits.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const collectionCSS=['sections/main-collection.liquid','snippets/storefront-filters.liquid','sections/footer.liquid'].map(file=>fs.readFileSync(path.join(root,file),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]).join('\n');
 const css=collectionCSS+trustCSS+source.match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1]+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const markup=source.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'')
  .replace(/<script type="application\/json" data-strings>[\s\S]*?<\/script>/,'<script type="application/json" data-strings>'+JSON.stringify(strings)+'</script>')
  .replace(/<script src=[\s\S]*?<\/script>/,'')
  .replace(/{{ settings.shopping_assistant_api_url \| escape }}/g,'https://assistant.example.test')
  .replace(/{{ settings.shopping_assistant_launcher[^}]*}}/g,strings.launcher_default)
  .replace(/{{ settings.shopping_assistant_title[^}]*}}/g,strings.title_default)
  .replace(/{{ 'shopping_assistant\.([^']+)' \| t(?: \| escape)? }}/g,(_,key)=>strings[key]);
 const page='<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>'+
 ['theme.css','storefront.css','accessibility.css','accessibility-panel.css'].map(f=>fs.readFileSync(path.join(root,'assets',f),'utf8')).join('\n')+css+
 '</style></head><body><main style="min-height:1800px">Fixture</main><button class="a11y-launcher">Accessibility</button>'+markup+
 '<script src="/assistant.js"></script></body></html>';
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type',req.url==='/assistant.js'?'text/javascript':'text/html;charset=utf-8');
  res.end(req.url==='/assistant.js'?fs.readFileSync(path.join(root,'assets/shopping-assistant.js'),'utf8'):page);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-assistant-'));
 const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
 ['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--disable-background-networking','about:blank'],
 {windowsHide:true,stdio:['ignore','ignore','pipe']});
 let stderr='',ws;chrome.stderr.on('data',b=>stderr+=b);
 try{
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(stderr);i++)await sleep(100);
  const debug=stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];assert.ok(debug,'Chrome unavailable');
  const tab=await(await fetch('http://'+new URL(debug).host+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  let id=0;const pending=new Map(),errors=[],navigations=[];
  const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ws.addEventListener('message',event=>{
   const m=JSON.parse(event.data);
   if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}
   if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
   if(m.method==='Fetch.requestPaused'){
    navigations.push(m.params.request.url);
    call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<h1>Mock checkout</h1>').toString('base64')});
   }
  });
  const ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<100;i++){if(await ev(expression))return;await sleep(30);}throw Error('Timed out: '+expression);};
  const click=selector=>ev('document.querySelector('+JSON.stringify(selector)+').click()');
  const key=async(key,code,num)=>{for(const type of ['keyDown','keyUp'])await call('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:num});};
  await call('Page.enable');await call('Runtime.enable');
  await call('Fetch.enable',{patterns:[{urlPattern:'https://checkout.example.test/*'}]});
  await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
  await wait('!!document.querySelector("[data-launch]")&&!document.querySelector("[data-launch]").hidden');
  await ev(`window.app=document.querySelector('fankee-shopping-assistant');window.calls=[];window.mode='matched';
   window.product=(id='1')=>({variantId:'gid://shopify/ProductVariant/'+id,title:'מוצר בדיקה '+id,variantTitle:'Default Title',quantity:2,unitPrice:{amount:'15.90',currencyCode:'ILS'},lineTotal:{amount:'31.80',currencyCode:'ILS'},availableForSale:true,minimum:1,increment:1,maximum:null,requiresSellingPlan:false,requiresComponents:false});
   window.makeQuote=()=>{const p=product(),item={requested:{originalText:'2 מוצר בדיקה',quantity:2},status:mode==='semantic'?'matched':mode,reason:mode==='semantic'?'SEMANTIC_UNIQUE_MATCH':'EXACT_TITLE_MATCH',bestMatch:p,candidates:[p,product('2')]};if(mode==='unavailable')item.candidates.forEach(p=>p.availableForSale=false);const items=mode==='multiple'?[{...item,status:'matched'},{...item,status:'matched',bestMatch:product('2')}]:[item];return {quoteId:'fixture-quote',revision:1,items,resolvedItems:items.filter(i=>i.status==='matched').map(i=>i.bestMatch),subtotal:{amount:mode==='multiple'?'63.60':'31.80',currencyCode:'ILS'},canCheckout:items.every(i=>i.status==='matched')};};
   window.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body),credentials:options.credentials});await new Promise(r=>setTimeout(r,70));if(mode==='error')throw Error('secret-stack-sentinel');if(url.endsWith('/checkout')){const posted=JSON.parse(options.body);if(JSON.stringify(Object.keys(posted).sort())!==JSON.stringify(['confirmed','lines','quoteId','revision'])||posted.confirmed!==true||posted.lines[0].variantId!=='gid://shopify/ProductVariant/1'||posted.lines[0].quantity!==2)throw Error('Invalid checkout contract');if(mode==='changed'){const q=makeQuote();q.canCheckout=true;q.revision=2;q.items[0].status='matched';q.resolvedItems=[product()];return new Response(JSON.stringify({code:'QUOTE_CHANGED',quote:q}),{status:409});}if(mode==='uncertain')throw Error('timeout');return new Response(JSON.stringify({checkoutUrl:'https://checkout.example.test/from-backend'}));}if(url.endsWith('/resolve')){mode='matched';const q=makeQuote();q.revision=2;return new Response(JSON.stringify(q));}return new Response(JSON.stringify(makeQuote()));};`);
  const submit=async mode=>{
   await ev('if(app.dialog.open)app.dialog.close();window.mode='+JSON.stringify(mode)+';app.edit();app.input.value="2 מוצר בדיקה";');
   await click('[data-launch]');await ev('app.form.requestSubmit();app.form.requestSubmit()');
   await wait('!app.busy');
  };
  await t.test('Exact/semantic matches, multiple items, backend totals and duplicate-submit prevention',async()=>{
   for(const mode of ['matched','semantic','multiple']){
    const before=await ev('calls.length');await submit(mode);
    assert.equal(await ev('calls.length'),before+1);
    assert.equal(await ev('document.querySelectorAll(".shopping-assistant__card").length'),mode==='multiple'?2:1);
    assert.ok((await ev('document.querySelector("[data-total]").textContent')).includes(mode==='multiple'?'63.60':'31.80'));
    assert.equal(await ev('document.querySelector("[data-review]").disabled'),false);
    assert.equal(await ev('calls.at(-1).credentials'),'omit');
    assert.deepEqual(await ev('calls.at(-1).body'),{message:'2 מוצר בדיקה'});
   }
  });
  await t.test('Ambiguous selection uses the exact resolve contract and new revision',async()=>{
   await submit('ambiguous');assert.equal(await ev('document.querySelectorAll("[data-choose]").length'),2);
   assert.equal(await ev('document.querySelector("[data-review]").disabled'),true);
   await click('[data-choose]');await wait('!app.busy');
   assert.deepEqual(await ev('calls.at(-1).body'),{quoteId:'fixture-quote',revision:1,itemIndex:0,variantId:'gid://shopify/ProductVariant/1'});
   assert.equal(await ev('app.quote.revision'),2);assert.equal(await ev('app.quote.canCheckout'),true);
  });
  await t.test('Unavailable products are explained and cannot checkout or be selected',async()=>{
   await submit('unavailable');
   assert.ok((await ev('app.results.textContent')).includes(strings.unavailable));
   assert.equal(await ev('document.querySelector("[data-review]").disabled'),true);
   assert.equal(await ev('document.querySelectorAll("[data-choose]").length'),0);
  });
  await t.test('Not-found text supports item editing and removing the final item',async()=>{
   await submit('not_found');assert.ok((await ev('app.results.textContent')).includes(strings.not_found));
   await click('[data-edit-item]');assert.equal(await ev('app.form.hidden'),false);assert.equal(await ev('document.activeElement===app.input'),true);
   await submit('not_found');await click('[data-remove]');
   assert.equal(await ev('app.input.value'),'');assert.equal(await ev('app.form.hidden'),false);
  });
  await t.test('Editing a complete list and resubmitting creates a fresh quote',async()=>{
   await submit('matched');await click('[data-edit]');assert.equal(await ev('app.quote'),null);
   await ev('app.input.value="new list";app.form.requestSubmit()');await wait('!app.busy');
   assert.deepEqual(await ev('calls.at(-1).body'),{message:'new list'});
  });
  await t.test('Backend errors are safe and leave a retryable input form',async()=>{
   await submit('error');assert.equal(await ev('app.status.textContent'),strings.error);
   assert.equal(await ev('app.form.hidden'),false);assert.ok(!(await ev('app.textContent')).includes('secret-stack'));
  });
  await t.test('Desktop/mobile layouts, safe-area widgets, focus trap, Escape and scroll restoration',async()=>{
   await submit('matched');
   for(const width of [1280,390,320]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});
    await sleep(80);
    const rect=await ev('(()=>{const r=app.dialog.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height};})()');
    assert.ok(rect.left>=0&&rect.right<=width+1);assert.ok(rect.height<=844);
    if(width===1280)assert.ok(rect.width<600);
   }
   await ev('app.dialog.close();window.scrollTo(0,300)');await sleep(50);
   const y=await ev('window.scrollY');await click('[data-launch]');
   for(let n=0;n<15;n++){await key('Tab','Tab',9);assert.equal(await ev('app.dialog.contains(document.activeElement)'),true,'Tab '+n+': '+await ev('document.activeElement.outerHTML.slice(0,100)'));}
   await key('Escape','Escape',27);await wait('!app.dialog.open');
   assert.equal(await ev('document.activeElement===app.launcher'),true);assert.equal(await ev('window.scrollY'),y);
   assert.equal(await ev('(()=>{app.positionLauncher();const a=app.launcher.getBoundingClientRect(),b=document.querySelector(".a11y-launcher").getBoundingClientRect();return a.bottom<=b.top||a.right<=b.left||a.left>=b.right;})()'),true);
  });
  await t.test('Ambient layers respect reduced motion and remain within mobile bounds',async()=>{
   await ev(`document.querySelector('main').id='MainContent';document.querySelector('main').setAttribute('data-storefront-home','');document.querySelector('main').innerHTML='<div class="hero-area"><h1 class="storefront-hero-heading">בדיקה</h1><div class="hero-btn"><a href="#" class="theme-btn">קנייה</a></div></div>';`);
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:844,deviceScaleFactor:1,mobile:false});
   assert.notEqual(await ev('getComputedStyle(document.querySelector("#MainContent"),"::before").animationName'),'none');
   assert.ok(await ev('parseFloat(getComputedStyle(document.querySelector(".storefront-hero-heading")).animationDuration)<=0.35'));
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   for(const selector of ['#MainContent','.hero-area'])for(const pseudo of ['::before','::after'])
    assert.equal(await ev('getComputedStyle(document.querySelector('+JSON.stringify(selector)+'),'+JSON.stringify(pseudo)+').animationName'),'none');
   assert.equal(await ev('getComputedStyle(document.querySelector(".hero-btn a")).transitionDuration'),'0s');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await call('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true});
   assert.equal(await ev('getComputedStyle(document.querySelector(".hero-area"),"::after").display'),'none');
   assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
   await ev('document.querySelector("main").removeAttribute("data-storefront-home");document.querySelector("main").innerHTML="Fixture";');
  });
  await t.test('Responsive proportions reserve launcher space and keep header/search/cards aligned',async()=>{
   await ev(`app.dialog.close();window.scrollTo(0,0);document.body.insertBefore(app,document.querySelector('main'));
    window.headerFixture=document.createElement('header');headerFixture.className='storefront-header';
    headerFixture.innerHTML='<div class="site-header"><nav class="navigation"><div class="container-fluid"><div class="row"><a class="navbar-brand storefront-menu-logo"><img width="300" height="100" alt="Test fixture" src="data:image/svg+xml,%3Csvg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"300\\" height=\\"100\\">%3C/svg>"></a><div class="mobail-menu"><button class="navbar-toggler open-btn">תפריט</button></div><fankee-predictive-search><form role="search"><input type="search" aria-label="חיפוש"><button>חיפוש</button></form></fankee-predictive-search><div class="storefront-header-secondary"><div class="storefront-header-tools"><div class="mini-cart"><button class="cart-toggle-btn">סל</button></div></div></div></div></div></nav></div>';
    document.body.insertBefore(headerFixture,app);document.querySelector('main').id='MainContent';document.querySelector('main').setAttribute('data-storefront-home','');
    document.querySelector('main').innerHTML='<div class="hero-area"><h1 class="storefront-hero-heading">מוצרים לבית נקי</h1><p class="storefront-hero-subtitle">כל מה שצריך לבית</p><div class="hero-btn"><a class="theme-btn">לקנייה</a></div></div><section class="catalog-home catalog-section container"><header class="catalog-section-header"><h2>קטגוריות</h2></header><div class="catalog-categories"><a class="catalog-category">כביסה וטיפוח הבית</a><a class="catalog-category">מוצרי ניקיון</a></div></section>';`);
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});await sleep(60);
    const metrics=await ev(`(()=>{
     const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
     return {overflow:document.documentElement.scrollWidth>innerWidth,
      launcher:rect(app.launcher),main:rect(document.querySelector('main')),row:rect(headerFixture.querySelector('.row')),
      search:rect(headerFixture.querySelector('fankee-predictive-search')),logo:rect(headerFixture.querySelector('img')),
      menu:rect(headerFixture.querySelector('.open-btn')),cart:rect(headerFixture.querySelector('.cart-toggle-btn')),
      columns:getComputedStyle(document.querySelector('.catalog-categories')).gridTemplateColumns.split(' ').length,
      card:rect(document.querySelector('.catalog-category')),position:getComputedStyle(app.launcher).position};
    })()`);
    assert.equal(metrics.overflow,false,'overflow at '+width);
    assert.ok(metrics.logo.left>=0&&metrics.logo.right<=width);
    assert.ok(metrics.cart.width>=44&&metrics.cart.height>=44);
    if(width<992){
     assert.equal(metrics.position,'static');assert.ok(metrics.launcher.bottom<=metrics.main.top+1,'launcher covers content at '+width);
     assert.ok(metrics.launcher.height>=44);assert.equal(metrics.columns,2);
     assert.ok(metrics.search.top>=metrics.logo.bottom-1);assert.ok(Math.abs(metrics.search.width-metrics.row.width)<=1);
     assert.ok(metrics.menu.width>=44&&metrics.menu.height>=44);
     assert.ok(metrics.card.left>=15&&metrics.card.right<=width-15);
    }else assert.equal(metrics.position,'fixed');
   }
   await ev('headerFixture.remove();document.querySelector("main").removeAttribute("data-storefront-home");document.querySelector("main").innerHTML="Fixture";');
  });
  await t.test('Trust strip is compact, readable and clear of floating controls at all requested sizes',async()=>{
   const trustSource=fs.readFileSync(path.join(root,'sections/trust-benefits.liquid'),'utf8');
   const index=JSON.parse(fs.readFileSync(path.join(root,'templates/index.json'),'utf8').replace(/^\s*\/\*[\s\S]*?\*\//,''));
   assert.equal(index.order[index.order.indexOf('hero')+1],'trust_benefits');
   const config=index.sections.trust_benefits;
   const itemTemplate=trustSource.match(/<li class="trust-strip__item"[\s\S]*?<\/li>/)[0];
   const items=config.block_order.map(id=>{
    const b=config.blocks[id].settings;
    return itemTemplate.replace('{{ block.shopify_attributes }}','')
     .replace(/{% case block.settings.icon %}[\s\S]*?{% endcase %}/,'<path d="M4 12h16M12 4v16"/>')
     .replace('{{ block.settings.title | escape }}',b.title).replace('{{ block.settings.subtitle | escape }}',b.subtitle)
     .replace(/{% if block.settings.subtitle != blank %}|{% endif %}/g,'');
   }).join('');
   await ev('app.dialog.close();window.scrollTo(0,0);document.querySelector("main").innerHTML='+JSON.stringify('<section class="trust-strip container" aria-label="יתרונות החנות"><ul class="trust-strip__list" role="list">'+items+'</ul></section>'));
   for(const width of [320,360,375,390,768,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});await sleep(40);
    const m=await ev(`(()=>{
     const strip=document.querySelector('.trust-strip'),rect=strip.getBoundingClientRect();
     const intersects=node=>{const r=node.getBoundingClientRect();return r.width&&r.height&&r.left<rect.right&&r.right>rect.left&&r.top<rect.bottom&&r.bottom>rect.top;};
     return {overflow:document.documentElement.scrollWidth>innerWidth,height:rect.height,
      columns:getComputedStyle(document.querySelector('.trust-strip__list')).gridTemplateColumns.split(' ').length,
      clipped:[...strip.querySelectorAll('.trust-strip__title')].some(n=>n.scrollWidth>n.clientWidth||n.scrollHeight>n.clientHeight),
      launcherOverlap:intersects(app.launcher),accessibilityOverlap:intersects(document.querySelector('.a11y-launcher')),
      icons:[...strip.querySelectorAll('svg')].every(n=>n.getAttribute('aria-hidden')==='true')};
    })()`);
    assert.equal(m.overflow,false,'overflow at '+width);assert.equal(m.clipped,false,'clipped text at '+width);
    assert.equal(m.columns,width<992?2:4);assert.equal(m.icons,true);
    assert.equal(m.launcherOverlap,false);assert.equal(m.accessibilityOverlap,false);
    if(width<600)assert.ok(m.height<=180,'mobile strip too tall: '+m.height);
   }
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.equal(await ev('getComputedStyle(document.querySelector(".trust-strip__item")).transitionDuration'),'0s');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await ev('document.querySelector("main").innerHTML="Fixture"');
  });
  await t.test('Collection header, GET filters, sorting, chips and empty state stay responsive',async()=>{
   await ev(`app.dialog.close();window.scrollTo(0,0);document.body.insertBefore(app,document.querySelector('main'));
    document.querySelector('main').innerHTML='<section class="catalog-section container collection-page" data-storefront-collection><header class="collection-page__header collection-page__header--image"><div><h1>מוצרי ניקיון וטיפוח לבית עם שם קטגוריה עברי ארוך לבדיקת שבירת שורות</h1><details class="collection-page__description"><summary>פרטי הקטגוריה</summary><div class="catalog-description">תיאור החנות נשמר במלואו ללא שינוי.</div></details></div><img class="collection-page__image" width="180" height="130" alt="קטגוריה"></header><div class="collection-page__toolbar"><p class="collection-page__count">2 מוצרים מתוך 10</p><form class="catalog-filters" action="/collections/fixture" method="get"><div class="catalog-sort"><label for="FixtureSort">מיון</label><select id="FixtureSort" name="sort_by"><option value="manual">מומלץ</option><option value="price-ascending">מחיר עולה</option></select></div><p class="collection-filter-label">סינון (2)</p><details class="catalog-filter" open><summary>מותג</summary><label class="catalog-filter__option"><input type="checkbox" name="filter.p.vendor" value="סנו" checked><span>סנו (2)</span></label></details><details class="catalog-filter"><summary>מחיר</summary><label>ממחיר<input type="number" name="filter.v.price.gte" min="0" value="10"></label><label>עד מחיר<input type="number" name="filter.v.price.lte" min="0" value="30"></label></details><button class="theme-btn" type="submit">הצגת מוצרים</button></form><div class="catalog-active-filters"><a href="/collections/fixture?filter.v.price.gte=10">מותג: סנו <span aria-hidden="true">×</span></a><a href="/collections/fixture?filter.p.vendor=סנו">מחיר: ₪10–₪30 <span aria-hidden="true">×</span></a><a href="/collections/fixture">נקה סינון</a></div></div><div class="catalog-grid"><article class="catalog-card"><div class="catalog-card__content"><h3>מוצר בדיקה</h3><div class="catalog-price"><bdi>₪39.90</bdi><s>₪79.90</s></div><button class="theme-btn">הוספה לסל</button></div></article><article class="catalog-card catalog-card--sold-out"><div class="catalog-card__content"><h3>מוצר שאזל</h3><div class="catalog-price">₪29.90</div><button class="theme-btn" disabled>אזל מהמלאי</button></div></article></div></section>';`);
   for(const width of [320,360,375,390,768,1024,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
    const m=await ev(`(()=>{
      const scope=document.querySelector('.collection-page'),select=scope.querySelector('select'),button=scope.querySelector('button');
      return {overflow:document.documentElement.scrollWidth>innerWidth,columns:getComputedStyle(scope.querySelector('.catalog-grid')).gridTemplateColumns.split(' ').length,
       tap:Math.min(select.getBoundingClientRect().height,button.getBoundingClientRect().height),
       titleClipped:scope.querySelector('h1').scrollWidth>scope.querySelector('h1').clientWidth,
       chips:[...scope.querySelectorAll('.catalog-active-filters a')].every(a=>a.scrollWidth<=a.clientWidth)};
    })()`);
    assert.equal(m.overflow,false,'overflow at '+width);assert.equal(m.titleClipped,false);
    assert.ok(m.chips);assert.ok(m.tap>=44);if(width<992)assert.equal(m.columns,2);
   }
   assert.equal(await ev('document.querySelector(".collection-page__description").open'),false);
   await click('.collection-page__description summary');assert.equal(await ev('document.querySelector(".collection-page__description").open'),true);
   await ev('document.querySelector("#FixtureSort").value="price-ascending"');
   const selectState=await ev('(()=>{const s=document.querySelector("#FixtureSort");return {html:s.outerHTML,value:s.value,disabled:s.disabled,form:s.form?.outerHTML.slice(0,100)}})()');
   const values=await ev('Object.fromEntries(new FormData(document.querySelector(".catalog-filters")))');
   assert.deepEqual(values,{sort_by:'price-ascending','filter.p.vendor':'סנו','filter.v.price.gte':'10','filter.v.price.lte':'30'},JSON.stringify(selectState));
   assert.equal(await ev('document.querySelector(".catalog-filters").method'),'get');
   assert.equal(await ev('document.querySelectorAll(".catalog-active-filters a").length'),3);
   await ev(`document.querySelector('.catalog-grid').outerHTML='<div class="collection-page__empty" role="status"><h2>לא מצאנו מוצרים שמתאימים לסינון שבחרת</h2><a class="theme-btn" href="/collections/fixture">נקה סינון</a></div>'`);
   assert.ok((await ev('document.querySelector(".collection-page__empty").textContent')).includes('נקה סינון'));
   await ev('document.querySelector("main").innerHTML="Fixture"');
  });
  await t.test('Footer links, newsletter and social targets remain responsive and accessible',async()=>{
   const footerSource=fs.readFileSync(path.join(root,'sections/footer.liquid'),'utf8');
   assert.match(footerSource,/{% form 'customer'/);
   assert.match(footerSource,/name="contact\[tags\]" value="newsletter"/);
   assert.match(footerSource,/form.posted_successfully\?/);
   assert.match(footerSource,/section.settings.whatsapp != blank/);
   assert.match(footerSource,/facebook_url != blank/);assert.match(footerSource,/instagram_url != blank/);
   const social={whatsapp:'https://wa.me/fixture',facebook:'https://facebook.example.test/store',instagram:'https://instagram.example.test/store'};
   const renderSocial=urls=>Object.entries(urls).filter(([,url])=>url).map(([key,url])=>'<li><a aria-label="'+key+'" href="'+url+'"><svg width="24" height="24" aria-hidden="true"><path d="M2 2h20v20H2z"/></svg></a></li>').join('');
   const html='<footer class="footer-area storefront-footer" dir="rtl" id="FooterFixture"><div class="container storefront-footer-inner"><div class="storefront-footer__top"><div class="storefront-footer__brand"><a class="storefront-footer-name" href="/">פאנקי</a><p class="storefront-footer__description">מוצרי ניקיון לבית ולמשפחה</p><ul class="storefront-footer-social" role="list">'+renderSocial(social)+'</ul></div><div class="storefront-footer-links"><nav aria-label="קניות"><h3>קניות</h3><ul><li><a href="/collections/fixture">קטגוריות מוצרי ניקיון לבית</a></li></ul></nav><nav aria-label="שירות לקוחות"><h3>שירות לקוחות</h3><ul><li><a href="/pages/contact">יצירת קשר</a></li><li><a href="/policies/shipping-policy">משלוחים והחזרות</a></li></ul></nav><nav aria-label="מדיניות"><h3>מדיניות</h3><ul><li><a href="/policies/privacy-policy">פרטיות ותנאי שימוש באתר</a></li></ul></nav></div><div class="newslatter-area"><h2>עדכונים מפאנקי</h2><p class="storefront-footer__newsletter-text">עדכונים מהחנות</p><form id="FooterSignup"><input type="hidden" name="contact[tags]" value="newsletter"><label for="FooterFixtureEmail">כתובת המייל שלכם</label><input id="FooterFixtureEmail" name="contact[email]" type="email" required autocomplete="email"><button type="submit">הרשמה</button><p role="status" hidden>נרשמתם בהצלחה</p></form></div></div><ul class="storefront-footer__trust"><li>תשלום מאובטח</li><li>איסוף עצמי</li><li>משלוח חינם מעל ₪150</li></ul><div class="storefront-footer__bottom"><p class="storefront-footer-copyright">© פאנקי</p><a class="storefront-footer-statement" href="/pages/accessibility">הצהרת נגישות</a></div></div></footer>';
   await ev('app.dialog.close();document.body.insertAdjacentHTML("beforeend",'+JSON.stringify(html)+');(()=>{const root=document.querySelector("#FooterFixture"),group=document.createElement("div");group.className="storefront-footer__social-group";const title=document.createElement("h3");title.textContent="עקבו אחרינו";group.append(title,root.querySelector(".storefront-footer-social"));root.querySelector(".storefront-footer__top").insertBefore(group,root.querySelector(".newslatter-area"));})()');
   for(const width of [320,360,375,390,768,1024,1440,1600]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<992});
    const m=await ev(`(()=>{
     const footer=document.querySelector('#FooterFixture');
     return {overflow:document.documentElement.scrollWidth>innerWidth,
      targets:[...footer.querySelectorAll('.storefront-footer-social a')].every(a=>a.getBoundingClientRect().width>=44&&a.getBoundingClientRect().height>=44),
      clipped:[...footer.querySelectorAll('a,input,button')].some(n=>n.scrollWidth>n.clientWidth),
      height:footer.getBoundingClientRect().height,
      clearance:innerWidth<992||[...footer.querySelectorAll('a,input,button')].every(n=>{const a=n.getBoundingClientRect(),b=app.launcher.getBoundingClientRect();return a.left>=b.right||a.right<=b.left||a.top>=b.bottom||a.bottom<=b.top;}),
      label:footer.querySelector('input[type=email]').labels.length,
      buttonHeight:footer.querySelector('button').getBoundingClientRect().height};
    })()`);
    assert.equal(m.overflow,false,'overflow at '+width);assert.equal(m.clipped,false,'clipping at '+width);
    assert.ok(m.targets);assert.equal(m.label,1);assert.ok(m.buttonHeight>=44);assert.equal(m.clearance,true,'launcher overlap at '+width);if(width>=1024)assert.ok(m.height<500,'desktop footer too tall: '+m.height);
   }
   assert.deepEqual(await ev('[...document.querySelectorAll("#FooterFixture .storefront-footer-social a")].map(a=>a.href)'),Object.values(social));
   assert.equal(await ev('document.querySelector("#FooterFixture a[href*=privacy]").getAttribute("href")'),'/policies/privacy-policy');
   await ev('document.querySelector("#FooterFixtureEmail").value="invalid"');
   assert.equal(await ev('document.querySelector("#FooterSignup").checkValidity()'),false);
   await ev('document.querySelector("#FooterFixtureEmail").value="customer@example.test";window.newsletterPost=null;document.querySelector("#FooterSignup").addEventListener("submit",e=>{e.preventDefault();newsletterPost=Object.fromEntries(new FormData(e.target));e.target.querySelector("[role=status]").hidden=false},{once:true});document.querySelector("#FooterSignup").requestSubmit()');
   assert.deepEqual(await ev('newsletterPost'),{'contact[tags]':'newsletter','contact[email]':'customer@example.test'});
   assert.equal(await ev('document.querySelector("#FooterSignup [role=status]").hidden'),false);
   const empty=renderSocial({whatsapp:'',facebook:'',instagram:''});assert.equal(empty,'');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   assert.equal(await ev('getComputedStyle(document.querySelector("#FooterFixture button"),"::before").display'),'none');
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await ev('document.querySelector("#FooterFixture").remove();document.querySelector("main").innerHTML="Fixture"');
  });
  await t.test('Checkout has separate confirmation, price changes require reconfirmation',async()=>{
   await submit('matched');const before=await ev('calls.length');
   await click('[data-review]');assert.equal(await ev('calls.length'),before);
   assert.equal(await ev('app.confirmation.hidden'),false);
   await ev('mode="changed"');await click('[data-confirm-checkout]');await wait('!app.busy');
   assert.equal(await ev('app.quote.revision'),2);assert.equal(await ev('app.confirmation.hidden'),true);
   assert.equal(await ev('app.status.textContent'),strings.changed);
  });
  await t.test('Uncertain checkout locks retry until a fresh list is prepared',async()=>{
   await submit('matched');await click('[data-review]');await ev('mode="uncertain"');
   await click('[data-confirm-checkout]');await wait('!app.busy');
   assert.equal(await ev('app.locked'),true);assert.equal(await ev('document.querySelector("[data-review]").disabled'),true);
   assert.equal(await ev('app.status.textContent'),strings.uncertain);
  });
  await t.test('Checkout posts only confirmed IDs/quantities and navigates to backend URL',async()=>{
   await submit('matched');await click('[data-review]');
   await click('[data-confirm-checkout]');
   for(let i=0;i<100&&!navigations.length;i++)await sleep(30);
   assert.deepEqual(navigations,['https://checkout.example.test/from-backend']);
   // Request was fulfilled locally by CDP; no real checkout or external API access.
  });
  assert.deepEqual(errors,[]);
 }finally{
  ws?.close();chrome.kill();await new Promise(r=>server.close(r));await sleep(300);
  const target=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-assistant-');
  if(target.startsWith(prefix))try{fs.rmSync(target,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
});
