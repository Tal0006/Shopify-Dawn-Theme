const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
// Every file the theme ships to the storefront (tools/, tests/ and docs are not uploaded).
const shipped=['assets','layout','sections','snippets','templates','config','locales'].flatMap(dir=>fs.readdirSync(path.join(root,dir),{recursive:true}).map(file=>path.join(dir,String(file)))).filter(file=>fs.statSync(path.join(root,file)).isFile()&&/\.(js|liquid|json)$/.test(file));
test('the retired create-on-search route never returns to shipped storefront code',()=>{
 assert.ok(shipped.some(file=>file.endsWith('group-delivery.js')),'storefront script found');
 for(const file of shipped){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  assert.ok(!/find-?or-?create/i.test(text),file+' references the retired find-or-create flow');
 }
});
test('Group Delivery searches only through /groups/find and creates only through Join',()=>{
 const script=fs.readFileSync(path.join(root,'assets/group-delivery.js'),'utf8');
 const endpoints=[...script.matchAll(/this\.api\(\s*'([^']+)'/g)].map(match=>match[1]);
 assert.ok(endpoints.includes('/groups/find'),'searches with /groups/find');
 assert.ok(endpoints.includes('/areas')&&endpoints.includes('/areas/nearest'),'area endpoints');
 const groupRoutes=new Set(endpoints.filter(endpoint=>endpoint.startsWith('/groups')));
 assert.deepEqual([...groupRoutes].sort(),['/groups/','/groups/find'].sort(),'only these literal group routes; joins/updates are built from the group id');
 assert.match(script,/'\/groups\/join'/,'area join (create on Join) is the only creating path');
});
