// Cancellation requests ("ביטול עסקה"): public submission, encryption at rest, idempotency, admin workflow, audit,
// email notice and retention. Real Express app and real migrations on PGlite (tests/admin-fixture.ts). Every check that
// sensitive data is absent searches for the exact known test values as substrings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {adminFixture} from './admin-fixture.js';
import {MemoryEmailProvider,cancellationNoticeEmail} from '../src/email.js';
import {israeliId,parseCancellation,cancellationConfig,CancellationInputError,REFERENCE,Cancellations,maskEmail} from '../src/cancellations.js';
import {ApiError,CANCELLATION_ENDPOINT_CODES} from '../src/domain.js';

const STORE='https://fanakee.com';
// Distinctive valid Israeli ID numbers (correct check digit) and contact details, so any leak is detectable.
const ID='314159260',ID2='271828188',ID3='161803390',ID_ZERO='057721565';
const PERSON={name:'ישראלה טסטרית',email:'cancel.secret@example.test',phone:'054-765-4321',orderNumber:'#7788',reason:'סיבה פרטית מאוד לבדיקה'};
const SENSITIVE=[ID,ID2,ID3,ID_ZERO,'ישראלה טסטרית','cancel.secret@example.test','7654321','סיבה פרטית מאוד'];
const KEY=randomBytes(32).toString('hex');
const valid=(over:Record<string,unknown>={})=>({name:PERSON.name,idNumber:ID,orderNumber:PERSON.orderNumber,email:PERSON.email,phone:PERSON.phone,reason:PERSON.reason,...over});

test('Israeli ID numbers and input validation (unit)',()=>{
 assert.equal(israeliId(ID),ID);assert.equal(israeliId('123456782'),'123456782');
 assert.equal(israeliId('57721565'),ID_ZERO,'left-padded to 9 digits');
 assert.equal(israeliId('012345678'),null,'wrong check digit');
 assert.equal(israeliId('000000000'),null);assert.equal(israeliId('1234'),null);assert.equal(israeliId('1234567890'),null);assert.equal(israeliId('12345678a'),null);
 const parsed=parseCancellation({...valid(),name:'  ישראלה\u200F   טסטרית ',idNumber:'314 159-260',orderNumber:' #a-7788 ',email:' Cancel.Secret@Example.TEST ',reason:' שורה  ראשונה \r\n\r\n\r\n\r\nשורה\tשנייה '});
 assert.deepEqual(parsed,{name:'ישראלה טסטרית',idNumber:ID,orderNumber:'A-7788',email:'cancel.secret@example.test',phone:'+972547654321',reason:'שורה ראשונה\n\nשורה שנייה',submissionKey:null});
 assert.deepEqual(parseCancellation({name:'דנה',idNumber:ID,email:'a@b.co',orderNumber:'',phone:'',reason:''}),{name:'דנה',idNumber:ID,orderNumber:null,email:'a@b.co',phone:null,reason:null,submissionKey:null},'empty optional fields are null');
 const fields=(body:unknown)=>{try{parseCancellation(body);return null;}catch(error){if(error instanceof CancellationInputError)return error.fields;if(error instanceof ApiError)return error.code;throw error;}};
 assert.deepEqual(fields({}),{name:'REQUIRED',idNumber:'REQUIRED',email:'REQUIRED'});
 assert.deepEqual(fields(valid({idNumber:'012345678'})),{idNumber:'INVALID'});
 assert.deepEqual(fields(valid({name:'<b>x</b>'})),{name:'INVALID'},'no HTML');
 assert.deepEqual(fields(valid({reason:'<img src=x onerror=alert(1)>'})),{reason:'INVALID'});
 assert.deepEqual(fields(valid({reason:'א'.repeat(2001)})),{reason:'INVALID'},'reason up to 2000 characters');
 assert.equal(fields(valid({reason:'א'.repeat(2000)})),null);
 assert.deepEqual(fields(valid({name:'א'.repeat(121)})),{name:'INVALID'});
 assert.deepEqual(fields(valid({name:'1'})),{name:'INVALID'});
 assert.deepEqual(fields(valid({email:'not-an-email'})),{email:'INVALID'});
 assert.deepEqual(fields(valid({phone:'12'})),{phone:'INVALID'});
 assert.deepEqual(fields(valid({orderNumber:'#77 88!'})),{orderNumber:'INVALID'});
 assert.deepEqual(fields(valid({name:'דנה\u0007'})),{name:'INVALID'},'control characters');
 assert.deepEqual(fields(valid({name:42})),{name:'INVALID'},'strings only');
 assert.deepEqual(fields(valid({email:{$ne:''}})),{email:'INVALID'});
 assert.equal(fields(valid({admin:true})),'INVALID_INPUT','no arbitrary fields');
 assert.equal(fields(valid({submissionKey:'short'})),'INVALID_INPUT');
 assert.equal(fields([valid()]),'INVALID_INPUT');assert.equal(fields('x'),'INVALID_INPUT');assert.equal(fields(null),'INVALID_INPUT');
 assert.equal(maskEmail('cancel.secret@example.test'),'c•••@example.test');
});

test('Cancellation configuration: dedicated key, retention and notification (names only, never values)',()=>{
 const off=cancellationConfig({});
 assert.equal(off.state,'DISABLED');assert.equal(off.retentionDays,null);assert.equal(off.notifyTo,null);
 assert.equal(cancellationConfig({CANCELLATION_ENCRYPTION_KEY:KEY}).state,'ENABLED');
 assert.equal(cancellationConfig({CANCELLATION_ENCRYPTION_KEY:Buffer.from(KEY,'hex').toString('base64')}).state,'ENABLED');
 const short=cancellationConfig({CANCELLATION_ENCRYPTION_KEY:'abc123'});assert.equal(short.state,'MISCONFIGURED');
 const reusedPayment=cancellationConfig({CANCELLATION_ENCRYPTION_KEY:KEY,GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY:Buffer.from(KEY,'hex').toString('base64url')});
 assert.equal(reusedPayment.state,'MISCONFIGURED','the payment key, even in another encoding, is refused');
 assert.match(reusedPayment.problems.join(' '),/GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY/);
 const reusedSession=cancellationConfig({CANCELLATION_ENCRYPTION_KEY:KEY,SESSION_SECRET:KEY});assert.equal(reusedSession.state,'MISCONFIGURED');
 for(const cfg of [short,reusedPayment,reusedSession])assert.ok(!JSON.stringify(cfg.problems).includes(KEY)&&!JSON.stringify(cfg.problems).includes('abc123'),'problems never echo a value');
 assert.equal(cancellationConfig({CANCELLATION_RETENTION_DAYS:'365'}).retentionDays,365);
 for(const bad of ['0','-5','1.5','30d','99999'])assert.equal(cancellationConfig({CANCELLATION_RETENTION_DAYS:bad}).retentionDays,null,bad);
 assert.ok(cancellationConfig({CANCELLATION_RETENTION_DAYS:'abc'}).retentionProblem);
 assert.equal(cancellationConfig({CANCELLATION_NOTIFY_EMAIL:'Ops@Example.test'}).notifyTo,'ops@example.test');
 assert.ok(cancellationConfig({CANCELLATION_NOTIFY_EMAIL:'nope'}).notifyProblem);
 // The notice template refuses anything but a reference and its admin URL.
 assert.throws(()=>cancellationNoticeEmail('CR-2222-2222',new Date(),'https://x.test/admin/cancellations/CR-3333-3333'));
 assert.throws(()=>cancellationNoticeEmail(ID,new Date(),'https://x.test/admin/cancellations/'+ID));
 assert.deepEqual(CANCELLATION_ENDPOINT_CODES.includes('INVALID_CANCELLATION'),true);
});

test('Cancellation requests: public API, encryption, idempotency, admin, audit, email and retention',{timeout:300000},async t=>{
 const email=new MemoryEmailProvider();
 const logged:string[]=[];const originals={log:console.log,info:console.info,warn:console.warn,error:console.error};
 for(const level of ['log','info','warn','error'] as const)console[level]=(...args:unknown[])=>{logged.push(args.map(a=>a instanceof Error?a.stack||a.message:typeof a==='string'?a:JSON.stringify(a)).join(' '));};
 const f=await adminFixture({email,cancellationLog:line=>logged.push(line),env:{STOREFRONT_ORIGINS:STORE,CANCELLATION_ENCRYPTION_KEY:KEY,CANCELLATION_RETENTION_DAYS:'30',CANCELLATION_NOTIFY_EMAIL:'ops@example.test'}});
 // Everything a shopper or the public can see, plus everything an admin page renders, for the final leak search.
 const publicOutput:string[]=[],adminOutput:string[]=[];
 const submit=async(body:unknown,options:{origin?:string|null;type?:string;raw?:string}={})=>{
  const origin=options.origin===undefined?STORE:options.origin;
  const response=await fetch(f.cfg.origin+'/api/v1/cancellations',{method:'POST',headers:{...(origin?{Origin:origin}:{}),'Content-Type':options.type??'application/json'},body:options.raw??JSON.stringify(body)});
  const text=await response.text();publicOutput.push(text,JSON.stringify([...response.headers]));
  let data:any=null;try{data=JSON.parse(text);}catch{}
  return {status:response.status,data,text,headers:response.headers};
 };
 const count=async()=>(await f.db.query('SELECT COUNT(*)::int AS n FROM cancellation_requests')).rows[0].n as number;
 const resetLimits=()=>f.db.query('DELETE FROM request_limits');
 try{
  const session=await f.login();
  const get=async(path:string,cookie=session.cookie)=>{const r=await fetch(f.cfg.origin+path,{redirect:'manual',headers:cookie?{Cookie:cookie}:{}});const text=await r.text();if(cookie)adminOutput.push(text);return {status:r.status,text,headers:r.headers,location:r.headers.get('location')};};
  const post=async(path:string,fields:Record<string,string>,options:{cookie?:string;origin?:string|null;csrf?:string|null}={})=>{
   const origin=options.origin===undefined?f.cfg.origin:options.origin,csrf=options.csrf===undefined?session.csrf:options.csrf;
   const r=await fetch(f.cfg.origin+path,{method:'POST',redirect:'manual',headers:{Cookie:options.cookie??session.cookie,...(origin?{Origin:origin}:{}),'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({...(csrf?{csrf}:{}),...fields})});
   const text=await r.text();adminOutput.push(text);return {status:r.status,text,location:r.headers.get('location'),headers:r.headers};
  };
  let first:{reference:string}={reference:''};

  await t.test('valid submission: 201 with a generic message and a reference; nothing personal echoed; CORS for the storefront only',async()=>{
   const r=await submit({...valid(),submissionKey:'key-'+randomBytes(12).toString('hex')});
   assert.equal(r.status,201);
   assert.deepEqual(Object.keys(r.data).sort(),['message','ok','reference']);
   assert.equal(r.data.ok,true);assert.equal(r.data.message,'הבקשה התקבלה ונשלחה לטיפול.');assert.match(r.data.reference,REFERENCE);
   for(const value of SENSITIVE)assert.ok(!r.text.includes(value),'response echoes '+value);
   assert.equal(r.headers.get('access-control-allow-origin'),STORE);assert.equal(r.headers.get('cache-control'),'no-store');
   first=r.data;
   assert.equal(await count(),1);
  });

  await t.test('stored row: ID encrypted (AES-GCM, bound to the row) with a keyed fingerprint; other fields as normalized',async()=>{
   const row=(await f.db.query('SELECT * FROM cancellation_requests WHERE reference=$1',[first.reference])).rows[0];
   assert.equal(row.status,'NEW');assert.equal(row.full_name,PERSON.name);assert.equal(row.email,PERSON.email);assert.equal(row.phone,'+972547654321');assert.equal(row.order_number,'7788');assert.equal(row.reason,PERSON.reason);
   assert.match(row.id_number_sealed,/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
   const everything=JSON.stringify(row);
   assert.ok(!everything.includes(ID),'the ID number is nowhere in the row in plaintext');
   for(const encoding of ['base64','base64url','hex'] as const)assert.ok(!everything.includes(Buffer.from(ID).toString(encoding)),'not merely encoded ('+encoding+')');
   assert.match(row.id_fingerprint,/^[a-f0-9]{64}$/);
   assert.notEqual(row.id_fingerprint,createHash('sha256').update(ID).digest('hex'),'the fingerprint is keyed, not a plain hash (10^9 IDs are brute-forceable)');
   assert.match(row.submission_key_hash,/^[a-f0-9]{64}$/);
   // A different key cannot open it, and the ciphertext is bound to its row.
   const other=new Cancellations(f.db,cancellationConfig({CANCELLATION_ENCRYPTION_KEY:randomBytes(32).toString('hex')}),{adminOrigin:()=>'',log:line=>logged.push(line)});
   await assert.rejects(other.revealId(first.reference,'session:000000000000'),(e:any)=>e.code==='CANCELLATION_UNAVAILABLE');
  });

  await t.test('invalid ID number: 400 INVALID_CANCELLATION naming the field only; nothing stored',async()=>{
   await resetLimits();const before=await count();
   const r=await submit(valid({idNumber:'012345678'}));
   assert.equal(r.status,400);assert.equal(r.data.code,'INVALID_CANCELLATION');assert.deepEqual(r.data.fields,{idNumber:'INVALID'});
   assert.ok(!r.text.includes('012345678'));for(const value of SENSITIVE)assert.ok(!r.text.includes(value));
   assert.equal(await count(),before);
  });

  await t.test('invalid and oversized fields, HTML, arbitrary fields and a body over 10 kB are refused; nothing stored',async()=>{
   await resetLimits();const before=await count();
   const cases:[unknown,number,string][]=[
    [valid({name:'<script>alert(1)</script>'}),400,'INVALID_CANCELLATION'],[valid({email:'x@'}),400,'INVALID_CANCELLATION'],
    [valid({reason:'א'.repeat(2001)}),400,'INVALID_CANCELLATION'],[valid({phone:'abc'}),400,'INVALID_CANCELLATION'],
    [valid({orderNumber:'<1>'}),400,'INVALID_CANCELLATION'],[valid({isAdmin:true}),400,'INVALID_INPUT'],[[valid()],400,'INVALID_INPUT'],
    [valid({reason:'x'.repeat(12000)}),413,'BODY_TOO_LARGE'],
   ];
   for(const [body,status,code] of cases){const r=await submit(body);assert.equal(r.status,status,code);assert.equal(r.data.code,code);for(const value of SENSITIVE)assert.ok(!r.text.includes(value));}
   const malformed=await submit(null,{raw:'{"idNumber":"'+ID+'",'});
   assert.equal(malformed.status,400);assert.equal(malformed.data.code,'INVALID_INPUT');assert.ok(!malformed.text.includes(ID),'a JSON parse error never echoes the body');
   // A card-like number in the free text is refused before any handler (shared /api/v1 guard).
   const card=await submit(valid({reason:'4580 0000 0000 0000'}));assert.equal(card.status,400);assert.equal(card.data.code,'CARD_DATA_NOT_ACCEPTED');
   assert.equal(await count(),before);
  });

  await t.test('wrong or missing Origin, non-JSON bodies and other methods are refused; nothing stored',async()=>{
   await resetLimits();const before=await count();
   for(const origin of ['https://evil.example','http://fanakee.com','https://fanakee.com.evil.example',null]){
    const r=await submit(valid(),{origin});assert.equal(r.status,403,String(origin));assert.equal(r.data.code,'INVALID_ORIGIN');
    assert.equal(r.headers.get('access-control-allow-origin'),null);
   }
   const form=await submit(null,{type:'application/x-www-form-urlencoded',raw:new URLSearchParams(valid() as any).toString()});assert.equal(form.status,403);
   const plain=await submit(null,{type:'text/plain',raw:JSON.stringify(valid())});assert.equal(plain.status,403);
   const getRequest=await fetch(f.cfg.origin+'/api/v1/cancellations',{headers:{Origin:STORE}});assert.equal(getRequest.status,404);
   const preflight=await fetch(f.cfg.origin+'/api/v1/cancellations',{method:'OPTIONS',headers:{Origin:STORE,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
   assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),STORE);
   assert.equal(await count(),before);
  });

  await t.test('duplicate submissions: same key, same content, simultaneous double submit -> one request',async()=>{
   await resetLimits();
   const key='retry-'+randomBytes(12).toString('hex'),body=valid({idNumber:ID2,orderNumber:'1001',submissionKey:key});
   const a=await submit(body),b=await submit(body);
   assert.equal(a.status,201);assert.equal(b.status,200);assert.equal(b.data.reference,a.data.reference);
   const c=await submit(valid({idNumber:ID2,orderNumber:'1001'}));assert.equal(c.data.reference,a.data.reference,'same ID + email + order within the window, no key');
   const d=await submit(valid({idNumber:ID2,orderNumber:'1002'}));assert.equal(d.status,201);assert.notEqual(d.data.reference,a.data.reference,'a different order is a new request');
   const reused=await submit(valid({idNumber:ID3,submissionKey:key}));assert.equal(reused.status,400,'a reused key with a different ID is refused');assert.equal(reused.data.code,'INVALID_INPUT');
   const concurrent=valid({idNumber:ID3,orderNumber:'2001',submissionKey:'double-'+randomBytes(12).toString('hex')});
   const [x,y]=await Promise.all([submit(concurrent),submit(concurrent)]);
   assert.deepEqual([x.status,y.status].sort(),[200,201]);assert.equal(x.data.reference,y.data.reference);
   const [p,q]=await Promise.all([submit(valid({idNumber:ID_ZERO,orderNumber:'3001'})),submit(valid({idNumber:ID_ZERO,orderNumber:'3001'}))]);
   assert.equal(p.data.reference,q.data.reference,'simultaneous copies without a key');
   assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM cancellation_requests WHERE order_number IN ('1001','1002','2001','3001')")).rows[0].n,4);
  });

  await t.test('rate limited per IP (10 per hour); the limit answers 429 without storing',async()=>{
   await resetLimits();const before=await count();
   const statuses:number[]=[];
   for(let i=0;i<11;i++)statuses.push((await submit(valid({name:'אדם '+'אבגדהוזחטיכ'[i],orderNumber:'R'+i}))).status);
   assert.deepEqual(statuses.slice(0,10),Array(10).fill(201));assert.equal(statuses[10],429);
   assert.equal(await count(),before+10);
   await resetLimits();
  });

  await t.test('email notice: reference, time and admin link only; delivery failure never affects the request',async()=>{
   const created=(await f.db.query('SELECT reference FROM cancellation_requests')).rows.length;
   await new Promise(r=>setTimeout(r,50));
   assert.equal(email.notices.length,created,'one notice per new request, none for duplicates');
   const notice=email.notices.find(n=>n.reference===first.reference)!;
   assert.equal(notice.to,'ops@example.test');assert.equal(notice.subject,'בקשת ביטול חדשה התקבלה · '+first.reference);
   assert.ok(notice.text.includes(f.cfg.origin+'/admin/cancellations/'+first.reference));
   const row=(await f.db.query('SELECT id,id_fingerprint,id_number_sealed FROM cancellation_requests WHERE reference=$1',[first.reference])).rows[0];
   for(const message of email.notices){
    const all=message.subject+message.text+message.html;
    for(const value of [...SENSITIVE,'7788',row.id,row.id_fingerprint,row.id_number_sealed.slice(3,20),KEY])assert.ok(!all.includes(value),'email contains '+value);
   }
   email.fail='once';
   const r=await submit(valid({idNumber:ID3,orderNumber:'5005'}));assert.equal(r.status,201);
   await new Promise(r=>setTimeout(r,50));
   assert.ok(logged.includes('Cancellation request notification email could not be delivered.'));
  });

  await t.test('admin authentication: list, detail and every action need a session',async()=>{
   const list=await get('/admin/cancellations','');assert.equal(list.status,303);assert.equal(list.location,'/admin?expired=1&next='+encodeURIComponent('/admin/cancellations'));
   const detail=await get('/admin/cancellations/'+first.reference,'');assert.equal(detail.status,303);
   for(const action of ['status','note','reveal-id']){
    const r=await fetch(f.cfg.origin+'/admin/cancellations/'+first.reference+'/'+action,{method:'POST',redirect:'manual',headers:{Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'status=IN_REVIEW&confirm=yes&note=x'});
    assert.equal(r.status,303,action);assert.equal(r.headers.get('location'),'/admin?expired=1');assert.ok(!(await r.text()).includes(ID));
   }
   const retention=await fetch(f.cfg.origin+'/admin/cancellations/retention',{method:'POST',redirect:'manual',headers:{Origin:f.cfg.origin}});assert.equal(retention.status,303);
   assert.equal((await f.db.query('SELECT status FROM cancellation_requests WHERE reference=$1',[first.reference])).rows[0].status,'NEW');
  });

  await t.test('CSRF and exact Origin are required for admin mutations',async()=>{
   for(const [label,options] of [['no token',{csrf:null}],['wrong token',{csrf:'0'.repeat(64)}],['other origin',{origin:'https://evil.example'}],['no origin',{origin:null}]] as const){
    for(const action of ['status','note','reveal-id']){
     const r=await post('/admin/cancellations/'+first.reference+'/'+action,{status:'IN_REVIEW',note:'x',confirm:'yes'},options as any);
     assert.equal(r.status,403,label+' '+action);assert.ok(!r.text.includes(ID),'never revealed: '+label);
    }
   }
   const row=(await f.db.query('SELECT status,admin_note FROM cancellation_requests WHERE reference=$1',[first.reference])).rows[0];
   assert.deepEqual([row.status,row.admin_note],['NEW',null]);
   // Only the earlier wrong-key attempt (FAILED) exists; no successful reveal.
   assert.equal((await f.db.query("SELECT COUNT(*)::int AS n FROM admin_audit WHERE action='cancellation.reveal_id' AND result='OK'")).rows[0].n,0);
  });

  await t.test('list and detail: Hebrew RTL, minimal identifier in the list, masked ID by default, enabled nav section',async()=>{
   const list=await get('/admin/cancellations');
   assert.equal(list.status,200);assert.equal(list.headers.get('cache-control'),'no-store');assert.equal(list.headers.get('x-robots-tag'),'noindex, nofollow');
   assert.match(list.text,/<html lang="he" dir="rtl">/);assert.match(list.text,/<a href="\/admin\/cancellations" aria-current="page">בקשות ביטול<\/a>/);
   assert.ok(list.text.includes(first.reference));assert.ok(list.text.includes('c•••@example.test'),'masked email in the list');
   for(const value of SENSITIVE)assert.ok(!list.text.includes(value),'list shows '+value);
   assert.match(list.text,/#7788/,'the order number helps find the transaction');
   assert.doesNotMatch(list.text,/data-cancellation-warnings/,'retention and key are configured: no warning');
   const filtered=await get('/admin/cancellations?q='+encodeURIComponent('#7788'));assert.ok(filtered.text.includes(first.reference));
   for(const path of ['/admin/cancellations?notice=toString','/admin/cancellations/'+first.reference+'?error=constructor&notice=__proto__'])assert.doesNotMatch((await get(path)).text,/function|native code|notice--ok|notice--error/,'only known notice codes render: '+path);
   const none=await get('/admin/cancellations?status=COMPLETED');assert.ok(!none.text.includes(first.reference));
   const detail=await get('/admin/cancellations/'+first.reference);
   assert.equal(detail.status,200);
   for(const value of [PERSON.name,PERSON.email,PERSON.reason])assert.ok(detail.text.includes(value),'detail shows '+value);
   assert.ok(!detail.text.includes(ID),'full ID number is not on the detail page');
   assert.ok(detail.text.includes('•••••••'+ID.slice(-2)),'masked ID');
   assert.match(detail.text,/action="\/admin\/cancellations\/[^"]+\/reveal-id"/);
   assert.equal((await get('/admin/cancellations/CR-2222-2222')).status,404);
   assert.equal((await get('/admin/cancellations/'+encodeURIComponent('<x>'))).status,404);
  });

  await t.test('reveal: needs explicit confirmation, shown only in the POST response, audited without the value',async()=>{
   const unconfirmed=await post('/admin/cancellations/'+first.reference+'/reveal-id',{});
   assert.equal(unconfirmed.status,303);assert.equal(unconfirmed.location,'/admin/cancellations/'+first.reference+'?error=reveal_confirm');assert.ok(!unconfirmed.text.includes(ID));
   const revealed=await post('/admin/cancellations/'+first.reference+'/reveal-id',{confirm:'yes'});
   assert.equal(revealed.status,200);assert.equal(revealed.headers.get('cache-control'),'no-store');
   assert.ok(revealed.text.includes('data-revealed-id>'+ID+'<'),'the full ID number is shown once');
   adminOutput.pop();// the one response allowed to contain it
   const audit=(await f.db.query("SELECT * FROM admin_audit WHERE action='cancellation.reveal_id' AND result='OK'")).rows;
   assert.equal(audit.length,1);assert.equal(audit[0].result,'OK');
   const again=await get('/admin/cancellations/'+first.reference);assert.ok(!again.text.includes(ID),'a later page view is masked again');
  });

  await t.test('status transitions: NEW -> IN_REVIEW -> COMPLETED, reopen, refused transitions; audited with statuses only',async()=>{
   const path='/admin/cancellations/'+first.reference;
   const status=async()=>(await f.db.query('SELECT status,in_review_at,completed_at,handled_by FROM cancellation_requests WHERE reference=$1',[first.reference])).rows[0];
   for(const bad of ['REJECTED','NEW','','APPROVED']){const r=await post(path+'/status',{status:bad});assert.equal(r.location,path+'?error=transition',bad);}
   assert.equal((await status()).status,'NEW');
   assert.equal((await post(path+'/status',{status:'IN_REVIEW'})).location,path+'?notice=status_updated');
   let row=await status();assert.equal(row.status,'IN_REVIEW');assert.ok(row.in_review_at);assert.match(row.handled_by,/^session:[a-f0-9]{12}$/);
   assert.equal((await post(path+'/status',{status:'NEW'})).location,path+'?error=transition','no way back to NEW');
   await post(path+'/status',{status:'COMPLETED'});row=await status();assert.equal(row.status,'COMPLETED');assert.ok(row.completed_at);
   await post(path+'/status',{status:'IN_REVIEW'});row=await status();assert.equal(row.status,'IN_REVIEW');assert.equal(row.completed_at,null,'reopen clears the completion (retention clock)');
   await post(path+'/status',{status:'COMPLETED'});
   const page=await get(path+'?notice=status_updated');assert.match(page.text,/שלב הטיפול עודכן/);assert.match(page.text,/פתיחה מחדש/);
   const audit=(await f.db.query("SELECT previous_status,new_status,result FROM admin_audit WHERE action='cancellation.status_change' ORDER BY at,id")).rows;
   assert.deepEqual(audit.map((a:any)=>[a.previous_status,a.new_status]),[['NEW','IN_REVIEW'],['IN_REVIEW','COMPLETED'],['COMPLETED','IN_REVIEW'],['IN_REVIEW','COMPLETED']]);
   const log=await get('/admin/audit');assert.match(log.text,/שינוי שלב בבקשת ביטול/);
  });

  await t.test('internal note: saved and shown; validated; never audited',async()=>{
   const path='/admin/cancellations/'+first.reference,note='הערה פנימית ייחודית לבדיקה';
   assert.equal((await post(path+'/note',{note})).location,path+'?notice=note_saved');
   assert.ok((await get(path)).text.includes(note));
   assert.equal((await post(path+'/note',{note:'א'.repeat(1001)})).location,path+'?error=note_invalid');
   assert.equal((await post(path+'/note',{note:'ב'.repeat(1000)})).location,path+'?notice=note_saved','1000 Hebrew characters (about 6 kB encoded) fit');
   await post(path+'/note',{note});
   const audit=JSON.stringify((await f.db.query("SELECT * FROM admin_audit WHERE action='cancellation.note_update'")).rows);
   assert.ok(audit.includes('NOTE_SAVED'));assert.ok(!audit.includes(note));
  });

  await t.test('audit metadata never contains the ID number or request content',async()=>{
   const rows=(await f.db.query("SELECT * FROM admin_audit WHERE action LIKE 'cancellation.%'")).rows;
   assert.ok(rows.length>=6);
   const text=JSON.stringify(rows);
   for(const value of [...SENSITIVE,'7788','הערה פנימית'])assert.ok(!text.includes(value),'audit contains '+value);
   const ids=new Set((await f.db.query('SELECT id FROM cancellation_requests')).rows.map((r:any)=>r.id));
   for(const row of rows)assert.ok(ids.has(row.target),'target is the request id');
   const api=await get('/admin/api/audit');for(const value of SENSITIVE)assert.ok(!api.text.includes(value));
  });

  await t.test('retention: only requests completed more than CANCELLATION_RETENTION_DAYS ago are cleared, permanently and audited',async()=>{
   const make=async(idNumber:string,order:string)=>(await submit(valid({idNumber,orderNumber:order,submissionKey:'ret-'+randomBytes(12).toString('hex')}))).data.reference as string;
   await resetLimits();
   const old=await make(ID2,'9001'),recent=await make(ID3,'9002'),openOld=await make(ID_ZERO,'9003');
   for(const ref of [old,recent])await post('/admin/cancellations/'+ref+'/status',{status:'COMPLETED'});
   await f.db.query("UPDATE cancellation_requests SET completed_at=NOW()-INTERVAL '31 days',created_at=NOW()-INTERVAL '40 days' WHERE reference=$1",[old]);
   await f.db.query("UPDATE cancellation_requests SET completed_at=NOW()-INTERVAL '29 days',created_at=NOW()-INTERVAL '400 days' WHERE reference=$1",[recent]);
   await f.db.query("UPDATE cancellation_requests SET created_at=NOW()-INTERVAL '400 days' WHERE reference=$1",[openOld]);
   const run=await post('/admin/cancellations/retention',{});
   assert.equal(run.location,'/admin/cancellations?purged=1');
   const rows=Object.fromEntries((await f.db.query('SELECT * FROM cancellation_requests WHERE reference = ANY($1)',[[old,recent,openOld]])).rows.map((r:any)=>[r.reference,r]));
   for(const column of ['full_name','order_number','email','phone','reason','id_number_sealed','id_fingerprint','submission_key_hash','admin_note'])assert.equal(rows[old][column],null,column+' cleared');
   assert.ok(rows[old].purged_at);assert.equal(rows[old].status,'COMPLETED');assert.equal(rows[old].reference,old);
   assert.ok(rows[recent].id_number_sealed&&!rows[recent].purged_at,'completed 29 days ago: kept (counted from completion, not submission)');
   assert.ok(rows[openOld].id_number_sealed&&!rows[openOld].purged_at,'never completed: kept however old');
   assert.match((await get('/admin/cancellations?purged=1')).text,/בקשה אחת נמחקה/);
   const detail=await get('/admin/cancellations/'+old);assert.match(detail.text,/הפרטים האישיים של הבקשה, כולל מספר תעודת הזהות המוצפן, נמחקו/);
   assert.doesNotMatch(detail.text,/reveal-id|name="status"/,'a purged request has no actions');
   assert.equal((await post('/admin/cancellations/'+old+'/status',{status:'IN_REVIEW'})).location,'/admin/cancellations/'+old+'?error=purged');
   assert.equal((await post('/admin/cancellations/'+old+'/reveal-id',{confirm:'yes'})).location,'/admin/cancellations/'+old+'?error=purged');
   const audit=(await f.db.query("SELECT actor,target,detail FROM admin_audit WHERE action='cancellation.retention_purge'")).rows;
   assert.deepEqual(audit.map((a:any)=>[a.target,a.detail]),[[rows[old].id,'RETENTION_DAYS:30']]);
   // A second run finds nothing more.
   assert.equal((await post('/admin/cancellations/retention',{})).location,'/admin/cancellations?purged=0');
  });

  await t.test('known test ID number is absent from every public response, email, log and admin page (except the one reveal)',async()=>{
   const haystacks={public:publicOutput.join('\n'),admin:adminOutput.join('\n'),email:JSON.stringify([email.notices,email.sent]),logs:logged.join('\n')};
   for(const [where,text] of Object.entries(haystacks))for(const id of [ID,ID2,ID3,ID_ZERO])assert.ok(!text.includes(id),id+' found in '+where);
   for(const [where,text] of Object.entries({public:haystacks.public,email:haystacks.email,logs:haystacks.logs}))
    for(const value of ['ישראלה טסטרית','cancel.secret@example.test','סיבה פרטית מאוד'])assert.ok(!text.includes(value),value+' found in '+where);
   assert.ok(publicOutput.length>40,'the search covered the public responses');
  });
 }finally{
  for(const level of ['log','info','warn','error'] as const)console[level]=originals[level];
  await f.close();
 }
});

test('Without a key the form refuses requests (503) and the admin pages warn; without retention nothing is deleted',{timeout:180000},async t=>{
 const f=await adminFixture({env:{STOREFRONT_ORIGINS:STORE}});
 try{
  const session=await f.login();
  await t.test('503 CANCELLATION_UNAVAILABLE, nothing stored',async()=>{
   const r=await fetch(f.cfg.origin+'/api/v1/cancellations',{method:'POST',headers:{Origin:STORE,'Content-Type':'application/json'},body:JSON.stringify(valid())});
   assert.equal(r.status,503);const data=await r.json() as any;assert.equal(data.code,'CANCELLATION_UNAVAILABLE');assert.ok(!JSON.stringify(data).includes(ID));
   assert.equal(r.headers.get('access-control-allow-origin'),STORE,'the storefront can read the refusal and show the other channels');
   assert.equal((await f.db.query('SELECT COUNT(*)::int AS n FROM cancellation_requests')).rows[0].n,0);
  });
  await t.test('warnings on the cancellations and services pages; the retention run is a no-op',async()=>{
   const page=await(await fetch(f.cfg.origin+'/admin/cancellations',{headers:{Cookie:session.cookie}})).text();
   assert.match(page,/data-cancellation-warnings/);assert.match(page,/CANCELLATION_ENCRYPTION_KEY/);assert.match(page,/לא הוגדרה תקופת שמירה לבקשות ביטול \(CANCELLATION_RETENTION_DAYS\)/);
   assert.match(page,/לא הוגדרה תקופת שמירה, ולכן בקשות אינן נמחקות/);assert.doesNotMatch(page,/action="\/admin\/cancellations\/retention"/);
   const services=await(await fetch(f.cfg.origin+'/admin/system/services',{headers:{Cookie:session.cookie}})).text();
   assert.match(services,/data-cancellation-warnings/);assert.match(services,/CANCELLATION_RETENTION_DAYS/);
   // A completed, old request is never deleted while no period is configured.
   await f.db.query("INSERT INTO cancellation_requests(id,reference,status,full_name,email,id_number_sealed,id_fingerprint,completed_at,created_at) VALUES(gen_random_uuid(),'CR-AAAA-2222','COMPLETED','דנה','d@example.test','v1.x.y.z',$1,NOW()-INTERVAL '5000 days',NOW()-INTERVAL '5000 days')",['a'.repeat(64)]);
   const r=await fetch(f.cfg.origin+'/admin/cancellations/retention',{method:'POST',redirect:'manual',headers:{Cookie:session.cookie,Origin:f.cfg.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:session.csrf})});
   assert.equal(r.headers.get('location'),'/admin/cancellations');
   assert.equal((await f.db.query("SELECT full_name FROM cancellation_requests WHERE reference='CR-AAAA-2222'")).rows[0].full_name,'דנה');
  });
 }finally{await f.close();}
});
