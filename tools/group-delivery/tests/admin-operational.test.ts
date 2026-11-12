// Operational delivery workflow: admin-only status layer, transition rules, completion as immutable history, and the
// area's next delivery cycle as a brand-new group created by the normal first join.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {adminFixture,AREA} from './admin-fixture.js';

test('Operational delivery workflow',{timeout:240000},async t=>{
 const f=await adminFixture();
 const logged:string[]=[];const originals={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const level of ['log','info','warn','error'] as const)console[level]=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
 try{
  const ids=await f.seed();
  const {cookie,csrf}=await f.login();
  const get=(path:string,c=cookie)=>fetch(f.cfg.origin+path,{redirect:'manual',headers:c?{Cookie:c}:{}});
  const json=async(path:string)=>{const r=await get(path);assert.equal(r.status,200,path);return r.json() as Promise<any>;};
  const api=(id:string,body:any,headers:Record<string,string>={Cookie:cookie,Origin:f.cfg.origin,'X-CSRF-Token':csrf})=>
   fetch(f.cfg.origin+'/admin/api/groups/'+id+'/operational-status',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const form=(id:string,body:Record<string,string>)=>fetch(f.cfg.origin+'/admin/groups/'+id+'/operational-status',{method:'POST',redirect:'manual',headers:{Cookie:cookie,Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...body})});
  const step=async(id:string,status:string,confirm?:boolean)=>{const r=await api(id,{status,...(confirm?{confirm:true}:{})});const body=await r.json() as any;assert.equal(r.status,200,status+' '+JSON.stringify(body));return body;};
  const deliver=async(id:string)=>{for(const status of ['IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY'])await step(id,status);return step(id,'COMPLETED',true);};
  const groupRow=async(id:string)=>(await f.db.query('SELECT * FROM delivery_groups WHERE public_id=$1',[id])).rows[0];
  const membersOf=async(id:string)=>(await f.db.query('SELECT m.* FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1 ORDER BY m.id',[id])).rows;
  const counts=async()=>(await f.db.query('SELECT (SELECT COUNT(*) FROM delivery_groups)::int AS groups,(SELECT COUNT(*) FROM group_members)::int AS members,(SELECT COUNT(*) FROM admin_audit)::int AS audit')).rows[0];
  const pub=async(id:string)=>(await(await get('/api/v1/groups/'+id,'')).json() as any).group;
  const metrics=async()=>(await json('/admin/api/dashboard')).dashboard;
  const start=await counts();

  await t.test('every group starts as NEW; the schema keeps COMPLETED and completed_at consistent',async()=>{
   const list=(await json('/admin/api/groups')).groups;
   assert.equal(list.length,5);assert.ok(list.every((g:any)=>g.operationalStatus==='NEW'&&g.completedAt===null&&g.completedBy===null));
   await assert.rejects(()=>f.db.query("UPDATE delivery_groups SET operational_status='COMPLETED' WHERE public_id=$1",[ids.approved]),'COMPLETED needs completed_at');
   await assert.rejects(()=>f.db.query("UPDATE delivery_groups SET operational_status='DONE' WHERE public_id=$1",[ids.approved]),'unknown status');
   assert.deepEqual((await metrics()).operational,{newDeliveries:1,inProgress:0,readyForDelivery:0,outForDelivery:0,completedToday:0,completed:0},'NEW deliveries = approved, not yet handled');
  });

  await t.test('admin session, CSRF, same Origin and valid values are required; nothing changes otherwise',async()=>{
   assert.equal((await api(ids.approved,{status:'IN_PROGRESS'},{Origin:f.cfg.origin})).status,401);
   const page=await fetch(f.cfg.origin+'/admin/groups/'+ids.approved+'/operational-status',{method:'POST',redirect:'manual',headers:{Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'status=IN_PROGRESS'});
   assert.equal(page.status,303);assert.equal(page.headers.get('location'),'/admin?expired=1');
   assert.equal((await api(ids.approved,{status:'IN_PROGRESS'},{Cookie:cookie,Origin:f.cfg.origin})).status,403,'no CSRF token');
   assert.equal((await api(ids.approved,{status:'IN_PROGRESS'},{Cookie:cookie,Origin:'https://evil.example','X-CSRF-Token':csrf})).status,403,'foreign Origin');
   for(const status of ['DONE','in_progress','',123,null,'COMPLETED;DROP']){
    const r=await api(ids.approved,{status});assert.equal(r.status,400,String(status));assert.equal((await r.json() as any).code,'INVALID_OPERATIONAL_STATUS');
   }
   const skip=await api(ids.approved,{status:'READY_FOR_DELIVERY'});assert.equal(skip.status,409);assert.equal((await skip.json() as any).code,'OPERATIONAL_TRANSITION_NOT_ALLOWED');
   const early=await api(ids.approved,{status:'COMPLETED',confirm:true});assert.equal(early.status,409,'COMPLETED only from OUT_FOR_DELIVERY');
   assert.equal((await api('00000000-0000-4000-8000-000000000000',{status:'IN_PROGRESS'})).status,404);
   assert.equal((await groupRow(ids.approved)).operational_status,'NEW');
   // The public API has no route for it.
   const publicTry=await fetch(f.cfg.origin+'/api/v1/groups/'+ids.approved+'/operational-status',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json'},body:'{"status":"COMPLETED","confirm":true}'});
   assert.equal(publicTry.status,404);
  });

  await t.test('transitions: forward one step, backward any step, same status is a no-op; business status untouched',async()=>{
   const first=await step(ids.approved,'IN_PROGRESS');
   assert.deepEqual([first.previous,first.status,first.changed,first.group.operationalStatus,first.group.status],['NEW','IN_PROGRESS',true,'IN_PROGRESS','APPROVED']);
   assert.deepEqual(first.group.operationalTargets,['NEW','READY_FOR_DELIVERY']);
   const viaForm=await form(ids.approved,{status:'READY_FOR_DELIVERY'});
   assert.equal(viaForm.headers.get('location'),'/admin/groups/'+ids.approved+'?notice=operational_updated');
   assert.equal((await step(ids.approved,'IN_PROGRESS')).previous,'READY_FOR_DELIVERY','back one step');
   await step(ids.approved,'READY_FOR_DELIVERY');await step(ids.approved,'OUT_FOR_DELIVERY');
   assert.equal((await step(ids.approved,'NEW')).previous,'OUT_FOR_DELIVERY','back several steps before completion');
   for(const status of ['IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY'])await step(ids.approved,status);
   const same=await step(ids.approved,'OUT_FOR_DELIVERY');assert.equal(same.changed,false);
   assert.equal((await form(ids.approved,{status:'OUT_FOR_DELIVERY'})).headers.get('location'),'/admin/groups/'+ids.approved+'?notice=operational_unchanged');
   assert.equal((await form(ids.approved,{status:'NOPE'})).headers.get('location'),'/admin/groups/'+ids.approved+'?error=INVALID_OPERATIONAL_STATUS');
   assert.equal((await pub(ids.approved)).status,'APPROVED','public status is the business status until completion');
   const timeline=(await json('/admin/api/groups/'+ids.approved+'/timeline')).timeline;
   assert.deepEqual(timeline.map((e:any)=>[e.previousStatus,e.newStatus]),[['NEW','IN_PROGRESS'],['IN_PROGRESS','READY_FOR_DELIVERY'],['READY_FOR_DELIVERY','IN_PROGRESS'],['IN_PROGRESS','READY_FOR_DELIVERY'],
    ['READY_FOR_DELIVERY','OUT_FOR_DELIVERY'],['OUT_FOR_DELIVERY','NEW'],['NEW','IN_PROGRESS'],['IN_PROGRESS','READY_FOR_DELIVERY'],['READY_FOR_DELIVERY','OUT_FOR_DELIVERY']]);
   assert.ok(timeline.every((e:any)=>/^session:[a-f0-9]{12}$/.test(e.actor)&&e.action==='group.operational_status_change'&&e.target===ids.approved&&e.at));
   assert.equal((await metrics()).operational.outForDelivery,1);
   const denied=(await f.db.query("SELECT * FROM admin_audit WHERE action='group.operational_status_change' AND result='DENIED'")).rows;
   assert.ok(denied.some((e:any)=>e.detail==='OPERATIONAL_TRANSITION_NOT_ALLOWED'&&e.new_status==='READY_FOR_DELIVERY'));
   assert.ok(denied.filter((e:any)=>e.detail==='INVALID_OPERATIONAL_STATUS').every((e:any)=>e.new_status===null),'invalid values are never stored');
  });

  await t.test('the group page shows the stepper, the allowed moves, the timeline and the completion dialog',async()=>{
   const html=await(await get('/admin/groups/'+ids.approved)).text();
   assert.match(html,/<li class="step step--current" aria-current="step"><span class="step__dot" aria-hidden="true"><\/span><span class="step__label">יצא למשלוח<\/span>/);
   assert.equal((html.match(/class="step step--done"/g)||[]).length,3);
   assert.match(html,/<select id="op-status" name="status"><option value="NEW">חדש \(חזרה\)<\/option><option value="IN_PROGRESS">בטיפול \(חזרה\)<\/option><option value="READY_FOR_DELIVERY">מוכן למשלוח \(חזרה\)<\/option><\/select>/);
   assert.match(html,/data-open-dialog="complete-dialog"[^>]*>השלמת המשלוח</);assert.doesNotMatch(html,/<dialog id="complete-dialog"[^>]* open>/);
   assert.match(html,/<h2 id="complete-dialog-title">השלמת המשלוח<\/h2>/);
   assert.match(html,/המשלוח הנוכחי ייסגר ויישמר בהיסטוריה\. לאחר מכן האזור יהיה מוכן לקבוצת משלוח חדשה\./);
   assert.match(html,/<dt>אזור<\/dt><dd>אשקלון<\/dd><\/div><div><dt>משתתפים פעילים<\/dt><dd>1<\/dd>/);assert.match(html,/סכום התחייבויות סופי<\/dt><dd><strong>[^<]*625\.00/);
   assert.match(html,new RegExp('<dt>מזהה קבוצה</dt><dd><code dir="ltr">'+ids.approved+'</code>'));
   assert.match(html,/autofocus data-dialog-cancel>ביטול<\/button><button type="submit" class="btn btn--primary" data-once data-complete-submit>סיום המשלוח<\/button>/);
   assert.match(html,/<h3 class="ops-history__title">היסטוריית שלבים<\/h3>/);assert.match(html,/חדש ← בטיפול/);
   assert.match(await(await get('/admin/groups/'+ids.approved+'?confirm=complete')).text(),/<dialog id="complete-dialog"[^>]* open>/,'no-JavaScript confirmation');
   // An open group warns that pledges can still change.
   assert.match(await(await get('/admin/groups/'+ids.ashdod)).text(),/הקבוצה עדיין פתוחה להתחייבויות/);
  });

  await t.test('completion needs explicit confirmation, keeps every row exactly, and is idempotent',async()=>{
   const before=await groupRow(ids.approved),members=await membersOf(ids.approved),audits=(await counts()).audit;
   const unconfirmed=await api(ids.approved,{status:'COMPLETED'});assert.equal(unconfirmed.status,400);assert.equal((await unconfirmed.json() as any).code,'COMPLETION_CONFIRMATION_REQUIRED');
   assert.equal((await form(ids.approved,{status:'COMPLETED'})).headers.get('location'),'/admin/groups/'+ids.approved+'?error=COMPLETION_CONFIRMATION_REQUIRED');
   assert.equal((await groupRow(ids.approved)).operational_status,'OUT_FOR_DELIVERY');
   const done=await form(ids.approved,{status:'COMPLETED',confirm:'yes'});
   assert.equal(done.headers.get('location'),'/admin/groups/'+ids.approved+'?notice=delivery_completed');
   const after=await groupRow(ids.approved);
   assert.equal(after.operational_status,'COMPLETED');assert.ok(after.completed_at);assert.match(after.completed_by,/^session:[a-f0-9]{12}$/);
   for(const key of ['id','public_id','area_id','area_name','threshold_agorot','pledged_total_agorot','status','created_at','expires_at'])assert.deepEqual(after[key],before[key],key);
   assert.deepEqual(await membersOf(ids.approved),members,'members, pledges, carts and receipts untouched');
   const completion=(await f.db.query("SELECT * FROM admin_audit WHERE action='group.complete' AND result='OK'")).rows;
   assert.deepEqual(completion.map((e:any)=>[e.target,e.previous_status,e.new_status,Number(e.amount_agorot)]),[[ids.approved,'OUT_FOR_DELIVERY','COMPLETED',62500]]);
   // Twice (API and form): no change, same completion time, no second completion event.
   const again=await step(ids.approved,'COMPLETED',true);assert.equal(again.changed,false);
   assert.equal((await form(ids.approved,{status:'COMPLETED',confirm:'yes'})).headers.get('location'),'/admin/groups/'+ids.approved+'?notice=operational_unchanged');
   assert.deepEqual((await groupRow(ids.approved)).completed_at,after.completed_at);
   assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM admin_audit WHERE action='group.complete' AND result='OK'")).rows[0].n,1);
   assert.ok((await counts()).audit>audits);
   // Terminal: the ordinary selector cannot reopen it.
   for(const status of ['OUT_FOR_DELIVERY','NEW']){
    const r=await api(ids.approved,{status});assert.equal(r.status,409);assert.equal((await r.json() as any).code,'OPERATIONAL_TRANSITION_NOT_ALLOWED');
   }
   assert.equal((await pub(ids.approved)).status,'COMPLETED','public aggregate reads COMPLETED');
   const html=await(await get('/admin/groups/'+ids.approved+'?notice=delivery_completed')).text();
   assert.match(html,/המשלוח הושלם ונשמר בהיסטוריה/);assert.match(html,/<div class="completed-summary"><strong>המשלוח הושלם ב־<time/);
   assert.doesNotMatch(html,/id="op-status"|data-open-dialog="complete-dialog"/,'no controls on a completed delivery');
   assert.match(html,/<dt>הושלם<\/dt><dd><time/);
   const m=await metrics();assert.equal(m.operational.completedToday,1);assert.equal(m.operational.outForDelivery,0);
  });

  await t.test('a completed area group is closed history; the next first join opens exactly one fresh group',async()=>{
   const oldId=ids.ashdod,oldMembers=await membersOf(oldId),activeBefore=(await metrics()).activeGroups;
   await deliver(oldId);
   assert.equal((await metrics()).activeGroups,activeBefore-1,'a completed delivery is not an active group');
   const oldGroup=await groupRow(oldId);assert.equal(oldGroup.status,'OPEN','business status is left as it was');
   // Public: not offered, not joinable, no pledge changes, no withdrawal; the old receipt still reads its own history.
   const find=await f.groups.find({areaPublicId:AREA.ashdod});assert.deepEqual([find.group,find.canCreateOnJoin],[null,true]);
   const line=[{variantId:'1',quantity:1}];
   await assert.rejects(()=>f.groups.join(oldId,{...f.person(),areaPublicId:AREA.ashdod,lines:line}),(e:any)=>e.code==='GROUP_CLOSED');
   await assert.rejects(()=>f.groups.update(oldId,ids.ashdodToken,{lines:line}),(e:any)=>e.code==='GROUP_CLOSED');
   await assert.rejects(()=>f.groups.withdraw(oldId,ids.ashdodToken,{confirm:true}),(e:any)=>e.code==='GROUP_CLOSED');
   await assert.rejects(()=>f.groups.adminWithdraw(oldId,oldMembers[0].id,{confirm:true}),(e:any)=>e.code==='GROUP_CLOSED');
   assert.equal((await f.groups.memberState(oldId,ids.ashdodToken)).member.status,'PLEDGED','the receipt still shows its own (historical) pledge');
   const http=await fetch(f.cfg.origin+'/api/v1/groups/'+oldId+'/join',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json'},body:JSON.stringify({...f.person(),areaPublicId:AREA.ashdod,lines:line})});
   assert.equal(http.status,409);assert.equal((await http.json() as any).code,'GROUP_CLOSED');
   // Expiry never rewrites a completed group.
   await f.db.query("UPDATE delivery_groups SET expires_at=NOW()-INTERVAL '1 minute' WHERE public_id=$1",[oldId]);await f.groups.expire();
   assert.equal((await groupRow(oldId)).status,'OPEN');
   // Two concurrent first joins: one new group, both inside it.
   const a=f.person(),b=f.person();
   const [first,second]=await Promise.all([f.groups.joinArea({...a,areaPublicId:AREA.ashdod,lines:line}),f.groups.joinArea({...b,areaPublicId:AREA.ashdod,lines:line})]);
   assert.equal(first.group.publicId,second.group.publicId,'one fresh group');assert.notEqual(first.group.publicId,oldId);
   assert.deepEqual([first.created,second.created].sort(),[false,true]);
   const fresh=await groupRow(first.group.publicId);
   assert.deepEqual([fresh.operational_status,fresh.completed_at,Number(fresh.threshold_agorot),fresh.area_id],['NEW',null,50000,oldGroup.area_id]);
   assert.ok(new Date(fresh.created_at)>=new Date(oldGroup.completed_at));
   assert.equal(second.group.pledgedTotalAgorot,12500*2,'starts from zero: only the two new pledges');assert.equal(second.group.participantCount,2);
   assert.deepEqual((await membersOf(first.group.publicId)).map((m:any)=>m.email).sort(),[a.email,b.email].sort(),'no member copied');
   assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM delivery_groups WHERE area_id=$1 AND operational_status<>'COMPLETED' AND status IN ('OPEN','THRESHOLD_REACHED')",[oldGroup.area_id])).rows[0].n,1);
   // An old receipt never reaches the new group; the old customer joins the new cycle like anyone else.
   await assert.rejects(()=>f.groups.update(first.group.publicId,ids.ashdodToken,{lines:line}),(e:any)=>e.code==='MEMBER_AUTH_REQUIRED');
   await assert.rejects(()=>f.groups.memberState(first.group.publicId,ids.ashdodToken),(e:any)=>e.code==='MEMBER_AUTH_REQUIRED');
   const dana=await f.groups.joinArea({email:'dana@example.test',phone:'050-1234567',areaPublicId:AREA.ashdod,lines:line});
   assert.equal(dana.group.publicId,first.group.publicId);assert.notEqual(dana.memberToken,ids.ashdodToken);
   assert.deepEqual(await membersOf(oldId),oldMembers,'the completed group is unchanged by the new cycle');
   const found=await f.groups.find({areaPublicId:AREA.ashdod});assert.equal(found.group?.publicId,first.group.publicId);
  });

  await t.test('an inactive area stays inactive after completion; legacy groups complete without a replacement',async()=>{
   await f.db.query('UPDATE delivery_areas SET active=false WHERE public_id=$1',[AREA.beerSheva]);
   await deliver(ids.reached);
   assert.equal((await f.db.query('SELECT active FROM delivery_areas WHERE public_id=$1',[AREA.beerSheva])).rows[0].active,false);
   await assert.rejects(()=>f.groups.find({areaPublicId:AREA.beerSheva}),(e:any)=>e.code==='INVALID_AREA');
   const r=await fetch(f.cfg.origin+'/admin/api/groups/'+ids.reached+'/approve',{method:'POST',headers:{Cookie:cookie,Origin:f.cfg.origin,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:'{}'});
   assert.equal(r.status,409,'a completed group is never approved');assert.equal((await groupRow(ids.reached)).status,'THRESHOLD_REACHED');
   assert.doesNotMatch(await(await get('/admin/groups/'+ids.reached)).text(),/אישור הקבוצה<\/button>/);
   // Legacy (no area): completion works, the dialog says no replacement opens, nothing new is created.
   for(const status of ['IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY'])await step(ids.legacy,status);
   assert.match(await(await get('/admin/groups/'+ids.legacy)).text(),/לקבוצה זו אין אזור מוגדר, ולכן לא תיפתח במקומה קבוצה חדשה\./);
   const groupsBefore=(await counts()).groups;
   assert.equal((await step(ids.legacy,'COMPLETED',true)).status,'COMPLETED');
   assert.equal((await counts()).groups,groupsBefore,'no group is created by completion');
   assert.equal((await pub(ids.legacy)).status,'COMPLETED');
  });

  await t.test('admin history: views, operational filter, search and sorting include completed groups',async()=>{
   const idsOf=async(q:string)=>(await json('/admin/api/groups?'+q)).groups.map((g:any)=>g.publicId).sort();
   assert.deepEqual(await idsOf('view=completed'),[ids.approved,ids.ashdod,ids.reached,ids.legacy].sort());
   assert.ok(!(await idsOf('view=current')).some((id:string)=>[ids.approved,ids.ashdod,ids.reached,ids.legacy].includes(id)));
   assert.equal((await idsOf('view=current')).length,2,'the expired group and the fresh Ashdod group');
   assert.deepEqual(await idsOf('view=awaiting'),[]);
   await step(ids.expired,'IN_PROGRESS');await step(ids.expired,'READY_FOR_DELIVERY');
   assert.deepEqual(await idsOf('view=awaiting'),[ids.expired]);assert.deepEqual(await idsOf('op=READY_FOR_DELIVERY'),[ids.expired]);
   assert.equal((await idsOf('q=dana%40')).length,2,'search finds the completed and the current cycle');
   assert.equal((await idsOf('state=active')).length,1,'only the fresh group accepts pledges');
   assert.equal((await get('/admin/api/groups?sort=operational&dir=asc')).status,200);
   for(const bad of ['op=DONE','view=archive'])assert.equal((await get('/admin/api/groups?'+bad)).status,400,bad);
   const html=await(await get('/admin?view=completed')).text();
   assert.match(html,/<a class="segmented__item" href="[^"]*view=completed[^"]*" aria-current="true">הושלמו<\/a>/);
   assert.match(html,/<span class="chip chip--op chip--op-completed">הושלם<\/span><span class="cell-note"><time/);
   const dash=await metrics();
   assert.deepEqual(dash.operational,{newDeliveries:0,inProgress:0,readyForDelivery:1,outForDelivery:0,completedToday:4,completed:4});
  });

  await t.test('audit page explains transitions and completion',async()=>{
   const html=await(await get('/admin/audit')).text();
   assert.match(html,/השלמת משלוח<span class="audit__desc">יצא למשלוח ← הושלם\. סכום סופי [^<]*625\.00/);
   assert.match(html,/שינוי סטטוס משלוח<span class="audit__desc">חדש ← בטיפול<\/span>/);
   assert.match(html,/שינוי סטטוס משלוח<span class="audit__desc">הבקשה לא בוצעה; שלב המשלוח לא שונה\./);
   const dump=JSON.stringify((await f.db.query('SELECT * FROM admin_audit')).rows);
   for(const secret of ['@example.test','+972',csrf,cookie.split('=')[1],ids.ashdodToken])assert.ok(!dump.includes(secret),'audit leaks '+secret.slice(0,6));
  });

  await t.test('no destructive reset: rows only accumulate, ids never change, nothing is moved or cleared',async()=>{
   const end=await counts();
   assert.ok(end.groups>=start.groups&&end.members>=start.members&&end.audit>start.audit);
   for(const id of [ids.approved,ids.ashdod,ids.reached,ids.legacy])assert.ok(await groupRow(id),'completed group still exists: '+id);
   assert.equal(Number((await groupRow(ids.ashdod)).pledged_total_agorot),37500,'historical totals are not zeroed');
   const dir=new URL('../src/',import.meta.url);
   for(const name of await readdir(dir))if(name.endsWith('.ts')){
    const source=await readFile(new URL(name,dir),'utf8');
    assert.doesNotMatch(source,/DELETE\s+FROM\s+(delivery_groups|group_members|admin_audit)|TRUNCATE[^;]*(delivery_groups|group_members|admin_audit)/i,name+': delete');
    assert.doesNotMatch(source,/UPDATE\s+group_members\s+SET[^;"'`]*\bgroup_id\s*=/i,name+': members moved to another group');
    assert.doesNotMatch(source,/UPDATE\s+delivery_groups\s+SET[^;"'`]*\bpublic_id\s*=/i,name+': public id rewritten');
   }
  });

  await t.test('nothing sensitive is logged',async()=>{
   const text=logged.join('\n');
   for(const secret of ['@example.test','+972',ids.ashdodToken,csrf,cookie.split('=')[1]])assert.ok(!text.includes(secret),'logged '+secret.slice(0,6));
  });
 }finally{
  Object.assign(console,originals);
  await f.close();
 }
});
