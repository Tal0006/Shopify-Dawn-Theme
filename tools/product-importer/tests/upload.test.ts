import {adminEnv,loginForTest} from './auth-helpers.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {crc32,deflateSync} from 'node:zlib';
import sharp from 'sharp';
import {ProductImageProcessor,EdgeBackgroundRemover,normalizeToCanvas,sniffImageFormat,sha256,
  BACKGROUND_REMOVAL_FAILED,type BackgroundRemovalService,type RawImage} from '../src/upload-image.js';
import {AuthorizedApiProductImageProvider,CompositeProductImageProvider,SerpApiProductImageProvider,
  type ProductImageProvider} from '../src/images.js';
import {Importer} from '../src/importer.js';
import {ShopifyAdmin,type ImageUploadFile} from '../src/shopify.js';
import {createApp} from '../src/server.js';
import type {ProductCatalogProduct} from '../src/catalog.js';

const code='7290000289380';
const metadata={barcode:code,title:'מסיר שומנים פאנקי 750 מ"ל',manufacturer:'פאנקי',category:'cleaning',source:'cheapersal'};
const catalog={lookupByBarcode:async()=>({...metadata})};
const valid={validate:async(value:unknown)=>({imageUrl:String(value)})};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status});
const RECT={left:50,top:100,width:200,height:400};

/** White backdrop with a red 1:2 "product" placed off-centre. */
async function photo(format:'jpeg'|'png'|'webp',w=600,h=600,rect=RECT){
  const image=sharp({create:{width:w,height:h,channels:3,background:'#ffffff'}})
    .composite([{input:{create:{width:rect.width,height:rect.height,channels:3,background:'#d7262e'}},left:rect.left,top:rect.top}]);
  return format==='jpeg'?image.jpeg({quality:95}).toBuffer():format==='png'?image.png().toBuffer():image.webp({quality:95}).toBuffer();
}
/** Mock segmentation: background = near-white pixels. Lets most tests avoid the real remover. */
const mockRemover:BackgroundRemovalService={async removeBackground(image:RawImage){
  const out=Buffer.from(image.data);
  for(let i=0;i<out.length;i+=4)if(out[i]>235&&out[i+1]>235&&out[i+2]>235)out[i+3]=0;
  return {image:{...image,data:out},method:'mock',confidence:'high'};
}};
const failingRemover:BackgroundRemovalService={async removeBackground(){throw Error('model unavailable');}};
async function alphaBox(png:Buffer){
  const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let left=info.width,top=info.height,right=-1,bottom=-1;
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++)if(data[(y*info.width+x)*4+3]>=128){
    if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;
  }
  return {left,top,width:right-left+1,height:bottom-top+1,canvas:info,data};
}
/** Valid PNG header claiming the given size, with no real pixel data: decode must never be attempted. */
function pngHeader(width:number,height:number){
  const chunk=(type:string,data:Buffer)=>{const head=Buffer.alloc(8);head.writeUInt32BE(data.length);head.write(type,4,'latin1');
    const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])));return Buffer.concat([head,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(16))),chunk('IEND',Buffer.alloc(0))]);
}
function gateway(){
  const created:ProductCatalogProduct[]=[],uploaded:ImageUploadFile[]=[];
  return {created,uploaded,shop:{currency:async()=>'ILS',findBarcode:async()=>undefined,
    uploadImage:async(file:ImageUploadFile)=>{uploaded.push(file);return 'https://shopify-staged-uploads.storage.googleapis.com/tmp/'+uploaded.length;},
    create:async(p:ProductCatalogProduct)=>{created.push(structuredClone(p));
      return {id:'gid://shopify/Product/7',title:p.title,barcode:code,adminUrl:'https://example.myshopify.com/admin/products/7'};}}};
}
function spyProvider(inner:ProductImageProvider=new CompositeProductImageProvider([])){
  let calls=0;
  return {get calls(){return calls;},provider:{policy:inner.policy,
    findByBarcode:async(c:string,p:ProductCatalogProduct)=>{calls++;return inner.findByBarcode(c,p);},
    discoverByBarcode:async(c:string,p:ProductCatalogProduct)=>{calls++;return inner.discoverByBarcode!(c,p);}} as ProductImageProvider};
}
const processor=(remover:BackgroundRemovalService=mockRemover)=>new ProductImageProcessor(remover);

test('1-3. JPEG, PNG and WebP uploads are accepted by content and re-encoded',async()=>{
  for(const format of ['jpeg','png','webp'] as const){
    const result=await processor().process(await photo(format));
    assert.equal(result.original.format,format);assert.equal(sniffImageFormat(result.original.data),format);
    assert.equal(result.processed?.format,'png');assert.equal(result.backgroundRemoved,true);
  }
});
test('4-5. SVG, GIF, PDF, HTML disguised as JPEG and corrupt JPEG data are rejected',async()=>{
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  for(const [bytes,status] of [[svg,415],[Buffer.from('GIF89a\x01\x00\x01\x00'),415],[Buffer.from('%PDF-1.7\n'),415],
    [Buffer.from('<!doctype html><html>not an image</html>'),415],[Buffer.from('MZ\x90\x00executable'),415],
    [Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),Buffer.alloc(2000,7)]),400]] as const)
    await assert.rejects(processor().process(bytes),(e:any)=>e.status===status,String(bytes.subarray(0,8)));
  // A PNG renamed .jpg/labelled image/jpeg is judged by content: it is a PNG.
  assert.equal((await processor().process(await photo('png'))).original.format,'png');
});
test('6-7. oversized files and excessive pixel dimensions are rejected before decoding',async()=>{
  const big=Buffer.concat([Buffer.from([0xff,0xd8,0xff]),Buffer.alloc(10*1024*1024)]);
  await assert.rejects(processor().process(big),(e:any)=>e.status===413);
  for(const [w,h] of [[8001,10],[10,8001],[7100,7100],[60000,60000]])
    await assert.rejects(processor().process(pngHeader(w,h)),(e:any)=>e.status===413,w+'x'+h);
});
test('8-9. EXIF orientation is applied, then GPS/device/timestamp metadata is removed',async()=>{
  // 300x100: left half red, right half blue; orientation 6 means "rotate 90° clockwise to display".
  const source=await sharp({create:{width:300,height:100,channels:3,background:'#0000ff'}})
    .composite([{input:{create:{width:150,height:100,channels:3,background:'#ff0000'}},left:0,top:0}])
    .jpeg({quality:95}).withMetadata({orientation:6})
    .withExif({IFD0:{Make:'FanakeeTestPhone',Model:'SN-12345',DateTime:'2026:11:16 10:00:00'},
      IFD3:{GPSLatitudeRef:'N',GPSLatitude:'31/1 46/1 0/1'}}).toBuffer();
  assert.ok(source.includes('FanakeeTestPhone'));assert.equal((await sharp(source).metadata()).orientation,6);
  const result=await processor(failingRemover).process(source);
  assert.deepEqual([result.original.width,result.original.height],[100,300]);
  const {data}=await sharp(result.original.data).raw().toBuffer({resolveWithObject:true});
  assert.ok(data[0]>200&&data[2]<60,'Top of the upright image is the red (left) half');
  for(const v of [result.original.data,...(result.processed?[result.processed.data]:[])]){
    const meta=await sharp(v).metadata();
    assert.equal(meta.exif,undefined);assert.equal(meta.orientation,undefined);
    for(const marker of ['FanakeeTestPhone','SN-12345','2026:11:16','GPS'])assert.ok(!v.includes(marker),marker);
  }
});
test('10-14. processed output is a 1200x1200 RGBA PNG: proportional, unstretched, centred, padded',async()=>{
  const result=await processor().process(await photo('png'));
  const meta=await sharp(result.processed!.data).metadata();
  assert.deepEqual([meta.width,meta.height,meta.format,meta.channels,meta.hasAlpha],[1200,1200,'png',4,true]);
  const box=await alphaBox(result.processed!.data);
  assert.ok(Math.abs(box.width/box.height-0.5)<0.01,'aspect ratio 1:2 preserved: '+box.width+'x'+box.height);
  assert.equal(box.height,1056,'tall product occupies 88% of the canvas height');
  assert.ok(Math.abs(box.left+box.width/2-600)<=1&&Math.abs(box.top+box.height/2-600)<=1,'centred');
  assert.ok(box.top>=72&&box.left>=72&&1200-(box.left+box.width)>=72&&1200-(box.top+box.height)>=72,'padding on every side');
  assert.equal(box.data[3],0,'corners are transparent, not a baked checkerboard or white');
  const square=await normalizeToCanvas({width:100,height:100,data:Buffer.alloc(100*100*4,255)});
  assert.deepEqual([square.product.width,square.product.height],[960,960],'square products use 80%');
  const wide=await normalizeToCanvas({width:300,height:100,data:Buffer.alloc(300*100*4,255)});
  assert.equal(wide.product.width/wide.product.height,3,'never stretched');
});
test('15. the real deterministic remover cuts a white bottle from a light backdrop without leaking or recolouring',async()=>{
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
    <rect width="600" height="800" fill="#f1f1ee"/>
    <rect x="250" y="120" width="100" height="90" fill="#d7262e"/>
    <path d="M230 210 h140 c40 40 80 80 80 160 v330 c0 20-20 40-40 40 h-220 c-20 0-40-20-40-40 v-330 c0-80 40-120 80-160z"
      fill="#ffffff" stroke="#c4c4c4" stroke-width="3"/>
    <rect x="200" y="420" width="200" height="200" fill="#ffd21f"/></svg>`;
  const source=await sharp(Buffer.from(svg)).jpeg({quality:92}).toBuffer();
  // Ground-truth product box measured from the source pixels (anything visibly unlike the backdrop).
  const raw=await sharp(source).raw().toBuffer({resolveWithObject:true});
  let sl=600,st=800,sr=-1,sb=-1;
  for(let y=0;y<800;y++)for(let x=0;x<600;x++){
    const i=(y*600+x)*3,d=Math.abs(raw.data[i]-241)+Math.abs(raw.data[i+1]-241)+Math.abs(raw.data[i+2]-238);
    if(d>24){if(x<sl)sl=x;if(x>sr)sr=x;if(y<st)st=y;if(y>sb)sb=y;}
  }
  const result=await new ProductImageProcessor(new EdgeBackgroundRemover()).process(source);
  assert.equal(result.backgroundRemoved,true);assert.equal(result.method,'edge-flood-fill');
  const out=await alphaBox(result.processed!.data);
  const at=(x:number,y:number)=>[...out.data.subarray((y*1200+x)*4,(y*1200+x)*4+4)];
  assert.equal(at(5,5)[3],0);assert.equal(at(1190,1190)[3],0);
  const scale=out.height/(sb-st+1),map=(x:number,y:number)=>[Math.round(out.left+(x-sl)*scale),Math.round(out.top+(y-st)*scale)] as const;
  const whiteBody=at(...map(300,300)),label=at(...map(300,520)),cap=at(...map(300,160));
  assert.equal(whiteBody[3],255,'white bottle body is kept opaque (no flood leak)');
  assert.ok(whiteBody.slice(0,3).every(v=>v>=245),'white stays white');
  assert.ok(label[3]===255&&label[0]>240&&label[1]>195&&label[2]<70,'yellow label colour unchanged');
  assert.ok(cap[3]===255&&cap[0]>195&&cap[1]<60,'red cap kept');
  assert.ok(Math.abs(out.width/out.height-(sr-sl+1)/(sb-st+1))<0.015,
    'proportions preserved: '+out.width+'x'+out.height+' vs '+(sr-sl+1)+'x'+(sb-st+1));
  assert.ok(st<=121&&sb>=740,'cap top and bottle base are inside the measured box (nothing clipped)');
});
test('16. background-removal failure falls back safely: original kept, nothing invented',async()=>{
  const result=await processor(failingRemover).process(await photo('jpeg'));
  assert.equal(result.processed,undefined);assert.equal(result.backgroundRemoved,false);
  assert.deepEqual(result.warnings,[BACKGROUND_REMOVAL_FAILED]);
  const busy=await new EdgeBackgroundRemover().removeBackground({width:64,height:64,
    data:Buffer.from(Array.from({length:64*64*4},(_,i)=>i%4===3?255:(i*37)%256))}).catch(e=>e);
  assert.ok(busy instanceof Error,'non-uniform background is reported, not guessed');
  const {shop,uploaded,created}=gateway();
  const service=new Importer(catalog,shop,undefined,valid,{uploads:processor(failingRemover)});
  const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  const u=await service.attachUpload(p.id,await photo('jpeg'),true);
  assert.equal(u.upload?.processed,null);assert.equal(u.upload?.choice,null);assert.match(u.imageWarning!,/לא הצלחנו להסיר את הרקע/);
  await assert.rejects(service.chooseUpload(p.id,'processed',u.upload!.id));
  const chosen=await service.chooseUpload(p.id,'original',u.upload!.id);
  assert.equal(chosen.selectedImage?.usagePolicy,'MANUAL_APPROVED');
  await service.confirm(p.id);assert.equal(uploaded[0].mimeType,'image/jpeg');assert.ok(created[0].imageUrl!.startsWith('https://shopify-staged-uploads'));
});
test('17-18. upload needs the permission checkbox; with it the image is MANUAL_APPROVED and auto-attachable',async()=>{
  const {shop,uploaded,created}=gateway();
  const service=new Importer(catalog,shop,undefined,valid,{uploads:processor()});
  const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  for(const flag of [undefined,false,'true',1])
    await assert.rejects(service.attachUpload(p.id,await photo('png'),flag),/הרשאה/);
  assert.equal(service.stats().uploads,0);
  const u=await service.attachUpload(p.id,await photo('png'),true);
  assert.equal(u.selectedImage?.source,'manual-upload');assert.equal(u.selectedImage?.usagePolicy,'MANUAL_APPROVED');
  assert.equal(u.selectedImage?.autoAttachAllowed,true);assert.equal(u.upload?.choice,'processed');
  assert.equal(u.product.imageUrl,undefined,'the local preview URL is never a Shopify image source');
  assert.ok(!JSON.stringify(u).includes('base64'));
  await service.confirm(p.id);
  assert.equal(uploaded.length,1);assert.equal(uploaded[0].mimeType,'image/png');
  assert.equal(uploaded[0].filename,'fanakee-'+code+'-processed.png');
  assert.equal(created[0].imageUrl,'https://shopify-staged-uploads.storage.googleapis.com/tmp/1');
});
test('19-20. approval cannot be forged or carried over: tampered bytes and replaced uploads are blocked',async()=>{
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,undefined,valid,{uploads:processor()});
  const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  const first=await service.attachUpload(p.id,await photo('png'),true);
  // Bytes replaced after confirmation (e.g. by a bug or memory corruption) no longer match the approval.
  const internal=(service as any).previews.get(p.id);
  internal.upload.processed.data=await photo('png',600,600,{left:10,top:10,width:100,height:100});
  await assert.rejects(service.confirm(p.id),/אינה מאושרת/);assert.equal(created.length,0);
  // A new upload discards the old upload and approval, even when the new one is not confirmed.
  const q=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  const a=await service.attachUpload(q.id,await photo('png'),true);
  await assert.rejects(service.attachUpload(q.id,await photo('jpeg'),false),/הרשאה/);
  await assert.rejects(service.chooseUpload(q.id,'processed',a.upload!.id),/השתנתה/);
  await service.confirm(q.id);assert.equal(created[0].imageUrl,undefined);
  // Variant choice must name the current upload id.
  const r=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  await service.attachUpload(r.id,await photo('png'),true);
  await assert.rejects(service.chooseUpload(r.id,'original',first.upload!.id),/השתנתה/);
});
test('21-22. an announced upload skips the provider chain; removing it resumes the chain',async()=>{
  const spy=spyProvider(new CompositeProductImageProvider([new AuthorizedApiProductImageProvider('https://authorized.example/{barcode}',
    'auth-key',async()=>json({imageUrl:'https://authorized.example/a.jpg'}))],valid));
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,spy.provider,valid,{uploads:processor()});
  const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  assert.equal(p.uploadPending,true);
  await service.attachUpload(p.id,await photo('png'),true);
  await service.chooseUpload(p.id,'original',(await service.attachUpload(p.id,await photo('png'),true)).upload!.id);
  assert.equal(spy.calls,0,'approved upload takes priority over paid providers');
  const removed=await service.chooseUpload(p.id,'remove');
  assert.equal(spy.calls,1);assert.equal(removed.upload,null);
  assert.equal(removed.product.imageSource,'authorized-api');assert.equal(service.stats().uploads,0);
  await service.confirm(p.id);assert.equal(created[0].imageUrl,'https://authorized.example/a.jpg');
});
test('23-25. Shopify staged upload carries processed/original bytes; no image skips staging',async()=>{
  const calls:{kind:string;body?:any;headers?:any}[]=[];let productInput:any;
  const admin=new ShopifyAdmin({domain:'example.myshopify.com',token:'shpat_private_test_token'},async(url,options)=>{
    if(String(url).startsWith('https://shopify-staged-uploads.storage.googleapis.com/')){
      const form=options!.body as FormData,file=form.get('file') as File;
      calls.push({kind:'staged-post',headers:options!.headers,body:{key:form.get('key'),policy:form.get('policy'),
        file:Buffer.from(await file.arrayBuffer()),type:file.type,name:file.name}});
      return new Response(null,{status:201});
    }
    const body=JSON.parse(String(options!.body));
    if(body.query.includes('StoreCurrency'))return json({data:{shop:{currencyCode:'ILS'}}});
    if(body.query.includes('ExistingBarcode'))return json({data:{productVariants:{nodes:[],pageInfo:{hasNextPage:false}}}});
    if(body.query.includes('CatalogDefinitions'))return json({data:{metafieldDefinitions:{nodes:[],pageInfo:{hasNextPage:false}}}});
    if(body.query.includes('stagedUploadsCreate')){
      calls.push({kind:'stage',body:body.variables.input[0]});
      return json({data:{stagedUploadsCreate:{userErrors:[],stagedTargets:[{url:'https://shopify-staged-uploads.storage.googleapis.com/',
        resourceUrl:'https://shopify-staged-uploads.storage.googleapis.com/tmp/fanakee-'+calls.length,
        parameters:[{name:'key',value:'tmp/fanakee'},{name:'policy',value:'signed-policy'}]}]}}});
    }
    productInput=body.variables.input;
    return json({data:{productSet:{product:{id:'gid://shopify/Product/9',title:metadata.title},userErrors:[]}}});
  });
  for(const choice of ['processed','original','none'] as const){
    calls.length=0;productInput=undefined;
    const service=new Importer(catalog,admin,undefined,valid,{uploads:processor()});
    const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
    const u=await service.attachUpload(p.id,await photo('jpeg'),true);
    const expected=choice==='none'?undefined:(service as any).previews.get(p.id).upload[choice].data as Buffer;
    await service.chooseUpload(p.id,choice,u.upload!.id);
    await service.confirm(p.id);
    assert.equal(productInput.status,'DRAFT');assert.equal(productInput.variants[0].price,'20.00');
    assert.deepEqual(productInput.variants[0].barcodes,[{value:code}]);assert.equal(productInput.title,metadata.title);
    if(choice==='none'){assert.equal(calls.length,0);assert.equal(productInput.files,undefined);continue;}
    const [stage,post]=calls;
    assert.equal(stage.body.resource,'IMAGE');assert.equal(stage.body.httpMethod,'POST');
    assert.equal(stage.body.mimeType,choice==='processed'?'image/png':'image/jpeg');
    assert.equal(stage.body.fileSize,String(expected!.length));
    assert.equal(sha256(post.body.file),sha256(expected!),'exact verified bytes reach Shopify');
    assert.equal(post.body.key,'tmp/fanakee');assert.equal(post.body.policy,'signed-policy');
    assert.ok(!JSON.stringify(post.headers??{}).includes('shpat_private_test_token'),'no Admin token sent to the staging target');
    assert.deepEqual(productInput.files,[{originalSource:'https://shopify-staged-uploads.storage.googleapis.com/tmp/fanakee-1',contentType:'IMAGE',alt:metadata.title}]);
  }
});
test('26-27 and flows A-D: approved provider, discovery confirmation, and no-image imports still work',async()=>{
  const authorized=new AuthorizedApiProductImageProvider('https://authorized.example/{barcode}','k',async()=>json({imageUrl:'https://authorized.example/b.jpg'}));
  const serp=new SerpApiProductImageProvider('serp-key',async()=>json({images_results:[{original:'https://images.example.com/s.jpg',
    title:metadata.title,link:'https://shop.example.co.il/p',original_width:800,original_height:800}]}),valid);
  const {shop,created}=gateway();
  const b=new Importer(catalog,shop,new CompositeProductImageProvider([authorized],valid),valid,{uploads:processor()});
  const pb=await b.preview(code,'20.00');assert.equal(pb.selectedImage?.usagePolicy,'APPROVED');await b.confirm(pb.id);
  const c=new Importer(catalog,shop,new CompositeProductImageProvider([serp],valid),valid,{uploads:processor()});
  const pc=await c.preview(code,'20.00');assert.equal(pc.candidates[0].usagePolicy,'DISCOVERY_ONLY');
  await assert.rejects(c.selectImage(pc.id,0));await c.selectImage(pc.id,0,true);await c.confirm(pc.id);
  const d=new Importer(catalog,shop,new CompositeProductImageProvider([],valid),valid,{uploads:processor()});
  const pd=await d.preview(code,'20.00');await d.confirm(pd.id);
  assert.deepEqual(created.map(p=>p.imageUrl),['https://authorized.example/b.jpg','https://images.example.com/s.jpg',undefined]);
});
test('28-29. uploads expire with the preview and are released after import, removal and errors',async()=>{
  let clock=Date.parse('2026-11-16T10:00:00Z');
  const {shop}=gateway();
  const service=new Importer(catalog,shop,undefined,valid,{uploads:processor(),now:()=>clock});
  const p=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  const u=await service.attachUpload(p.id,await photo('png'),true);
  assert.equal(service.stats().uploads,1);assert.ok(service.stats().uploadBytes>0);
  assert.equal(service.uploadImage(p.id,u.upload!.id,'processed').mimeType,'image/png');
  clock+=31*60*1000;
  assert.throws(()=>service.uploadImage(p.id,u.upload!.id,'processed'),(e:any)=>e.status===404);
  service.sweep();assert.deepEqual(service.stats(),{previews:0,uploads:0,uploadBytes:0});
  await assert.rejects(service.confirm(p.id),/פגה/);
  // Released after a successful import, after removal, and nothing is stored when processing fails.
  const q=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  await service.attachUpload(q.id,await photo('png'),true);await service.confirm(q.id);
  assert.equal(service.stats().uploads,0);
  const r=await service.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  await service.attachUpload(r.id,await photo('png'),true);await service.chooseUpload(r.id,'remove');
  assert.equal(service.stats().uploads,0);
  await assert.rejects(service.attachUpload(r.id,Buffer.from('<svg/>'),true));
  assert.equal(service.stats().uploads,0);
  // Upload count is capped across previews.
  const capped=new Importer(catalog,shop,undefined,valid,{uploads:processor(),maxUploads:1});
  const one=await capped.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  const two=await capped.preview(code,'20.00',undefined,undefined,{uploadPending:true});
  await capped.attachUpload(one.id,await photo('png'),true);
  await assert.rejects(capped.attachUpload(two.id,await photo('png'),true),(e:any)=>e.status===429);
});
test('processing is serialized with a bounded queue so uploads cannot flood the instance',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const slow=new ProductImageProcessor({async removeBackground(image){await gate;return mockRemover.removeBackground(image);}},{maxConcurrent:1,maxQueue:1});
  const input=await photo('png');
  const first=slow.process(input),second=slow.process(input);
  await assert.rejects(slow.process(input),(e:any)=>e.status===429);
  release();await Promise.all([first,second]);
  assert.ok((await slow.process(input)).processed);
});
test('HTTP upload route: auth, CSRF, octet-stream only, explicit confirmation header, 10MB limit, private previews',async()=>{
  const lines:string[]=[];
  const {shop,created}=gateway();
  const service=new Importer(catalog,shop,undefined,valid,{uploads:processor(),log:l=>lines.push(l)});
  const server=createApp(service,4316,adminEnv).listen(4316,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:4316';
  try{
    const image=await photo('jpeg');
    assert.equal((await fetch(origin+'/api/image-upload',{method:'POST',body:image,headers:{'Content-Type':'application/octet-stream'}})).status,401);
    const Cookie=await loginForTest(origin);
    const {csrf}=await(await fetch(origin+'/api/session',{headers:{Cookie}})).json();
    const base={Cookie,Origin:origin,'X-CSRF-Token':csrf};
    const p=await(await fetch(origin+'/api/preview',{method:'POST',headers:{...base,'Content-Type':'application/json'},
      body:JSON.stringify({barcode:code,price:'20.00',uploadPending:true})})).json();
    const upload=(headers:Record<string,string>,body:Buffer=image)=>fetch(origin+'/api/image-upload',{method:'POST',body,
      headers:{...base,'Content-Type':'application/octet-stream','X-Preview-Id':p.id,...headers}});
    assert.equal((await upload({'Content-Type':'image/jpeg','X-Usage-Confirmed':'true'})).status,403);
    assert.equal((await upload({'X-CSRF-Token':'forged','X-Usage-Confirmed':'true'})).status,403);
    for(const confirmed of [undefined,'TRUE','1','yes'])
      assert.equal((await upload(confirmed?{'X-Usage-Confirmed':confirmed}:{})).status,400,String(confirmed));
    const tooBig=await upload({'X-Usage-Confirmed':'true'},Buffer.concat([image,Buffer.alloc(10*1024*1024)]));
    assert.equal(tooBig.status,413);assert.match((await tooBig.json()).error,/10MB/);
    const accepted=await upload({'X-Usage-Confirmed':'true'});
    assert.equal(accepted.status,200);
    const body=await accepted.json();assert.equal(body.upload.processed.width,1200);
    const preview=await fetch(origin+body.upload.processed.url,{headers:{Cookie}});
    assert.equal(preview.status,200);assert.equal(preview.headers.get('content-type'),'image/png');
    assert.equal(preview.headers.get('x-content-type-options'),'nosniff');assert.equal(preview.headers.get('cache-control'),'no-store');
    assert.equal((await fetch(origin+body.upload.processed.url)).status,401);
    assert.equal((await fetch(origin+'/api/image-upload/'+p.id+'/'+crypto.randomUUID()+'/processed',{headers:{Cookie}})).status,404);
    assert.equal((await fetch(origin+'/api/image-upload/'+p.id+'/'+body.upload.id+'/..%2F..%2Fpackage.json',{headers:{Cookie}})).status,404);
    assert.match((await fetch(origin+'/',{headers:{Cookie}})).headers.get('content-security-policy')!,/img-src 'self'/);
    // A forged JSON approval flag on import does not substitute a different image.
    await fetch(origin+'/api/image-upload/choice',{method:'POST',headers:{...base,'Content-Type':'application/json'},
      body:JSON.stringify({previewId:p.id,choice:'none',approved:true,autoAttachAllowed:true})});
    await fetch(origin+'/api/import',{method:'POST',headers:{...base,'Content-Type':'application/json'},
      body:JSON.stringify({previewId:p.id,approved:true,uploadId:body.upload.id,imageUrl:'https://evil.example/a.jpg'})});
    assert.equal(created.length,1);assert.equal(created[0].imageUrl,undefined);
    const log=lines.join('\n');assert.match(log,/action=upload provider=manual-upload/);
    assert.ok(!log.includes(p.id)&&!log.includes('Cookie')&&!log.includes(csrf));
  }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
