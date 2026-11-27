// Owner pages for the order lifecycle (src/orders-page.ts): the cycle split workflow (choose, read-only preview,
// final confirmation) and per-order external payment reconciliation, through the real forms. Owner-only access, stale
// previews, double submission, exact amounts, payment separate from delivery, and the interim protection of paid
// orders before the split. Fake customers; in-process PGlite, the real Express app, mocked Shopify.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {Renewals} from '../src/renewals.js';

const AREA={ofakim:'6f1a2c00-0006-4a00-8000-0000000000a6',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',sderot:'6f1a2c00-0007-4a00-8000-0000000000a7'};
const PRICES:Record<string,string>={'31':'20.00','32':'25.00','33':'30.00','34':'12.40','35':'25.00','41':'20.00','42':'30.00','43':'16.10','44':'20.00','12':'127.30','13':'98.60','51':'141.20'};
const ORIGINAL=['31','32','33','34','35'].map(v=>({variantId:v,quantity:1})),SECOND=['41','42','43','44'].map(v=>({variantId:v,quantity:1}));

test('Order lifecycle owner pages',{timeout:400000},async t=>{
 const f=await adminFixture();
 try{
  Object.assign(f.shopify.prices,PRICES);
  const renewals=new Renewals(f.db,f.groups,(f.groups as any).shopify);
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const get=async(path:string,auth=true)=>{const r=await fetch(origin+path,{redirect:'manual',headers:auth?{Cookie:cookie}:{}});return {status:r.status,location:r.headers.get('location')||'',text:await r.text()};};
  const form=async(path:string,fields:Record<string,string>,opts:{auth?:boolean;csrf?:string;origin?:string}={})=>{
   const r=await fetch(origin+path,{method:'POST',redirect:'manual',headers:{...(opts.auth===false?{}:{Cookie:cookie}),Origin:opts.origin??origin,'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({csrf:opts.csrf??csrf,...fields})});
   return {status:r.status,location:r.headers.get('location')||'',text:await r.text()};
  };
  const one=async(sql:string,v:any[]=[])=>(await f.db.query(sql,v)).rows[0];
  const n=async(sql:string,v:any[]=[])=>Number((await one(sql,v)).n);
  const scenario=async(area:string)=>{
   const people=[f.person(),f.person(),f.person(),f.person()];
   const a=await f.groups.joinArea({...people[0],areaPublicId:area,lines:ORIGINAL});const id=a.group.publicId;
   const b=await f.groups.join(id,{...people[1],areaPublicId:area,lines:[{variantId:'12',quantity:1}]});
   const c=await f.groups.join(id,{...people[2],areaPublicId:area,lines:[{variantId:'13',quantity:1}]});
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '2 days' WHERE public_id=$1",[id]);await f.groups.expire();
   const gid=(await one('SELECT id FROM delivery_groups WHERE public_id=$1',[id])).id;
   const [A,B,C]=(await f.db.query('SELECT id FROM group_members WHERE group_id=$1 ORDER BY created_at',[gid])).rows.map((x:any)=>x.id as string);
   for(const m of [A,B,C])await renewals.reconfirm(id,m,{method:'PHONE'},'session:aaaaaaaaaaaa');
   await renewals.reopen(id,{confirm:true,days:14},'session:aaaaaaaaaaaa');
   await f.groups.update(id,a.memberToken,{lines:SECOND});
   const d=await f.groups.joinArea({...people[3],areaPublicId:area,lines:[{variantId:'51',quantity:2}]});
   const D=(await one('SELECT id FROM group_members WHERE group_id=$1 ORDER BY created_at DESC LIMIT 1',[gid])).id;
   return {id,gid,A,B,C,D,tokens:{a:a.memberToken,b:b.memberToken,c:c.memberToken,d:d.memberToken},people};
  };
  const roles=(s:any)=>({['role_'+s.A]:'RESTORE',['role_'+s.B]:'KEEP',['role_'+s.C]:'KEEP',['role_'+s.D]:'TRANSFER'});
  const executeFields=(html:string)=>{
   const pick=(name:string)=>html.match(new RegExp('name="'+name+'" value="([^"]*)"'))?.[1]?.replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&#39;/g,"'")||'';
   return {plan:pick('plan'),expectedState:pick('expectedState'),idempotencyKey:pick('idempotencyKey')};
  };

  await t.test('owner only: pages redirect to login, actions are refused without a session, a CSRF token or the right Origin',async()=>{
   const s=await scenario(AREA.sderot);
   for(const path of ['/admin/groups/'+s.id+'/cycle-split'])assert.equal((await get(path,false)).status,303);
   const actions:[string,Record<string,string>][]=[['/admin/groups/'+s.id+'/cycle-split/review',roles(s)],['/admin/groups/'+s.id+'/cycle-split/execute',{plan:'{}'}],
    ['/admin/groups/'+s.id+'/members/'+s.B+'/external-payment',{amount:'127.30',method:'CASH',receivedOn:'2026-11-19',attest:'yes'}]];
   for(const [path,fields] of actions){
    assert.ok([401,403,303].includes((await form(path,fields,{auth:false})).status),'no session: '+path);
    assert.equal((await form(path,fields,{csrf:'wrong'})).status,403,'no CSRF: '+path);
    assert.equal((await form(path,fields,{origin:'https://evil.example'})).status,403,'wrong Origin: '+path);
   }
   for(const path of ['/admin/api/groups/'+s.id+'/cycle-split/preview','/admin/api/groups/'+s.id+'/cycle-split','/admin/api/groups/'+s.id+'/members/'+s.B+'/external-payment']){
    const r=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,401,path);
   }
   assert.equal((await fetch(origin+'/admin/api/groups/'+s.id+'/members/'+s.A+'/history')).status,401);
   assert.equal(await n('SELECT count(*) AS n FROM member_payment_records'),0);assert.equal(await n('SELECT count(*) AS n FROM group_cycle_splits'),0);
   assert.equal((await one('SELECT operational_status FROM delivery_groups WHERE id=$1',[s.gid])).operational_status,'NEW','nothing changed');
  });

  await t.test('interim protection: the two untouched paid orders are recorded and locked before the split; the split still works',async()=>{
   const s=await scenario(AREA.ofakim);
   // Group page: each order separately, payment separate from delivery; the split link is offered.
   const page=(await get('/admin/groups/'+s.id)).text;
   for(const text of ['התאמת תשלומים שהתקבלו מחוץ למערכת','לא נרשם תשלום','לא סומן כנמסר','סיום מחזור ופתיחת מחזור חדש'])assert.ok(page.includes(text),text);
   // Exact amount only; then recorded, locked, never a charge.
   const pay=(m:string,amount:string,extra:Record<string,string>={})=>form('/admin/groups/'+s.id+'/members/'+m+'/external-payment',{amount,method:'CASH',receivedOn:'2026-11-19',attest:'yes',...extra});
   assert.match((await pay(s.B,'127.00')).location,/orderError=INVALID_PAYMENT_RECORD/);
   assert.match((await pay(s.B,'127.30',{attest:''})).location,/orderError=INVALID_PAYMENT_RECORD/,'attestation required');
   assert.match((await pay(s.B,'127.30')).location,/orderNotice=payment_recorded/);
   assert.match((await pay(s.B,'127.30')).location,/orderNotice=payment_unchanged/,'double submit: no second record');
   assert.match((await pay(s.C,'98.60',{method:'BANK_TRANSFER',reference:'העברה 8812'})).location,/orderNotice=payment_recorded/);
   assert.equal(await n('SELECT count(*) AS n FROM member_payment_records'),2);
   await assert.rejects(()=>f.groups.update(s.id,s.tokens.b,{lines:SECOND}),(e:any)=>e.code==='ORDER_LOCKED','B can no longer be overwritten');
   await assert.rejects(()=>f.groups.withdraw(s.id,s.tokens.c,{confirm:true}),(e:any)=>e.code==='ORDER_LOCKED');
   assert.deepEqual([Number((await one('SELECT paid_total_agorot FROM delivery_groups WHERE id=$1',[s.gid])).paid_total_agorot),await n('SELECT count(*) AS n FROM group_payment_charges'),await n('SELECT count(*) AS n FROM group_members WHERE payment_status IS NOT NULL')],[0,0,0]);
   const paid=(await get('/admin/groups/'+s.id)).text;assert.ok(paid.includes('שולם מחוץ למערכת'));assert.ok(paid.includes('העברה 8812'));
   // A's overwritten order cannot be "paid" at 112.40 yet (its current amount is 86.10): restore first.
   assert.match((await pay(s.A,'112.40')).location,/orderError=INVALID_PAYMENT_RECORD/);
   // Step 1: the choice. Locked orders cannot be transferred; A offers the restore of its verified original.
   const choice=(await get('/admin/groups/'+s.id+'/cycle-split')).text;
   assert.ok(choice.includes('שחזור ההזמנה המקורית'));assert.ok(choice.includes('הסל המקורי המאומת'));
   // Step 2: the read-only preview — every affected order, its cart, role and receipt; nothing changed yet.
   const review=await form('/admin/groups/'+s.id+'/cycle-split/review',roles(s));
   assert.equal(review.status,200);
   for(const text of ['תצוגה מקדימה','הזמנה מקורית משוחזרת','הזמנה חדשה נפרדת (מהסל הנוכחי)','הזמנה שעוברת למחזור החדש','הזמנה שנשארת במחזור הקודם','אישור ההצטרפות של הלקוח',
    '594.40','338.30','368.50','מחזור חדש (ייפתח)','אישור סופי'])assert.ok(review.text.includes(text),text);
   assert.equal((await one('SELECT operational_status FROM delivery_groups WHERE id=$1',[s.gid])).operational_status,'NEW','the preview changes nothing');
   // Step 3: execute. Without the confirmations: refused, nothing changed.
   const fields=executeFields(review.text);
   assert.match((await form('/admin/groups/'+s.id+'/cycle-split/execute',{...fields,reason:'ORDER_OVERWRITE_RECONCILIATION'})).location,/error=SPLIT_CONFIRMATION_REQUIRED/);
   const done=await form('/admin/groups/'+s.id+'/cycle-split/execute',{...fields,reason:'ORDER_OVERWRITE_RECONCILIATION',deliveredAttested:'yes',confirm:'yes'});
   assert.equal(done.status,303);assert.match(done.location,new RegExp('^/admin/groups/'+s.id+'\\?orderNotice=cycle_split'));
   // Double submission of the same confirmation: replayed, nothing written again.
   const counts=async()=>[await n('SELECT count(*) AS n FROM group_members'),await n('SELECT count(*) AS n FROM delivery_groups'),await n('SELECT count(*) AS n FROM group_cycle_splits')];
   const c0=await counts();
   const again=await form('/admin/groups/'+s.id+'/cycle-split/execute',{...fields,reason:'ORDER_OVERWRITE_RECONCILIATION',deliveredAttested:'yes',confirm:'yes'});
   assert.match(again.location,/orderNotice=cycle_split/);assert.deepEqual(await counts(),c0);
   // Result: the old cycle holds the three historical orders, all locked; 282.40 is out of its total, history kept.
   const old=(await f.db.query('SELECT status,pledged_total_agorot,order_state,locked_reason,withdrawn_by FROM group_members WHERE group_id=$1 ORDER BY created_at',[s.gid])).rows;
   assert.deepEqual(old.map((m:any)=>[m.status,Number(m.pledged_total_agorot),m.order_state,m.locked_reason,m.withdrawn_by]),
    [['PLEDGED',11240,'LOCKED','DELIVERED',null],['PLEDGED',12730,'LOCKED','PAID_EXTERNAL',null],['PLEDGED',9860,'LOCKED','PAID_EXTERNAL',null],['WITHDRAWN',0,'OPEN',null,'TRANSFERRED']]);
   assert.equal(Number((await one('SELECT pledged_total_agorot FROM delivery_groups WHERE id=$1',[s.gid])).pledged_total_agorot),33830);
   assert.equal(await n("SELECT count(*) AS n FROM group_members WHERE group_id=$1 AND status='PLEDGED' AND order_state='OPEN'",[s.gid]),0,'no historical order is editable');
   const area=(await one('SELECT area_id FROM delivery_groups WHERE id=$1',[s.gid])).area_id;
   assert.equal(await n("SELECT count(*) AS n FROM delivery_groups WHERE area_id=$1 AND status IN ('OPEN','THRESHOLD_REACHED','APPROVED') AND operational_status<>'COMPLETED'",[area]),1,'exactly one current cycle');
   // Now A's restored original is paid: exact amount 112.40.
   assert.match((await pay(s.A,'112.40',{method:'BIT'})).location,/orderNotice=payment_recorded/);
   const after=(await get('/admin/groups/'+s.id+'?orderNotice=cycle_split')).text;
   assert.ok(!after.slice(after.indexOf('id="payments"')).includes('לא סומן כנמסר'),'every historical order reads delivered (the cycle completed), separately from its payment');
   const section=after.slice(after.indexOf('id="payments"'),after.indexOf('</section>',after.indexOf('id="payments"')));
   assert.equal((section.match(/שולם מחוץ למערכת<\/span>/g)||[]).length,3,'three payments recorded, one per order');
   assert.ok(after.includes('המחזור הקודם הושלם'));assert.ok(!after.includes('href="/admin/groups/'+s.id+'/cycle-split"'),'no second split of a completed cycle');
   assert.equal((await get('/admin/groups/'+s.id+'/members/'+s.D)).status,200);
   assert.ok((await get('/admin/groups/'+s.id)).text.includes('הועבר למחזור חדש'),'the carried order is labelled, never as a withdrawal');
  });

  await t.test('stale preview: a customer change after the preview is rejected and the owner is sent back to choose again',async()=>{
   const s=await scenario(AREA.netivot);
   const review=await form('/admin/groups/'+s.id+'/cycle-split/review',roles(s));
   const fields=executeFields(review.text);
   await f.groups.update(s.id,s.tokens.d,{lines:[{variantId:'51',quantity:1}]});
   const r=await form('/admin/groups/'+s.id+'/cycle-split/execute',{...fields,reason:'ORDER_OVERWRITE_RECONCILIATION',deliveredAttested:'yes',confirm:'yes'});
   assert.equal(r.status,303);assert.match(r.location,/\/cycle-split\?error=SPLIT_STATE_CHANGED/);
   assert.ok((await get(r.location)).text.includes('הנתונים השתנו מאז התצוגה המקדימה'));
   assert.equal((await one('SELECT operational_status FROM delivery_groups WHERE id=$1',[s.gid])).operational_status,'NEW');
   assert.equal(await n("SELECT count(*) AS n FROM admin_audit WHERE action='group.cycle_split' AND result='DENIED' AND detail='SPLIT_STATE_CHANGED'"),1,'the refusal is audited');
   // A selection with nothing to carry is refused at the preview, with the choice kept.
   const empty=await form('/admin/groups/'+s.id+'/cycle-split/review',{['role_'+s.A]:'KEEP',['role_'+s.D]:'KEEP'});
   assert.equal(empty.status,409);assert.ok(empty.text.includes('יש לבחור לפחות הזמנה אחת'));
  });
 }finally{await f.close();}
});
