// Shared test fixture: the real header section (plus announcement bar and layout shell) rendered with liquidjs.
// Not a test file (tests/helpers is not matched by the test glob).
const fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..','..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const he=JSON.parse(read('locales/he.default.json').replace(/^\s*\/\*[\s\S]*?\*\//,''));
let Liquid;try{({Liquid}=require('liquidjs'));}catch{Liquid=null;}
// The real header section rendered with liquidjs; Shopify-only tags/filters are replaced by simple equivalents.
async function headerPage({sticky=true,body=null}={}){
 const globals={settings:{sticky_header:sticky,catalog_collection:null,group_delivery_navigation:false,announcement_enabled:true,announcement_1_text:'משלוח חינם מ-150 ₪',announcement_2_text:'איסוף עצמי מבאר שבע'},shop:{name:'פאנקי',customer_accounts_enabled:true,url:'https://fanakee.com'},routes:{root_url:'/',account_url:'/account',cart_url:'/cart',search_url:'/search',all_products_collection_url:'/collections/all',collections_url:'/collections',predictive_search_url:'/search/suggest'},cart:{item_count:2,items:[],total_price:3180,currency:{iso_code:'ILS'},note:''},request:{page_type:'index',path:'/'},pages:{},collections:{}};
 globals.cart['empty?']=false;
 const liquid=new Liquid({root:[path.join(root,'snippets')],extname:'.liquid',globals});
 const ignore=end=>({parse(token,remain){const stream=this.liquid.parser.parseStream(remain);stream.on('tag:'+end,()=>stream.stop()).on('template',()=>{}).on('end',()=>{throw Error(end+' missing');});stream.start();},*render(){}});
 for(const [tag,end] of [['doc','enddoc'],['stylesheet','endstylesheet'],['schema','endschema']])liquid.registerTag(tag,ignore(end));
 liquid.registerTag('form',{parse(token,remain){this.tpls=[];const stream=this.liquid.parser.parseStream(remain);stream.on('tag:endform',()=>stream.stop()).on('template',tpl=>this.tpls.push(tpl)).on('end',()=>{throw Error('endform');});stream.start();},*render(ctx,emitter){emitter.write('<form method="post" action="/cart" class="cart-drawer__form">');yield this.liquid.renderer.renderTemplates(this.tpls,ctx,emitter);emitter.write('</form>');}});
 const lookup=key=>key.split('.').reduce((a,k)=>a?.[k],he);
 liquid.registerFilter('t',(key,...args)=>{let v=lookup(key);if(typeof v!=='string')v=typeof v==='object'&&v?.other?v.other:key;for(const [k,val] of args.filter(Array.isArray))v=v.replace(new RegExp('{{\\s*'+k+'\\s*}}','g'),val);return v;});
 liquid.registerFilter('asset_url',f=>'/assets/'+f);
 liquid.registerFilter('money',c=>'₪'+(Number(c)/100).toFixed(2));
 liquid.registerFilter('image_url',img=>img?.src||'/assets/preloader.png');
 liquid.registerFilter('image_tag',(src,...args)=>{const o=Object.fromEntries(args.filter(Array.isArray));return `<img src="${src}" alt="${o.alt??''}" width="170" height="147">`;});
 const menu={links:[{title:'קטלוג',url:'/collections/all',active:false,current:false,links:[{title:'כביסה',url:'/collections/laundry',current:false,links:[{title:'מרכך',url:'/collections/s',current:false,links:[]}]}]},{title:'צור קשר',url:'/pages/contact',active:false,current:false,links:[]}]};
 const strip=s=>s.replace(/{% schema %}[\s\S]*?{% endschema %}/,'').replace(/{% stylesheet %}[\s\S]*?{% endstylesheet %}/,'');
 const header=await liquid.parseAndRender(strip(read('sections/header.liquid')),{section:{id:'header',settings:{logo:{src:'/assets/preloader.png',alt:'פאנקי'},menu}}});
 const announcement=await liquid.renderFile('announcement-bar',{});
 const block=f=>(read(f).match(/{% stylesheet %}([\s\S]*?){% endstylesheet %}/)||['',''])[1];
 const css=['bootstrap.min.css','animate.css','style.css','storefront.css','accessibility.css'].map(f=>read('assets/'+f)).join('\n')+['snippets/storefront-design.liquid','sections/header.liquid','snippets/cart-drawer.liquid','snippets/announcement-bar.liquid','snippets/navigation-links.liquid','snippets/predictive-search-styles.liquid'].map(block).join('\n');
 const content=body??'<section style="padding:24px 16px"><h1>תוכן</h1>'+'<p>טקסט לדוגמה בעמוד.</p>'.repeat(140)+'<h2 id="anchor">עוגן</h2>'+'<p>עוד טקסט.</p>'.repeat(40)+'</section>';
 return `<!doctype html><html class="js"${sticky?' data-sticky-header':''} dir="rtl" lang="he"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><a class="a11y-skip-link" href="#MainContent">דילוג לתוכן</a><div class="page-wrapper">${announcement}<div id="shopify-section-header" class="shopify-section header-section">${header}</div><main id="MainContent" tabindex="-1">${content}</main></div><button class="a11y-launcher" type="button">נגישות</button></body></html>`;
}


module.exports={headerPage,Liquid,root};
