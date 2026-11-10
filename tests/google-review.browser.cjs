// Google review CTA: settings contract, no review gating, rendering rules, and footer layout/motion/accessibility in
// headless Chrome. Liquid rendering of the show/hide rules uses liquidjs when resolvable (NODE_PATH); skipped otherwise.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const {test}=require('node:test');const assert=require('node:assert/strict');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const REVIEW_URL='https://g.page/r/CTA0XiuYPkeoECE/review';
const snippet=read('snippets/google-review-cta.liquid');
const tr=JSON.parse(read('locales/he.default.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

test('Theme settings, footer placement and no review gating',()=>{
 const group=JSON.parse(read('config/settings_schema.json')).find(item=>item.name==='t:google_review_editor.settings');
 assert.ok(group,'Google review settings group');
 const byId=Object.fromEntries(group.settings.filter(item=>item.id).map(item=>[item.id,item]));
 assert.deepEqual(Object.keys(byId),['google_review_enabled','google_review_url','google_review_heading','google_review_text','google_review_button']);
 assert.equal(byId.google_review_enabled.default,true);
 assert.equal(byId.google_review_url.default,REVIEW_URL);
 for(const id of ['google_review_heading','google_review_text','google_review_button'])assert.equal(byId[id].default,undefined,id+' falls back to translations');
 for(const locale of ['he.schema.json','en.default.schema.json']){const keys=JSON.parse(read('locales/'+locale)).google_review_editor;for(const item of group.settings)for(const value of [item.label,item.info,item.content].filter(Boolean))assert.ok(keys[value.replace('t:google_review_editor.','')],locale+' '+value);}
 assert.equal(tr.google_review.heading,'נהניתם מהשירות?');
 assert.equal(tr.google_review.text,'נשמח לשמוע מה חשבתם ולעזור ללקוחות נוספים להכיר את פאנקי');
 assert.equal(tr.google_review.button,'כתבו לנו ביקורת בגוגל');
 // Rendered once, in the footer, between the columns and the trust row.
 const renders=['layout','sections','snippets'].flatMap(dir=>fs.readdirSync(path.join(root,dir)).map(file=>dir+'/'+file)).filter(file=>file.endsWith('.liquid')&&/render 'google-review-cta'/.test(read(file).replace(/{% doc %}[\s\S]*?{% enddoc %}/,'')));
 assert.deepEqual(renders,['sections/footer.liquid']);
 assert.match(read('sections/footer.liquid'),/<\/div>\s*{% render 'google-review-cta', context: 'footer' %}\s*<ul class="storefront-footer__trust"/);
 // No gating: no questions, ratings, forms, scripts choosing a destination, or incentives. One link, one URL source.
 const markup=snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'');
 assert.doesNotMatch(markup,/<(form|input|button|select|textarea)\b/);
 assert.doesNotMatch(markup+JSON.stringify(tr.google_review),/coupon|discount|reward|הנחה|קופון|מתנה|הטבה/i);
 assert.equal((markup.match(/<a\b/g)||[]).length,1);
 assert.match(markup,/<a class="google-review-cta__link" href="{{ review_url \| escape }}" target="_blank" rel="noopener noreferrer" aria-label=/);
 assert.doesNotMatch(read('assets/storefront.js'),/review[^\n]*(href|location|window\.open)/i,'JavaScript never changes the review destination');
});

let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
test('Liquid renders nothing when disabled or without an https URL',{skip:Liquid?false:'liquidjs not resolvable (set NODE_PATH to an install to run)'},async()=>{
 const engine=new Liquid();
 const en=JSON.parse(read('locales/en.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
 const lookup=(locale,key)=>key.split('.').reduce((a,k)=>a?.[k],locale);
 engine.registerFilter('t',(key,...args)=>{let value=lookup(tr,key);for(const [k,v] of args.filter(Array.isArray))value=value.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),v);return value;});
 engine.registerFilter('handleize',value=>String(value).toLowerCase().replace(/[^a-z0-9]+/g,'-'));
 const template=engine.parse(snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,''));
 const render=settings=>engine.render(template,{context:'footer',shop:{name:'פאנקי'},settings:{google_review_enabled:true,google_review_url:REVIEW_URL,google_review_heading:'',google_review_text:'',google_review_button:'',...settings}});
 const html=await render({});
 assert.equal((html.match(/href="([^"]+)"/g)||[]).join(),'href="'+REVIEW_URL+'"');
 assert.ok(html.includes(tr.google_review.heading)&&html.includes(tr.google_review.text)&&html.includes('>'+tr.google_review.button+'<'));
 assert.ok(html.includes('aria-label="כתבו לנו ביקורת בגוגל – כתיבת ביקורת על פאנקי בגוגל (נפתח בכרטיסייה חדשה)"'));
 for(const settings of [{google_review_enabled:false},{google_review_url:''},{google_review_url:'   '},{google_review_url:'http://g.page/r/x/review'},{google_review_url:'javascript:alert(1)'}])assert.equal((await render(settings)).trim(),'',JSON.stringify(settings));
 const custom=await render({google_review_heading:'<b>כותרת</b>',google_review_text:'טקסט "שלנו"',google_review_button:'לביקורת'});
 assert.ok(custom.includes('&lt;b&gt;כותרת&lt;/b&gt;')&&/טקסט &(quot|#34);שלנו&(quot|#34);/.test(custom)&&custom.includes('>לביקורת<'));
 assert.ok(!custom.includes(tr.google_review.heading));
 assert.ok(en.google_review.button&&en.google_review.link_label.includes('{{ shop }}'));
});

// Static markup for the browser: the snippet's real markup with its Liquid outputs resolved to the defaults.
function cardHTML(){
 const start='{%- if review_show -%}';
 let html=snippet.slice(snippet.indexOf(start)+start.length,snippet.lastIndexOf('{%- endif -%}'));
 html=html.replace(/{%- for i in \(1\.\.5\) -%}([\s\S]*?){%- endfor -%}/,(_m,star)=>[0,1,2,3,4].map(i=>star.trim().replace('{{ forloop.index0 }}',i)).join(''));
 html=html.replace(/{%- if review_text != blank %}([\s\S]*?){% endif %}/,'$1').replace(/{{ 'google_review\.(\w+)' \| t }}/g,(_m,key)=>escape(tr.google_review[key]));
 const vars={review_context:'footer',review_heading_id:'GoogleReview-footer',review_url:REVIEW_URL,review_heading:tr.google_review.heading,review_text:tr.google_review.text,review_label:tr.google_review.button,review_aria:tr.google_review.link_label.replace('{{ shop }}','פאנקי'),review_new_tab:tr.google_review.new_tab};
 html=html.replace(/{{ (review_\w+)(?: \| escape)? }}/g,(_m,name)=>{assert.ok(name in vars,name);return escape(vars[name]);});
 assert.doesNotMatch(html,/{[{%]/);
 return html;
}

test('Footer review card: layout, floating controls, accessibility and motion',{timeout:120000},async t=>{
 const block=file=>read(file).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const css=['bootstrap.min.css','style.css','storefront.css','accessibility.css'].map(file=>read('assets/'+file)).join('')+block('snippets/storefront-design.liquid')+block('sections/footer.liquid')+block('snippets/group-delivery-entry.liquid')+block('snippets/google-review-cta.liquid');
 const links=['מדיניות פרטיות','מדיניות החזרים','תנאי שימוש','מדיניות משלוחים'].map(text=>`<li><a href="/policies/x">${text}</a></li>`).join('');
 const footer=`<footer class="footer-area storefront-footer" dir="rtl"><div class="container storefront-footer-inner"><div class="storefront-footer__top"><div class="storefront-footer__brand"><p class="storefront-footer__description">מוצרי ניקיון וטיפוח לבית, במחירים הוגנים.</p><a class="group-delivery-entry" href="/pages/group-delivery">משלוח קבוצתי</a></div><nav class="storefront-footer-policies" aria-label="מדיניות"><h3>מדיניות</h3><ul>${links}</ul></nav><div class="storefront-footer__social-group"><h3>עקבו אחרינו</h3><ul class="storefront-footer-social" role="list"><li><a href="https://wa.me/1" aria-label="WhatsApp">W</a></li><li><a href="https://instagram.com/x" aria-label="Instagram">I</a></li></ul></div></div>${cardHTML()}<ul class="storefront-footer__trust" role="list"><li>תשלום מאובטח</li><li>איסוף עצמי</li><li>משלוחים</li></ul><div class="storefront-footer__bottom"><a class="storefront-footer-statement" href="/pages/a11y">הצהרת נגישות</a><p class="storefront-footer-copyright">© 2026 פאנקי</p></div></div></footer>`;
 const controls=`<style>@media(max-width:991px){fankee-shopping-assistant .shopping-assistant__launcher{display:none}}</style><button class="a11y-launcher" type="button">נגישות</button><fankee-shopping-assistant><button class="shopping-assistant__launcher" type="button" style="position:fixed;inset-inline-end:16px;bottom:84px;width:184px;height:44px">עוזר קניות</button></fankee-shopping-assistant>`;
 const html=`<!doctype html><html class="js" dir="rtl" lang="he"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main id="MainContent" style="min-height:1400px"><h1>חנות</h1></main>${footer}${controls}</body></html>`;
 const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-review-'));
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
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  call=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
  ev=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const wait=async expression=>{for(let i=0;i<160;i++){if(await ev(expression))return;await sleep(25);}throw Error('Timeout: '+expression);};
  const load=async(width=1280)=>{await call('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await wait('document.readyState==="complete"');await ev('window.Shopify={routes:{root:"/"}}');await ev(read('assets/storefront.js'));};
  await call('Page.enable');await call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await load();

  await t.test('Card starts hidden below the fold, enters once with a star stagger, then stays still',async()=>{
   assert.equal(await ev('document.querySelector("[data-review-cta]").dataset.reviewReveal'),'pending');
   await ev('document.querySelector("[data-review-cta]").scrollIntoView({block:"center"})');
   await wait('document.querySelector("[data-review-cta]").dataset.reviewReveal==="entered"');
   const stars=await ev('[...document.querySelectorAll(".google-review-cta__star")].map(s=>{const c=getComputedStyle(s);return [c.animationName,c.animationIterationCount,parseFloat(c.animationDelay)]})');
   assert.equal(stars.length,5);
   for(const [name,count] of stars){assert.equal(name,'google-review-star');assert.equal(count,'1','no continuous animation');}
   assert.ok(stars[4][2]>stars[0][2],'stagger');
   await wait('getComputedStyle(document.querySelector("[data-review-cta]")).opacity==="1"');
   assert.equal(await ev('document.getAnimations().filter(a=>a.effect?.target?.closest?.(".google-review-cta")&&a.playState==="running"&&a.effect.getComputedTiming().iterations===Infinity).length'),0);
  });
  await t.test('Link opens the exact Google review URL in a new tab with a name that starts with its visible text',async()=>{
   const link=await ev('(()=>{const a=document.querySelector(".google-review-cta__link");return {href:a.href,target:a.target,rel:a.rel,label:a.getAttribute("aria-label"),text:a.textContent.trim(),count:document.querySelectorAll("a[href*=\'g.page\']").length,heading:document.querySelector(".google-review-cta__heading").textContent,named:[...document.querySelectorAll("[data-review-cta],[data-review-cta] [role]")].filter(n=>n.hasAttribute("aria-labelledby")||n.getAttribute("role")==="group").length,headings:[...document.querySelectorAll(".google-review-cta h1,.google-review-cta h2,.google-review-cta h3")].length,stars:document.querySelector(".google-review-cta__stars").getAttribute("aria-hidden"),svgs:[...document.querySelectorAll(".google-review-cta svg")].every(s=>s.closest("[aria-hidden=true]"))}})()');
   assert.equal(link.href,REVIEW_URL);assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');assert.equal(link.count,1);
   assert.ok(link.label.startsWith(link.text),'label in name');assert.ok(link.label.includes('בגוגל')&&link.label.includes(tr.google_review.new_tab));
   assert.equal(link.heading,tr.google_review.heading);assert.equal(link.named,0,'heading is not repeated as a group name');assert.equal(link.headings,1);assert.equal(link.stars,'true');assert.equal(link.svgs,true);
  });
  await t.test('Fits every width without overflow, keeps a 44px CTA and clears floating controls',async()=>{
   for(const width of [320,360,390,768,1024,1280,1440]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:width<768});
    await ev('scrollTo(0,document.documentElement.scrollHeight)');await wait('document.getAnimations().every(a=>a.playState!=="running")');
    const m=await ev(`(()=>{const card=document.querySelector(".google-review-cta"),a=card.querySelector(".google-review-cta__link"),c=card.getBoundingClientRect(),r=a.getBoundingClientRect(),star=card.querySelector(".google-review-cta__star").getBoundingClientRect(),heading=card.querySelector("h2").getBoundingClientRect();
     const hits=[...document.querySelectorAll(".a11y-launcher,.shopping-assistant__launcher")].filter(n=>getComputedStyle(n).display!=="none").map(n=>n.getBoundingClientRect()).filter(b=>!(r.right<=b.left||r.left>=b.right||r.bottom<=b.top||r.top>=b.bottom)).length;
     return {overflow:document.documentElement.scrollWidth>innerWidth,cardOut:c.left<0||c.right>innerWidth,height:r.height,full:Math.abs(r.width-(c.width-2-2*parseFloat(getComputedStyle(card).paddingInlineStart)))<2,inside:r.left>=c.left&&r.right<=c.right,cardHeight:c.height,star:star.width,font:parseFloat(getComputedStyle(card.querySelector(".google-review-cta__text")).fontSize),hits,rtl:getComputedStyle(card).direction,headingVisible:heading.width>0}})()`);
    assert.equal(m.overflow,false,'page overflow '+width);assert.equal(m.cardOut,false,'card overflow '+width);
    assert.ok(m.height>=44,'CTA height '+width);assert.equal(m.inside,true,'CTA inside card '+width);
    if(width<600)assert.equal(m.full,true,'full-width CTA '+width);
    assert.ok(m.star>=14&&m.font>=13,'readable '+width);assert.equal(m.hits,0,'floating controls '+width);assert.equal(m.rtl,'rtl');
    assert.ok(m.cardHeight<=(width>=768?100:230),'compact card '+width+': '+m.cardHeight);
   }
  });
  await t.test('Keyboard focus is clearly visible and colours keep high contrast',async()=>{
   await call('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
   await ev('document.querySelector(".google-review-cta__link").focus()');
   const s=await ev('(()=>{const a=document.activeElement,c=getComputedStyle(a);return {match:a.matches(".google-review-cta__link:focus-visible"),outline:c.outlineStyle,width:parseFloat(c.outlineWidth),color:c.outlineColor,fg:c.color,bg:c.backgroundColor,heading:getComputedStyle(document.querySelector(".google-review-cta__heading")).color,text:getComputedStyle(document.querySelector(".google-review-cta__text")).color}})()');
   assert.equal(s.match,true);assert.equal(s.outline,'solid');assert.ok(s.width>=2);assert.equal(s.color,'rgb(255, 255, 255)');
   const lum=rgb=>{const [r,g,b]=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;});return .2126*r+.7152*g+.0722*b;};
   const ratio=(a,b)=>{const [x,y]=[lum(a),lum(b)].sort((p,q)=>q-p);return (x+.05)/(y+.05);};
   assert.ok(ratio(s.fg,s.bg)>=7,'CTA text contrast');
   // Lightest point of the footer surface under the card (glass layers over rgb(11 79 88)).
   for(const color of [s.heading,s.text])assert.ok(ratio(color,'rgb(40, 110, 120)')>=4.5,'card text contrast '+color);
  });
  await t.test('Reduced motion and the accessibility pause show the card at once with no animation',async()=>{
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await load(390);
   assert.equal(await ev('document.querySelector("[data-review-cta]").dataset.reviewReveal'),'visible');
   const r=await ev('(()=>{const card=document.querySelector(".google-review-cta");return {opacity:getComputedStyle(card).opacity,star:getComputedStyle(card.querySelector(".google-review-cta__star")).animationName,transition:getComputedStyle(card.querySelector(".google-review-cta__link")).transitionDuration}})()');
   assert.deepEqual(r,{opacity:'1',star:'none',transition:'0s'});
   await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await load(390);
   assert.equal(await ev('document.querySelector("[data-review-cta]").dataset.reviewReveal'),'pending');
   await ev('document.documentElement.setAttribute("data-a11y-paused","")');
   assert.equal(await ev('getComputedStyle(document.querySelector(".google-review-cta")).opacity'),'1','pause reveals a pending card');
   await ev('document.querySelector("[data-review-cta]").scrollIntoView({block:"center"})');await sleep(100);
   assert.equal(await ev('getComputedStyle(document.querySelector(".google-review-cta__star")).animationName'),'none');
   await ev('document.documentElement.removeAttribute("data-a11y-paused")');
  });
  await t.test('Without JavaScript the card is visible and the footer keeps its existing parts',async()=>{
   await call('Emulation.setScriptExecutionDisabled',{value:true});
   await call('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+'/'});await sleep(400);
   await call('Emulation.setScriptExecutionDisabled',{value:false});
   const r=await ev('(()=>{const card=document.querySelector(".google-review-cta");return {state:card.dataset.reviewReveal??null,opacity:getComputedStyle(card).opacity,parts:[".storefront-footer-social a",".group-delivery-entry",".storefront-footer-policies a",".storefront-footer__trust li",".storefront-footer-statement"].map(s=>document.querySelectorAll(s).length>0)}})()');
   assert.deepEqual(r,{state:null,opacity:'1',parts:[true,true,true,true,true]});
  });
 }finally{
  ws?.close();chrome?.kill();server.close();
  await sleep(200);try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
 }
});
