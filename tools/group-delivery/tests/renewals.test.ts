// Expiration management (src/renewals.ts, /admin/renewals, group-page renewal section): owner-only access, explicit
// customer reconfirmation before an expired pledge counts again, re-checks against Shopify, duplicate and conflict
// prevention, refused payment states, kept history and receipts, and the audit trail. In-process PGlite with the real
// migrations, the real Express app and a mocked Shopify (tests/admin-fixture.ts): no network, no real data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';

const AREA={kiryatGat:'6f1a2c00-0004-4a00-8000-0000000000a4',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',ofakim:'6f1a2c00-0006-4a00-8000-0000000000a6',
 ashdod:'6f1a2c00-0002-4a00-8000-0000000000a2',beerSheva:'6f1a2c00-0001-4a00-8000-0000000000a1',ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3',sderot:'6f1a2c00-0007-4a00-8000-0000000000a7'};

test('Group renewals',{timeout:240000},async t=>{
 const f=await adminFixture();
 try{
  const {cookie,csrf}=await f.login();
  const origin=f.cfg.origin;
  const api=async(path:string,body?:any,headers:Record<string,string>={Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf})=>{
   const response=await fetch(origin+path,{method:body?'POST':'GET',redirect:'manual',headers:{...headers,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
   const text=await response.text();let json:any=null;try{json=JSON.parse(text);}catch{}
   return {status:response.status,body:json,text,location:response.headers.get('location')};
  };
  const form=async(path:string,fields:Record<string,string>)=>{
   const response=await fetch(origin+path,{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...fields})});
   return {status:response.status,location:response.headers.get('location')||''};
  };
  const join=(area:string,who=f.person(),quantity=1)=>f.groups.joinArea({...who,areaPublicId:area,lines:[{variantId:'1',quantity},{variantId:'2',quantity:1}]});
  const expire=async(id:string)=>{await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 hour' WHERE public_id=$1",[id]);await f.groups.expire();};
  const group=async(id:string)=>(await f.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[id])).rows[0];
  const members=async(id:string)=>(await f.db.query('SELECT m.* FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1 ORDER BY m.created_at,m.id',[id])).rows;
  const audits=async(action:string,target?:string)=>(await f.db.query('SELECT * FROM admin_audit WHERE action=$1'+(target?' AND target=$2':'')+' ORDER BY at',target?[action,target]:[action])).rows;
  // An expired group with `count` members (each 1×125 + 1×125 = 250 ILS at the default mock price).
  const expiredGroup=async(area:string,count=2,people=Array.from({length:count},()=>f.person()))=>{
   const first=await join(area,people[0]);const id=first.group.publicId,tokens=[first.memberToken];
   for(const who of people.slice(1))tokens.push((await f.groups.join(id,{...who,areaPublicId:area,lines:[{variantId:'1',quantity:1},{variantId:'2',quantity:1}]})).memberToken);
   await expire(id);
   return {id,tokens,people,members:(await members(id)).map((m:any)=>m.id as string)};
  };
  const reconfirm=(id:string,memberId:string,body:any)=>api('/admin/api/groups/'+id+'/members/'+memberId+'/reconfirm',body);
  const reopen=(id:string,body:any)=>api('/admin/api/groups/'+id+'/reopen',body);

  await t.test('owner only: no session, a wrong Origin or a missing CSRF token changes nothing',async()=>{
   const g=await expiredGroup(AREA.kiryatGat,1);
   const page=await fetch(origin+'/admin/groups/'+g.id,{redirect:'manual'});assert.equal(page.status,303);assert.match(page.headers.get('location')||'',/^\/admin\?expired=1/);
   assert.equal((await api('/admin/api/groups/'+g.id+'/renewal',undefined,{})).status,401);
   assert.equal((await api('/admin/api/groups?view=expired',undefined,{})).status,401);
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).status,200,'the owner can');
   for(const headers of [{},{Cookie:cookie,Origin:origin},{Cookie:cookie,Origin:'https://evil.example','X-CSRF-Token':csrf},{Origin:origin,'X-CSRF-Token':csrf}]){
    const r=await api('/admin/api/groups/'+g.id+'/reopen',{confirm:true,days:7},headers);
    assert.ok([401,403].includes(r.status),'refused: '+JSON.stringify(Object.keys(headers)));
   }
   assert.equal((await group(g.id)).status,'EXPIRED','nothing was reopened');
   assert.equal((await audits('group.reopen',g.id)).length,0,'refused before reaching the action');
  });

  await t.test('overview inside the existing groups list: views for groups expiring soon and expired groups with pledges',async()=>{
   const soon=(await join(AREA.netivot)).group.publicId;
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()+INTERVAL '10 hours' WHERE public_id=$1",[soon]);
   const expired=await expiredGroup(AREA.ofakim,2);
   const ids=async(view:string)=>(await api('/admin/api/groups?view='+view)).body.groups.map((g:any)=>g.publicId);
   assert.ok((await ids('expiring')).includes(soon),'expiring soon');assert.ok(!(await ids('expiring')).includes(expired.id));
   assert.ok((await ids('expired')).includes(expired.id),'expired with stored pledges');assert.ok(!(await ids('expired')).includes(soon));
   const e=(await api('/admin/api/groups?view=expired')).body.groups.find((g:any)=>g.publicId===expired.id);
   assert.deepEqual([e.activeMembers,e.pledgedTotalAgorot,e.status],[2,50000,'EXPIRED']);
   // No separate dashboard: the standalone page and API do not exist; the existing list offers the views.
   assert.equal((await api('/admin/renewals')).status,404);assert.equal((await api('/admin/api/renewals')).status,404);
   const html=(await api('/admin?view=expired')).text;assert.match(html,/פג תוקף עם התחייבויות/);assert.match(html,/מסתיימות בקרוב/);assert.ok(!html.includes('חידוש קבוצות'));
   // Original commitments, products and customer details stay visible on the group page.
   const page=(await api('/admin/groups/'+expired.id)).text;
   for(const text of ['@example.test','מוצרים בהתחייבויות','התחייבות שמורה: '])assert.ok(page.includes(text),text);
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()+INTERVAL '20 days' WHERE public_id=$1",[soon]);
  });

  await t.test('nothing renews silently: a reopen without a recorded reconfirmation is refused and audited',async()=>{
   const g=await expiredGroup(AREA.ashdod,2);
   const r=await reopen(g.id,{confirm:true,days:14});
   assert.deepEqual([r.status,r.body.code],[409,'RECONFIRMATION_REQUIRED']);
   assert.equal((await group(g.id)).status,'EXPIRED');
   assert.deepEqual((await members(g.id)).map((m:any)=>[m.status,Number(m.pledged_total_agorot)]),[['PLEDGED',25000],['PLEDGED',25000]],'pledges untouched');
   assert.equal((await audits('group.reopen',g.id)).at(-1).result,'DENIED');
   assert.equal((await reopen(g.id,{days:14})).body.code,'REOPEN_CONFIRMATION_REQUIRED','explicit confirmation');
   assert.equal((await reopen(g.id,{confirm:true,days:90})).status,400,'days are limited');
   // Approaching and current groups cannot be "reopened".
   const current=(await join(AREA.beerSheva)).group.publicId;
   assert.equal((await reopen(current,{confirm:true,days:14})).status,409);
  });

  await t.test('reconfirmation: a method is required, the note never holds contact details, price changes need the customer\'s agreement',async()=>{
   const g=await expiredGroup(AREA.sderot,2);
   assert.equal((await reconfirm(g.id,g.members[0],{})).body.code,'INVALID_RECONFIRMATION');
   for(const reference of ['dana@example.test','050-1234567','0501234567','<b>x</b>','x'.repeat(61)])
    assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE',reference})).body.code,'INVALID_RECONFIRMATION',reference);
   const ok=await reconfirm(g.id,g.members[0],{method:'WHATSAPP',reference:'שיחה 26.11'});
   assert.deepEqual([ok.status,ok.body.confirmedAmountAgorot,ok.body.previousAmountAgorot],[200,25000,25000]);
   const row=(await audits('member.reconfirm',g.id)).at(-1);
   assert.deepEqual([row.result,row.detail,Number(row.amount_agorot),row.subject],['OK','WHATSAPP',25000,g.members[0]]);
   assert.ok(!JSON.stringify(row).includes('example.test')&&!JSON.stringify(row).includes('שיחה'),'audit holds no contact details or notes');
   // Today's price differs from the stored pledge: refused until the owner states the amount the customer agreed to.
   f.shopify.prices['1']='130.00';
   const changed=await reconfirm(g.id,g.members[1],{method:'PHONE'});assert.deepEqual([changed.status,changed.body.code],[409,'PRICE_CHANGED']);
   assert.equal((await reconfirm(g.id,g.members[1],{method:'PHONE',acceptTotalAgorot:25000})).body.code,'PRICE_CHANGED','the old total is not accepted');
   const agreed=await reconfirm(g.id,g.members[1],{method:'PHONE',acceptTotalAgorot:25500});
   assert.deepEqual([agreed.status,agreed.body.confirmedAmountAgorot],[200,25500]);
   // The form flow sends the owner back to that member with today's total, so the agreement can be ticked.
   const back=await form('/admin/groups/'+g.id+'/members/'+g.members[0]+'/reconfirm',{method:'PHONE'});
   f.shopify.prices={};
   assert.equal(back.status,303);
   const priceUrl=await form('/admin/groups/'+g.id+'/members/'+g.members[0]+'/reconfirm',{method:'EMAIL'});
   assert.match(priceUrl.location,/renewalNotice=reconfirmed/);
  });

  await t.test('a price change after the confirmation refuses the reopen; the next confirmation replaces the previous one',async()=>{
   const g=await expiredGroup(AREA.ashkelon,1);
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).status,200);
   f.shopify.prices['2']='140.00';
   const r=await reopen(g.id,{confirm:true,days:14});assert.deepEqual([r.status,r.body.code],[409,'PRICE_CHANGED']);
   assert.equal((await group(g.id)).status,'EXPIRED');
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE',acceptTotalAgorot:26500})).status,200);
   const rows=(await f.db.query('SELECT used_at,revoked_at FROM member_reconfirmations WHERE member_id=$1 ORDER BY recorded_at',[g.members[0]])).rows;
   assert.deepEqual(rows.map((x:any)=>[x.used_at===null,x.revoked_at===null]),[[true,false],[true,true]],'the earlier one is revoked, never counted');
   const done=await reopen(g.id,{confirm:true,days:7});assert.equal(done.status,200);assert.equal(done.body.group.pledgedTotalAgorot,26500);
   f.shopify.prices={};
  });

  await t.test('reopen: only reconfirmed pledges count; the rest stay as expired, unconfirmed commitments (never withdrawals); receipts kept',async()=>{
   const g=await expiredGroup(AREA.kiryatGat,3);
   // (kiryatGat already holds the authorization test's expired group; it is not current, so it does not conflict.)
   // One of three customers confirms: 250 ILS, below the 500 ILS target, so the group is OPEN and offered to customers.
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).status,200);
   const before=(await members(g.id))[1];
   const r=await reopen(g.id,{confirm:true,days:14});
   assert.equal(r.status,200);assert.deepEqual([r.body.counted,r.body.expiredUnconfirmed,r.body.days],[1,2,14]);
   const after=await group(g.id);
   assert.deepEqual([after.status,Number(after.pledged_total_agorot),after.reopened_count],['OPEN',25000,1]);
   const days=(new Date(after.expires_at).getTime()-Date.now())/86400000;assert.ok(days>13.9&&days<14.1,'new deadline');
   const rows=await members(g.id);
   assert.deepEqual(rows.map((m:any)=>[m.status,Number(m.pledged_total_agorot),m.withdrawn_by]),[['PLEDGED',25000,null],['WITHDRAWN',0,'EXPIRED'],['WITHDRAWN',0,'EXPIRED']]);
   assert.deepEqual(rows[1].cart_snapshot,before.cart_snapshot,'the original cart is kept');
   assert.ok(new Date(rows[1].withdrawn_at).getTime()<Date.now()-60000,'dated at the group\'s expiry, not at the reopen');
   // Shown as expired and unconfirmed, never as a customer withdrawal or an owner removal; counted apart.
   const page=(await api('/admin/groups/'+g.id)).text;
   assert.ok(page.includes('פג תוקף, לא אושר מחדש'));assert.ok(!page.includes('פרש מהקבוצה'));assert.ok(!page.includes('הוסר על ידי מנהל'));
   assert.ok(page.includes('<dd>1 · 2 פג תוקף ולא אושרו מחדש</dd>'),'counted apart');assert.ok(!page.includes('הוסרו מהקבוצה'),'not counted as removals');
   const memberPage=(await api('/admin/groups/'+g.id+'/members/'+g.members[1])).text;assert.ok(memberPage.includes('פג תוקף, לא אושר מחדש'));assert.ok(!memberPage.includes('פרש מהקבוצה'));
   assert.equal((await api('/admin/api/groups/'+g.id+'/members?status=WITHDRAWN')).body.members.filter((m:any)=>m.withdrawnBy==='EXPIRED').length,2,'listed under inactive');
   const csv=(await api('/admin/groups/'+g.id+'/export.csv')).text;assert.equal((csv.match(/EXPIRED_UNCONFIRMED/g)||[]).length,2);
   // Device receipts keep working: the confirmed customers are members, the other one sees an inactive membership.
   assert.equal((await f.groups.member(g.id,g.tokens[0])).status,'PLEDGED');
   assert.equal((await f.groups.member(g.id,g.tokens[1])).status,'WITHDRAWN');
   // What every customer sees for the area now.
   const found=await f.groups.find({areaPublicId:AREA.kiryatGat});
   assert.deepEqual([found.group?.publicId,found.group?.pledgedTotalAgorot,found.group?.participantCount],[g.id,25000,1]);
   const a=(await audits('group.reopen',g.id)).at(-1);
   assert.deepEqual([a.result,a.previous_status,a.new_status,Number(a.amount_agorot),a.detail],['OK','EXPIRED','OPEN',25000,'COUNTED_1_EXPIRED_2_DAYS_14']);
   const kept=await audits('member.expire_unconfirmed',g.id);
   assert.deepEqual(kept.map((x:any)=>[x.detail,Number(x.amount_agorot),x.previous_status]),[['NOT_RECONFIRMED',25000,'PLEDGED'],['NOT_RECONFIRMED',25000,'PLEDGED']],'each one audited with its original amount');
   assert.equal((await audits('member.withdraw',g.id)).length,0,'no withdrawal is recorded');
   assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM member_reconfirmations WHERE group_id=$1 AND used_at IS NOT NULL',[after.id])).rows[0].n,1);
   // The customer can renew it themselves from the storefront receipt: the reason is cleared and it counts again.
   await f.groups.update(g.id,g.tokens[2],{lines:[{variantId:'1',quantity:1}]});
   const renewed=(await members(g.id))[2];assert.deepEqual([renewed.status,Number(renewed.pledged_total_agorot),renewed.withdrawn_by,renewed.withdrawn_at],['PLEDGED',12500,null,null]);
   assert.equal(Number((await group(g.id)).pledged_total_agorot),37500,'counted once, at today\'s price');
   // Migration 017 replaced the 004 check: exactly one check on the reason, and unknown reasons are still refused.
   const checks=(await f.db.query("SELECT conname FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%withdrawn_by%'")).rows;
   assert.deepEqual(checks.map((c:any)=>c.conname),['group_members_withdrawn_by_check']);
   await assert.rejects(()=>f.db.query("UPDATE group_members SET withdrawn_by='SOMETHING' WHERE id=$1",[g.members[1]]));
   // Reaching the target through renewals follows the service's own rule (THRESHOLD_REACHED at 500 ILS).
   const full=await expiredGroup(AREA.sderot,2);
   for(const m of full.members)assert.equal((await reconfirm(full.id,m,{method:'PHONE'})).status,200);
   assert.equal((await reopen(full.id,{confirm:true,days:5})).body.group.status,'THRESHOLD_REACHED');
   // A second reopen is refused (it is not expired), and the reopened group expires normally at its new deadline.
   assert.equal((await reopen(g.id,{confirm:true,days:14})).body.code,'RENEWAL_NOT_ALLOWED');
   await expire(g.id);assert.equal((await group(g.id)).status,'EXPIRED');
   // Used confirmations never count again: the next renewal needs new ones.
   assert.equal((await reopen(g.id,{confirm:true,days:14})).body.code,'RECONFIRMATION_REQUIRED');
  });

  await t.test('no duplicate counting: a customer already in a current group, or an area with a current group, is refused',async()=>{
   // An expired Netivot group, then a new customer opens a new current group there: reopening would split the progress.
   const g=await expiredGroup(AREA.netivot,1);
   await join(AREA.netivot);
   const last=g.members.at(-1)!;
   assert.equal((await reconfirm(g.id,last,{method:'PHONE'})).status,200,'recording is allowed');
   const conflict=await reopen(g.id,{confirm:true,days:14});
   assert.deepEqual([conflict.status,conflict.body.code],[409,'CURRENT_GROUP_EXISTS']);
   assert.equal((await group(g.id)).status,'EXPIRED');
   // The same person already pledged in a current group elsewhere.
   const other=await expiredGroup(AREA.ofakim,1,[f.person()]);
   await join(AREA.beerSheva,{email:(await members(other.id))[0].email,phone:(await members(other.id))[0].phone});
   assert.equal((await reconfirm(other.id,other.members[0],{method:'PHONE'})).body.code,'ALREADY_ACTIVE_ELSEWHERE');
  });

  await t.test('card, paid, charged and started deliveries are never renewed by the owner',async()=>{
   const g=await expiredGroup(AREA.sderot,1);
   const set=(sql:string)=>f.db.query('UPDATE delivery_groups SET '+sql+' WHERE public_id=$1',[g.id]);
   await set("payment_mode='CARDCOM'");assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).body.code,'RENEWAL_NOT_ALLOWED');
   await set("payment_mode='NONE',operational_status='IN_PROGRESS'");assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).body.code,'RENEWAL_NOT_ALLOWED');
   await set("operational_status='NEW',payment_state='PAID'");assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).body.code,'RENEWAL_NOT_ALLOWED');
   await set('payment_state=NULL');
   await f.db.query("UPDATE group_members SET payment_status='CHARGED',approved_amount_agorot=pledged_total_agorot,consent_at=NOW() WHERE id=$1",[g.members[0]]);
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).body.code,'RENEWAL_NOT_ALLOWED');
   const state=(await api('/admin/api/groups/'+g.id+'/renewal')).body;assert.equal(state.eligible,false);assert.ok(state.blockers.includes('PAYMENT_RECORDED'));
  });

  await t.test('group page: renewal section, products, separate commitment and payment columns, the audit log of the group; no Shopify request unless names are asked for',async()=>{
   const g=await expiredGroup(AREA.ashdod,1);
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '2 hours' WHERE status IN ('OPEN','THRESHOLD_REACHED') AND area_id=(SELECT id FROM delivery_areas WHERE public_id=$1)",[AREA.ashdod]);await f.groups.expire();
   const requests=f.shopify.requests;
   const html=(await api('/admin/groups/'+g.id)).text;
   assert.equal(f.shopify.requests,requests,'the group page makes no Shopify request');
   for(const text of ['חידוש הקבוצה','ממתין לאישור הלקוח','רישום אישור הלקוח','מוצרים בהתחייבויות','הצגת שמות המוצרים','>מצב התחייבות</th>','>תשלום</th>','ללא תשלום מקוון','/admin/audit?target='+g.id])assert.ok(html.includes(text),text);
   for(const text of ['היסטוריית פעולות בקבוצה','id="pay-title"'])assert.ok(!html.includes(text),'no duplicate card: '+text);
   assert.ok(html.indexOf('לקוחות בקבוצה')<html.indexOf('חידוש הקבוצה'),'customers come first');
   await api('/admin/groups/'+g.id+'?products=names');assert.equal(f.shopify.requests,requests+1,'one batched request for the names');
   assert.equal((await reconfirm(g.id,g.members[0],{method:'PHONE'})).status,200);
   const ready=(await api('/admin/groups/'+g.id)).text;assert.match(ready,/פתיחה מחדש/);assert.match(ready,/אישר מחדש בשיחת טלפון/);
   const done=await form('/admin/groups/'+g.id+'/reopen',{days:'10',confirm:'yes'});
   assert.match(done.location,/renewalNotice=reopened/);
   const history=(await api('/admin/audit?target='+g.id)).text;assert.match(history,/פתיחת קבוצה מחדש/);assert.match(history,/רישום אישור לקוח/);assert.match(history,/מוצגות פעולות של קבוצה אחת/);
   const all=(await api('/admin/api/audit?target='+g.id)).body;assert.ok(all.events.length>=2&&all.events.every((e:any)=>e.target===g.id),'only this group');
   assert.equal((await api('/admin/api/audit?target=not-a-uuid')).body.target,null,'an invalid filter is ignored');
   const unconfirmed=await form('/admin/groups/'+g.id+'/reopen',{days:'10'});assert.match(unconfirmed.location,/renewalError=/);
  });
 }finally{await f.close();}
});
