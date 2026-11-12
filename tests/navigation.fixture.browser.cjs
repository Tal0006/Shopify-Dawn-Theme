// Local navigation fixture: exercises real theme CSS/JS without a Shopify store.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.join(__dirname,'..');
 const css=['theme.css','storefront.css','accessibility.css','accessibility-panel.css'].map(file=>fs.readFileSync(path.join(root,'assets',file),'utf8')).join('\n')+fs.readFileSync(path.join(root,'snippets/storefront-design.liquid'),'utf8').match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)[1];
 const groups=Array.from({length:5},(_,i)=>'<li class="nav-mega-group has-children"><div class="nav-mega-group-heading"><a href="/collections/group-'+i+'">Category '+i+'</a><button class="nav-group-toggle submenu-toggle" type="button" data-group-trigger aria-expanded="false" aria-controls="Group-'+i+'" aria-label="Category '+i+'"><svg width="14" height="14"></svg></button></div><ul id="Group-'+i+'" class="nav-mega-children">'+Array.from({length:i%3+2},(_,j)=>'<li><a href="/collections/child-'+i+'-'+j+'">Subcategory '+i+' '+j+'</a></li>').join('')+'</ul></li>').join('');
 const html='<html dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>'+css+'</style><script defer src="/storefront.js"></script></head><body><div class="shopify-section"><header class="storefront-header"><div class="site-header"><nav class="navigation navbar navbar-expand-lg"><div class="container-fluid"><div class="row"><a class="navbar-brand" href="/">Fankee</a><div class="mobail-menu"><button class="open-btn">Menu</button></div><div class="storefront-header-secondary"><div id="navbar" class="collapse navbar-collapse navigation-holder"><button class="menu-close">Close</button><ul class="nav navbar-nav"><li class="nav-disclosure" data-nav-disclosure><button id="CatalogTrigger" type="button" class="nav-mega-trigger submenu-toggle" data-mega-trigger aria-expanded="false" aria-controls="CatalogPanel">Catalog<svg width="14" height="14"></svg></button><div id="CatalogPanel" class="nav-mega-panel" data-mega-panel role="region" aria-labelledby="CatalogTrigger" hidden><ul class="nav-mega-groups">'+groups+'</ul><div class="nav-mega-footer"><a href="/collections/all">All products</a></div></div></li></ul></div><div class="storefront-header-tools"><div class="mini-cart"><button class="cart-toggle-btn">Cart</button><div class="mini-cart-content" inert><button class="mini-cart-close">Close</button><div class="mini-cart-items">Empty</div></div></div></div></div></div></div></nav></div></header></div><main tabindex="-1" style="min-height:1000px">Navigation fixture</main></body></html>';
 const server=http.createServer((req,res)=>{if(req.url==='/storefront.js'){res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(root,'assets/storefront.js'),'utf8'));}else{res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fankee-navigation-'));
 const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let stderr='';chrome.stderr.on('data',b=>stderr+=b);
 try{
  for(let n=0;n<100&&!/DevTools listening on (ws:\/\/\S+)/.test(stderr);n++)await new Promise(r=>setTimeout(r,100));
  const match=stderr.match(/DevTools listening on (ws:\/\/\S+)/);if(!match)throw Error('Chrome unavailable');
  const child=spawn(process.execPath,['--test',path.join(__dirname,'navigation.browser.cjs')],{windowsHide:true,stdio:'inherit',env:{...process.env,ACCESSIBILITY_DEBUG_URL:'http://'+new URL(match[1]).host,ACCESSIBILITY_PREVIEW_URL:'http://127.0.0.1:'+server.address().port}});
  process.exitCode=await new Promise(r=>child.on('exit',r));
 }finally{
  chrome.kill();await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,500));
  const resolved=path.resolve(profile),prefix=path.join(path.resolve(os.tmpdir()),'fankee-navigation-');
  if(resolved.startsWith(prefix))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:150});}catch{}
 }
})().catch(error=>{console.error(error);process.exitCode=1});
