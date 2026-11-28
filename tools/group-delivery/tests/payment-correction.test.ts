// Correcting a mistaken external payment record (src/orders.ts): the original is voided, never erased (when, which
// admin session, why); a correction is a new record naming the one it replaces; the order stays locked to the customer
// until the owner reconciles it (a new record, or an explicit release, never for a delivered order or completed
// cycle). Never a refund, a Shopify or Cardcom change, or an online payment state. Synthetic data, in-process PGlite.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {adminFixture} from './admin-fixture.js';
import {Orders} from '../src/orders.js';

const AREA={ashkelon:'6f1a2c00-0003-4a00-8000-0000000000a3',netivot:'6f1a2c00-0005-4a00-8000-0000000000a5',sderot:'6f1a2c00-0007-4a00-8000-0000000000a7'};
const ADMIN='session:dddddddddddd';

test('External payment correction',{timeout:240000},async t=>{
 const f=await adminFixture();
 try{
  Object.assign(f.shopify.prices,{'12':'127.30','13':'98.60'});
  const orders=new Orders(f.db,f.groups,(f.groups as any).shopify);
  const {cookie,csrf}=await f.login();
  const form=async(path:string,fields:Record<string,string>,auth=true)=>{
   const r=await fetch(f.cfg.origin+path,{method:'POST',redirect:'manual',headers:{...(auth?{Cookie:cookie}:{}),Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...fields})});
   return {status:r.status,location:r.headers.get('location')||''};
  };
  const one=async(sql:string,v:any[]=[])=>(await f.db.query(sql,v)).rows[0];
  const all=async(sql:string,v:any[]=[])=>(await f.db.query(sql,v)).rows;
  const paid=async(area:string)=>{
   const x=f.person();const j=await f.groups.joinArea({...x,areaPublicId:area,lines:[{variantId:'12',quantity:1}]});const id=j.group.publicId;
   const gid=(await one('SELECT id FROM delivery_groups WHERE public_id=$1',[id])).id,mid=(await one('SELECT id FROM group_members WHERE group_id=$1',[gid])).id;
   await orders.attestPayment(id,mid,{attest:true,amountAgorot:12730,method:'CASH',receivedOn:'2026-11-20',reference:'קבלה 1'},ADMIN);
   return {id,gid,mid,token:j.memberToken};
  };
  const records=(mid:string)=>all('SELECT id,amount_agorot,method,to_char(received_on,$2) AS day,voided_at IS NOT NULL AS voided,voided_by,void_reason,replaces_id FROM member_payment_records WHERE member_id=$1 ORDER BY recorded_at,id',[mid,'YYYY-MM-DD']);

  await t.test('correction: the original is kept as voided (who, why), the new record names it; the order stays locked',async()=>{
   const s=await paid(AREA.ashkelon);
   const base={attest:true,reason:'שיטת תשלום שגויה'};
   await assert.rejects(()=>orders.correctPayment(s.id,s.mid,{...base,attest:false},ADMIN),(e:any)=>e.code==='INVALID_PAYMENT_RECORD','explicit attestation');
   for(const reason of ['','ab','dana@example.test','x'.repeat(61),'050-1234567'])
    await assert.rejects(()=>orders.correctPayment(s.id,s.mid,{...base,reason},ADMIN),(e:any)=>e.code==='INVALID_PAYMENT_RECORD',reason);
   await assert.rejects(()=>orders.correctPayment(s.id,s.mid,{...base,replacement:{amountAgorot:12000,method:'BIT',receivedOn:'2026-11-21'}},ADMIN),(e:any)=>e.code==='INVALID_PAYMENT_RECORD','exact amount');
   assert.equal((await records(s.mid)).length,1,'refusals write nothing');
   const out=await orders.correctPayment(s.id,s.mid,{...base,replacement:{amountAgorot:12730,method:'BIT',receivedOn:'2026-11-21',reference:'ביט 77'}},ADMIN);
   assert.deepEqual(out,{memberId:s.mid,voided:true,corrected:true,locked:true});
   const r=await records(s.mid);
   assert.equal(r.length,2,'nothing erased');
   assert.deepEqual([r[0].voided,r[0].voided_by,r[0].void_reason,r[0].method,r[0].day],[true,ADMIN,'שיטת תשלום שגויה','CASH','2026-11-20'],'original kept as it was, plus the void');
   assert.deepEqual([r[1].voided,r[1].replaces_id,r[1].method,r[1].day,Number(r[1].amount_agorot)],[false,r[0].id,'BIT','2026-11-21',12730]);
   assert.equal((await one('SELECT order_state FROM group_members WHERE id=$1',[s.mid])).order_state,'LOCKED');
   await assert.rejects(()=>f.groups.update(s.id,s.token,{lines:[{variantId:'13',quantity:1}]}),(e:any)=>e.code==='ORDER_LOCKED');
   const audit=(await all("SELECT action,detail,actor,amount_agorot FROM admin_audit WHERE subject=$1 AND result='OK' ORDER BY at,id",[s.mid])).map((a:any)=>[a.action,a.detail,a.actor]);
   assert.deepEqual(audit,[['member.payment_attest','CASH',ADMIN],['member.payment_void','CORRECTED',ADMIN],['member.payment_attest','BIT',ADMIN]]);
   const history=await orders.history(s.mid);
   assert.deepEqual(history.payments.map(p=>[p.voided,p.voidReason,p.correction]),[[true,'שיטת תשלום שגויה',false],[false,null,true]]);
  });

  await t.test('void without a replacement: still locked; an explicit release only for an undelivered order in an open cycle',async()=>{
   const s=await paid(AREA.netivot);
   await assert.rejects(()=>orders.releaseOrder(s.id,s.mid,{attest:true,reason:'לא שולם בפועל'},ADMIN),(e:any)=>e.code==='RELEASE_NOT_ALLOWED','an active record blocks release');
   assert.deepEqual(await orders.correctPayment(s.id,s.mid,{attest:true,reason:'נרשם בטעות'},ADMIN),{memberId:s.mid,voided:true,corrected:false,locked:true});
   await assert.rejects(()=>orders.correctPayment(s.id,s.mid,{attest:true,reason:'שוב'},ADMIN),(e:any)=>e.code==='NO_PAYMENT_RECORD','nothing left to void');
   // Protected until reconciled: the customer still cannot edit or withdraw it.
   await assert.rejects(()=>f.groups.update(s.id,s.token,{lines:[{variantId:'13',quantity:1}]}),(e:any)=>e.code==='ORDER_LOCKED');
   await assert.rejects(()=>f.groups.withdraw(s.id,s.token,{confirm:true}),(e:any)=>e.code==='ORDER_LOCKED');
   await assert.rejects(()=>orders.releaseOrder(s.id,s.mid,{attest:true,reason:'x'},ADMIN),(e:any)=>e.code==='INVALID_PAYMENT_RECORD','a reason is required');
   assert.deepEqual(await orders.releaseOrder(s.id,s.mid,{attest:true,reason:'לא שולם בפועל'},ADMIN),{memberId:s.mid,released:true});
   const m=await one('SELECT order_state,locked_at,locked_reason,pledged_total_agorot FROM group_members WHERE id=$1',[s.mid]);
   assert.deepEqual([m.order_state,m.locked_at,m.locked_reason,Number(m.pledged_total_agorot)],['OPEN',null,null,12730]);
   await f.groups.update(s.id,s.token,{lines:[{variantId:'13',quantity:1}]});
   assert.equal((await records(s.mid)).length,1,'the voided record is still there');
   assert.equal((await one("SELECT count(*)::int AS n FROM admin_audit WHERE action='member.order_release' AND subject=$1 AND actor=$2",[s.mid,ADMIN])).n,1);
   // Never for a delivered order or a completed cycle.
   const d=await paid(AREA.sderot);
   await orders.correctPayment(d.id,d.mid,{attest:true,reason:'נרשם בטעות'},ADMIN);
   await f.db.query("UPDATE group_members SET locked_reason='DELIVERED' WHERE id=$1",[d.mid]);
   await assert.rejects(()=>orders.releaseOrder(d.id,d.mid,{attest:true,reason:'לא שולם בפועל'},ADMIN),(e:any)=>e.code==='RELEASE_NOT_ALLOWED','delivered');
   await f.db.query("UPDATE group_members SET locked_reason='PAID_EXTERNAL' WHERE id=$1",[d.mid]);
   await f.db.query("UPDATE delivery_groups SET operational_status='COMPLETED',completed_at=NOW(),completed_by=$2 WHERE id=$1",[d.gid,ADMIN]);
   await assert.rejects(()=>orders.releaseOrder(d.id,d.mid,{attest:true,reason:'לא שולם בפועל'},ADMIN),(e:any)=>e.code==='RELEASE_NOT_ALLOWED','completed cycle');
  });

  await t.test('owner only, through the forms; concurrent voids act once; nothing touches charges or online payment fields',async()=>{
   const s=await paid('6f1a2c00-0004-4a00-8000-0000000000a4');
   const path='/admin/groups/'+s.id+'/members/'+s.mid+'/external-payment/correct';
   assert.ok([401,403,303].includes((await form(path,{reason:'נרשם בטעות',attest:'yes'},false)).status),'no session');
   assert.ok([401,403,303].includes((await form('/admin/groups/'+s.id+'/members/'+s.mid+'/release',{reason:'לא שולם בפועל',attest:'yes'},false)).status));
   const api=await fetch(f.cfg.origin+'/admin/api/groups/'+s.id+'/members/'+s.mid+'/external-payment/correct',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json'},body:'{}'});
   assert.equal(api.status,401);
   assert.match((await form(path,{reason:'נרשם בטעות'})).location,/orderError=INVALID_PAYMENT_RECORD/,'attestation required');
   assert.match((await form(path,{reason:'סכום שגוי',attest:'yes',new_amount:'127.30',new_method:'BANK_TRANSFER',new_receivedOn:'2026-11-22'})).location,/orderNotice=payment_corrected/);
   const page=await (await fetch(f.cfg.origin+'/admin/groups/'+s.id,{headers:{Cookie:cookie}})).text();
   assert.ok(page.includes('רישומים קודמים בוטלו ונשמרו'));assert.ok(page.includes('תיקון או ביטול הרישום'));
   const both=await Promise.allSettled([1,2].map(()=>orders.correctPayment(s.id,s.mid,{attest:true,reason:'נרשם בטעות'},ADMIN)));
   assert.deepEqual(both.map(b=>b.status==='fulfilled'?'ok':(b.reason as any).code).sort(),['NO_PAYMENT_RECORD','ok']);
   assert.equal((await records(s.mid)).length,2,'one original, one correction, both kept');
   assert.deepEqual([(await one('SELECT count(*)::int AS n FROM group_payment_charges')).n,(await one('SELECT count(*)::int AS n FROM group_members WHERE payment_status IS NOT NULL')).n,
    Number((await one('SELECT paid_total_agorot FROM delivery_groups WHERE id=$1',[s.gid])).paid_total_agorot)],[0,0,0]);
   await assert.rejects(()=>f.db.query("UPDATE member_payment_records SET voided_at=NOW() WHERE voided_at IS NULL"),'a void always records who and why');
  });
 }finally{await f.close();}
});
