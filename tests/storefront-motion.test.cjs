const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../assets/storefront-motion.js'),'utf8');
function fixture({reduced=false,paused=false,editor=false,support=true}={}){
 const nodes=[element(20),element(1500)],events={},windowEvents={},observers=[];
 function element(top){return {top,dataset:{},style:{setProperty(){},removeProperty(){}},parentElement:null,getBoundingClientRect(){throw Error('setup must not read layout');},hasAttribute(name){return name==='data-storefront-reveal'&&this.dataset.storefrontReveal!==undefined;}};}
 const home={querySelectorAll(selector){return selector==='[data-storefront-reveal]'?nodes.filter(n=>n.hasAttribute('data-storefront-reveal')):nodes;},contains:()=>true};
 const root={hasAttribute:()=>paused};
 const media={matches:reduced,addEventListener(_name,fn){this.change=fn;}};
 class IO{constructor(callback){this.callback=callback;this.observed=[];this.removed=[];observers.push(this);}observe(n){this.observed.push(n);}unobserve(n){this.removed.push(n);}disconnect(){this.disconnected=true;}}
 class MO{constructor(cb){this.callback=cb;}observe(){fixture.preferenceCallback=this.callback;}disconnect(){this.disconnected=true;}}
 const window={Shopify:{designMode:editor},matchMedia:()=>media,addEventListener:(name,fn)=>windowEvents[name]=fn};
 if(support)window.IntersectionObserver=IO;
 const document={documentElement:root,querySelector:()=>home,addEventListener:(name,fn)=>events[name]=fn};
 vm.runInNewContext(source,{window,document,IntersectionObserver:IO,MutationObserver:MO,innerHeight:800});
 // The observer's first report: on screen (top < 800) or not.
 const first=(list=nodes)=>observers[0].callback(list.map(target=>({target,isIntersecting:target.top<800})));
 return {nodes,observers,media,events,windowEvents,home,element,first,pause(){paused=true;fixture.preferenceCallback();}};
}
test('Visible content is never hidden and below-fold content reveals once',()=>{
 const f=fixture(),observer=f.observers[0];
 assert.deepEqual(observer.observed,f.nodes,'all targets observed; nothing hidden before the first report');
 assert.ok(f.nodes.every(n=>n.dataset.storefrontReveal===undefined));
 f.first();
 assert.equal(f.nodes[0].dataset.storefrontReveal,'visible');assert.ok(observer.removed.includes(f.nodes[0]));assert.equal(f.nodes[1].dataset.storefrontReveal,'pending');
 observer.callback([{target:f.nodes[1],isIntersecting:true}]);
 assert.equal(f.nodes[1].dataset.storefrontReveal,'visible');assert.ok(observer.removed.includes(f.nodes[1]));
 observer.callback([{target:f.nodes[1],isIntersecting:false}]);assert.equal(f.nodes[1].dataset.storefrontReveal,'visible');
});
test('Reduced motion, accessibility pause, Theme Editor and missing observer leave content visible',()=>{
 for(const options of [{reduced:true},{paused:true},{editor:true},{support:false}]){
  const f=fixture(options);assert.ok(f.nodes.every(n=>n.dataset.storefrontReveal!=='pending'));assert.equal(f.observers.length,0);
 }
});
test('Runtime reduced-motion and accessibility changes immediately reveal pending content',()=>{
 for(const action of ['reduce','pause']){
  const f=fixture();f.first();if(action==='reduce'){f.media.matches=true;f.media.change();}else f.pause();
  assert.ok(f.nodes.every(n=>n.dataset.storefrontReveal==='visible'));assert.equal(f.observers[0].disconnected,true);
 }
});
test('Section reloads do not replay existing reveals; unloading cleans observation',()=>{
 const f=fixture(),observer=f.observers[0];f.first();
 f.events['shopify:section:load']({target:f.home});assert.equal(observer.observed.length,2,'no node observed twice');
 const added=f.element(2000);f.nodes.push(added);f.events['shopify:section:load']({target:f.home});assert.equal(observer.observed.length,3);
 f.first([added]);assert.equal(added.dataset.storefrontReveal,'pending');
 f.events['shopify:section:unload']({target:f.home});assert.ok(observer.removed.includes(added));
});
test('Page exit releases observations and leaves content visible for history restoration',()=>{
 const f=fixture();f.first();f.windowEvents.pagehide();assert.ok(f.nodes.every(n=>n.dataset.storefrontReveal==='visible'));
 assert.equal(f.observers[0].disconnected,true);
});
