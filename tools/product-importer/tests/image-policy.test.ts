import {adminEnv,loginForTest} from './auth-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {AuthorizedApiProductImageProvider,CompositeProductImageProvider,SerpApiProductImageProvider,ImageSourcePolicy,
  PublicImageUrlValidator,createProductImageProvider,hostMatchesDomain,imageSourcePolicyFromEnv,parseApprovedDomains,
  parseApprovedProviders,logDomain,type ProductImageProvider} from '../src/images.js';
import {Importer} from '../src/importer.js';
import {ShopifyAdmin} from '../src/shopify.js';
import {createApp} from '../src/server.js';
import type {ProductCatalogProduct} from '../src/catalog.js';

const code='7290108356472';
const metadata={barcode:code,title:"מקסימה ג'ל כביסה מרוכז בייבי",manufacturer:'סנו',category:'laundry',unitQuantity:'1.5',source:'cheapersal'};
const SERP_KEY='serp-private-test-key',AUTH_KEY='authorized-private-test-key',BL_KEY='barcode-private-test-key';
const brandImage='https://images.officialbrand.co.il/products/7291234567890.jpg';
const otherImage='https://images.example.com/found.jpg';
const valid={validate:async(value:unknown)=>({imageUrl:String(value)})};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const brandPolicy=new ImageSourcePolicy({approvedDomains:parseApprovedDomains('officialbrand.co.il')});
const result=(p:ProductCatalogProduct)=>({id:'gid://shopify/Product/1',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'});
function gateway(){
  const created:ProductCatalogProduct[]=[];
  return {created,shop:{currency:async()=>'ILS',findBarcode:async()=>undefined,
    create:async(p:ProductCatalogProduct)=>{created.push(structuredClone(p));return result(p);}}};
}
const searchResult=(original:string,link='https://shop.example.co.il/product/'+code)=>({original,
  title:"סנו מקסימה ג'ל כביסה מרוכז בייבי 1.5 ליטר",link,original_width:800,original_height:800,is_product:true});
const serp=(original:string,link?:string,validator=valid)=>new SerpApiProductImageProvider(SERP_KEY,
  async()=>json({images_results:[searchResult(original,link)]}),validator);
const catalog={lookupByBarcode:async()=>({...metadata})};

test('approved domains parse safely: comma list, trim, lowercase, empty values and invalid entries ignored',()=>{
  assert.deepEqual(parseApprovedDomains(' ExampleManufacturer.com, ,OfficialBrand.CO.IL ,importer.example.co.il,,'),
    ['examplemanufacturer.com','officialbrand.co.il','importer.example.co.il']);
  for(const empty of [undefined,'','  ',',,, ,'])assert.deepEqual(parseApprovedDomains(empty),[]);
  // Schemes, paths, ports, credentials, IPs, single labels and shared suffixes never become approvals.
  assert.deepEqual(parseApprovedDomains('https://brand.com,brand.com/path,brand.com:443,user@brand.com,127.0.0.1,'+
    'localhost,co.il,com,cdn.shopify.com,brand com,*'),[]);
  assert.deepEqual(parseApprovedDomains('*.officialbrand.com,.media.brand.co.il,officialbrand.com.'),['officialbrand.com','media.brand.co.il']);
});
test('hostname matching accepts subdomains and rejects lookalike suffix tricks',()=>{
  assert.equal(hostMatchesDomain('officialbrand.com','officialbrand.com'),true);
  assert.equal(hostMatchesDomain('media.officialbrand.com','officialbrand.com'),true);
  for(const host of ['officialbrand.com.evil.example','evilofficialbrand.com','officialbrand.co','com',undefined])
    assert.equal(hostMatchesDomain(host,'officialbrand.com'),false,String(host));
  const policy=new ImageSourcePolicy({approvedDomains:['officialbrand.com']});
  for(const url of ['https://officialbrand.com.evil.example/a.jpg','https://evil.example/officialbrand.com/a.jpg',
    'https://evil.example/a.jpg?u=https://officialbrand.com/a.jpg','https://evilofficialbrand.com/a.jpg',
    'http://officialbrand.com/a.jpg','data:image/png;base64,AAAA','javascript:alert(1)','not a url'])
    assert.equal(policy.classify({imageUrl:url,source:'serpapi'}).autoAttachAllowed,false,url);
  assert.equal(policy.classify({imageUrl:'https://officialbrand.com./a.jpg',source:'serpapi'}).usagePolicy,'APPROVED');
});
test('uppercase/lowercase hostnames are normalized for both configuration and image URLs',()=>{
  const policy=new ImageSourcePolicy({approvedDomains:parseApprovedDomains(' OfficialBrand.CO.IL ')});
  assert.equal(policy.classify({imageUrl:'https://IMAGES.OfficialBrand.Co.IL/P/1.JPG',source:'serpapi'}).usagePolicy,'APPROVED');
});
test('empty or missing PRODUCT_IMAGE_APPROVED_DOMAINS boots safely; SerpAPI stays discovery-only',async()=>{
  for(const value of [undefined,'',' , ','https://bad'] as const){
    const env={GOOGLE_IMAGE_PROVIDER:'serpapi',SERPAPI_API_KEY:SERP_KEY,PRODUCT_IMAGE_PROVIDER_ORDER:'serpapi',
      ...(value===undefined?{}:{PRODUCT_IMAGE_APPROVED_DOMAINS:value})};
    assert.deepEqual(imageSourcePolicyFromEnv(env).approvedDomains,[]);
    const images=createProductImageProvider(env,async()=>json({images_results:[searchResult(brandImage)]}),valid);
    const discovery=await images.discoverByBarcode!(code,metadata);
    assert.equal(discovery.image,null);assert.equal(discovery.candidates[0].usagePolicy,'DISCOVERY_ONLY');
    assert.doesNotThrow(()=>createApp(new Importer(catalog,gateway().shop,images),4399,{...adminEnv,...env}));
  }
  assert.deepEqual(imageSourcePolicyFromEnv({}).approvedProviders,['authorized-api']);
  assert.deepEqual(parseApprovedProviders('serpapi,manual,unknown, UPCITEMDB '),['upcitemdb']);
});
test('1. SerpAPI image from an arbitrary domain is DISCOVERY_ONLY and not attached',async()=>{
  const images=new CompositeProductImageProvider([serp(otherImage)],valid,brandPolicy);
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,images,valid);
  const p=await service.preview(code,'15.90');
  assert.equal(p.product.imageUrl,undefined);
  assert.equal(p.candidates[0].usagePolicy,'DISCOVERY_ONLY');assert.equal(p.candidates[0].autoAttachAllowed,false);
  assert.equal(p.candidates[0].source,'serpapi');assert.equal(p.candidates[0].sourceDomain,'shop.example.co.il');
  await service.confirm(p.id);assert.equal(created[0].imageUrl,undefined);
});
test('2. SerpAPI image hosted on an approved domain is APPROVED and auto-attached',async()=>{
  const images=new CompositeProductImageProvider([serp(brandImage)],valid,brandPolicy);
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,images,valid);
  const p=await service.preview(code,'15.90');
  assert.equal(p.product.imageUrl,brandImage);assert.equal(p.product.imageSource,'serpapi');
  assert.equal(p.selectedImage?.usagePolicy,'APPROVED');assert.equal(p.selectedImage?.autoAttachAllowed,true);
  assert.equal(p.selectedImage?.reason,'approved-domain');assert.equal(p.manuallySelected,false);
  await service.confirm(p.id);assert.equal(created[0].imageUrl,brandImage);
});
test('3-5. approved subdomain is accepted; lookalike domain is not; matching is case-insensitive',async()=>{
  const check=async(image:string)=>(await new CompositeProductImageProvider([serp(image)],valid,brandPolicy)
    .discoverByBarcode(code,metadata)).image?.usagePolicy;
  assert.equal(await check('https://media.cdn.officialbrand.co.il/x.jpg'),'APPROVED');
  assert.equal(await check('https://MEDIA.OfficialBrand.CO.IL/x.jpg'),'APPROVED');
  assert.equal(await check('https://officialbrand.co.il.evil.example/x.jpg'),undefined);
  assert.equal(await check('https://notofficialbrand.co.il/x.jpg'),undefined);
});
test('7. an approved provider image (authorized-api) still auto-attaches by default',async()=>{
  const images=createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'authorized-api',PRODUCT_IMAGE_API_KEY:AUTH_KEY,
    PRODUCT_IMAGE_API_URL:'https://authorized.example/{barcode}'},async()=>json({imageUrl:otherImage}),valid);
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,images,valid);
  const p=await service.preview(code,'15.90');
  assert.equal(p.product.imageSource,'authorized-api');assert.equal(p.selectedImage?.usagePolicy,'APPROVED');
  await service.confirm(p.id);assert.equal(created[0].imageUrl,otherImage);
});
test('8-10. discovery-only results do not auto-attach, the chain continues, and import without image succeeds',async()=>{
  const calls:string[]=[];
  const env={PRODUCT_IMAGE_PROVIDER:'auto',PRODUCT_IMAGE_PROVIDER_ORDER:'barcodelookup,serpapi,authorized-api',
    BARCODE_LOOKUP_API_KEY:BL_KEY,GOOGLE_IMAGE_PROVIDER:'serpapi',SERPAPI_API_KEY:SERP_KEY,
    PRODUCT_IMAGE_API_KEY:AUTH_KEY,PRODUCT_IMAGE_API_URL:'https://authorized.example/{barcode}'};
  const http=(authorized:unknown):typeof fetch=>async url=>{
    const u=String(url);calls.push(new URL(u).hostname);
    if(u.includes('barcodelookup'))return json({products:[{barcode_number:code,images:['https://catalog.example.com/bl.jpg']}]});
    if(u.includes('serpapi'))return json({images_results:[searchResult(otherImage)]});
    return authorized===null?json({},404):json({imageUrl:authorized});
  };
  const chained=createProductImageProvider(env,http('https://authorized.example/cdn/a.jpg'),valid);
  const p=await new Importer(catalog,gateway().shop,chained,valid).preview(code,'15.90');
  assert.deepEqual(calls,['api.barcodelookup.com','serpapi.com','authorized.example']);
  assert.equal(p.product.imageSource,'authorized-api');assert.equal(p.selectedImage?.usagePolicy,'APPROVED');
  assert.deepEqual(p.candidates.map(c=>[c.source,c.usagePolicy]),
    [['authorized-api','APPROVED'],['barcodelookup','DISCOVERY_ONLY'],['serpapi','DISCOVERY_ONLY']]);
  const {shop,created}=gateway();
  const onlyDiscovery=new Importer(catalog,shop,createProductImageProvider(env,http(null),valid),valid);
  const empty=await onlyDiscovery.preview(code,'15.90');
  assert.equal(empty.product.imageUrl,undefined);assert.equal(empty.candidates.length,2);
  assert.ok(empty.candidates.every(c=>c.autoAttachAllowed===false));
  assert.match(empty.imageWarning!,/ממקור מאושר/);
  const outcome=await onlyDiscovery.confirm(empty.id);
  assert.equal(outcome.duplicate,false);assert.equal(created.length,1);assert.equal(created[0].imageUrl,undefined);
});
test('11-12. manual URL needs explicit approval; with it the image is MANUAL_APPROVED and attached',async()=>{
  let lookups=0;
  const {shop,created}=gateway();
  const service=new Importer({lookupByBarcode:async()=>{lookups++;return {...metadata};}},shop,undefined,valid);
  for(const approval of [undefined,false,'true',1,'yes'])
    await assert.rejects(service.preview(code,'15.90',otherImage,approval),/הרשאה/);
  assert.equal(lookups,0);
  const p=await service.preview(code,'15.90',otherImage,true);
  assert.equal(p.product.imageSource,'manual');assert.equal(p.selectedImage?.usagePolicy,'MANUAL_APPROVED');
  assert.equal(p.selectedImage?.autoAttachAllowed,false);
  await service.confirm(p.id);assert.equal(created[0].imageUrl,otherImage);
});
test('13. a manual approval covers that image and product action only, not its domain',async()=>{
  const sameHost='https://images.example.com/another.jpg';
  const images=new CompositeProductImageProvider([serp(sameHost)],valid);
  const service=new Importer(catalog,gateway().shop,images,valid);
  const manual=await service.preview(code,'15.90',otherImage,true);
  assert.equal(manual.selectedImage?.usagePolicy,'MANUAL_APPROVED');
  const later=await service.preview(code,'15.90');
  assert.equal(later.product.imageUrl,undefined);
  assert.equal(later.candidates[0].imageUrl,sameHost);assert.equal(later.candidates[0].usagePolicy,'DISCOVERY_ONLY');
  await assert.rejects(service.selectImage(later.id,0),/הרשאה/);
  await assert.rejects(service.preview(code,'15.90',otherImage),/הרשאה/);
  assert.deepEqual(images.policy.approvedDomains,[]);
});
test('14. preview exposes provider, source page and source-page domain; the UI renders them in Hebrew',async()=>{
  const images=new CompositeProductImageProvider([serp(otherImage,'https://www.OfficialBrand.co.il/product/'+code)],valid);
  const p=await new Importer(catalog,gateway().shop,images,valid).preview(code,'15.90');
  const c=p.candidates[0];
  assert.equal(c.source,'serpapi');assert.equal(c.sourceDomain,'www.officialbrand.co.il');
  assert.equal(c.sourcePageUrl,'https://www.officialbrand.co.il/product/'+code);assert.equal(c.imageUrl,otherImage);
  const ui=readFileSync(new URL('../public/app.js',import.meta.url),'utf8')+readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  for(const text of ['מקור תמונה מאושר','תמונה לבדיקה','המקור אינו ברשימת המקורות המאושרים לשימוש אוטומטי.',
    'נמצאה תמונה בחיפוש, אך המקור אינו מאושר לשימוש אוטומטי.','יש לוודא שיש הרשאה להשתמש בתמונה לפני שמוסיפים אותה למוצר.',
    'אני מאשר/ת שיש לנו הרשאה להשתמש בתמונה הזו','השתמש בתמונה','חפש תמונה אחרת','תמונה נמצאה דרך: '])
    assert.ok(ui.includes(text),text);
  assert.doesNotMatch(ui,/זכויות יוצרים|לא חוקי|מוגנת/);
});
test('15. final server-side guard blocks unapproved images before the Shopify mutation',async()=>{
  // Approved-domain image that redirects off the approved domain by import time (e.g. open redirect).
  let redirect=false;
  const shifting={validate:async(value:unknown)=>({imageUrl:redirect?'https://evil.example/x.jpg':String(value)})};
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,new CompositeProductImageProvider([serp(brandImage,undefined,shifting)],shifting,brandPolicy),shifting);
  const p=await service.preview(code,'15.90');assert.equal(p.selectedImage?.usagePolicy,'APPROVED');
  redirect=true;await assert.rejects(service.confirm(p.id),/אינה מאושרת/);
  // Confirmed discovery image whose final URL changed after the admin confirmed it.
  redirect=false;
  const confirmedService=new Importer(catalog,shop,new CompositeProductImageProvider([serp(otherImage,undefined,shifting)],shifting),shifting);
  const q=await confirmedService.preview(code,'15.90');await confirmedService.selectImage(q.id,0,true);
  redirect=true;await assert.rejects(confirmedService.confirm(q.id),/אינה מאושרת/);
  // A real validator following an approved-domain open redirect yields an unapproved final URL.
  const redirecting=new PublicImageUrlValidator(async()=>[{address:'8.8.8.8',family:4}],async url=>
    url.hostname.endsWith('officialbrand.co.il')?{status:302,location:'https://evil.example/x.jpg'}:{status:200,contentType:'image/jpeg'});
  const openRedirect=await new CompositeProductImageProvider([serp(brandImage,undefined,valid)],redirecting,brandPolicy).discoverByBarcode(code,metadata);
  assert.equal(openRedirect.image,null);assert.equal(openRedirect.candidates[0].imageUrl,'https://evil.example/x.jpg');
  assert.equal(openRedirect.candidates[0].usagePolicy,'DISCOVERY_ONLY');
  assert.equal(created.length,0);
});
test('15b. HTTP clients cannot force approval with their own flags',async()=>{
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,new CompositeProductImageProvider([serp(otherImage)],valid),valid);
  const server=createApp(service,4315,adminEnv).listen(4315,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:4315';
  try{
    const Cookie=await loginForTest(origin);
    const {csrf}=await(await fetch(origin+'/api/session',{headers:{Cookie}})).json();
    const headers={Cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
    const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await post('/api/preview',{barcode:code,price:'15.90',manualImageUrl:otherImage,manualImageApproved:'true'})).status,400);
    const p=await(await post('/api/preview',{barcode:code,price:'15.90',approved:true,autoAttachAllowed:true})).json();
    assert.equal(p.product.imageUrl,undefined);
    assert.equal((await post('/api/image-selection',{previewId:p.id,candidateIndex:0,approved:true,autoAttachAllowed:true})).status,400);
    await post('/api/import',{previewId:p.id,imageUrl:otherImage,approved:true});
    assert.equal(created.length,1);assert.equal(created[0].imageUrl,undefined);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('16-17. metadata flow is unchanged and Shopify DRAFT creation works with and without an image',async()=>{
  const inputs:any[]=[];
  const admin=new ShopifyAdmin({domain:'example.myshopify.com',token:'shopify-private-token'},async(_url,options)=>{
    const body=JSON.parse(String(options!.body));
    if(body.query.includes('StoreCurrency'))return json({data:{shop:{currencyCode:'ILS'}}});
    if(body.query.includes('ExistingBarcode'))return json({data:{productVariants:{nodes:[],pageInfo:{hasNextPage:false}}}});
    if(body.query.includes('CatalogDefinitions'))return json({data:{metafieldDefinitions:{nodes:[],pageInfo:{hasNextPage:false}}}});
    inputs.push(body.variables.input);
    return json({data:{productSet:{product:{id:'gid://shopify/Product/9',title:metadata.title},userErrors:[]}}});
  });
  for(const images of [new CompositeProductImageProvider([serp(otherImage)],valid),
    new CompositeProductImageProvider([serp(brandImage)],valid,brandPolicy)] as ProductImageProvider[]){
    const service=new Importer({lookupByBarcode:async()=>({...metadata,imageUrl:'https://ignored.example/a.jpg'})},admin,images,valid);
    const p=await service.preview(code,'15.90');
    for(const key of ['barcode','title','manufacturer','category','unitQuantity','source'] as const)
      assert.equal(p.product[key],metadata[key]);
    await service.confirm(p.id);
  }
  assert.equal(inputs.length,2);
  for(const input of inputs){assert.equal(input.status,'DRAFT');assert.equal(input.variants[0].price,'15.90');
    assert.deepEqual(input.variants[0].barcodes,[{value:code}]);}
  assert.equal(inputs[0].files,undefined);
  assert.deepEqual(inputs[1].files,[{originalSource:brandImage,contentType:'IMAGE',alt:metadata.title}]);
});
test('18. image decision logs contain provider, domain, policy and autoAttach, never keys or signed URLs',async()=>{
  const lines:string[]=[];
  const signed='https://cdn.example.net/img.jpg?token=SIGNEDTOKEN123&key='+SERP_KEY;
  const images=createProductImageProvider({PRODUCT_IMAGE_PROVIDER_ORDER:'serpapi,authorized-api',GOOGLE_IMAGE_PROVIDER:'serpapi',
    SERPAPI_API_KEY:SERP_KEY,PRODUCT_IMAGE_API_KEY:AUTH_KEY,PRODUCT_IMAGE_API_URL:'https://authorized.example/{barcode}'},
  async url=>String(url).includes('serpapi')?json({images_results:[searchResult(signed,'https://shop.example.co.il/p?session='+AUTH_KEY)]}):json({},404),valid);
  const service=new Importer(catalog,gateway().shop,images,valid,{log:line=>lines.push(line)});
  const p=await service.preview(code,'15.90',otherImage,true);
  await service.selectImage(p.id,0,true);await service.confirm(p.id);
  const log=lines.join('\n');
  assert.match(log,/\[image\] action=select provider=serpapi domain=shop\.example\.co\.il policy=MANUAL_APPROVED autoAttach=false attached=true/);
  assert.match(log,/action=manual provider=manual domain=images\.example\.com policy=MANUAL_APPROVED/);
  assert.match(log,/action=import provider=serpapi/);
  for(const secret of [SERP_KEY,AUTH_KEY,'SIGNEDTOKEN123','://','?'])assert.ok(!log.includes(secret),secret);
  assert.equal(logDomain('https://a.example/x?y=1'),'a.example');assert.equal(logDomain('bad host/<script>'),'unknown');
});
test('policy fields supplied by a provider are never trusted',async()=>{
  const forged:ProductImageProvider={findByBarcode:async()=>({imageUrl:otherImage,source:'barcodelookup',confidence:.99,
    usagePolicy:'APPROVED',autoAttachAllowed:true,reason:'forged'})};
  const discovery=await new CompositeProductImageProvider([forged],valid).discoverByBarcode(code,metadata);
  assert.equal(discovery.image,null);assert.equal(discovery.candidates[0].usagePolicy,'DISCOVERY_ONLY');
  const direct=await new Importer(catalog,gateway().shop,forged,valid).preview(code,'15.90');
  assert.equal(direct.product.imageUrl,undefined);assert.equal(direct.candidates[0].autoAttachAllowed,false);
});
test('explicit PRODUCT_IMAGE_APPROVED_PROVIDERS restores automatic use for a contracted provider',async()=>{
  const images=createProductImageProvider({PRODUCT_IMAGE_PROVIDER_ORDER:'barcodelookup',BARCODE_LOOKUP_API_KEY:BL_KEY,
    PRODUCT_IMAGE_APPROVED_PROVIDERS:'barcodelookup'},async()=>json({products:[{barcode_number:code,images:[otherImage]}]}),valid);
  const p=await new Importer(catalog,gateway().shop,images,valid).preview(code,'15.90');
  assert.equal(p.product.imageSource,'barcodelookup');assert.equal(p.selectedImage?.reason,'approved-provider');
});
test('manual URLs are still SSRF-checked: data, javascript, private and malformed URLs are rejected',async()=>{
  let probes=0;
  const validator=new PublicImageUrlValidator(async host=>[{address:host==='internal.example.com'?'10.0.0.5':'8.8.8.8',family:4}],
    async()=>{probes++;return {status:200,contentType:'image/png'};});
  const service=new Importer(catalog,gateway().shop,undefined,validator);
  for(const url of ['data:image/png;base64,iVBORw0KGgo=','javascript:alert(1)','http://169.254.169.254/latest','http://localhost/a.png',
    'https://internal.example.com/a.png','https://[::1]/a.png','http://2130706433/a.png','https://user:pw@images.example.com/a.png','::not-a-url'])
    await assert.rejects(service.preview(code,'15.90',url,true),url);
  assert.equal(probes,0);
});
