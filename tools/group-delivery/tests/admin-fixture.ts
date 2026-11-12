// Shared fixture for the admin dashboard tests: on-disk PGlite with the real migrations, the real Express app, a mocked
// Shopify Storefront API (counts requests) and seeded groups/members covering every dashboard state.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createApp} from '../src/server.js';
import {Groups} from '../src/groups.js';
import {Areas} from '../src/areas.js';
import {Shopify} from '../src/shopify.js';
import {config} from '../src/config.js';
import {migrate,type Database,type Connection} from '../src/db.js';
export const AREA={beerSheva:'6f1a2c00-0001-4a00-8000-0000000000a1',ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3',sderot:'6f1a2c00-0007-4a00-8000-0000000000a7'};
export async function adminFixture(){
 const dir=await mkdtemp(join(tmpdir(),'fankee-admin-db-'));
 const engine=new PGlite(dir);
 let tail=Promise.resolve();
 async function acquire(){let release!:()=>void;const wait=tail;tail=new Promise<void>(r=>release=r);await wait;return release;}
 const query=async(sql:string,values?:any[]):Promise<any>=>values?engine.query(sql,values):(await engine.exec(sql)).at(-1)||{rows:[]};
 const db:Database={async query(sql,values){const release=await acquire();try{return await query(sql,values);}finally{release();}},async connect(){const release=await acquire();return {query,release} as Connection;}};
 const cfg=config({PORT:'4330',DATABASE_URL:'postgresql://test',ADMIN_USERNAME:'merchant',ADMIN_PASSWORD:'testing-password-long-only',SESSION_SECRET:'testing-session-secret-not-real-00000000',SHOPIFY_STORE_DOMAIN:'example.myshopify.com',SHOPIFY_STOREFRONT_PRIVATE_TOKEN:'test-private-shopify-token',APP_ORIGIN:'http://127.0.0.1:4330'});
 const shopify={mode:'ok' as 'ok'|'down',requests:0,prices:{} as Record<string,string>};
 const validator=new Shopify(cfg,async(_input,options)=>{
  shopify.requests++;
  if(shopify.mode==='down')throw Error('upstream down');
  const body=JSON.parse(String(options?.body));
  return new Response(JSON.stringify({data:{nodes:body.variables.ids.map((id:string)=>{const n=id.split('/').pop()!;return {id,title:'Default Title',availableForSale:true,requiresComponents:false,quantityAvailable:100,price:{amount:shopify.prices[n]||'125.00',currencyCode:'ILS'},quantityRule:{minimum:1,increment:1,maximum:null},product:{title:'מוצר '+n,requiresSellingPlan:false}};})}}));
 });
 await migrate(db);
 const areas=new Areas(db,cfg),groups=new Groups(db,cfg,validator,areas),app=createApp(db,cfg,validator);
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 cfg.origin='http://127.0.0.1:'+(server.address() as any).port;
 let n=0;
 const person=(email?:string)=>{n++;return {email:email||'customer'+n+'@example.test',phone:'05'+String(20000000+n).padStart(8,'0')};};
 const join_=(area:string,quantity:number,who=person())=>groups.joinArea({...who,areaPublicId:area,lines:[{variantId:'1',quantity},{variantId:'2',quantity:1}]});
 // Seed: Ashdod open (2 pledged + 1 withdrawn), Beer Sheva reached, Ashkelon approved, Sderot expired, one legacy group.
 const seed=async()=>{
  const ashdod=await join_(AREA.ashdod,1,{email:'dana@example.test',phone:'050-1234567'});
  await groups.join(ashdod.group.publicId,{...person(),areaPublicId:AREA.ashdod,lines:[{variantId:'1',quantity:1}]});
  const leaving=await groups.join(ashdod.group.publicId,{...person('leaving@example.test'),areaPublicId:AREA.ashdod,lines:[{variantId:'1',quantity:1}]});
  await groups.withdraw(ashdod.group.publicId,leaving.memberToken,{confirm:true});
  const reached=await join_(AREA.beerSheva,4,{email:'Big.Buyer@Example.test',phone:'+972521112233'});
  const approved=await join_(AREA.ashkelon,4);
  await groups.approve(approved.group.publicId);
  const expired=await join_(AREA.sderot,1);
  await db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 hour',created_at=NOW()-INTERVAL '20 days' WHERE public_id=$1",[expired.group.publicId]);
  await db.query("UPDATE delivery_groups SET created_at=NOW()-INTERVAL '3 days' WHERE public_id=$1",[approved.group.publicId]);
  // A legacy (pre-areas) group with no area and a member whose stored email looks like a spreadsheet formula.
  const legacyId='11111111-2222-4333-8444-555555555555';
  await db.query("INSERT INTO delivery_groups(id,public_id,area_name,locality_key,threshold_agorot,pledged_total_agorot,expires_at) VALUES(gen_random_uuid(),$1,'תל אביב','תל אביב',50000,12500,NOW()+INTERVAL '5 days')",[legacyId]);
  await db.query(`INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash)
   SELECT gen_random_uuid(),id,'=HYPERLINK("http://evil.example","x")','+972509999999','תל אביב','[{"variantId":"gid://shopify/ProductVariant/1","quantity":1,"unitAgorot":"12500"}]'::jsonb,12500,'legacy-hash' FROM delivery_groups WHERE public_id=$1`,[legacyId]);
  return {ashdod:ashdod.group.publicId,reached:reached.group.publicId,approved:approved.group.publicId,expired:expired.group.publicId,legacy:legacyId,ashdodToken:ashdod.memberToken};
 };
 const login=async(password=cfg.password,next?:string)=>{
  const response=await fetch(cfg.origin+'/admin/login',{method:'POST',redirect:'manual',headers:{Origin:cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:cfg.username,password,...(next?{next}:{})})});
  const cookie=response.headers.get('set-cookie')?.split(';')[0]||'';
  const page=cookie?await(await fetch(cfg.origin+'/admin',{headers:{Cookie:cookie}})).text():'';
  return {response,cookie,csrf:page.match(/name="csrf" value="([^"]+)"/)?.[1]||''};
 };
 const close=async()=>{
  await new Promise<void>(r=>server.close(()=>r()));await engine.close();
  if(resolve(dir).startsWith(join(resolve(tmpdir()),'fankee-admin-db-')))await rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 };
 return {db,cfg,groups,shopify,seed,login,close,person};
}
