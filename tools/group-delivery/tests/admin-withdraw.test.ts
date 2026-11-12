// Store-owner removal of a customer from a group: same domain withdrawal as the customer's own, row kept, totals
// recalculated from active pledges, last cart kept as history, audited with safe metadata, idempotent. Only the receipt
// brings a withdrawn member back (no email + phone recovery yet); capacity counts active members only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {adminFixture,AREA} from './admin-fixture.js';

test('Admin removal of a customer from a group',{timeout:180000},async t=>{
 const f=await adminFixture();
 const logged:string[]=[];const originals={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const level of ['log','info','warn','error'] as const)console[level]=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
 try{
  // Ashdod: ₪390 + ₪80 = ₪470 of ₪500 (the brief's example). Beer Sheva: ₪450 + ₪80 = ₪530, target reached.
  // Ashkelon: approved (closed). Prices come from the mocked Storefront API per variant.
  Object.assign(f.shopify.prices,{'10':'390.00','11':'80.00','12':'450.00','13':'600.00'});
  const join=(area:string,variantId:string,who:{email:string;phone:string})=>f.groups.joinArea({...who,areaPublicId:area,lines:[{variantId,quantity:1}]});
  const alice={email:'alice@example.test',phone:'0501111111'},bob={email:'bob@example.test',phone:'0502222222'};
  const dina={email:'dina@example.test',phone:'0503333333'},eli={email:'eli@example.test',phone:'0504444444'},fay={email:'fay@example.test',phone:'0505555555'};
  const a=await join(AREA.ashdod,'10',alice),b=await join(AREA.ashdod,'11',bob);
  const g=a.group.publicId;assert.equal(b.group.publicId,g);assert.equal(b.group.pledgedTotalAgorot,47000);
  const d=await join(AREA.beerSheva,'12',dina),e=await join(AREA.beerSheva,'11',eli);
  const h=d.group.publicId;assert.equal(e.group.status,'THRESHOLD_REACHED');
  const closed=(await join(AREA.ashkelon,'13',fay)).group.publicId;await f.groups.approve(closed);
  const row=async(email:string)=>(await f.db.query('SELECT * FROM group_members WHERE email=$1',[email])).rows[0];
  const ids={alice:(await row(alice.email)).id,bob:(await row(bob.email)).id,dina:(await row(dina.email)).id,eli:(await row(eli.email)).id,fay:(await row(fay.email)).id};
  const memberCount=async()=>(await f.db.query('SELECT COUNT(*)::int AS n FROM group_members')).rows[0].n;
  const rowsAtStart=await memberCount();

  const {cookie,csrf}=await f.login();
  const get=(path:string,c=cookie)=>fetch(f.cfg.origin+path,{redirect:'manual',headers:c?{Cookie:c}:{}});
  const json=async(path:string)=>{const r=await get(path);assert.equal(r.status,200,path);return r.json() as Promise<any>;};
  const api=(group:string,member:string,body:any,headers:Record<string,string>={Cookie:cookie,Origin:f.cfg.origin,'X-CSRF-Token':csrf})=>
   fetch(f.cfg.origin+'/admin/api/groups/'+group+'/members/'+member+'/withdraw',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const form=(group:string,member:string,body:Record<string,string>,headers:Record<string,string>={Cookie:cookie,Origin:f.cfg.origin})=>
   fetch(f.cfg.origin+'/admin/groups/'+group+'/members/'+member+'/withdraw',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(body)});
  const publicGroup=async(id:string)=>(await(await get('/api/v1/groups/'+id,'')).json() as any).group;

  await t.test('rejected without an admin session, CSRF token, same Origin or explicit confirmation; nothing changes',async()=>{
   assert.equal((await api(g,ids.bob,{confirm:true},{Origin:f.cfg.origin})).status,401,'no session');
   const noSession=await form(g,ids.bob,{confirm:'yes'},{Origin:f.cfg.origin});
   assert.equal(noSession.status,303);assert.equal(noSession.headers.get('location'),'/admin?expired=1');
   assert.equal((await api(g,ids.bob,{confirm:true},{Cookie:cookie,Origin:f.cfg.origin})).status,403,'no CSRF token');
   assert.equal((await api(g,ids.bob,{confirm:true},{Cookie:cookie,Origin:'https://evil.example','X-CSRF-Token':csrf})).status,403,'foreign Origin');
   const badForm=await form(g,ids.bob,{csrf:'wrong',confirm:'yes'});
   assert.equal(badForm.status,403);assert.match(badForm.headers.get('content-type')!,/text\/html/,'friendly HTML page for a form');
   for(const body of [{},{confirm:'true'},{confirm:1},{confirm:'yes'}]){
    const r=await api(g,ids.bob,body);assert.equal(r.status,400,JSON.stringify(body));assert.equal((await r.json() as any).code,'WITHDRAW_CONFIRMATION_REQUIRED');
   }
   const unconfirmed=await form(g,ids.bob,{csrf});
   assert.equal(unconfirmed.headers.get('location'),'/admin/groups/'+g+'/members/'+ids.bob+'?error=WITHDRAW_CONFIRMATION_REQUIRED');
   assert.equal((await row(bob.email)).status,'PLEDGED');assert.equal((await publicGroup(g)).pledgedTotalAgorot,47000);
   // The public API gains no admin capability: no member-id withdrawal there, and the receipt route still needs the token.
   for(const path of ['/api/v1/groups/'+g+'/members/'+ids.bob+'/withdraw','/api/v1/admin/groups/'+g+'/members/'+ids.bob+'/withdraw']){
    const r=await fetch(f.cfg.origin+path,{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:'{"confirm":true}'});
    assert.equal(r.status,404,path);
   }
   const receiptless=await fetch(f.cfg.origin+'/api/v1/groups/'+g+'/withdraw',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf},body:'{"confirm":true}'});
   assert.equal(receiptless.status,401,'an admin cookie is not a member receipt');
   assert.equal((await row(bob.email)).status,'PLEDGED');
  });

  await t.test('the member page offers the removal with a confirmation that names the customer, pledge and group',async()=>{
   const page=await(await get('/admin/groups/'+g+'/members/'+ids.bob)).text();
   assert.match(page,/data-open-dialog="withdraw-dialog"[^>]*>הסר מהמשלוח הקבוצתי</);
   assert.match(page,/<dialog id="withdraw-dialog"[^>]*aria-labelledby="withdraw-dialog-title"[^>]*>/);assert.doesNotMatch(page,/<dialog[^>]* open>/,'closed until asked');
   assert.match(page,/הסרת לקוח מהמשלוח הקבוצתי/);assert.match(page,/הלקוח יוסר מהקבוצה וההתחייבות שלו בסך .*80\.00.* תוסר מהסכום הכולל\./);
   assert.match(page,/הפעולה תישמר ביומן הפעולות\./);assert.match(page,/bob@example\.test/);assert.match(page,/\+972502222222/);assert.match(page,/אשדוד · <code dir="ltr">/);
   // Cancel first, with autofocus; the destructive button second.
   assert.match(page,/<button type="submit" formmethod="dialog" formnovalidate class="btn btn--quiet" autofocus data-dialog-cancel>ביטול<\/button><button type="submit" class="btn btn--danger" data-withdraw-submit>הסר מהקבוצה<\/button>/);
   assert.match(page,/action="\/admin\/groups\/[^"]+\/members\/[^"]+\/withdraw"/);assert.match(page,/name="confirm" value="yes"/);
   // Without JavaScript the trigger link renders the same confirmation in place.
   assert.match(await(await get('/admin/groups/'+g+'/members/'+ids.bob+'?confirm=withdraw')).text(),/<dialog id="withdraw-dialog"[^>]* open>/);
   // Not offered for a closed group.
   const approved=await(await get('/admin/groups/'+closed+'/members/'+ids.fay)).text();
   assert.doesNotMatch(approved,/data-open-dialog/);assert.match(approved,/הקבוצה אינה פעילה \(אושרה\), ולכן לא ניתן להסיר ממנה לקוחות\./);
  });

  await t.test('removal withdraws the member through the domain: row kept, pledge zero, totals and counts recalculated',async()=>{
   const before=await row(bob.email),alicesRow=await row(alice.email),dashboardBefore=(await json('/admin/api/dashboard')).dashboard;
   const r=await form(g,ids.bob,{csrf,confirm:'yes'});
   assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/admin/groups/'+g+'?notice=member_withdrawn');
   const after=await row(bob.email);
   assert.deepEqual([after.status,Number(after.pledged_total_agorot),after.withdrawn_by],['WITHDRAWN',0,'ADMIN']);
   assert.deepEqual(after.cart_snapshot,before.cart_snapshot,'the last cart is kept as history');assert.equal(after.cart_snapshot.length,1);
   assert.ok(after.withdrawn_at instanceof Date||typeof after.withdrawn_at==='string','removal time recorded');
   assert.deepEqual([after.id,after.email,after.phone,after.token_hash,String(new Date(after.created_at))],[before.id,before.email,before.phone,before.token_hash,String(new Date(before.created_at))],'same row, contact and receipt kept');
   assert.deepEqual(await row(alice.email),alicesRow,'another member is untouched');
   assert.equal(await memberCount(),rowsAtStart,'nothing deleted');
   // ₪470 − ₪80 = ₪390; one active member; 78% of ₪500. Public aggregate, admin group and dashboard agree.
   const pub=await publicGroup(g);
   assert.deepEqual([pub.pledgedTotalAgorot,pub.participantCount,pub.progressPercent,pub.remainingAmountAgorot,pub.status],[39000,1,78,11000,'OPEN']);
   const admin=(await json('/admin/api/groups/'+g)).group;
   assert.deepEqual([admin.pledgedTotalAgorot,admin.activeMembers,admin.totalMembers,admin.withdrawnMembers,admin.progressPercent],[39000,1,2,1,78]);
   const dashboard=(await json('/admin/api/dashboard')).dashboard;
   assert.deepEqual([dashboard.activeCustomers,dashboard.activePledges,dashboard.activePledgedAgorot],[dashboardBefore.activeCustomers-1,dashboardBefore.activePledges-1,dashboardBefore.activePledgedAgorot-8000]);
   // The group page shows the outcome straight away.
   const page=await(await get('/admin/groups/'+g+'?notice=member_withdrawn')).text();
   assert.match(page,/הלקוח הוסר מהמשלוח הקבוצתי\./);assert.match(page,/aria-valuenow="78"/);assert.match(page,/<dd>1 · 1 הוסרו מהקבוצה<\/dd>/);
   assert.match(page,/class="row--withdrawn"[\s\S]*?<span class="chip chip--removed">הוסר על ידי מנהל<\/span>/);
   const member=await(await get('/admin/groups/'+g+'/members/'+ids.bob)).text();
   assert.match(member,/chip--removed">הוסר על ידי מנהל/);assert.match(member,/<dt>מועד היציאה<\/dt><dd><time/);
   // The kept cart is shown as history only, with its historical total; the active pledge is ₪0.
   assert.match(member,/<h2 id="cart-title">הסל האחרון לפני ההסרה<\/h2>/);assert.match(member,/תיעוד היסטורי בלבד/);
   assert.match(member,/מחיר יחידה \(היסטורי\)/);assert.match(member,/סכום הסל לפני ההסרה \(היסטורי\)<\/th><td class="num" colspan="2"><strong>[^<]*80\.00/);
   const detail=(await json('/admin/api/groups/'+g+'/members/'+ids.bob)).member;
   assert.deepEqual([detail.snapshotKind,detail.historicalLines,detail.cartLines,detail.pledgedTotalAgorot,detail.snapshotTotalAgorot],['HISTORICAL',1,0,0,8000]);assert.doesNotMatch(member,/data-open-dialog/,'no second removal offered');
  });

  await t.test('history stays visible: the withdrawn filter, the default list and the export include the record',async()=>{
   assert.deepEqual((await json('/admin/api/groups/'+g+'/members')).members.map((m:any)=>[m.email,m.status,m.withdrawnBy]),[[alice.email,'PLEDGED',null],[bob.email,'WITHDRAWN','ADMIN']]);
   assert.deepEqual((await json('/admin/api/groups/'+g+'/members?memberStatus=WITHDRAWN')).members.map((m:any)=>m.email),[bob.email]);
   assert.deepEqual((await json('/admin/api/groups/'+g+'/members?memberStatus=PLEDGED')).members.map((m:any)=>m.email),[alice.email]);
   const page=await(await get('/admin/groups/'+g)).text();
   for(const label of ['הכול','פעילים','הוסרו מהקבוצה'])assert.match(page,new RegExp('class="segmented__item"[^>]*>'+label+'</a>'));
   const exported=new TextDecoder().decode(new Uint8Array(await(await get('/admin/groups/'+g+'/export.csv')).arrayBuffer()));
   assert.match(exported,/"bob@example\.test","'\+972502222222","WITHDRAWN","0\.00"/);
  });

  await t.test('a removal below the target clears "target reached" through the same recalculation',async()=>{
   const r=await api(h,ids.eli,{confirm:true});assert.equal(r.status,200);
   const body=await r.json() as any;
   assert.deepEqual([body.changed,body.previous,body.member],[true,{status:'PLEDGED',pledgedTotalAgorot:8000},{status:'WITHDRAWN',pledgedTotalAgorot:0}]);
   assert.deepEqual([body.group.status,body.group.pledgedTotalAgorot,body.group.participantCount,body.group.progressPercent],['OPEN',45000,1,90]);
   assert.ok(!JSON.stringify(body).includes('@example.test'),'no contact details or token in the response');
   assert.equal((await json('/admin/api/groups/'+h)).group.status,'OPEN');
  });

  await t.test('a second removal is a safe no-op; closed groups and unrelated or unknown members are refused unchanged',async()=>{
   const snapshot=JSON.stringify((await f.db.query('SELECT * FROM group_members ORDER BY id')).rows);
   const groupsBefore=JSON.stringify((await f.db.query('SELECT public_id,status,pledged_total_agorot FROM delivery_groups ORDER BY public_id')).rows);
   const again=await api(g,ids.bob,{confirm:true});assert.equal(again.status,200);
   const body=await again.json() as any;assert.equal(body.changed,false);assert.equal(body.group.pledgedTotalAgorot,39000);
   assert.equal((await form(g,ids.bob,{csrf,confirm:'yes'})).headers.get('location'),'/admin/groups/'+g+'?notice=member_already_withdrawn');
   assert.match(await(await get('/admin/groups/'+g+'?notice=member_already_withdrawn')).text(),/הלקוח כבר הוסר מהקבוצה קודם לכן\. לא בוצע שינוי\./);
   const refusedClosed=await api(closed,ids.fay,{confirm:true});assert.equal(refusedClosed.status,409);assert.equal((await refusedClosed.json() as any).code,'GROUP_CLOSED');
   assert.equal((await form(closed,ids.fay,{csrf,confirm:'yes'})).headers.get('location'),'/admin/groups/'+closed+'/members/'+ids.fay+'?error=GROUP_CLOSED');
   assert.match(await(await get('/admin/groups/'+closed+'/members/'+ids.fay+'?error=GROUP_CLOSED')).text(),/לא ניתן להסיר לקוח מקבוצה שאינה פעילה\. לא בוצע שינוי\./);
   // A member id from another group, an unknown id and a malformed id never touch anyone.
   for(const [group,member] of [[g,ids.dina],[g,'00000000-0000-4000-8000-000000000000'],[g,'not-a-member'],['00000000-0000-4000-8000-000000000000',ids.alice]]){
    const r=await api(group,member,{confirm:true});assert.equal(r.status,404,group+' '+member);
   }
   assert.equal(JSON.stringify((await f.db.query('SELECT * FROM group_members ORDER BY id')).rows),snapshot,'no member row changed');
   assert.equal(JSON.stringify((await f.db.query('SELECT public_id,status,pledged_total_agorot FROM delivery_groups ORDER BY public_id')).rows),groupsBefore,'no group changed (the approved group stays approved)');
  });

  await t.test('audit events carry safe metadata and read as Hebrew sentences',async()=>{
   const events=(await f.db.query("SELECT * FROM admin_audit WHERE action='member.withdraw' ORDER BY at")).rows;
   const ok=events.filter((e:any)=>e.result==='OK'&&e.detail===null);
   assert.deepEqual(ok.map((e:any)=>[e.target,e.subject,e.previous_status,Number(e.amount_agorot)]),[[g,ids.bob,'PLEDGED',8000],[h,ids.eli,'PLEDGED',8000]]);
   assert.ok(ok.every((e:any)=>/^session:[a-f0-9]{12}$/.test(e.actor)&&e.at),'anonymous session reference and timestamp');
   assert.ok(events.some((e:any)=>e.result==='OK'&&e.detail==='ALREADY_WITHDRAWN'&&e.previous_status==='WITHDRAWN'&&Number(e.amount_agorot)===0));
   assert.ok(events.some((e:any)=>e.result==='DENIED'&&e.detail==='GROUP_CLOSED'&&e.target===closed));
   assert.ok(events.some((e:any)=>e.result==='DENIED'&&e.detail==='WITHDRAW_CONFIRMATION_REQUIRED'));
   const dump=JSON.stringify(events);
   const hashes=(await f.db.query('SELECT token_hash FROM group_members')).rows.map((r:any)=>r.token_hash);
   for(const secret of ['@example.test','+972',b.memberToken,...hashes,csrf,cookie.split('=')[1],'variantId','gid://'])assert.ok(!dump.includes(secret),'audit leaks '+secret.slice(0,8));
   const page=await(await get('/admin/audit')).text();
   assert.match(page,/הסרת לקוח מהקבוצה<span class="audit__desc">הלקוח הוסר מהקבוצה\. התחייבות של [^<]*80\.00[^<]*הוסרה\./);
   assert.match(page,/href="\/admin\/groups\/[^"]+\/members\/[^"]+">לפרטי הלקוח<\/a>/);
   assert.match(page,/הלקוח כבר הוסר קודם לכן\. לא בוצע שינוי\./);assert.match(page,/הבקשה לא בוצעה; הלקוח וההתחייבות לא שונו\./);
  });

  await t.test('the kept cart never counts and is never restored: the receipt reads WITHDRAWN with no cart',async()=>{
   assert.equal((await publicGroup(g)).pledgedTotalAgorot,39000,'only active pledges count');
   const requests=f.shopify.requests;
   const member=await fetch(f.cfg.origin+'/api/v1/groups/'+g+'/member',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json',Authorization:'Bearer '+b.memberToken},body:'{}'});
   assert.equal(member.status,200);
   assert.deepEqual((await member.json() as any).member,{status:'WITHDRAWN',pledgedTotalAgorot:0,cartCheck:'OK',cart:[]});
   assert.equal(f.shopify.requests,requests,'the historical cart is not even checked against Shopify');
   await assert.rejects(()=>f.groups.update(g,b.memberToken,{lines:[]}),(e:any)=>e.code==='EMPTY_CART_CANNOT_UPDATE_PLEDGE');
   assert.equal((await row(bob.email)).status,'WITHDRAWN');assert.equal((await publicGroup(g)).pledgedTotalAgorot,39000);
  });

  await t.test('knowing a removed customer\'s email + phone is not enough: no reactivation, no new token, receipt unchanged',async()=>{
   const before=await row(bob.email),groupBefore=await publicGroup(g);
   for(const attempt of [
    ()=>f.groups.joinArea({...bob,areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:2}]}),
    ()=>f.groups.join(g,{...bob,areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:2}]}),
    ()=>f.groups.join(g,{email:bob.email,phone:'0509999999',areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:1}]}),
    ()=>f.groups.join(g,{email:'other@example.test',phone:bob.phone,areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:1}]}),
   ])await assert.rejects(attempt,(e:any)=>e.status===409&&e.code==='ALREADY_JOINED');
   // Over HTTP too: the response carries the safe existing-membership code and no token.
   const http=await fetch(f.cfg.origin+'/api/v1/groups/join',{method:'POST',headers:{Origin:f.cfg.origin,'Content-Type':'application/json'},body:JSON.stringify({...bob,areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:1}]})});
   const body=await http.json() as any;assert.equal(http.status,409);assert.equal(body.code,'ALREADY_JOINED');assert.ok(!('memberToken' in body));
   assert.deepEqual(await row(bob.email),before,'row, receipt hash and kept cart unchanged');
   assert.deepEqual(await publicGroup(g),groupBefore,'group unchanged');assert.equal(await memberCount(),rowsAtStart,'no new row');
   assert.equal((await f.groups.memberState(g,b.memberToken)).member.status,'WITHDRAWN','the real receipt still works');
   await assert.rejects(()=>f.groups.join(g,{...alice,areaPublicId:AREA.ashdod,lines:[{variantId:'11',quantity:1}]}),(e:any)=>e.code==='ALREADY_JOINED','a pledged member cannot join twice');
  });

  await t.test('with the valid receipt the member pledges again explicitly on the same row; self-withdrawal keeps the cart too',async()=>{
   const receiptHash=(await row(bob.email)).token_hash;
   const renewed=await f.groups.update(g,b.memberToken,{lines:[{variantId:'11',quantity:2}]});
   assert.deepEqual([renewed.group.pledgedTotalAgorot,renewed.group.participantCount,renewed.validatedPledgeAgorot],[55000,2,16000]);
   const back=await row(bob.email);
   assert.deepEqual([back.id,back.status,Number(back.pledged_total_agorot),back.withdrawn_by,back.withdrawn_at,back.token_hash],[ids.bob,'PLEDGED',16000,null,null,receiptHash],'same row and the same receipt');
   assert.equal(back.cart_snapshot[0].quantity,2,'the new pledge replaces the kept cart');
   assert.equal(await memberCount(),rowsAtStart);
   // The customer's own withdrawal: same code path, recorded as theirs, last cart kept, total back to active pledges.
   await f.groups.withdraw(g,b.memberToken,{confirm:true});
   const self=await row(bob.email);
   assert.deepEqual([self.status,Number(self.pledged_total_agorot),self.withdrawn_by,self.cart_snapshot.length,self.cart_snapshot[0].quantity],['WITHDRAWN',0,'MEMBER',1,2]);
   assert.ok(self.withdrawn_at);assert.equal((await publicGroup(g)).pledgedTotalAgorot,39000);
   assert.deepEqual((await f.groups.memberState(g,b.memberToken)).member.cart,[],'not restored');
  });

  await t.test('the admin UI tells a store-owner removal from a customer\'s own withdrawal',async()=>{
   const self=await(await get('/admin/groups/'+g+'/members/'+ids.bob)).text();
   assert.match(self,/<span class="chip chip--withdrawn">פרש מהקבוצה<\/span>/);assert.match(self,/<dt>יציאה מהקבוצה<\/dt><dd>פרש מהקבוצה<\/dd>/);
   assert.match(self,/הסל האחרון לפני ההסרה/);assert.match(self,/סכום הסל לפני ההסרה \(היסטורי\)<\/th><td class="num" colspan="2"><strong>[^<]*160\.00/);
   const removed=await(await get('/admin/groups/'+h+'/members/'+ids.eli)).text();
   assert.match(removed,/<span class="chip chip--removed">הוסר על ידי מנהל<\/span>/);assert.match(removed,/<dt>יציאה מהקבוצה<\/dt><dd>הוסר על ידי מנהל<\/dd>/);
   const list=(await json('/admin/api/groups/'+g+'/members?memberStatus=WITHDRAWN')).members;
   assert.deepEqual(list.map((m:any)=>[m.email,m.withdrawnBy,m.cartLines]),[[bob.email,'MEMBER',0]]);
   const page=await(await get('/admin/groups/'+g)).text();assert.match(page,/פרש מהקבוצה/);assert.match(page,/class="segmented__item"[^>]*>הוסרו מהקבוצה<\/a>/);
   // Operational line export: active pledges only (the kept cart is history).
   const lines=new TextDecoder().decode(new Uint8Array(await(await get('/admin/groups/'+g+'/export-lines.csv')).arrayBuffer()).slice(3)).trim().split('\r\n');
   assert.equal(lines.length,2);assert.match(lines[1],/alice@example\.test/);
  });

  await t.test('no hard delete: member rows are never deleted by the service code',async()=>{
   assert.equal(await memberCount(),rowsAtStart);
   const dir=new URL('../src/',import.meta.url);
   for(const name of await readdir(dir))if(name.endsWith('.ts'))assert.doesNotMatch(await readFile(new URL(name,dir),'utf8'),/DELETE\s+FROM\s+group_members|TRUNCATE[^;]*group_members/i,name);
  });

  await t.test('capacity counts active members only: 70 withdrawn + 30 active accepts a join; 100 active is full',async()=>{
   const first=await f.groups.joinArea({email:'cap-first@example.test',phone:'0586000000',areaPublicId:AREA.sderot,lines:[{variantId:'20',quantity:1}]});
   const id=first.group.publicId;let n=0;
   const insert=async(count:number,status:'PLEDGED'|'WITHDRAWN')=>{for(let i=0;i<count;i++,n++)await f.db.query(
    "INSERT INTO group_members(id,group_id,email,phone,locality_key,cart_snapshot,pledged_total_agorot,token_hash,status) SELECT gen_random_uuid(),id,$2,$3,locality_key,'[]'::jsonb,$4,$5,$6 FROM delivery_groups WHERE public_id=$1",
    [id,'cap'+n+'@example.test','+97258'+String(1000000+n),status==='PLEDGED'?100:0,'cap-hash-'+n,status]);};
   await insert(70,'WITHDRAWN');await insert(29,'PLEDGED');
   const detail=(await json('/admin/api/groups/'+id)).group;
   assert.deepEqual([detail.capacity,detail.activeMembers,detail.withdrawnMembers,detail.totalMembers],[{active:30,limit:100},30,70,100]);
   assert.match(await(await get('/admin/groups/'+id)).text(),/<dt>תפוסה<\/dt><dd>30 מתוך 100 מקומות פעילים<\/dd>/);
   assert.equal((await publicGroup(id)).participantCount,30);
   // 100 rows but 30 active: the area join still finds this group and adds an active member.
   const joined=await f.groups.joinArea({email:'cap-new@example.test',phone:'0586000001',areaPublicId:AREA.sderot,lines:[{variantId:'20',quantity:1}]});
   assert.deepEqual([joined.group.publicId,joined.created,joined.group.participantCount],[id,false,31]);
   // 100 active: full for a direct join, and the area join opens a new group instead.
   await insert(69,'PLEDGED');
   await assert.rejects(()=>f.groups.join(id,{email:'cap-late@example.test',phone:'0586000002',areaPublicId:AREA.sderot,lines:[{variantId:'20',quantity:1}]}),(e:any)=>e.code==='GROUP_FULL');
   const overflow=await f.groups.joinArea({email:'cap-late@example.test',phone:'0586000002',areaPublicId:AREA.sderot,lines:[{variantId:'20',quantity:1}]});
   assert.equal(overflow.created,true);assert.notEqual(overflow.group.publicId,id);
   // A removal frees an active slot without deleting anything.
   const one=(await f.db.query("SELECT m.id FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1 AND m.status='PLEDGED' ORDER BY m.email LIMIT 1",[id])).rows[0].id;
   assert.equal((await api(id,one,{confirm:true})).status,200);
   const late=await f.groups.join(id,{email:'cap-later@example.test',phone:'0586000003',areaPublicId:AREA.sderot,lines:[{variantId:'20',quantity:1}]});
   assert.equal(late.group.participantCount,100);
   assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM group_members m JOIN delivery_groups g ON g.id=m.group_id WHERE g.public_id=$1",[id])).rows[0].n,171,'70 withdrawn + 100 who joined (one since removed, row kept) + the late join');
  });

  await t.test('nothing sensitive is logged',async()=>{
   const text=logged.join('\n');
   for(const secret of ['@example.test','+972',b.memberToken,csrf,cookie.split('=')[1]])assert.ok(!text.includes(secret),'logged '+secret.slice(0,6));
  });
 }finally{
  Object.assign(console,originals);
  await f.close();
 }
});
