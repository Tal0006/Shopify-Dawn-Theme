// Browser harness for tests/feedback.test.tsx: mounts the real FeedbackBlock (Preact) next to a stand-in order
// confirmation, with a fake Thank you page API and fake fetch. The s-* elements are minimal stand-ins for Shopify's
// Polaris web components (the real ones only exist inside checkout): they keep the same property and event contract
// the block relies on (values/change on choice lists, value/input on text areas, click on buttons, disabled).
import {render} from 'preact';
import {FeedbackBlock,type SurveyApi} from '../src/FeedbackBlock';
import he from '../locales/he.default.json';

type Mode='ok'|'down'|'error'|'slow';
const w=window as any;
w.requests=[] as {url:string;method:string;headers:Record<string,string>;body:string}[];
w.storageWrites=[] as {key:string;data:unknown}[];

class Choice extends HTMLElement {connectedCallback(){this.setAttribute('role','radio');this.tabIndex=0;this.addEventListener('click',()=>this.closest('s-choice-list')?.dispatchEvent(Object.assign(new Event('pick'),{value:this.getAttribute('value')})));}}
class ChoiceList extends HTMLElement {
 private current:string[]=[];
 get values(){return this.current;} set values(v:string[]){this.current=Array.isArray(v)?v:[];this.sync();}
 set label(v:string){this.setAttribute('data-label',v);} set error(v:string|undefined){if(v)this.setAttribute('data-error',v);else this.removeAttribute('data-error');}
 connectedCallback(){this.setAttribute('role','radiogroup');this.addEventListener('pick',(e:any)=>{if(this.hasAttribute('disabled'))return;this.current=[e.value];this.sync();this.dispatchEvent(new Event('change'));});this.sync();}
 private sync(){for(const c of this.querySelectorAll('s-choice'))c.setAttribute('aria-checked',String(this.current.includes(c.getAttribute('value')||'')));}
}
class TextArea extends HTMLElement {
 private area=document.createElement('textarea');
 get value(){return this.area.value;} set value(v:string){if(this.area.value!==v)this.area.value=v??'';}
 set label(v:string){this.setAttribute('data-label',v);this.area.setAttribute('aria-label',v);}
 set maxLength(v:number){this.area.maxLength=v;}
 connectedCallback(){if(!this.contains(this.area))this.append(this.area);}
}
class Button extends HTMLElement {
 connectedCallback(){this.setAttribute('role',this.hasAttribute('href')?'link':'button');this.tabIndex=0;
  // Like the real component: a disabled button does not fire click.
  this.addEventListener('click',e=>{if(this.hasAttribute('disabled'))e.stopImmediatePropagation();},{capture:true});}
}
for(const [name,ctor] of [['s-choice',Choice],['s-choice-list',ChoiceList],['s-text-area',TextArea],['s-button',Button]] as const)customElements.define(name,ctor as CustomElementConstructor);
for(const name of ['s-section','s-stack','s-paragraph','s-text','s-banner'])customElements.define(name,class extends HTMLElement {});

const interpolate=(text:string,options?:Record<string,unknown>)=>text.replace(/\{\{(\w+)\}\}/g,(_,k)=>String(options?.[k]??''));
w.mount=(options:{mode?:Mode;submitted?:string|null;order?:string|null;editor?:boolean}={})=>{
 const root=document.getElementById('block')!;render(null,root);
 w.requests.length=0;w.storageWrites.length=0;
 const store=new Map<string,unknown>(options.submitted?[['feedback-submitted-v1',options.submitted]]:[]);
 const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
 const fetcher=async(url:string,init:RequestInit={})=>{
  w.requests.push({url,method:init.method||'GET',headers:{...(init.headers as Record<string,string>)},body:String(init.body??'')});
  const mode=options.mode||'ok';
  if(mode==='down')throw new TypeError('Failed to fetch');
  await new Promise(r=>setTimeout(r,mode==='slow'?400:30));
  return mode==='error'?respond({error:'x',code:'SERVICE_UNAVAILABLE'},503):respond({ok:true,message:he.success});
 };
 const api:SurveyApi={
  i18n:{translate:(key,opts)=>interpolate((he as Record<string,string>)[key]??key,opts)},
  orderConfirmation:{value:options.order===null?undefined:{order:{id:options.order||'gid://shopify/Order/4242'},number:'X7K2P9QA'}},
  sessionToken:{get:async()=>'header.payload.signature-for-tests'},
  storage:{read:async<T,>(key:string)=>(store.get(key)??null) as T|null,write:async(key:string,data:unknown)=>{w.storageWrites.push({key,data});store.set(key,data);}},
  extension:{editor:options.editor?{type:'checkout'}:undefined},
 };
 render(<FeedbackBlock api={api} fetcher={fetcher}/>,root);
};
