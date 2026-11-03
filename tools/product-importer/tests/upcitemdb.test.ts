import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UpcItemDbImageProvider } from '../src/upcitemdb.js';
import { createProductImageProvider, FallbackProductImageProvider } from '../src/images.js';
import { Importer } from '../src/importer.js';
const code='7290108356472';
const product={barcode:code,title:'Cheapersal title',source:'cheapersal'};
const first='https://images.example.com/first.jpg', second='https://images.example.com/second.jpg';
const valid={validate:async (value:unknown)=>({imageUrl:String(value)})};
const body=(images:unknown)=>({code:'OK',total:1,items:[{images}]});
const mock=(value:unknown,status=200):typeof fetch=>async()=>new Response(JSON.stringify(value),{status});
test('UPCitemdb one image uses free endpoint without an API key',async()=>{
  const provider=new UpcItemDbImageProvider(async (url,options)=>{
    assert.equal(url,'https://api.upcitemdb.com/prod/trial/lookup?upc='+code);
    assert.deepEqual(options?.headers,{Accept:'application/json'});
    assert.equal(options?.redirect,'error');
    return new Response(JSON.stringify(body([first])));
  },valid);
  const image=await provider.findByBarcode(code,product);
  assert.equal(image?.imageUrl,first);assert.equal(image?.source,'upcitemdb');assert.equal(image?.confidence,0.90);
  assert.equal(image?.candidates?.length,1);
});
test('several valid images select the first and retain alternatives',async()=>{
  const checked:unknown[]=[];
  const provider=new UpcItemDbImageProvider(mock(body([first,second])),{
    validate:async value=>{checked.push(value);return {imageUrl:String(value)};}
  });
  assert.equal((await provider.findByBarcode(code,product))?.imageUrl,first);
  assert.deepEqual(checked,[first,second]);
});
test('invalid first URL and non-image content advance to the next HTTPS candidate',async()=>{
  const provider=new UpcItemDbImageProvider(mock(body(['javascript:alert(1)','http://images.example.com/plain.jpg',first,second])),{
    validate:async value=>{if(value===first) throw Error('text/html');return {imageUrl:String(value)};}
  });
  assert.equal((await provider.findByBarcode(code,product))?.imageUrl,second);
});
test('HTTPS redirect downgraded to HTTP is skipped',async()=>{
  const provider=new UpcItemDbImageProvider(mock(body([first,second])),{
    validate:async value=>({imageUrl:value===first?'http://images.example.com/downgrade':second})
  });
  assert.equal((await provider.findByBarcode(code,product))?.imageUrl,second);
});
for(const [label,value] of [
  ['no images',body([])],['missing images',{code:'OK',items:[{}]}],
  ['no item',{code:'OK',items:[]}],['missing items',{code:'OK'}],
  ['code not OK',{code:'NOT_FOUND',items:[{images:[first]}]}],
  ['application error',{code:'EXCEED_LIMIT'}],
  ['invalid images',body([null,23,'ftp://images.example.com/a','http://images.example.com/a'])]
] as const) test(label+' returns null',async()=>{
  assert.equal(await new UpcItemDbImageProvider(mock(value),valid).findByBarcode(code,product),null);
});
test('404, 5xx and network failure return null without retries',async()=>{
  for(const status of [404,500,503]){
    let requests=0;
    const provider=new UpcItemDbImageProvider(async()=>{requests++;return new Response('{}',{status});},valid);
    assert.equal(await provider.findByBarcode(code,product),null);
    assert.equal(await provider.findByBarcode(code,product),null);
    assert.equal(requests,1);
  }
  let requests=0;
  const provider=new UpcItemDbImageProvider(async()=>{requests++;throw Error('network error');},valid);
  assert.equal(await provider.findByBarcode(code,product),null);
  assert.equal(await provider.findByBarcode(code,product),null);assert.equal(requests,1);
});
test('429 cools down all barcodes and does not retry',async()=>{
  let requests=0;
  const provider=new UpcItemDbImageProvider(async()=>{
    requests++;return new Response('{}',{status:429,headers:{'Retry-After':'3600'}});
  },valid);
  assert.equal(await provider.findByBarcode(code,product),null);
  assert.equal(await provider.findByBarcode('7290012823626',product),null);
  assert.equal(await provider.findByBarcode(code,product),null);
  assert.equal(requests,1);
});
test('successful and negative cache plus concurrent lookups share one API request',async()=>{
  for(const response of [body([first]),body([])]){
    let requests=0;
    const provider=new UpcItemDbImageProvider(async()=>{requests++;await Promise.resolve();return new Response(JSON.stringify(response));},valid);
    const [a,b]=await Promise.all([provider.findByBarcode(code,product),provider.findByBarcode(code,product)]);
    assert.deepEqual(a,b);await provider.findByBarcode(code,product);assert.equal(requests,1);
  }
});
test('factory enables UPCitemdb without key and falls back to configured authorized API',async()=>{
  const calls:string[]=[];
  const http:typeof fetch=async url=>{
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).includes('api.upcitemdb.com')?{code:'NOT_FOUND'}:{imageUrl:second}));
  };
  const free=createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'upcitemdb',PRODUCT_IMAGE_PROVIDER_ORDER:'upcitemdb,authorized-api'},http,valid);
  assert.equal(await free.findByBarcode(code,product),null);
  const chain=createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'upcitemdb',
    PRODUCT_IMAGE_API_KEY:'test',PRODUCT_IMAGE_API_URL:'https://authorized.example/{barcode}'},http,valid);
  assert.equal((await chain.findByBarcode(code,product))?.source,'authorized-api');
  assert.equal(calls.at(-1),'https://authorized.example/'+code);
});
test('automatic UPCitemdb takes priority over authorized and manual images; repeated previews cached',async()=>{
  let lookups=0,createdImage:string|undefined;
  const images=createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'upcitemdb',
    PRODUCT_IMAGE_API_KEY:'test',PRODUCT_IMAGE_API_URL:'https://authorized.example/{barcode}'},async url=>{
      assert.match(String(url),/api.upcitemdb.com/);lookups++;
      return new Response(JSON.stringify(body([first])));
    },valid);
  const importer=new Importer({lookupByBarcode:async()=>product},{
    currency:async()=>'ILS',findBarcode:async()=>undefined,
    create:async p=>{createdImage=p.imageUrl;return {id:'1',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'};}
  },images,valid);
  const p=await importer.preview(code,'15.90',second);
  assert.equal(p.product.imageSource,'upcitemdb');assert.equal(p.product.imageUrl,first);
  await importer.preview(code,'15.90',second);assert.equal(lookups,1);
  await importer.confirm(p.id);assert.equal(createdImage,first);
});
test('fallback skips provider exceptions and invalid content before manual fallback',async()=>{
  const images=new FallbackProductImageProvider([
    {findByBarcode:async()=>{throw Error('unavailable');}},
    {findByBarcode:async()=>({imageUrl:first,source:'authorized-api'})}
  ],{validate:async()=>{throw Error('not an image');}});
  const importer=new Importer({lookupByBarcode:async()=>product},{
    currency:async()=>'ILS',findBarcode:async()=>undefined,create:async()=>{throw Error('unused');}
  },images,valid);
  const preview=await importer.preview(code,'15.90',second);
  assert.equal(preview.product.imageSource,'manual');assert.equal(preview.product.imageUrl,second);
});
test('no API image and no manual URL still creates without image',async()=>{
  let created=false;
  const importer=new Importer({lookupByBarcode:async()=>product},{
    currency:async()=>'ILS',findBarcode:async()=>undefined,
    create:async p=>{created=true;assert.equal(p.imageUrl,undefined);return {id:'1',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'};}
  },new UpcItemDbImageProvider(mock({code:'NOT_FOUND'}),valid),valid);
  await importer.confirm((await importer.preview(code,'15.90')).id);
  assert.equal(created,true);
});
