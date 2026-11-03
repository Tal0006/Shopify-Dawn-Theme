import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SerpApiProductImageProvider,createProductImageProvider,CompositeProductImageProvider,type SerpApiDiagnostic} from '../src/images.js';
import {Importer} from '../src/importer.js';
const code='7290108356472';
const product={barcode:code,title:"מקסימה ג'ל כביסה מרוכז בייבי",manufacturer:'סנו',source:'cheapersal'};
const original='https://images.example.co.il/full-size.jpg';
const thumbnail='https://thumbs.example.co.il/preview.jpg';
const relevant={original,thumbnail,title:"סנו מקסימה ג'ל כביסה מרוכז בייבי 1.5 ליטר",link:'https://shop.example.co.il/product/'+code,
  source:'shop.example.co.il',original_width:800,original_height:800,is_product:true};
const valid={validate:async(value:unknown)=>({imageUrl:String(value)})};
const response=(data:unknown)=>new Response(JSON.stringify(data));
test('sends exact barcode, Google Images engine and Israeli/Hebrew defaults; reads only images_results',async()=>{
  let requests=0;
  const provider=new SerpApiProductImageProvider('test-key',async url=>{
    requests++;const params=new URL(String(url)).searchParams;
    assert.deepEqual(Object.fromEntries(params),{engine:'google_images',q:code,gl:'il',hl:'he',location:'Israel',api_key:'test-key',safe:'active'});
    return response({images_results:[relevant],shopping_results:[{...relevant,original:'https://wrong.example/shopping.jpg'}]});
  },valid);
  const candidates=await provider.findCandidatesByBarcode(code,product);
  assert.equal(requests,1);assert.equal(candidates.length,1);
  assert.equal(candidates[0].imageUrl,original);assert.equal(candidates[0].thumbnailUrl,thumbnail);
  assert.equal(candidates[0].title,relevant.title);assert.equal(candidates[0].sourceDomain,'shop.example.co.il');
  assert.equal(candidates[0].originalWidth,800);assert.equal(candidates[0].isProduct,true);
});
test('Shopping-only response produces no image candidates',async()=>{
  const provider=new SerpApiProductImageProvider('test',async()=>response({shopping_results:[relevant]}),valid);
  assert.deepEqual(await provider.findCandidatesByBarcode(code,product),[]);
});
test('locale overrides are passed through factory and distinct thumbnail survives composite normalization',async()=>{
  const provider=createProductImageProvider({PRODUCT_IMAGE_PROVIDER_ORDER:'serpapi',GOOGLE_IMAGE_PROVIDER:'serpapi',
    SERPAPI_API_KEY:'test',SERPAPI_GL:'gb',SERPAPI_HL:'en',SERPAPI_LOCATION:'London, England, United Kingdom'},async url=>{
    const p=new URL(String(url)).searchParams;assert.equal(p.get('gl'),'gb');assert.equal(p.get('hl'),'en');
    assert.equal(p.get('location'),'London, England, United Kingdom');
    return response({images_results:[relevant]});
  },valid);
  const result=await provider.discoverByBarcode!(code,product);
  assert.equal(result.image,null);assert.equal(result.candidates[0].thumbnailUrl,thumbnail);
  assert.equal(result.candidates[0].imageUrl,original);
});
test('Israeli matching product ranks above relevant US result; unrelated Walmart/Lowes products are rejected',async()=>{
  const provider=new SerpApiProductImageProvider('test',async()=>response({images_results:[
    {original:'https://walmart.example/paint.jpg',title:'24 Acrylic Paint Set',link:'https://www.walmart.com/paint',is_product:true,original_width:3000,original_height:3000},
    {original:'https://lowes.example/bath.jpg',title:'Bathroom accessory set',link:'https://www.lowes.com/bath',is_product:true},
    {...relevant,original:'https://us.example/product.jpg',link:'https://us.example/product',original_width:3000,original_height:3000},
    {...relevant,link:'https://shop.example.co.il/product'}
  ]}),valid,['walmart.com']);
  const candidates=await provider.findCandidatesByBarcode(code,product);
  assert.equal(candidates.length,2);assert.equal(candidates[0].imageUrl,original);
  assert.ok(candidates[0].relevanceScore!>candidates[1].relevanceScore!);
});
test('is_product, .il and dimensions cannot rescue a semantically unrelated result',async()=>{
  let checks=0;
  const provider=new SerpApiProductImageProvider('test',async()=>response({images_results:[
    {...relevant,title:'Drink bottle',link:'https://shop.example.co.il/'+code}
  ]}),{validate:async value=>{checks++;return {imageUrl:String(value)};}});
  assert.deepEqual(await provider.findCandidatesByBarcode(code,product),[]);assert.equal(checks,0);
});
test('manufacturer alone cannot match a different product',async()=>{
  const provider=new SerpApiProductImageProvider('test',async()=>response({images_results:[
    {...relevant,title:'סנו ספוגים לניקוי חלונות'}
  ]}),valid);
  assert.deepEqual(await provider.findCandidatesByBarcode(code,product),[]);
});
test('one relevant candidate stops the first search and prevents fallback queries',async()=>{
  const queries:string[]=[];
  const provider=new SerpApiProductImageProvider('test',async url=>{
    queries.push(new URL(String(url)).searchParams.get('q')!);return response({images_results:[relevant]});
  },valid);
  assert.equal((await provider.findCandidatesByBarcode(code,product)).length,1);
  assert.deepEqual(queries,[code]);
});
test('fallback order is exact barcode, barcode plus manufacturer, then manufacturer plus title',async()=>{
  const queries:string[]=[];
  const provider=new SerpApiProductImageProvider('test',async url=>{
    queries.push(new URL(String(url)).searchParams.get('q')!);
    return response({images_results:queries.length===3?[relevant]:[]});
  },valid);
  assert.equal((await provider.findCandidatesByBarcode(code,product)).length,1);
  assert.deepEqual(queries,[code,code+' '+product.manufacturer,product.manufacturer+' '+product.title]);
});
test('second query succeeds and prevents the third query',async()=>{
  const queries:string[]=[];
  const provider=new SerpApiProductImageProvider('test',async url=>{
    queries.push(new URL(String(url)).searchParams.get('q')!);
    return response({images_results:queries.length===2?[relevant]:[]});
  },valid);
  await provider.findCandidatesByBarcode(code,product);
  assert.deepEqual(queries,[code,code+' '+product.manufacturer]);
});
test('an invalid original is skipped; the next relevant original is used without fallback',async()=>{
  let requests=0;
  const provider=new SerpApiProductImageProvider('test',async()=>{
    requests++;return response({images_results:[{...relevant,original:'https://invalid.example/html'},relevant]});
  },{validate:async value=>{if(String(value).includes('invalid'))throw Error('not an image');return {imageUrl:String(value)};}});
  const candidates=await provider.findCandidatesByBarcode(code,product);
  assert.equal(candidates[0].imageUrl,original);assert.equal(requests,1);
});
test('thumbnail never substitutes for missing original and invalid thumbnail falls back to original preview',async()=>{
  const provider=new SerpApiProductImageProvider('test',async()=>response({images_results:[
    {...relevant,original:undefined},
    {...relevant,thumbnail:'javascript:alert(1)'}
  ]}),valid);
  const candidates=await provider.findCandidatesByBarcode(code,product);
  assert.equal(candidates.length,1);assert.equal(candidates[0].imageUrl,original);assert.equal(candidates[0].thumbnailUrl,original);
});
test('repeat and concurrent previews cache one SerpAPI search per barcode/locale',async()=>{
  let calls=0;
  const http:typeof fetch=async()=>{calls++;return response({images_results:[relevant]});};
  const he=new SerpApiProductImageProvider('test',http,valid);
  const [a,b]=await Promise.all([he.findCandidatesByBarcode(code,product),he.findCandidatesByBarcode(code,product)]);
  assert.deepEqual(a,b);a[0].title='changed';
  assert.equal((await he.findCandidatesByBarcode(code,product))[0].title,relevant.title);assert.equal(calls,1);
  const en=new SerpApiProductImageProvider('test',http,valid,[],{gl:'il',hl:'en',location:'Israel'});
  await en.findCandidatesByBarcode(code,product);assert.equal(calls,2);
});
test('up to five relevant candidates are returned with no irrelevant filler',async()=>{
  const provider=new SerpApiProductImageProvider('test',async()=>response({images_results:[
    ...Array.from({length:10},(_,i)=>({...relevant,original:'https://images.example.co.il/'+i+'.jpg'})),
    {original:'https://wrong.example/a.jpg',title:'Acrylic paint',link:'https://wrong.example/a'}
  ]}),valid);
  const candidates=await provider.findCandidatesByBarcode(code,product);
  assert.equal(candidates.length,5);assert.ok(candidates.every(c=>c.relevanceScore!>=.45));
});
test('only selected original is sent to Shopify, never the preview thumbnail',async()=>{
  let importedImage:string|undefined;
  const provider=new CompositeProductImageProvider([new SerpApiProductImageProvider('test',async()=>response({images_results:[relevant]}),valid)],valid);
  const service=new Importer({lookupByBarcode:async()=>product},{
    currency:async()=>'ILS',findBarcode:async()=>undefined,create:async p=>{
      importedImage=p.imageUrl;return {id:'1',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'};
    }
  },provider,valid);
  const p=await service.preview(code,'15.90');assert.equal(p.product.imageUrl,undefined);
  assert.equal(p.candidates[0].thumbnailUrl,thumbnail);
  await service.selectImage(p.id,0);await service.confirm(p.id);assert.equal(importedImage,original);
});
test('development diagnostics contain queries, locale and counts but never the API key',async()=>{
  const entries:SerpApiDiagnostic[]=[];
  const provider=new SerpApiProductImageProvider('private-test-key',async()=>response({images_results:[
    relevant,{...relevant,title:'Acrylic paint',original:'https://wrong.example/a.jpg'}
  ]}),valid,[],{development:true,diagnostic:entry=>entries.push(entry)});
  await provider.findCandidatesByBarcode(code,product);
  assert.equal(entries.length,1);assert.equal(entries[0].query,code);
  assert.deepEqual(entries[0].locale,{gl:'il',hl:'he',location:'Israel'});
  assert.equal(entries[0].imagesResultsReturned,2);assert.equal(entries[0].acceptedCandidates,1);assert.equal(entries[0].rejectedCandidates,1);
  assert.ok(!JSON.stringify(entries).includes('private-test-key'));
  const disabled=new SerpApiProductImageProvider('test',async()=>response({images_results:[relevant]}),valid,[],
    {development:false,diagnostic:()=>{throw Error('production diagnostics must not run');}});
  assert.equal((await disabled.findCandidatesByBarcode(code,product)).length,1);
});
