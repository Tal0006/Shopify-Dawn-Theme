// Post-purchase feedback (Thank you page survey): strict input, Shopify session-token authentication, one response per
// order, CORS for the extension's Web Worker, rate limiting, the admin dashboard (summary math, filters, missing-products
// aggregation) and the absence of customer data. Real Express app and real migrations on PGlite (tests/admin-fixture.ts).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {adminFixture} from './admin-fixture.js';
import {parseFeedback,verifySessionToken,aggregateMissingProducts,feedbackConfig,feedbackFilters,FeedbackInputError,FEEDBACK_SUCCESS_MESSAGE} from '../src/feedback.js';
import {ApiError} from '../src/domain.js';

const CLIENT_ID='fankee-test-client-id',SECRET='test-app-secret-not-real-0123456789',SHOP='example.myshopify.com';
// The token's optional customer id: it must never be stored or shown.
const CUSTOMER_SUB='gid://shopify/Customer/987654321012';
const REVIEW='https://g.page/r/fankee-test/review';
const now=()=>Math.floor(Date.now()/1000);
const b64=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const sign=(claims:Record<string,unknown>,secret=SECRET,header:Record<string,unknown>={alg:'HS256',typ:'JWT'})=>{
 const h=b64(header),p=b64(claims);return h+'.'+p+'.'+createHmac('sha256',secret).update(h+'.'+p).digest('base64url');
};
const claims=(over:Record<string,unknown>={})=>({dest:SHOP,aud:CLIENT_ID,exp:now()+300,nbf:now()-1,iat:now()-1,jti:randomUUID(),sub:CUSTOMER_SUB,...over});
const settings={clientId:CLIENT_ID,clientSecret:SECRET,shop:SHOP};
let orderSeq=7000000000;
const valid=(over:Record<string,unknown>={})=>({orderId:'gid://shopify/Order/'+(++orderSeq),confirmationNumber:'X7K2P9QA',rating:4,missingProducts:false,encounteredProblem:false,version:1,...over});
const fieldsOf=(body:unknown)=>{try{parseFeedback(body);return null;}catch(error){if(error instanceof FeedbackInputError)return error.fields;if(error instanceof ApiError)return error.code;throw error;}};

test('Feedback input: strict schema, ratings, conditional details, lengths and normalisation (unit)',()=>{
 const parsed=parseFeedback(valid({orderId:'gid://shopify/Order/123',confirmationNumber:' x7k2p9qa ',missingProducts:true,missingProductsDetails:'  מגבונים\u200F   לחים \r\n\r\n\r\n\r\nאקונומיקה ',improvementFeedback:'  <3 משלוח מהיר  '}));
 assert.deepEqual(parsed,{orderId:'123',confirmationNumber:'X7K2P9QA',rating:4,missingProducts:true,missingProductsDetails:'מגבונים לחים\n\nאקונומיקה',encounteredProblem:false,problemDetails:null,improvementFeedback:'<3 משלוח מהיר',version:1});
 for(const rating of [1,2,3,4,5])assert.equal(fieldsOf(valid({rating})),null,'rating '+rating);
 for(const rating of [0,6,-1,2.5,'5',null,true,[5],{}])assert.deepEqual(fieldsOf(valid({rating})),{rating:rating===null?'REQUIRED':'INVALID'},'rating '+JSON.stringify(rating));
 const {rating:_r,...noRating}=valid();assert.deepEqual(fieldsOf(noRating),{rating:'REQUIRED'});
 assert.deepEqual(fieldsOf({}),{orderId:'REQUIRED',rating:'REQUIRED',missingProducts:'REQUIRED',encounteredProblem:'REQUIRED'});
 assert.deepEqual(fieldsOf(valid({missingProducts:'yes'})),{missingProducts:'INVALID'},'booleans only');
 // Conditional details: kept only with "yes"; a "yes" without details is fine; details with "no" are refused.
 assert.equal(parseFeedback(valid({missingProducts:true})).missingProductsDetails,null);
 assert.equal(parseFeedback(valid({encounteredProblem:true,problemDetails:'  '})).problemDetails,null,'blank details are null');
 assert.equal(parseFeedback(valid({encounteredProblem:true,problemDetails:'התשלום נתקע'})).problemDetails,'התשלום נתקע');
 assert.deepEqual(fieldsOf(valid({missingProducts:false,missingProductsDetails:'סבון'})),{missingProductsDetails:'INVALID'});
 assert.deepEqual(fieldsOf(valid({encounteredProblem:false,problemDetails:'תקלה'})),{problemDetails:'INVALID'});
 // Maximum lengths (after normalisation): 500 / 1000 / 1000 characters.
 assert.equal(fieldsOf(valid({missingProducts:true,missingProductsDetails:'א'.repeat(500)})),null);
 assert.deepEqual(fieldsOf(valid({missingProducts:true,missingProductsDetails:'א'.repeat(501)})),{missingProductsDetails:'INVALID'});
 assert.equal(fieldsOf(valid({encounteredProblem:true,problemDetails:'א'.repeat(1000)})),null);
 assert.deepEqual(fieldsOf(valid({encounteredProblem:true,problemDetails:'א'.repeat(1001)})),{problemDetails:'INVALID'});
 assert.equal(fieldsOf(valid({improvementFeedback:'א'.repeat(1000)})),null);
 assert.deepEqual(fieldsOf(valid({improvementFeedback:'א'.repeat(1001)})),{improvementFeedback:'INVALID'});
 // No HTML, no control characters, strings only.
 assert.deepEqual(fieldsOf(valid({improvementFeedback:'<b>שלום</b>'})),{improvementFeedback:'INVALID'});
 assert.deepEqual(fieldsOf(valid({improvementFeedback:'<img src=x onerror=alert(1)>'})),{improvementFeedback:'INVALID'});
 assert.deepEqual(fieldsOf(valid({improvementFeedback:'<!-- x -->'})),{improvementFeedback:'INVALID'});
 assert.equal(fieldsOf(valid({improvementFeedback:'מחיר > 50 ו־3 < 4'})),null,'comparison signs are plain text');
 assert.deepEqual(fieldsOf(valid({improvementFeedback:'שלום\u0007'})),{improvementFeedback:'INVALID'});
 assert.deepEqual(fieldsOf(valid({improvementFeedback:42})),{improvementFeedback:'INVALID'});
 // Order identifiers.
 for(const orderId of ['123','gid://shopify/Order/0','gid://shopify/Order/12a','gid://shopify/Customer/1','gid://shopify/Order/1/2','gid://shopify/Order/'+'1'.repeat(21)])
  assert.deepEqual(fieldsOf(valid({orderId})),{orderId:'INVALID'},orderId);
 assert.deepEqual(fieldsOf(valid({confirmationNumber:'ab'})),{confirmationNumber:'INVALID'});
 assert.equal(parseFeedback(valid({confirmationNumber:''})).confirmationNumber,null);
 assert.deepEqual(fieldsOf(valid({version:0})),{version:'INVALID'});
 // Unknown fields (including attempts to send customer data) and non-object bodies are refused outright.
 for(const extra of [{email:'a@b.co'},{name:'דנה'},{phone:'0501234567'},{cart:[]},{created_at:'2020-01-01'},{__proto__x:1}])
  assert.equal(fieldsOf(valid(extra)),'INVALID_INPUT',JSON.stringify(extra));
 for(const body of [null,'x',[valid()],42])assert.equal(fieldsOf(body),'INVALID_INPUT');
});

test('Session tokens: signature, audience, shop and time claims (unit)',()=>{
 assert.equal(verifySessionToken(sign(claims()),settings),true);
 assert.equal(verifySessionToken(sign(claims({dest:'https://'+SHOP})),settings),true,'dest with a scheme');
 assert.equal(verifySessionToken(sign(claims({aud:[CLIENT_ID]})),settings),true,'audience array');
 const {sub:_s,nbf:_n,iat:_i,...minimal}=claims();assert.equal(verifySessionToken(sign(minimal),settings),true,'anonymous buyer, no sub');
 assert.equal(verifySessionToken(sign(claims(),'another-secret-of-a-different-app-0000'),settings),false,'wrong secret');
 assert.equal(verifySessionToken(sign(claims({aud:'another-app'})),settings),false,'other app');
 assert.equal(verifySessionToken(sign(claims({dest:'other-shop.myshopify.com'})),settings),false,'other shop');
 assert.equal(verifySessionToken(sign(claims({dest:undefined})),settings),false);
 assert.equal(verifySessionToken(sign(claims({exp:now()-10})),settings),false,'expired');
 assert.equal(verifySessionToken(sign(claims({exp:now()+7200})),settings),false,'implausibly long-lived');
 assert.equal(verifySessionToken(sign(claims({nbf:now()+60})),settings),false,'not yet valid');
 assert.equal(verifySessionToken(sign(claims({iat:now()+60})),settings),false,'issued in the future');
 assert.equal(verifySessionToken(sign(claims({exp:String(now()+300)})),settings),false);
 assert.equal(verifySessionToken(sign(claims(),SECRET,{alg:'none'}),settings),false,'alg none');
 assert.equal(verifySessionToken(sign(claims(),SECRET,{alg:'HS512'}),settings),false);
 const token=sign(claims()),[h,,sig]=token.split('.');
 assert.equal(verifySessionToken(h+'.'+b64(claims({aud:CLIENT_ID,dest:SHOP,exp:now()+3000}))+'.'+sig,settings),false,'tampered payload');
 assert.equal(verifySessionToken(h+'.'+token.split('.')[1]+'.',settings),false,'no signature');
 for(const bad of [undefined,null,'',42,'a.b','a.b.c.d','x'.repeat(5000),'@@@.@@@.@@@'])assert.equal(verifySessionToken(bad,settings),false);
});

test('Configuration, filters and missing-product aggregation (unit)',()=>{
 assert.equal(feedbackConfig({},SHOP).state,'DISABLED');
 assert.equal(feedbackConfig({SHOPIFY_CLIENT_ID:CLIENT_ID,SHOPIFY_CLIENT_SECRET:SECRET},SHOP).state,'ENABLED');
 const bad=feedbackConfig({SHOPIFY_CLIENT_ID:CLIENT_ID,SHOPIFY_CLIENT_SECRET:'short'},SHOP);
 assert.equal(bad.state,'MISCONFIGURED');assert.ok(!JSON.stringify(bad).includes('short'),'never echoes a value');
 // No Google review request belongs to the feedback feature: a GOOGLE_REVIEW_URL value is simply ignored.
 const withReview=feedbackConfig({SHOPIFY_CLIENT_ID:CLIENT_ID,SHOPIFY_CLIENT_SECRET:SECRET,GOOGLE_REVIEW_URL:REVIEW},SHOP);
 assert.equal(withReview.state,'ENABLED');assert.doesNotMatch(JSON.stringify({...withReview,clientSecret:null}),/review|google/i);
 assert.deepEqual(feedbackFilters({rating:'9',missing:'maybe',problem:'yes',from:'2026-02-30',to:'2026-11-20',page:'-2'}),{rating:'',missing:'',problem:'yes',from:'',to:'2026-11-20',page:1});
 assert.deepEqual(feedbackFilters({rating:['1','2']}).rating,'','arrays are ignored');
 const at=(d:number)=>new Date(Date.UTC(2026,10,d)).toISOString();
 assert.deepEqual(aggregateMissingProducts([
  {text:'מגבונים לחים, אקונומיקה',at:at(3)},{text:'  מגבונים   לחים!!',at:at(5)},{text:'Fairy\nfairy / ספוג',at:at(4)},{text:'אקונומיקה; אקונומיקה',at:at(1)},{text:'x',at:at(2)}]),
  [{text:'מגבונים לחים',count:2,lastAt:at(5)},{text:'אקונומיקה',count:2,lastAt:at(3)},{text:'Fairy',count:1,lastAt:at(4)},{text:'ספוג',count:1,lastAt:at(4)}],
  'grouped case- and punctuation-insensitively, once per response, most mentioned first');
});

test('Post-purchase feedback endpoint and admin dashboard',{timeout:300000},async t=>{
 const f=await adminFixture({env:{SHOPIFY_CLIENT_ID:CLIENT_ID,SHOPIFY_CLIENT_SECRET:SECRET,GOOGLE_REVIEW_URL:REVIEW}});
 const url=f.cfg.origin+'/api/post-purchase-feedback';
 const resetLimits=()=>f.db.query('DELETE FROM request_limits');
 const send=(body:unknown,options:{token?:string|null;type?:string;raw?:string;origin?:string}={})=>fetch(url,{method:'POST',
  headers:{...(options.token===null?{}:{Authorization:'Bearer '+(options.token??sign(claims()))}),'Content-Type':options.type??'application/json',...(options.origin?{Origin:options.origin}:{})},
  body:options.raw??JSON.stringify(body)});
 const rows=async()=>(await f.db.query('SELECT * FROM post_purchase_feedback ORDER BY created_at,id')).rows;
 try{
  await t.test('a valid response is stored once, with the generic answer and open CORS without credentials',async()=>{
   const body=valid({orderId:'gid://shopify/Order/1001',missingProducts:true,missingProductsDetails:'מגבונים לחים',encounteredProblem:true,problemDetails:'התשלום נתקע',improvementFeedback:'משלוח מהיר יותר'});
   const response=await send(body,{origin:'https://extensions.shopifycdn.com'});
   assert.equal(response.status,200);
   assert.deepEqual(await response.json(),{ok:true,message:FEEDBACK_SUCCESS_MESSAGE});
   assert.equal(response.headers.get('access-control-allow-origin'),'*');
   assert.equal(response.headers.get('access-control-allow-credentials'),null);
   assert.equal(response.headers.get('set-cookie'),null);
   const [row]=await rows();
   assert.equal(row.shopify_order_id,'1001');assert.equal(row.confirmation_number,'X7K2P9QA');assert.equal(row.rating,4);
   assert.equal(row.missing_products,true);assert.equal(row.missing_products_details,'מגבונים לחים');
   assert.equal(row.encountered_problem,true);assert.equal(row.problem_details,'התשלום נתקע');assert.equal(row.improvement_feedback,'משלוח מהיר יותר');
   assert.equal(row.source,'thank-you');assert.equal(row.version,1);
   const preflight=await fetch(url,{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'}});
   assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'*');
   assert.match(preflight.headers.get('access-control-allow-headers')||'',/Authorization/);
  });

  await t.test('no customer data is stored: only order identifiers and answers',async()=>{
   const columns=(await f.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='post_purchase_feedback' ORDER BY column_name")).rows.map((r:any)=>r.column_name);
   assert.deepEqual(columns,['confirmation_number','created_at','encountered_problem','id','improvement_feedback','missing_products','missing_products_details','problem_details','rating','shopify_order_id','source','updated_at','version']);
   const dump=JSON.stringify(await rows());
   assert.ok(!dump.includes('987654321012'),'the token subject (customer id) is never stored');
   assert.ok(!dump.includes(CLIENT_ID)&&!dump.includes(SHOP),'nor token claims');
  });

  await t.test('one response per order: repeats (even different answers) and concurrent submissions change nothing',async()=>{
   const first=valid({orderId:'gid://shopify/Order/2002',rating:5});
   assert.equal((await send(first)).status,200);
   const again=await send({...first,rating:1,encounteredProblem:true,problemDetails:'ניסיון לשנות'});
   assert.equal(again.status,200);assert.deepEqual(await again.json(),{ok:true,message:FEEDBACK_SUCCESS_MESSAGE},'same answer: never reveals that the order already answered');
   const burst=await Promise.all(Array.from({length:6},(_,i)=>send(valid({orderId:'gid://shopify/Order/3003',rating:1+(i%5)}))));
   assert.deepEqual(burst.map(r=>r.status),[200,200,200,200,200,200]);
   const stored=(await rows()).filter((r:any)=>['2002','3003'].includes(r.shopify_order_id));
   assert.equal(stored.length,2);assert.equal(stored.find((r:any)=>r.shopify_order_id==='2002').rating,5);
   assert.equal(stored.find((r:any)=>r.shopify_order_id==='2002').problem_details,null);
  });

  await t.test('authentication: a valid Shopify session token for this app and shop is required (Origin is not proof)',async()=>{
   await resetLimits();const before=(await rows()).length;
   const cases:[string,string|null][]=[['no token',null],['garbage','not-a-token-at-all-xxxxxxxx'],['wrong secret',sign(claims(),'another-secret-of-a-different-app-0000')],
    ['other shop',sign(claims({dest:'other-shop.myshopify.com'}))],['other app',sign(claims({aud:'other-app-client'}))],['expired',sign(claims({exp:now()-30}))],['alg none',sign(claims(),SECRET,{alg:'none'})]];
   for(const [label,token] of cases){
    const response=await send(valid(),{token,origin:'https://fanakee.com'});
    assert.equal(response.status,401,label);
    const json=await response.json();assert.equal(json.code,'FEEDBACK_AUTH_REQUIRED',label);
    assert.ok(!JSON.stringify(json).match(/secret|aud|dest|exp/i),'never says why: '+label);
   }
   const basic=await fetch(url,{method:'POST',headers:{Authorization:'Basic '+Buffer.from('a:b').toString('base64'),'Content-Type':'application/json'},body:JSON.stringify(valid())});
   assert.equal(basic.status,401);
   assert.equal((await rows()).length,before,'nothing stored');
  });

  await t.test('strict JSON: unknown fields, invalid ratings, oversized text and bodies, card numbers, wrong content type',async()=>{
   await resetLimits();const before=(await rows()).length;
   const expect=async(response:Response,status:number,code:string)=>{assert.equal(response.status,status,code);const json=await response.json();assert.equal(json.code,code);return json;};
   await expect(await send(valid({email:'a@b.co'})),400,'INVALID_INPUT');
   const invalid=await expect(await send(valid({rating:6})),400,'INVALID_FEEDBACK');
   assert.deepEqual(invalid.fields,{rating:'INVALID'});
   await expect(await send(valid({rating:0})),400,'INVALID_FEEDBACK');
   await expect(await send(valid({improvementFeedback:'א'.repeat(1001)})),400,'INVALID_FEEDBACK');
   await expect(await send(valid({missingProducts:false,missingProductsDetails:'סבון'})),400,'INVALID_FEEDBACK');
   await expect(await send(valid({improvementFeedback:'<script>alert(1)</script>'})),400,'INVALID_FEEDBACK');
   await expect(await send(null,{raw:JSON.stringify(valid({improvementFeedback:'א'.repeat(9000)}))}),413,'BODY_TOO_LARGE');
   await expect(await send(null,{raw:'{"rating":'}),400,'INVALID_INPUT');
   assert.deepEqual((await expect(await send(valid({improvementFeedback:'הכרטיס שלי 4111-1111-1111-1111 נדחה'})),400,'INVALID_FEEDBACK')).fields,{improvementFeedback:'INVALID'},'a card number inside free text');
   await expect(await send(valid({improvementFeedback:'4111 1111 1111 1111'})),400,'CARD_DATA_NOT_ACCEPTED');
   await expect(await send(valid(),{type:'text/plain'}),415,'INVALID_CONTENT_TYPE');
   await expect(await send(null,{raw:new URLSearchParams({rating:'5'}).toString(),type:'application/x-www-form-urlencoded'}),415,'INVALID_CONTENT_TYPE');
   // The largest valid response (500 + 1000 + 1000 Hebrew characters) fits the body limit.
   const largest=await send(valid({missingProducts:true,missingProductsDetails:'א'.repeat(500),encounteredProblem:true,problemDetails:'ב'.repeat(1000),improvementFeedback:'ג'.repeat(1000)}));
   assert.equal(largest.status,200);
   assert.equal((await rows()).length,before+1);
  });

  await t.test('rate limiting: 30 submissions per address per 10 minutes, then 429',async()=>{
   await resetLimits();
   const statuses:number[]=[];for(let i=0;i<31;i++)statuses.push((await send(valid())).status);
   assert.deepEqual(statuses.slice(0,30),Array(30).fill(200));
   assert.equal(statuses[30],429);
   const limited=await send(valid());assert.equal(limited.status,429);assert.equal((await limited.json()).code,'RATE_LIMITED');
   assert.equal((await send(valid(),{token:null})).status,429,'bad tokens count against the same budget');
   await resetLimits();
  });

  await t.test('no Google review functionality: no review link endpoint, nothing review-related stored or returned',async()=>{
   const response=await fetch(url+'/config');
   assert.equal(response.status,404,'the review link endpoint does not exist, even with GOOGLE_REVIEW_URL set');
   assert.doesNotMatch(await response.text(),/g\.page|googleReviewUrl/);
   const columns=(await f.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='post_purchase_feedback'")).rows.map((r:any)=>r.column_name);
   assert.ok(columns.length>0);assert.deepEqual(columns.filter((c:string)=>/review|google|click/i.test(c)),[],'no review click is stored');
   assert.equal((await send({...valid(),reviewClicked:true})).status,400,'a review field is refused like any unknown field');
   const {cookie}=await f.login();
   assert.doesNotMatch(await(await fetch(f.cfg.origin+'/admin/feedback',{headers:{Cookie:cookie}})).text(),/GOOGLE_REVIEW_URL|ביקורת בגוגל/);
  });

  await t.test('admin: login required; summary, average and percentages; filters; missing products; escaping',async()=>{
   const anonymous=await fetch(f.cfg.origin+'/admin/feedback',{redirect:'manual'});
   assert.equal(anonymous.status,303);assert.ok((anonymous.headers.get('location')||'').startsWith('/admin?expired=1'));
   await f.db.query('DELETE FROM post_purchase_feedback');
   const day=(d:number,h=12)=>new Date(Date.UTC(2026,9,d,h-3)).toISOString(); // Israel noon (UTC+3 in October)
   const insert=(order:string,at:string,rating:number,missing:string|null,problem:string|null,improve:string|null=null)=>f.db.query(`INSERT INTO post_purchase_feedback(id,created_at,updated_at,shopify_order_id,confirmation_number,rating,missing_products,missing_products_details,encountered_problem,problem_details,improvement_feedback)
    VALUES(gen_random_uuid(),$1,$1,$2,'CONF'||$2,$3,$4,$5,$6,$7,$8)`,[at,order,rating,missing!==null,missing||null,problem!==null,problem||null,improve]);
   await insert('11',day(1),5,null,null,'הכול "מעולה" & מהיר');
   await insert('12',day(2),4,'מגבונים לחים, אקונומיקה',null);
   await insert('13',day(3),2,'מגבונים לחים',"הכפתור <לא> הגיב");
   await insert('14',day(4),1,'',"נתקע בתשלום");
   await insert('15',day(5,1),3,'Fairy',null); // 01:00 Israel time on Oct 5 is still Oct 4 in UTC
   const {cookie}=await f.login();
   const page=async(search='')=>{const r=await fetch(f.cfg.origin+'/admin/feedback'+search,{headers:{Cookie:cookie}});assert.equal(r.status,200);return r.text();};
   const metric=(html:string,key:string)=>html.match(new RegExp('data-feedback-metric="'+key+'"><span class="metric__label">[^<]*</span><strong class="metric__value">([^<]*)<'))?.[1];
   const all=await page();
   assert.match(all,/<html lang="he" dir="rtl">/);
   // 5 responses; average (5+4+2+1+3)/5 = 3; missing 4/5 = 80%; problem 2/5 = 40%.
   assert.deepEqual(['responses','average','missing','problem'].map(k=>metric(all,k)),['5','3 מתוך 5','80%','40%']);
   assert.match(all,/מוצרים שלקוחות חיפשו ולא מצאו/);
   const terms=[...all.matchAll(/<span class="fb-terms__text">([^<]+)<\/span> <span class="tag">([^<]+)<\/span>/g)].map(m=>m[1]+':'+m[2]);
   assert.deepEqual(terms,['מגבונים לחים:2 פעמים','Fairy:פעם אחת','אקונומיקה:פעם אחת']);
   assert.ok(all.includes('הכול &quot;מעולה&quot; &amp; מהיר')&&all.includes('הכפתור &lt;לא&gt; הגיב'),'free text is escaped');
   assert.ok(all.includes('https://admin.shopify.com/store/example/orders/13'),'links to the order in Shopify admin');
   assert.ok(all.includes('CONF13'));
   // Filters: rating, missing, problem and Israel-time date range; averages and percentages follow the filter.
   const two=await page('?rating=2');assert.deepEqual(['responses','average'].map(k=>metric(two,k)),['1','2 מתוך 5']);
   const missingNo=await page('?missing=no');assert.deepEqual(['responses','missing'].map(k=>metric(missingNo,k)),['1','0%']);
   const problem=await page('?problem=yes');assert.deepEqual(['responses','average','problem'].map(k=>metric(problem,k)),['2','1.5 מתוך 5','100%']);
   assert.equal(metric(await page('?missing=yes&problem=no'),'responses'),'2');
   assert.equal(metric(await page('?from=2026-10-02&to=2026-10-04'),'responses'),'3','Oct 2-4 inclusive, Israel time');
   assert.equal(metric(await page('?from=2026-10-05'),'responses'),'1','01:00 Israel time on Oct 5 belongs to Oct 5');
   const empty=await page('?rating=5&missing=yes');
   assert.deepEqual(['responses','average','missing'].map(k=>metric(empty,k)),['0','—','—']);
   assert.match(empty,/אין תשובות שמתאימות לסינון/);
   // Junk filters are ignored, never echoed unescaped.
   const junk=await page('?rating=%3Cscript%3E&from=%22%3E%3Cb%3E');assert.equal(metric(junk,'responses'),'5');assert.ok(!junk.includes('<script>')&&!junk.includes('"><b>'));
   assert.doesNotMatch(all,/987654321012|test-app-secret/,'no token data or secrets');
  });
 }finally{await f.close();}
});

test('Feedback without the app credentials: refused (503) while the admin page still works',{timeout:120000},async()=>{
 const f=await adminFixture({env:{}});
 try{
  const response=await fetch(f.cfg.origin+'/api/post-purchase-feedback',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sign(claims())},body:JSON.stringify(valid())});
  assert.equal(response.status,503);assert.equal((await response.json()).code,'FEEDBACK_UNAVAILABLE');
  assert.equal(response.headers.get('access-control-allow-origin'),'*','the extension can read the failure');
  const {cookie}=await f.login();
  const html=await(await fetch(f.cfg.origin+'/admin/feedback',{headers:{Cookie:cookie}})).text();
  assert.match(html,/data-feedback-warnings/);assert.match(html,/SHOPIFY_CLIENT_ID/);assert.doesNotMatch(html,/GOOGLE_REVIEW_URL/);
  assert.match(html,/עדיין לא התקבלו תשובות לשאלון/);
 }finally{await f.close();}
});
