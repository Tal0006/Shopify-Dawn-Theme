import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BarcodeLookupImageProvider,GoUpcImageProvider,OpenProductsFactsImageProvider,SerpApiProductImageProvider,
  CompositeProductImageProvider,createProductImageProvider,PublicImageUrlValidator,imageDimensions} from '../src/images.js';
import {Importer} from '../src/importer.js';
import {createApp} from '../src/server.js';
const code='7290108356472';
const metadata={barcode:code,title:"מקסימה ג'ל כביסה מרוכז בייבי",manufacturer:'סנו',source:'cheapersal'};
const one='https://images.example.com/one.jpg',two='https://images.example.com/two.jpg';
const valid={validate:async(value:unknown)=>({imageUrl:String(value)})};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const env={PRODUCT_IMAGE_PROVIDER:'auto',BARCODE_LOOKUP_API_KEY:'barcode-test',GO_UPC_API_KEY:'go-test'};
const off={status:1,code,product:{code,image_front_url:one}};
const bl={products:[{barcode_number:code,images:[one,two]}]};
const upc={code:'OK',items:[{images:[one]}]};
const imported={id:'gid://shopify/Product/1',title:metadata.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'};
const gateway=(onCreate:(p:any)=>void=()=>{})=>({currency:async()=>'ILS',findBarcode:async()=>undefined,
  create:async(p:any)=>{onCreate(p);return imported;}});
test('Barcode Lookup uses exact barcode, validates multiple images and skips invalid URLs',async()=>{
  const calls:string[]=[];
  const provider=new BarcodeLookupImageProvider('secret',async url=>{
    const u=new URL(String(url));assert.equal(u.searchParams.get('barcode'),code);
    assert.equal(u.searchParams.get('key'),'secret');assert.equal(u.searchParams.has('search'),false);
    return response({products:[{barcode_number:code,images:['javascript:alert(1)',one,two]}]});
  },{validate:async value=>{calls.push(String(value));if(value===one)throw Error('not image');return {imageUrl:String(value)};}});
  const image=await provider.findByBarcode(code,metadata);
  assert.equal(image?.imageUrl,two);assert.equal(image?.confidence,.95);assert.deepEqual(calls,[one,two]);
});
test('mismatched Barcode Lookup and Go-UPC responses are not trusted',async()=>{
  assert.equal(await new BarcodeLookupImageProvider('key',async()=>response({products:[{barcode_number:'96385074',images:[one]}]}),valid)
    .findByBarcode(code,metadata),null);
  assert.equal(await new GoUpcImageProvider('key',async()=>response({code:'96385074',product:{imageUrl:one}}),valid)
    .findByBarcode(code,metadata),null);
});
test('Go-UPC uses Bearer auth and normalizes confidence',async()=>{
  const provider=new GoUpcImageProvider('secret',async(url,options)=>{
    assert.equal(url,'https://go-upc.com/api/v1/code/'+code);
    assert.equal((options?.headers as any).Authorization,'Bearer secret');
    return response({code,product:{imageUrl:one}});
  },valid);
  assert.equal((await provider.findByBarcode(code,metadata))?.source,'go-upc');
});
test('Open Facts uses product_type all and supports selected_images front',async()=>{
  const provider=new OpenProductsFactsImageProvider(async(url,options)=>{
    assert.equal(new URL(String(url)).searchParams.get('product_type'),'all');
    assert.match((options?.headers as any)['User-Agent'],/FankeeProductImporter/);
    return response({status:1,product:{code,selected_images:{front:{display:{he:one,en:two}}}}});
  },valid);
  const result=await provider.findByBarcode(code,metadata);
  assert.equal(result?.source,'open-products-facts');assert.equal(result?.imageUrl,one);assert.equal(result?.confidence,.9);
});
for(const target of ['barcodelookup','go-upc','open-products-facts','upcitemdb']){
  test('default chain reaches '+target+' and stops after success',async()=>{
    const calls:string[]=[];
    const provider=createProductImageProvider(env,async url=>{
      const u=String(url);calls.push(u);
      if(u.includes('barcodelookup'))return target==='barcodelookup'?response(bl):response({},404);
      if(u.includes('go-upc'))return target==='go-upc'?response({code,product:{imageUrl:one}}):response({},404);
      if(u.includes('openfoodfacts'))return target==='open-products-facts'?response(off):response({status:0});
      if(u.includes('upcitemdb'))return response(upc);
      throw Error('unexpected provider');
    },valid);
    const result=await provider.findByBarcode(code,metadata);
    assert.equal(result?.source,target);
    assert.equal(calls.length,['barcodelookup','go-upc','open-products-facts','upcitemdb'].indexOf(target)+1);
  });
}
test('network and 429 failures fall through, respect cooldown and cache paid calls',async()=>{
  for(const mode of ['network','429']){
    let firstCalls=0;
    const provider=createProductImageProvider({...env,PRODUCT_IMAGE_PROVIDER_ORDER:'barcodelookup,go-upc'},async url=>{
      if(String(url).includes('barcodelookup')){
        firstCalls++;if(mode==='network')throw Error('secret upstream failure');
        return new Response('{}',{status:429,headers:{'Retry-After':'3600'}});
      }
      return response({product:{imageUrl:one}});
    },valid);
    assert.equal((await provider.findByBarcode(code,metadata))?.source,'go-upc');
    await provider.findByBarcode(code,metadata);
    if(mode==='429')await provider.findByBarcode('7290012823626',metadata);
    assert.equal(firstCalls,1);
  }
});
test('provider order is configurable and unknown providers rejected',async()=>{
  let requests=0;
  const provider=createProductImageProvider({...env,PRODUCT_IMAGE_PROVIDER_ORDER:'go-upc,barcodelookup'},async url=>{
    requests++;assert.match(String(url),/go-upc/);return response({product:{imageUrl:one}});
  },valid);
  assert.equal((await provider.findByBarcode(code,metadata))?.source,'go-upc');assert.equal(requests,1);
  assert.throws(()=>createProductImageProvider({PRODUCT_IMAGE_PROVIDER_ORDER:'unknown'}));
});
test('paid API responses and composite discovery are cached and coalesced',async()=>{
  let calls=0;
  const provider=createProductImageProvider({...env,PRODUCT_IMAGE_PROVIDER_ORDER:'barcodelookup'},async()=>{
    calls++;return response(bl);
  },valid);
  const [a,b]=await Promise.all([provider.discoverByBarcode!(code,metadata),provider.discoverByBarcode!(code,metadata)]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  a.candidates[0].imageUrl='https://tampered.example/a';
  assert.equal((await provider.discoverByBarcode!(code,metadata)).candidates[0].imageUrl,one);
});
test('multiple exact barcode images are offered; changing selection does not create Shopify product',async()=>{
  let created=0;
  const images=new BarcodeLookupImageProvider('key',async()=>response(bl),valid);
  const service=new Importer({lookupByBarcode:async()=>metadata},gateway(()=>created++),
    new CompositeProductImageProvider([images],valid),valid);
  const p=await service.preview(code,'15.90');
  assert.equal(p.candidates.length,2);assert.equal(p.product.imageUrl,one);
  const selected=await service.selectImage(p.id,1);
  assert.equal(selected.product.imageUrl,two);assert.equal(created,0);
  await service.confirm(p.id);assert.equal(created,1);
  await assert.rejects(service.selectImage(p.id,0));
});
test('SerpAPI returns candidates only, ranks preferred domains and limits to five',async()=>{
  const provider=new SerpApiProductImageProvider('secret',async url=>{
    const u=new URL(String(url));assert.equal(u.searchParams.get('engine'),'google_images');
    assert.equal(u.searchParams.get('api_key'),'secret');
    return response({images_results:[
      {original:one,title:metadata.title,link:'https://retailer.example/product',original_width:1000,original_height:1000},
      {original:two,title:metadata.title,link:'https://brand.example/product',original_width:600,original_height:600},
      ...Array.from({length:10},(_,i)=>({original:'https://images.example.com/'+i+'.jpg',title:metadata.title,link:'https://catalog.example/product'}))
    ]});
  },valid,['brand.example']);
  assert.equal(await provider.findByBarcode(),null);
  const candidates=await provider.findCandidatesByBarcode(code,metadata);
  assert.equal(candidates.length,5);assert.equal(candidates[0].imageUrl,two);
  assert.equal(candidates[0].confidence,.5);assert.equal(candidates[0].sourceDomain,'brand.example');
});
test('SerpAPI empty barcode results trigger barcode/manufacturer fallback and cache both',async()=>{
  const queries:string[]=[];
  const provider=new SerpApiProductImageProvider('secret',async url=>{
    const query=new URL(String(url)).searchParams.get('q')!;queries.push(query);
    return response({images_results:query===code?[]:[{original:one,title:metadata.title,link:'https://brand.example/product'}]});
  },valid);
  await provider.findCandidatesByBarcode(code,metadata);await provider.findCandidatesByBarcode(code,metadata);
  assert.deepEqual(queries,[code,code+' '+metadata.manufacturer]);
});
test('Google results are not automatically imported, even one candidate needs explicit selection',async()=>{
  let image:string|undefined;
  const search=new SerpApiProductImageProvider('key',async()=>response({images_results:[{original:one,title:metadata.title,link:'https://brand.example/product'}]}),valid);
  const provider=new CompositeProductImageProvider([search],valid);
  const service=new Importer({lookupByBarcode:async()=>metadata},gateway(p=>image=p.imageUrl),provider,valid);
  const p=await service.preview(code,'15.90');
  assert.equal(p.product.imageUrl,undefined);assert.equal(p.candidates.length,1);
  await assert.rejects(service.selectImage(p.id,9));await assert.rejects(service.selectImage('forged',0));
  const selected=await service.selectImage(p.id,0);
  assert.equal(selected.product.imageSource,'serpapi');assert.equal(selected.manuallySelected,true);
  assert.equal(selected.selectedImage?.sourcePageUrl,'https://brand.example/product');
  await service.confirm(p.id);assert.equal(image,one);
  const cached=await service.preview(code,'15.90');assert.equal(cached.manuallySelected,true);assert.equal(cached.product.imageUrl,one);
});
test('low confidence and search sources cannot auto-select even if they return a direct result',async()=>{
  const provider=new CompositeProductImageProvider([{findByBarcode:async()=>({imageUrl:one,source:'serpapi',confidence:.99})}],valid);
  const discovery=await provider.discoverByBarcode(code,metadata);
  assert.equal(discovery.image,null);assert.equal(discovery.candidates.length,1);
});
test('no provider image allows manual fallback or confirmed import without an image',async()=>{
  const images=new CompositeProductImageProvider([{findByBarcode:async()=>null}],valid);
  let createdImage:string|undefined;
  const service=new Importer({lookupByBarcode:async()=>metadata},gateway(p=>createdImage=p.imageUrl),images,valid);
  const p=await service.preview(code,'15.90',two);assert.equal(p.product.imageSource,'manual');
  await service.confirm(p.id);assert.equal(createdImage,two);
  const empty=await service.preview(code,'15.90');assert.match(empty.imageWarning!,/לא נמצאה תמונה אוטומטית/);
  await service.confirm(empty.id);assert.equal(createdImage,undefined);
});
test('choosing no image is explicit and does not upload a previously selected image',async()=>{
  let image:string|undefined=one;
  const service=new Importer({lookupByBarcode:async()=>metadata},gateway(p=>image=p.imageUrl),
    new CompositeProductImageProvider([new BarcodeLookupImageProvider('key',async()=>response(bl),valid)],valid),valid);
  const p=await service.preview(code,'15.90');await service.selectImage(p.id,null);
  await service.confirm(p.id);assert.equal(image,undefined);
});
test('image validation rejects length, tracking pixels, tiny dimensions and disguised HTML',async()=>{
  const resolve=async()=>[{address:'8.8.8.8',family:4}];
  const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.write('IHDR',12,'ascii');png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
  assert.deepEqual(imageDimensions(png),{width:1,height:1});
  for(const probe of [
    {status:200,contentType:'image/png',contentLength:30},
    {status:200,contentType:'image/png',contentLength:21*1024*1024},
    {status:200,contentType:'image/png',sample:png},
    {status:200,contentType:'image/jpeg',sample:Buffer.from('<!doctype html><html>fake</html>')}
  ])await assert.rejects(new PublicImageUrlValidator(resolve,async()=>probe).validate(one));
  await assert.rejects(new PublicImageUrlValidator(resolve,async()=>({status:200})).validate('https://images.example.com/1x1.gif'));
  png.writeUInt32BE(500,16);png.writeUInt32BE(500,20);
  assert.equal((await new PublicImageUrlValidator(resolve,async()=>({status:200,contentType:'image/png',sample:png})).validate(one)).warning,undefined);
});
test('candidate selection HTTP endpoint enforces CSRF and server-held candidate index',async()=>{
  const service=new Importer({lookupByBarcode:async()=>metadata},gateway(),
    new CompositeProductImageProvider([new BarcodeLookupImageProvider('key',async()=>response(bl),valid)],valid),valid);
  const server=createApp(service,4314).listen(4314,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:4314';
  try{
    const {csrf}=await(await fetch(origin+'/api/session')).json();
    const headers={Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
    const p=await(await fetch(origin+'/api/preview',{method:'POST',headers,body:JSON.stringify({barcode:code,price:'15.90'})})).json();
    assert.equal((await fetch(origin+'/api/image-selection',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,403);
    const selected=await(await fetch(origin+'/api/image-selection',{method:'POST',headers,body:JSON.stringify({previewId:p.id,candidateIndex:1,imageUrl:'https://untrusted.example/a'})})).json();
    assert.equal(selected.product.imageUrl,two);
    assert.equal((await fetch(origin+'/api/image-selection',{method:'POST',headers,body:JSON.stringify({previewId:p.id,candidateIndex:100})})).status,400);
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('Open Facts v3 follows only official cross-product HTTPS API redirects',async()=>{
  const calls:string[]=[];
  const provider=new OpenProductsFactsImageProvider(async(url,options)=>{
    calls.push(String(url));assert.equal(options?.redirect,'manual');
    if(calls.length===1)return new Response(null,{status:302,headers:{
      Location:'https://world.openproductsfacts.org/api/v3/product/'+code+'.json?fields=code,image_front_url'
    }});
    return response({status:'success',code,result:{id:'product_found'},product:{code,image_front_url:one}});
  },valid);
  assert.equal((await provider.findByBarcode(code,metadata))?.imageUrl,one);assert.equal(calls.length,2);
  let count=0;
  const blocked=new OpenProductsFactsImageProvider(async()=>{
    count++;return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/api/v3/product/'+code}});
  },valid);
  assert.equal(await blocked.findByBarcode(code,metadata),null);assert.equal(count,1);
});
test('rapid Go-UPC calls are spaced without issuing an extra paid request',async()=>{
  let count=0;
  const provider=new GoUpcImageProvider('key',async()=>{count++;return response({product:{imageUrl:one}});},valid);
  await provider.findByBarcode(code,metadata);await provider.findByBarcode('7290012823626',metadata);
  assert.equal(count,1);
});
test('test harness blocks accidental external requests before network access',async()=>{
  await assert.rejects(fetch('https://example.com/should-never-be-requested'),/External HTTP is disabled/);
});
