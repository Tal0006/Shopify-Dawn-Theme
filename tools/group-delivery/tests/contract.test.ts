// Storefront/server error-code contract. Fails when the service adds or renames a public code that the
// Group Delivery section does not map, or when the storefront maps or throws a code nobody produces.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PUBLIC_ERROR_CODES,ADMIN_ERROR_CODES,CANCELLATION_ENDPOINT_CODES,CANCELLATION_ERROR_CODES} from '../src/domain.js';
const theme=new URL('../../../',import.meta.url);
const read=(path:string)=>readFileSync(new URL(path,theme),'utf8');
// Browser-side failures owned by assets/group-delivery.js; DEFAULT is the fallback message.
const CLIENT_CODES=['CART_EMPTY','CART_READ_FAILED','CART_CURRENCY','REQUEST_TIMEOUT','NETWORK_ERROR','INVALID_RESPONSE','AREA_REQUIRED','AREAS_EMPTY','RESTORE_FAILED','DEFAULT'];
const section=read('sections/group-delivery.liquid');
const table=section.match(/assign group_errors = '([^']+)' \| split: ','/)?.[1];
const mapping=new Map((table||'').split(',').map(entry=>entry.split(':') as [string,string]));
const locale=(file:string)=>JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,'')).group_delivery as Record<string,unknown>;

test('every public service error code has a storefront message',()=>{
 assert.ok(table,'data-group-errors table not found in sections/group-delivery.liquid');
 for(const code of PUBLIC_ERROR_CODES)assert.ok(mapping.has(code),'Unmapped public error code: '+code);
});
test('the storefront maps only codes that the service or browser can produce',()=>{
 const known=new Set<string>([...PUBLIC_ERROR_CODES,...CLIENT_CODES]);
 for(const code of mapping.keys())assert.ok(known.has(code),'Mapped code is never produced: '+code);
 for(const code of ADMIN_ERROR_CODES)assert.ok(!mapping.has(code),'Admin-only code exposed to shoppers: '+code);
 for(const code of CLIENT_CODES)assert.ok(mapping.has(code),'Unmapped browser error code: '+code);
});
test('the client script raises only mapped codes',()=>{
 const script=read('assets/group-delivery.js');
 const raised=[...script.matchAll(/failure\('([A-Z_]+)'\)/g)].map(match=>match[1]);
 assert.ok(raised.length>0);
 for(const code of raised)assert.ok(mapping.has(code),'Client raises unmapped code: '+code);
 assert.ok(!/GROUP_NOT_OPEN/.test(script),'Legacy GROUP_NOT_OPEN code must not return');
});
test('every mapped message exists in the Hebrew default and English locales',()=>{
 for(const file of ['locales/he.default.json','locales/en.json']){
  const strings=locale(file);
  for(const [code,key] of mapping)assert.equal(typeof strings[key],'string',file+': missing group_delivery.'+key+' for '+code);
  assert.equal(typeof strings.waking,'string',file+': missing group_delivery.waking');
 }
});

// Cancellation form (sections/cancellation-request.liquid): its ERRORS table must cover every code the endpoint answers
// plus the browser-side failures, and must never map a Group Delivery-only or admin-only code.
test('the cancellation form maps every code the cancellation endpoint can answer',()=>{
 const section=read('sections/cancellation-request.liquid');
 const table=section.match(/const ERRORS = \{([\s\S]*?)\};/)?.[1];
 assert.ok(table,'ERRORS table not found in sections/cancellation-request.liquid');
 const mapped=new Map([...table.matchAll(/([A-Z_]+): '([a-z]+)'/g)].map(m=>[m[1],m[2]]));
 const client=['REQUEST_TIMEOUT','NETWORK_ERROR','INVALID_RESPONSE','DEFAULT'];
 for(const code of [...CANCELLATION_ENDPOINT_CODES,...client])assert.ok(mapped.has(code),'Unmapped cancellation code: '+code);
 const known=new Set<string>([...CANCELLATION_ENDPOINT_CODES,...client]);
 for(const code of mapped.keys())assert.ok(known.has(code),'Mapped code is never produced: '+code);
 for(const group of mapped.values())assert.ok(['fields','card','rate','unavailable'].includes(group),group);
 for(const group of ['fields','card','rate','unavailable'])assert.match(section,new RegExp('data-error-'+group+'="'),'message attribute for '+group);
 for(const code of ADMIN_ERROR_CODES)assert.ok(!mapped.has(code),'Admin-only code exposed: '+code);
 for(const code of CANCELLATION_ERROR_CODES.filter(c=>!(CANCELLATION_ENDPOINT_CODES as readonly string[]).includes(c)))assert.ok(!mapped.has(code),'Admin-only cancellation code exposed: '+code);
 for(const file of ['locales/he.default.json','locales/en.json']){
  const strings=JSON.parse(read(file).replace(/^\s*\/\*[\s\S]*?\*\//,'')).cancellation_request as Record<string,unknown>;
  for(const key of ['error_fields','error_card','error_rate','error_unavailable','waking'])assert.equal(typeof strings[key],'string',file+': cancellation_request.'+key);
 }
});
