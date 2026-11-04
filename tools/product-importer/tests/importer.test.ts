import {adminEnv,loginForTest} from './auth-helpers.js';
import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcode, price } from '../src/validation.js';
import { CheapersalProductCatalogProvider, MemoryCatalogCache } from '../src/catalog.js';
import { Importer } from '../src/importer.js';
import { ShopifyAdmin } from '../src/shopify.js';
import { createApp } from '../src/server.js';
const code = '7290108356472';
const product = {barcode:code,title:'מוצר בדיקה',source:'cheapersal'};
const imported = {id:'gid://shopify/Product/123', title:product.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/123'};
const http = (status:number,body:unknown):typeof fetch => async () => new Response(JSON.stringify(body),{status});
test('valid EAN-13 examples and whitespace',() => {
  for (const value of [code,'7290012823626','7290005427107']) assert.equal(barcode(' '+value+' '),value);
});
test('EAN-8 and UPC-A checksums',() => {
  assert.equal(barcode('96385074'),'96385074');
  assert.equal(barcode('036000291452'),'036000291452');
  for (const value of ['96385075','036000291453']) assert.throws(() => barcode(value));
});
test('invalid barcode rejected',() => {
  for (const value of ['7290108356473','abc','','123',null]) assert.throws(() => barcode(value));
});
test('price must be entered manually and precise',() => {
  assert.equal(price('15.9'),'15.90');
  assert.equal(price('0.01'),'0.01');
  for (const value of ['',0,'0','-1','1.234','Infinity','1e2','1,20',null]) assert.throws(() => price(value));
});
test('product found, metadata-only successful cache',async () => {
  let calls = 0;
  const provider = new CheapersalProductCatalogProvider('test',new MemoryCatalogCache(),async () => {
    calls++; return new Response(JSON.stringify({success:true,data:{barcode:code,name:'בדיקה',manufacturer:'יצרן',category:'cleaning',
      unitQty:'1 ליטר',imageUrl:'https://images.example.com/item.jpg',price:999}}));
  });
  const [a,b] = await Promise.all([provider.lookupByBarcode(code),provider.lookupByBarcode(code)]);
  assert.equal(a.imageUrl,undefined);
  assert.equal(a.unitQuantity,'1 ליטר');
  assert.ok(!('price' in a)); assert.deepEqual(a,b);
  await provider.lookupByBarcode(code); assert.equal(calls,1);
});
test('Cheapersal image fields are ignored',async () => {
  for (const image of [undefined,'javascript:alert(1)','http://example.com/a','https://127.0.0.1/a']) {
    const provider = new CheapersalProductCatalogProvider('test',undefined,http(200,{success:true,data:{name:'בדיקה',image}}));
    assert.equal((await provider.lookupByBarcode(code)).imageUrl,undefined);
  }
});
for (const [status,message] of [[401,'מפתח'],[404,'לא נמצא'],[429,'מכסת']] as const) {
  test('Cheapersal '+status,async () => {
    const provider = new CheapersalProductCatalogProvider('secret',undefined,http(status,{error:'secret'}));
    await assert.rejects(provider.lookupByBarcode(code),(e:Error) => e.message.includes(message) && !e.message.includes('secret'));
  });
}
test('success false, malformed response, mismatch, network failure',async () => {
  for (const response of [{success:false},{success:true,data:{}},{success:true,data:{name:'x',barcode:'96385074'}}]) {
    await assert.rejects(new CheapersalProductCatalogProvider('test',undefined,http(200,response)).lookupByBarcode(code));
  }
  await assert.rejects(new CheapersalProductCatalogProvider('test',undefined,async () => { throw Error('secret'); }).lookupByBarcode(code),
    (e:Error) => !e.message.includes('secret'));
});
test('invalid input does not call external provider',async () => {
  const service = new Importer({lookupByBarcode:async () => { throw Error('must not call'); }},{} as any);
  await assert.rejects(service.preview('bad','15.90'),/הברקוד/);
  await assert.rejects(service.preview(code,'-1'),/מחיר/);
});
test('duplicate Shopify barcode never creates or changes a product',async () => {
  const service = new Importer({lookupByBarcode:async () => product},{
    currency:async () => 'ILS',findBarcode:async () => imported,
    create:async () => { throw Error('must not create'); }});
  const p = await service.preview(code,'15.90');
  const result = await service.confirm(p.id);
  assert.equal(result.duplicate,true); assert.deepEqual(result.product,imported);
});
test('confirm uses server preview, manual price, and is idempotent',async () => {
  let creates = 0;
  const service = new Importer({lookupByBarcode:async () => product},{
    currency:async () => 'ILS',findBarcode:async () => undefined,
    create:async (p,amount) => { creates++; assert.equal(amount,'15.90'); assert.equal(p.title,product.title); return imported; }});
  const p = await service.preview(code,'15.90');
  assert.equal(creates,0);
  await service.confirm(p.id); await service.confirm(p.id); assert.equal(creates,1);
  await assert.rejects(service.confirm('forged'));
});
test('concurrent confirmations cannot both create',async () => {
  let release!:() => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const service = new Importer({lookupByBarcode:async () => product},{
    currency:async () => 'ILS',findBarcode:async () => { await gate; return undefined; },create:async () => imported});
  const a = await service.preview(code,'15.90'), b = await service.preview(code,'15.90');
  const pending = service.confirm(a.id);
  await assert.rejects(service.confirm(b.id),/ייבוא אחר/); release(); await pending;
});
test('uncertain mutation is never retried on same preview',async () => {
  let calls = 0;
  const service = new Importer({lookupByBarcode:async () => product},{
    currency:async () => 'ILS',findBarcode:async () => undefined,create:async () => { calls++; throw Error('timeout'); }});
  const p = await service.preview(code,'15.90');
  await assert.rejects(service.confirm(p.id)); await assert.rejects(service.confirm(p.id),/ייתכן/);
  assert.equal(calls,1);
});
test('GraphQL scans all barcode pages, including immediate unindexed products',async () => {
  let calls = 0;
  const shop = new ShopifyAdmin({domain:'example.myshopify.com',token:'secret'},async (_url,options) => {
    const body = JSON.parse(options!.body as string);
    assert.match(body.query,/barcodes/);
    calls++;
    if (calls === 1) return new Response(JSON.stringify({data:{productVariants:{nodes:[],pageInfo:{hasNextPage:true,endCursor:'next'}}}}));
    assert.equal(body.variables.after,'next');
    return new Response(JSON.stringify({data:{productVariants:{nodes:[{barcodes:{nodes:[{value:code}]},product:{id:imported.id,title:product.title}}],
      pageInfo:{hasNextPage:false}}}}));
  });
  assert.equal((await shop.findBarcode(code))?.id,imported.id); assert.equal(calls,2);
});
test('Shopify creates a draft with copied media, manual price and escaped description',async () => {
  let input:any;
  const shop = new ShopifyAdmin({domain:'example.myshopify.com',token:'secret'},async (_url,options) => {
    const body = JSON.parse(options!.body as string);
    if (body.query.includes('CatalogDefinitions')) return new Response(JSON.stringify({data:{
      metafieldDefinitions:{nodes:[],pageInfo:{hasNextPage:false}}}}));
    input = body.variables.input;
    return new Response(JSON.stringify({data:{productSet:{product:{id:imported.id,title:product.title},userErrors:[]}}}));
  });
  await shop.create({...product,description:'<script>alert(1)</script>',imageUrl:'https://images.example.com/item.jpg'},'15.90');
  assert.equal(input.status,'DRAFT');
  assert.equal(input.variants[0].price,'15.90');
  assert.deepEqual(input.variants[0].barcodes,[{value:code}]);
  assert.ok(!input.variants[0].inventoryQuantities);
  assert.match(input.descriptionHtml,/&lt;script&gt;/);
  assert.equal(input.files[0].originalSource,'https://images.example.com/item.jpg');
  assert.equal(input.metafields.find((m:any) => m.key === 'external_barcode').value,code);
  await shop.create(product,'15.90'); assert.equal(input.files,undefined);
});
test('existing incompatible metafield definition prevents creation',async () => {
  const shop = new ShopifyAdmin({domain:'example.myshopify.com',token:'secret'},http(200,{data:{metafieldDefinitions:{
    nodes:[{key:'catalog_source',type:{name:'number_integer'},validations:[]}],pageInfo:{hasNextPage:false}}}}));
  await assert.rejects(shop.create(product,'15.90'),/custom.catalog_source/);
});
test('Shopify GraphQL errors are sanitized',async () => {
  const shop = new ShopifyAdmin({domain:'example.myshopify.com',token:'secret'},http(200,{errors:[{message:'secret'}]}));
  await assert.rejects(shop.currency(),(e:Error) => !e.message.includes('secret'));
});
test('HTTP rejects foreign origins/hosts and requires CSRF before mutation',async () => {
  const service = new Importer({lookupByBarcode:async () => product},{currency:async () => 'ILS',findBarcode:async () => imported,create:async () => imported});
  const server = createApp(service,4311,adminEnv).listen(4311,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  const base = 'http://127.0.0.1:4311';
  try {
    assert.equal((await fetch(base+'/api/session',{headers:{Origin:'https://attacker.example'}})).status,403);
    const foreignHost = await new Promise<number>(resolve => {
      request(base+'/api/session',{headers:{Host:'attacker.example'}},response => {
        response.resume(); resolve(response.statusCode!);
      }).end();
    });
    assert.equal(foreignHost,403);
    const Cookie=await loginForTest(base);
    assert.equal((await fetch(base+'/api/import',{method:'POST',headers:{Cookie,Origin:base,'Content-Type':'application/json'},body:'{}'})).status,403);
    const {csrf} = await (await fetch(base+'/api/session',{headers:{Cookie}})).json();
    const headers = {Cookie,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf};
    const response = await fetch(base+'/api/preview',{method:'POST',headers,body:JSON.stringify({barcode:code,price:'15.90'})});
    assert.equal(response.status,200);
    const preview = await response.json();
    assert.equal((await (await fetch(base+'/api/import',{method:'POST',headers,body:JSON.stringify({previewId:preview.id})})).json()).duplicate,true);
    assert.equal((await fetch(base+'/.env',{headers:{Cookie}})).status,404);
    assert.match((await fetch(base,{headers:{Cookie}})).headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  } finally { await new Promise<void>((resolve,reject) => server.close(e => e ? reject(e) : resolve())); }
});
