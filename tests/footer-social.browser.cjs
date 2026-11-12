// Footer social links: Facebook reuses the existing settings (footer `facebook` → global `social_facebook_link`),
// renders once, opens in a new tab and matches the WhatsApp/Instagram icon buttons in RTL at every width.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const FACEBOOK='https://www.facebook.com/profile.php?id=61595992301035';
const tr=JSON.parse(read('locales/he.default.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
const footer=read('sections/footer.liquid');
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('Facebook uses the existing settings, renders once and only when configured',()=>{
 const data=JSON.parse(read('config/settings_data.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
 assert.equal(data.current.social_facebook_link,FACEBOOK,'global Theme Settings value');
 assert.ok(!data.current.sections.footer.settings.facebook,'footer override stays blank, so the global setting applies');
 const schema=JSON.parse(read('config/settings_schema.json'));
 assert.equal(schema.flatMap(group=>group.settings||[]).filter(item=>/facebook/i.test(item.id||'')).length,1,'no duplicate global setting');
 const sectionSchema=JSON.parse(footer.match(/{% schema %}([\s\S]*?){% endschema %}/)[1]);
 assert.equal(sectionSchema.settings.filter(item=>/facebook/i.test(item.id||'')).length,1,'no duplicate footer setting');
 assert.match(footer,/assign facebook_url = section\.settings\.facebook \| default: settings\.social_facebook_link/);
 const links=footer.match(/<a [^>]*href="{{ facebook_url[^>]*>/g)||[];
 assert.equal(links.length,1,'one Facebook link');
 assert.match(footer,/{% if facebook_url != blank %}<li><a href="{{ facebook_url \| escape }}" target="_blank" rel="noopener noreferrer" aria-label="{{ 'storefront\.facebook_profile' \| t: shop: shop\.name }}"><svg [^>]*aria-hidden="true" focusable="false">/);
 assert.equal(tr.storefront.facebook_profile.replace('{{ shop }}','פאנקי'),'פייסבוק של פאנקי');
 assert.doesNotMatch(read('layout/theme.liquid')+footer,/font-awesome|fontawesome|cdnjs|icons8|simple-icons/i,'no external icon library');
});

test('Footer social icons in the browser: size, focus, RTL alignment and floating controls',{timeout:120000},async t=>{
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['theme.css','storefront.css','accessibility.css','accessibility-panel.css'].map(file=>read('assets/'+file)).join('')+block('snippets/storefront-design.liquid')+block('sections/footer.liquid');
 // The real <li> markup for WhatsApp, Facebook and Instagram with their settings filled in.
 const items=['section.settings.whatsapp','facebook_url','instagram_url'].map(name=>{
  const line=footer.split(/\r?\n/).find(l=>l.includes('{% if '+name+' != blank %}<li>'));assert.ok(line,name);
  return line.trim().replace(/^{% if [\w.]+ != blank %}/,'').replace(/{% endif %}$/,'')
   .replace(/{{ section\.settings\.whatsapp \| escape }}/,'https://wa.me/972543966168').replace(/{{ facebook_url \| escape }}/,escape(FACEBOOK)).replace(/{{ instagram_url \| escape }}/,'https://www.instagram.com/fankee1006/')
   .replace(/{{ '([\w.]+)' \| t(?:: shop: shop\.name)? }}/g,(_m,key)=>escape(key.split('.').reduce((a,k)=>a[k],tr).replace('{{ shop }}','פאנקי')));
 }).join('');
 assert.doesNotMatch(items,/{[{%]/);
 const html=`<!doctype html><html dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>${css}@media(max-width:991px){fankee-shopping-assistant .shopping-assistant__launcher{display:none}}</style></head><body><main style="min-height:900px"></main><footer class="footer-area storefront-footer" dir="rtl"><div class="container storefront-footer-inner"><div class="storefront-footer__top"><div class="storefront-footer__brand"><p class="storefront-footer__description">פאנקי</p></div><nav class="storefront-footer-policies" aria-label="מדיניות"><h3>מדיניות</h3><ul><li><a href="#">מדיניות פרטיות</a></li><li><a href="#">תנאי שימוש</a></li></ul></nav><div class="storefront-footer__social-group"><h3>עקבו אחרינו</h3><ul class="storefront-footer-social" role="list" aria-label="עקבו אחרינו">${items}</ul></div></div><ul class="storefront-footer__trust" role="list"><li>תשלום מאובטח</li></ul><div class="storefront-footer__bottom"><a class="storefront-footer-statement" href="#">הצהרת נגישות</a><p class="storefront-footer-copyright">© 2026 פאנקי</p></div></div></footer><button class="a11y-launcher" type="button">נגישות</button><fankee-shopping-assistant><button class="shopping-assistant__launcher" type="button" style="position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px">עוזר קניות</button></fankee-shopping-assistant></body></html>`;
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-social-'));
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
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await sleep(500);

  await t.test('Facebook link: exact URL, new tab, accessible name, decorative icon',async()=>{
   const r=await ev('(()=>{const links=[...document.querySelectorAll(".storefront-footer-social a")];const fb=links.filter(a=>a.href.includes("facebook.com"));const a=fb[0];return {count:fb.length,href:a.href,target:a.target,rel:a.rel,label:a.getAttribute("aria-label"),svg:a.querySelector("svg").getAttribute("aria-hidden"),focusable:a.querySelector("svg").getAttribute("focusable"),text:a.textContent.trim(),order:links.map(l=>l.getAttribute("aria-label"))}})()');
   assert.deepEqual(r,{count:1,href:FACEBOOK,target:'_blank',rel:'noopener noreferrer',label:'פייסבוק של פאנקי',svg:'true',focusable:'false',text:'',order:['וואטסאפ','פייסבוק של פאנקי','אינסטגרם']});
  });
  for(const width of [320,360,390,768,1280]){
   await t.test('Width '+width+': 44px targets, one aligned RTL row, no overflow, clear of floating controls',async()=>{
    await call('Emulation.setDeviceMetricsOverride',{width,height:700,deviceScaleFactor:1,mobile:width<768});
    await ev('scrollTo(0,document.documentElement.scrollHeight)');await sleep(100);
    const m=await ev(`(()=>{const links=[...document.querySelectorAll(".storefront-footer-social a")].map(a=>a.getBoundingClientRect()),list=document.querySelector(".storefront-footer-social").getBoundingClientRect();
     const controls=[...document.querySelectorAll(".a11y-launcher,.shopping-assistant__launcher")].filter(n=>getComputedStyle(n).display!=="none").map(n=>n.getBoundingClientRect());
     return {sizes:links.map(r=>[Math.round(r.width),Math.round(r.height)]),sameRow:links.every(r=>Math.abs(r.top-links[0].top)<1),rtl:links[0].left>links[1].left&&links[1].left>links[2].left,gap:links[0].left-links[1].right,startAligned:Math.abs(links[0].right-list.right)<2,overflow:document.documentElement.scrollWidth>innerWidth,overlap:links.some(r=>controls.some(b=>!(r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom)))}})()`);
    for(const [w,h] of m.sizes){assert.ok(w>=44&&h>=44,'44px at '+width);}
    assert.equal(new Set(m.sizes.map(String)).size,1,'all icons the same size');
    assert.equal(m.sameRow,true);assert.equal(m.rtl,true,'RTL order');assert.ok(m.gap>=6,'spacing');assert.equal(m.startAligned,true,'aligned to the start like before');
    assert.equal(m.overflow,false);assert.equal(m.overlap,false,'floating controls');
   });
  }
  await t.test('Keyboard focus on the Facebook icon is visible and matches the other icons',async()=>{
   const styles=[];
   for(const index of [0,1,2]){
    await ev('document.querySelectorAll(".storefront-footer-social a")['+index+'].focus()');
    styles.push(await ev('(()=>{const c=getComputedStyle(document.activeElement);return {visible:document.activeElement.matches(":focus-visible"),outline:c.outlineStyle,width:parseFloat(c.outlineWidth),shadow:c.boxShadow!=="none"}})()'));
   }
   assert.ok(styles[1].visible&&styles[1].outline==='solid'&&styles[1].width>=2&&styles[1].shadow);
   assert.deepEqual(styles[1],styles[0]);assert.deepEqual(styles[1],styles[2]);
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
