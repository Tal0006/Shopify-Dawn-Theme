import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthorizedApiProductImageProvider, createProductImageProvider, PublicImageUrlValidator, isPublicAddress } from '../src/images.js';
import { CheapersalProductCatalogProvider } from '../src/catalog.js';
import { Importer } from '../src/importer.js';
import type { ProductCatalogProduct } from '../src/catalog.js';
const code = '7290108356472';
const metadata = {barcode:code,title:"מקסימה ג'ל כביסה מרוכז בייבי",manufacturer:'סנו',category:'laundry',unitQuantity:'1.5',source:'cheapersal'};
const url = 'https://images.example.com/item.jpg';
const result = {id:'gid://shopify/Product/1',title:metadata.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/1'};
const valid = {validate:async (value:unknown) => ({imageUrl:String(value)})};
const addresses = async () => [{address:'8.8.8.8',family:4}];
const provider = (status:number,body:unknown) => new AuthorizedApiProductImageProvider(
  'https://authorized.example/images/{barcode}','test-only-key',async () =>
    status === 204 ? new Response(null,{status}) : new Response(JSON.stringify(body),{status}));
const shop = (onCreate:(p:ProductCatalogProduct)=>void = () => {}) => ({
  currency:async () => 'ILS',findBarcode:async () => undefined,
  create:async (p:ProductCatalogProduct,price:string) => { assert.equal(price,'15.90'); onCreate(p); return result; }
});
test('real Cheapersal fixture normalizes metadata without image or invented description',async () => {
  const catalog = new CheapersalProductCatalogProvider('test',undefined,async () => new Response(JSON.stringify({
    success:true,data:{barcode:code,name:metadata.title,manufacturer:'סנו',category:'laundry',description:'',unitQty:'1.5'}})));
  const p = await catalog.lookupByBarcode(code);
  assert.deepEqual(p, {...metadata,description:undefined});
  assert.equal(p.imageUrl,undefined);
});
test('authorized image provider success uses barcode and server-side API key',async () => {
  const images = new AuthorizedApiProductImageProvider('https://authorized.example/images/{barcode}','test-key',async (endpoint,options) => {
    assert.equal(endpoint,'https://authorized.example/images/'+code);
    assert.equal((options?.headers as Record<string,string>)['X-API-Key'],'test-key');
    assert.equal(options?.redirect,'error');
    return new Response(JSON.stringify({imageUrl:url}));
  });
  assert.deepEqual(await images.findByBarcode(code,metadata),{imageUrl:url,source:'authorized-api',confidence:0.90});
});
test('image not found supports 404, 204 and null',async () => {
  for (const [status,body] of [[404,{}],[204,null],[200,{imageUrl:null}]] as const)
    assert.equal(await provider(status,body).findByBarcode(code,metadata),null);
});
test('provider errors never leak raw upstream details or key',async () => {
  for (const status of [401,429,503]) assert.equal(await provider(status,{error:'test-only-key'}).findByBarcode(code,metadata),null);
  await assert.rejects(provider(200,{imageUrl:'javascript:alert(1)'}).findByBarcode(code,metadata),(e:Error)=>!e.message.includes('test-only-key'));
});

test('disabled provider and configuration validation',async () => {
  assert.equal(await createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'none'}).findByBarcode(code,metadata),null);
  assert.throws(() => createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'unknown'}));
  assert.throws(() => createProductImageProvider({PRODUCT_IMAGE_PROVIDER:'authorized-api'}));
});
test('automatic image is combined with metadata and imported',async () => {
  let created:ProductCatalogProduct|undefined;
  const importer = new Importer({lookupByBarcode:async () => metadata},shop(p => created=p),provider(200,{imageUrl:url}),valid);
  const p = await importer.preview(code,'15.90');
  assert.equal(p.product.imageUrl,url); assert.equal(p.product.source,'cheapersal');
  assert.equal(p.product.imageSource,'authorized-api');
  await importer.confirm(p.id); assert.equal(created?.imageUrl,url);
});
test('provider unavailable and not-found both allow creation without image',async () => {
  for (const images of [provider(503,{}),provider(404,{})]) {
    let created = false;
    const importer = new Importer({lookupByBarcode:async () => metadata},shop(p => {
      assert.equal(p.imageUrl,undefined); created=true;
    }),images,valid);
    const p = await importer.preview(code,'15.90');
    assert.ok(p.imageWarning); await importer.confirm(p.id); assert.equal(created,true);
  }
});
test('manual image fallback is used after provider failure and validated before creation',async () => {
  let validations=0;
  const importer = new Importer({lookupByBarcode:async () => metadata},shop(p => {
    assert.equal(p.imageUrl,url); assert.equal(p.imageSource,'manual');
  }),{findByBarcode:async () => { throw Error('provider unavailable'); }},
  {validate:async value => { validations++; assert.equal(value,url); return {imageUrl:url}; }});
  const p=await importer.preview(code,'15.90',' '+url+' ');
  assert.equal(p.product.imageSource,'manual');
  await importer.confirm(p.id); assert.equal(validations,2);
});
test('invalid manual image is rejected; invalid automatic image becomes a warning',async () => {
  const validator = new PublicImageUrlValidator(addresses,async () => ({status:200,contentType:'text/html'}));
  const importer = new Importer({lookupByBarcode:async () => metadata},shop(),provider(200,{imageUrl:url}),validator);
  await assert.rejects(importer.preview(code,'15.90','javascript:alert(1)'));
  await assert.rejects(importer.preview(code,'15.90',url));
  const p = await importer.preview(code,'15.90');
  assert.equal(p.product.imageUrl,undefined); assert.ok(p.imageWarning);
});
test('public HTTP/HTTPS images accepted without relying on extensions',async () => {
  const validator = new PublicImageUrlValidator(addresses,async () => ({status:200,contentType:'image/jpeg; charset=binary'}));
  for (const protocol of ['http','https']) assert.equal((await validator.validate(protocol+'://images.example.com/content?id=1')).imageUrl,protocol+'://images.example.com/content?id=1');
});
test('invalid URLs and private DNS targets rejected before probe',async () => {
  let probes=0;
  const validator = new PublicImageUrlValidator(async () => [{address:'127.0.0.1',family:4}],async () => { probes++; return {status:200}; });
  for (const value of ['ftp://images.example.com/x','javascript:alert(1)','https://user:pass@images.example.com/a',
    'https://localhost/a','http://127.0.0.1/a','https://images.example.com:9000/a',url])
    await assert.rejects(validator.validate(value));
  assert.equal(probes,0);
  for (const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','192.168.1.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'])
    assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
});
test('redirects checked again; redirects to private addresses blocked',async () => {
  let probes=0;
  const validator = new PublicImageUrlValidator(async host => [{address:host==='private.example.com'?'10.0.0.1':'8.8.8.8',family:4}],
    async () => { probes++; return {status:302,location:'http://private.example.com/a'}; });
  await assert.rejects(validator.validate(url)); assert.equal(probes,1);
});
test('missing images, non-image and SVG content rejected',async () => {
  for (const response of [{status:404},{status:200,contentType:'text/html'},{status:200,contentType:'image/svg+xml'}])
    await assert.rejects(new PublicImageUrlValidator(addresses,async () => response).validate(url));
});
test('unverifiable HEAD or network failure returns a visible warning',async () => {
  for (const probe of [async () => ({status:405}),async () => ({status:200}),async () => { throw Error('timeout'); }]) {
    const checked = await new PublicImageUrlValidator(addresses,probe).validate(url);
    assert.equal(checked.imageUrl,url); assert.ok(checked.warning);
  }
  const importer = new Importer({lookupByBarcode:async () => metadata},shop(),provider(200,{imageUrl:url}),
    new PublicImageUrlValidator(addresses,async () => ({status:405})));
  assert.ok((await importer.preview(code,'15.90')).imageWarning);
});
test('changed image is revalidated before Shopify mutation',async () => {
  let checks=0, creates=0;
  const importer=new Importer({lookupByBarcode:async () => metadata},shop(() => creates++),provider(200,{imageUrl:url}),
    {validate:async () => { if (++checks>1) throw Error('image became invalid'); return {imageUrl:url}; }});
  const p=await importer.preview(code,'15.90');
  await assert.rejects(importer.confirm(p.id)); assert.equal(creates,0);
});
