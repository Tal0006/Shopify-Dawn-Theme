import {test} from 'node:test';
import {request} from 'node:http';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server.js';
import {authConfig,createAuth} from '../src/auth.js';
import {Importer} from '../src/importer.js';
import {adminEnv} from './auth-helpers.js';
import {readFileSync} from 'node:fs';
// Node fetch normalizes Host; raw local HTTP lets the tests exercise canonical/proxy hosts.
const fetch=(url:string,options:RequestInit={}):Promise<Response>=>new Promise((resolve,reject)=>{
  const req=request(url,{method:options.method || 'GET',headers:options.headers as Record<string,string>},res=>{
    const chunks:Buffer[]=[];
    res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    res.on('end',()=>{
      const headers=new Headers();
      for(const [key,value] of Object.entries(res.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
      const body=Buffer.concat(chunks);
      resolve(new Response(res.statusCode===204?null:body,{status:res.statusCode!,headers}));
    });
  });
  req.on('error',reject);
  if(options.body)req.write(String(options.body));
  req.end();
});
const code='7290108356472';
const product={barcode:code,title:'Test product',source:'cheapersal'};
const gateway={currency:async()=>'ILS',findBarcode:async()=>undefined,create:async()=>({id:'1',barcode:code,title:'Product',adminUrl:'https://example.myshopify.com/admin/products/1'})};
async function serve(run:(origin:string)=>Promise<void>,env:NodeJS.ProcessEnv=adminEnv,service=new Importer({lookupByBarcode:async()=>product},gateway)){
  // Bind an ephemeral socket while keeping the application's configured origin deterministic.
  const server=createApp(service,4310,env).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const origin='http://127.0.0.1:'+(server.address() as AddressInfo).port;
  // Local test requests use the configured host. No external API calls are made.
  try{await run(origin);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
const Host='127.0.0.1:4310', Origin='http://'+Host;
async function login(base:string,username=adminEnv.IMPORTER_USERNAME,password=adminEnv.IMPORTER_PASSWORD,extra:Record<string,string>={}){
  return fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Host,Origin,'Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams({username,password})});
}
async function session(base:string,Cookie:string){
  return (await fetch(base+'/api/session',{headers:{Host,Cookie}})).json();
}
test('Authentication configuration fails closed and production requires HTTPS',()=>{
  assert.throws(()=>authConfig({},4310),/Configure/);
  assert.throws(()=>authConfig({...adminEnv,IMPORTER_PASSWORD:'short'},4310),/Configure/);
  assert.throws(()=>authConfig({...adminEnv,NODE_ENV:'production'},4310),/HTTPS/);
  assert.equal(authConfig({...adminEnv,NODE_ENV:'production',RENDER_EXTERNAL_URL:'https://importer.onrender.com'},4310).origin,'https://importer.onrender.com');
});
test('Public health is minimal; UI redirects and all APIs reject unauthenticated clients',async()=>{
  await serve(async base=>{
    const health=await fetch(base+'/health');assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});
    for(const path of ['/index.html','/app.js','/.env']){
      const response=await fetch(base+path,{redirect:'manual',headers:{Host}});
      assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/login');
    }
    for(const path of ['/api/session','/api/preview','/api/image-selection','/api/import','/api/logout','/api/unknown']){
      const response=await fetch(base+path,{method:path==='/api/session'?'GET':'POST',headers:{Host}});
      assert.equal(response.status,401,path);
    }
    const page=await fetch(base+'/login',{headers:{Host}});assert.equal(page.status,200);
    const html=await page.text();assert.match(html,/type="password"/);assert.ok(!html.includes(adminEnv.IMPORTER_PASSWORD));
  });
});
test('Login creates an opaque HttpOnly session, CSRF gates mutations, logout invalidates it',async()=>{
  await serve(async base=>{
    assert.equal((await login(base,'wrong','wrong')).status,401);
    assert.equal((await login(base,undefined,undefined,{Origin:'https://evil.example'})).status,403);
    const response=await login(base);assert.equal(response.status,303);
    const raw=response.headers.get('set-cookie')!;assert.match(raw,/HttpOnly/);assert.match(raw,/SameSite=Strict/);assert.ok(!raw.includes('Secure'));
    const Cookie=raw.split(';')[0];assert.ok(!Cookie.includes(adminEnv.IMPORTER_PASSWORD));
    const {csrf}=await session(base,Cookie);assert.match(csrf,/^[a-f0-9]{64}$/);
    assert.equal((await fetch(base+'/api/logout',{method:'POST',headers:{Host,Cookie,Origin,'Content-Type':'application/json'},body:'{}'})).status,403);
    const preview=await fetch(base+'/api/preview',{method:'POST',headers:{Host,Cookie,Origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({barcode:code,price:'15.90'})});
    assert.equal(preview.status,200);
    const logout=await fetch(base+'/api/logout',{method:'POST',headers:{Host,Cookie,Origin,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'});
    assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie')!,/Expires=/);
    assert.equal((await fetch(base+'/api/session',{headers:{Host,Cookie}})).status,401);
  });
});
test('Production proxy path uses Secure host-only cookies and rejects direct HTTP',async()=>{
  const env={...adminEnv,NODE_ENV:'production',APP_ORIGIN:'https://importer.example'};
  await serve(async base=>{
    assert.equal((await fetch(base+'/login',{headers:{Host:'importer.example'}})).status,400);
    const response=await login(base,undefined,undefined,{Host:'importer.example',Origin:'https://importer.example','X-Forwarded-Proto':'https'});
    assert.equal(response.status,303);
    const cookie=response.headers.get('set-cookie')!;
    assert.match(cookie,/^__Host-importer_session=/);assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.ok(!cookie.includes('Domain='));
    assert.equal((await fetch(base+'/api/session',{headers:{Host:'importer.example',Cookie:cookie.split(';')[0],'X-Forwarded-Proto':'https'}})).status,200);
  },env);
});
test('Login rate limit stops repeated failed guesses',async()=>{
  await serve(async base=>{
    for(let i=0;i<10;i++)assert.equal((await login(base,'wrong','wrong')).status,401);
    const response=await login(base);assert.equal(response.status,429);assert.equal(response.headers.get('retry-after'),'900');
  });
});
test('Raw provider exceptions, environment values, and credential-like fields never reach browser JSON',async()=>{
  const keys=['SHOPIFY_CLIENT_SECRET','SHOPIFY_ADMIN_ACCESS_TOKEN','CHEAPERSAL_API_KEY','SERPAPI_API_KEY','BARCODE_LOOKUP_API_KEY','GO_UPC_API_KEY','PRODUCT_IMAGE_API_KEY'];
  const fake=Object.fromEntries(keys.map((key,index)=>[key,'sentinel-credential-'+index]));
  let throws=false;
  const service=new Importer({lookupByBarcode:async()=>{
    if(throws)throw Error(fake.SHOPIFY_CLIENT_SECRET);
    return {...product,title:Object.values(fake).join(' '),api_key:fake.CHEAPERSAL_API_KEY};
  }},gateway);
  await serve(async base=>{
    const Cookie=(await login(base)).headers.get('set-cookie')!.split(';')[0];
    const {csrf}=await session(base,Cookie);
    const headers={Host,Cookie,Origin,'Content-Type':'application/json','X-CSRF-Token':csrf};
    for(const path of ['/','/app.js','/style.css','/api/session']){
      const text=await(await fetch(base+path,{headers:{Host,Cookie}})).text();
      for(const value of [...Object.values(fake),adminEnv.IMPORTER_PASSWORD])assert.ok(!text.includes(value),path);
    }
    for(const path of ['/.env','/src/server.ts','/package.json'])assert.equal((await fetch(base+path,{headers:{Host,Cookie}})).status,404);
    const response=await fetch(base+'/api/preview',{method:'POST',headers,body:JSON.stringify({barcode:code,price:'15.90'})});
    const text=await response.text();assert.equal(response.status,200);
    for(const value of Object.values(fake))assert.ok(!text.includes(value));
    assert.ok(!text.includes('api_key'));
    throws=true;
    const error=await fetch(base+'/api/preview',{method:'POST',headers,body:JSON.stringify({barcode:code,price:'15.90'})});
    assert.equal(error.status,500);const failure=await error.text();assert.ok(!failure.includes('sentinel-'));assert.ok(!failure.includes('stack'));
    const malformed=await fetch(base+'/api/preview',{method:'POST',headers,body:'{"'+fake.SHOPIFY_CLIENT_SECRET});
    assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes('sentinel-'));
  },{...adminEnv,...fake},service);
});
test('Sessions expire server-side after eight hours',()=>{
  let now=0,cookie='';
  const auth=createAuth(authConfig(adminEnv,4310),()=>now);
  const req={headers:{},body:{username:adminEnv.IMPORTER_USERNAME,password:adminEnv.IMPORTER_PASSWORD},ip:'127.0.0.1'} as any;
  const res={cookie:(name:string,value:string)=>{cookie=name+'='+value;},redirect:()=>{}} as any;
  auth.login(req,res);
  assert.ok(auth.session({headers:{cookie}} as any));
  now=8*60*60_000;assert.equal(auth.session({headers:{cookie}} as any),undefined);
});
test('Production entrypoint and build paths use compiled output and do not require a .env file',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const ts=JSON.parse(readFileSync(new URL('../tsconfig.json',import.meta.url),'utf8'));
  assert.equal(ts.compilerOptions.outDir,'dist');assert.equal(ts.compilerOptions.rootDir,'src');assert.equal(pkg.scripts.start,'node dist/server.js');
});

test('Blank origins use the exact local default; Render fallback and explicit origin are normalized',()=>{
  for(const APP_ORIGIN of ['', '   '])assert.equal(authConfig({...adminEnv,APP_ORIGIN},4310).origin,Origin);
  assert.equal(authConfig({...adminEnv,NODE_ENV:'production',APP_ORIGIN:'',RENDER_EXTERNAL_URL:'https://render.example'},4310).origin,'https://render.example');
  assert.equal(authConfig({...adminEnv,APP_ORIGIN:' http://127.0.0.1:4310/ '},4310).origin,Origin);
});
test('Public login preserves native form origin; null, missing, localhost aliases and foreign hosts stay forbidden',async()=>{
  await serve(async base=>{
    const page=await fetch(base+'/login',{headers:{Host}});
    assert.equal(page.headers.get('referrer-policy'),'same-origin');
    for(const origin of ['null','http://localhost:4310','http://127.0.0.1:4311','https://evil.example']){
      assert.equal((await login(base,undefined,undefined,{Origin:origin})).status,403);
    }
    assert.equal((await fetch(base+'/login',{method:'POST',headers:{Host,'Content-Type':'application/x-www-form-urlencoded'},body:'username=ignored&password=ignored'})).status,403);
    assert.equal((await login(base,undefined,undefined,{Host:'foreign.example'})).status,403);
    assert.equal((await login(base)).status,303,'Login requires no API session or CSRF token');
  });
});
test('Development 403 diagnostics contain only fixed reasons, never header/body/configuration values',async()=>{
  const messages:string[]=[],original=console.warn;
  console.warn=(...values:unknown[])=>{messages.push(values.join(' '));};
  try{
    await serve(async base=>{
      await login(base,'do-not-log-user','do-not-log-password',{Origin:'null',Cookie:'do-not-log-cookie'});
      await fetch(base+'/login',{method:'POST',headers:{Host,'Content-Type':'application/x-www-form-urlencoded'},body:'password=do-not-log-password'});
      const Cookie=(await login(base)).headers.get('set-cookie')!.split(';')[0];
      await fetch(base+'/api/logout',{method:'POST',headers:{Host,Cookie,Origin,'Content-Type':'application/json'},body:'{}'});
      await fetch(base+'/api/logout',{method:'POST',headers:{Host,Cookie,Origin,'Content-Type':'application/json','X-CSRF-Token':'do-not-log-csrf'},body:'{}'});
    });
  }finally{console.warn=original;}
  assert.deepEqual(messages,[
    'Login rejected: invalid origin (null)','Login rejected: missing origin',
    'Request rejected: missing CSRF token','Request rejected: invalid CSRF token'
  ]);
  for(const sensitive of ['do-not-log',adminEnv.IMPORTER_PASSWORD])assert.ok(!messages.join(' ').includes(sensitive));
});
test('Production origin rejections do not emit development diagnostics',async()=>{
  const messages:unknown[][]=[],original=console.warn;console.warn=(...values:unknown[])=>{messages.push(values);};
  try{
    await serve(async base=>{
      assert.equal((await login(base,undefined,undefined,{Host:'importer.example',Origin:'null','X-Forwarded-Proto':'https'})).status,403);
    },{...adminEnv,NODE_ENV:'production',APP_ORIGIN:'https://importer.example'});
  }finally{console.warn=original;}
  assert.equal(messages.length,0);
});

test('Public root renders login HTML and login assets load without authentication',async()=>{
  await serve(async base=>{
    const root=await fetch(base+'/',{headers:{Host,'Sec-Fetch-Site':'cross-site'}});
    assert.equal(root.status,200);assert.match(root.headers.get('content-type')!,/text\/html/);
    assert.match(await root.text(),/action="\/login"/);assert.equal(root.headers.get('referrer-policy'),'same-origin');
    for(const path of ['/login','/login.css','/style.css']){
      assert.equal((await fetch(base+path,{headers:{Host,'Sec-Fetch-Site':'cross-site'}})).status,200);
    }
    assert.equal((await fetch(base+'/favicon.ico',{headers:{Host,'Sec-Fetch-Site':'cross-site'}})).status,204);
    const api=await fetch(base+'/api/session',{headers:{Host,'Sec-Fetch-Site':'cross-site'}});
    assert.equal(api.status,401);assert.deepEqual(await api.json(),{error:'גישה אינה מורשית'});
  });
});
test('Render HTTPS root/login/API/logout routing preserves secure cookies and strict mutation origins',async()=>{
  const render='https://shopify-dawn-theme.onrender.com';
  const env={...adminEnv,NODE_ENV:'production',APP_ORIGIN:render,RENDER_EXTERNAL_URL:render};
  const host=new URL(render).host;
  const headers={Host:host,'X-Forwarded-Proto':'https'};
  await serve(async base=>{
    const anonymous=await fetch(base+'/',{headers:{...headers,'Sec-Fetch-Site':'cross-site'}});
    assert.equal(anonymous.status,200);assert.match(await anonymous.text(),/type="password"/);
    assert.deepEqual(await(await fetch(base+'/health')).json(),{status:'ok'});
    const credentials={...headers,Origin:render,'Content-Type':'application/x-www-form-urlencoded'};
    const wrong=await fetch(base+'/login',{method:'POST',headers:credentials,body:new URLSearchParams({username:'wrong',password:'wrong'})});
    assert.equal(wrong.status,401);
    const success=await fetch(base+'/login',{method:'POST',headers:credentials,body:new URLSearchParams({username:adminEnv.IMPORTER_USERNAME,password:adminEnv.IMPORTER_PASSWORD})});
    assert.equal(success.status,303);
    const cookie=success.headers.get('set-cookie')!;assert.match(cookie,/; Secure/);assert.match(cookie,/; HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    const Cookie=cookie.split(';')[0];
    const ui=await fetch(base+'/',{headers:{...headers,Cookie}});
    assert.equal(ui.status,200);const html=await ui.text();assert.match(html,/id="lookup"/);assert.doesNotMatch(html,/type="password"/);
    const noSession=await fetch(base+'/api/preview',{method:'POST',headers:{...headers,Origin:render,'Content-Type':'application/json'},body:'{}'});
    assert.equal(noSession.status,401);assert.deepEqual(await noSession.json(),{error:'גישה אינה מורשית'});
    const {csrf}=await(await fetch(base+'/api/session',{headers:{...headers,Cookie}})).json();
    const mutation={...headers,Cookie,Origin:render,'Content-Type':'application/json','X-CSRF-Token':csrf};
    const preview=await fetch(base+'/api/preview',{method:'POST',headers:mutation,body:JSON.stringify({barcode:code,price:'15.90'})});
    assert.equal(preview.status,200);
    assert.equal((await fetch(base+'/logout',{method:'POST',headers:{...mutation,Origin:'https://evil.example'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/logout',{method:'POST',headers:{...headers,Cookie,Origin:render,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(base+'/logout',{method:'POST',headers:mutation,body:'{}'})).status,200);
    const after=await fetch(base+'/',{headers:{...headers,Cookie}});
    assert.equal(after.status,200);assert.match(await after.text(),/type="password"/);
    assert.equal((await fetch(base+'/api/session',{headers:{...headers,Cookie}})).status,401);
  },env);
});
