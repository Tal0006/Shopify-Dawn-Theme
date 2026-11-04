import {createHash} from 'node:crypto';
import type {WhatsAppSession,WhatsAppSessionStore} from './whatsapp-types.js';
export class MemoryWhatsAppSessionStore implements WhatsAppSessionStore {
 private sessions=new Map<string,WhatsAppSession>();
 private seen=new Map<string,number>();
 private limits=new Map<string,{count:number;expires:number}>();
 constructor(private now=Date.now){}
 private key(customer:string){return createHash('sha256').update(customer).digest('hex');}
 private prune(){
  const now=this.now();
  for(const [k,v] of this.sessions)if(v.expiresAt<=now)this.sessions.delete(k);
  for(const [k,v] of this.seen)if(v<=now)this.seen.delete(k);
  for(const [k,v] of this.limits)if(v.expires<=now)this.limits.delete(k);
 }
 get(customer:string){this.prune();const s=this.sessions.get(this.key(customer));return s?structuredClone(s):undefined;}
 set(customer:string,s:WhatsAppSession){
  this.prune();const key=this.key(customer);
  if(!this.sessions.has(key)&&this.sessions.size>=500)throw Error('WHATSAPP_CAPACITY');
  this.sessions.set(key,structuredClone(s));
 }
 delete(customer:string){this.sessions.delete(this.key(customer));}
 claimMessage(id:string){
  this.prune();if(this.seen.has(id))return false;
  // Fail closed rather than evict recent IDs and permit duplicate checkout work.
  if(this.seen.size>=10000)throw Error('WHATSAPP_CAPACITY');
  this.seen.set(id,this.now()+86400000);return true;
 }
 allow(customer:string){
  this.prune();const key=this.key(customer),v=this.limits.get(key);
  if(v){v.count++;return v.count<=10;}
  if(this.limits.size>=1000)return false;
  this.limits.set(key,{count:1,expires:this.now()+60000});return true;
 }
}
