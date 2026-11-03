const {syncBuiltinESMExports}=require('node:module');
const allowed=value=>{
  let host;
  if(typeof value==='string'||value instanceof URL){host=new URL(value).hostname;}
  else host=value?.hostname||value?.host||'localhost';
  return ['127.0.0.1','localhost','::1','[::1]'].includes(host);
};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,...args)=>{
  const url=typeof input==='string'||input instanceof URL?input:input.url;
  if(!allowed(url))return Promise.reject(new Error('External HTTP is disabled in automated tests; inject a mock.'));
  return originalFetch(input,...args);
};
for(const name of ['node:http','node:https']){
  const module=require(name);
  for(const method of ['request','get']){
    const original=module[method];
    module[method]=function(input,...args){
      if(!allowed(input))throw new Error('External HTTP is disabled in automated tests; inject a mock.');
      return original.call(this,input,...args);
    };
  }
}
syncBuiltinESMExports();
