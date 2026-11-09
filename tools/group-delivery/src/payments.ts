import {randomBytes} from 'node:crypto';
import {ApiError} from './domain.js';
// Provider-neutral payment boundary. Group Delivery code depends only on this interface; every provider-specific
// identifier is an opaque string that is stored server-side and never returned to browsers, rendered or logged.
// No implementation may receive, store or forward card numbers, expiry dates or CVV: card entry happens on the
// provider's own hosted page/fields, and only a tokenized payment-method reference comes back.

/** Where the browser goes to verify a payment method. `mock` is the development control; real providers redirect. */
export type VerificationNext={type:'mock'}|{type:'redirect';url:string};
export type VerificationStatus=
 |{status:'PENDING'}
 |{status:'VERIFIED';paymentMethodRef:string}
 |{status:'FAILED';failureCode:'DECLINED'|'PROVIDER_ERROR'}
 |{status:'CANCELLED'};
export type FailureCode='DECLINED'|'PROVIDER_ERROR';
export type ChargeResult=
 |{status:'SUCCEEDED';chargeRef:string;amountAgorot:bigint}
 |{status:'FAILED';failureCode:FailureCode}
 |{status:'PENDING'};
export type AuthorizationResult=
 |{status:'AUTHORIZED';authorizationRef:string;amountAgorot:bigint}
 |{status:'FAILED';failureCode:FailureCode}
 |{status:'PENDING'};
export interface ChargeRequest {
 paymentMethodRef:string;
 /** Integer agorot from the server's stored, member-approved amount; never from a request body. */
 amountAgorot:bigint;
 currency:'ILS';
 /** Same key for every submission of one attempt; the provider must return the original result for a repeat. */
 idempotencyKey:string;
 /** Our opaque member-scoped reference (no PII) for provider-side reconciliation. */
 reference:string;
}
export interface PaymentProvider {
 /** Stored with each verification so money is only ever moved by the provider that issued the reference. */
 readonly name:string;
 /** True only for the development simulator; gates the mock-result route and the storefront test control. */
 readonly simulated:boolean;
 /** Exact hostnames a redirect verification may send the shopper to. Any other URL is refused. */
 readonly redirectHosts?:readonly string[];
 /**
  * Preferred production flow: authorize every approved member, capture only once the authorized total covers the
  * group target, void otherwise. When false, the direct-charge fallback (createCharge) is used.
  */
 readonly supportsAuthorization:boolean;
 /** Start tokenization/verification without charging. `reference` is our verification public id. */
 createVerificationSession(input:{reference:string;idempotencyKey:string}):Promise<{sessionRef:string;next:VerificationNext}>;
 /** Authoritative status, read from the provider (never from the browser). */
 getVerificationStatus(sessionRef:string):Promise<VerificationStatus>;
 /** Direct charge (fallback when authorization/capture is unsupported). Idempotent per key. */
 createCharge(input:ChargeRequest):Promise<ChargeResult>;
 /** Lookup by idempotency key after a lost response; NOT_FOUND means the provider never received it. */
 getChargeStatus(idempotencyKey:string):Promise<ChargeResult|{status:'NOT_FOUND'}>;
 /** Reserve funds without moving money. Idempotent per key. Required when supportsAuthorization. */
 authorize?(input:ChargeRequest):Promise<AuthorizationResult>;
 /** Capture exactly the authorized amount. Idempotent per key. */
 capture?(input:{authorizationRef:string;amountAgorot:bigint;idempotencyKey:string}):Promise<ChargeResult>;
 /** Release an authorization that will not be captured. Idempotent per key. */
 voidAuthorization?(input:{authorizationRef:string;idempotencyKey:string}):Promise<{status:'VOIDED'}|{status:'FAILED'}>;
}

const unavailable=()=>new ApiError(503,'PAYMENTS_UNAVAILABLE','אימות אמצעי תשלום אינו זמין כרגע. נסו שוב מאוחר יותר.');
/** No provider configured: every payment operation fails closed, so nobody can join without verification. */
export class UnavailablePaymentProvider implements PaymentProvider {
 readonly name='none';readonly simulated=false;readonly supportsAuthorization=false;
 async createVerificationSession():Promise<never>{throw unavailable();}
 async getVerificationStatus():Promise<never>{throw unavailable();}
 async createCharge():Promise<never>{throw unavailable();}
 async getChargeStatus():Promise<never>{throw unavailable();}
}

export type MockOutcome='verified'|'failed'|'cancelled';
type Outcome='succeed'|'decline'|'error'|'lost-response';
/**
 * Development/test simulator. In memory, no network, no card data, no real money.
 * Outcomes: 'succeed', 'decline', 'error' (throws before the "provider" records anything) or 'lost-response'
 * (records the result, then throws as if the response never arrived). Repeating an idempotency key returns the
 * recorded result and never counts twice.
 */
export class MockPaymentProvider implements PaymentProvider {
 readonly name='mock';readonly simulated=true;
 /** Switch to false to exercise the direct-charge fallback. */
 supportsAuthorization=true;
 chargeOutcome:Outcome='succeed';authorizationOutcome:Outcome='succeed';captureOutcome:'succeed'|'error'|'decline'='succeed';
 /** Money actually moved: successful captures plus successful direct charges. */
 chargeCount=0;authorizationCount=0;voidCount=0;
 private sessions=new Map<string,VerificationStatus>();
 private charges=new Map<string,ChargeResult>();
 private authorizations=new Map<string,AuthorizationResult>();
 private captures=new Map<string,ChargeResult>();
 private voids=new Set<string>();
 private ref=(prefix:string)=>prefix+randomBytes(12).toString('hex');
 async createVerificationSession(){
  const sessionRef=this.ref('mock_vs_');this.sessions.set(sessionRef,{status:'PENDING'});
  return {sessionRef,next:{type:'mock'} as const};
 }
 /** Stands in for the shopper finishing (or abandoning) the provider's hosted verification page. */
 simulate(sessionRef:string,outcome:MockOutcome){
  if(this.sessions.get(sessionRef)?.status!=='PENDING')return;
  this.sessions.set(sessionRef,outcome==='verified'?{status:'VERIFIED',paymentMethodRef:this.ref('mock_pm_')}:outcome==='failed'?{status:'FAILED',failureCode:'DECLINED'}:{status:'CANCELLED'});
 }
 async getVerificationStatus(sessionRef:string):Promise<VerificationStatus>{return this.sessions.get(sessionRef)||{status:'PENDING'};}
 private valid(input:ChargeRequest){return /^mock_pm_[a-f0-9]{24}$/.test(input.paymentMethodRef)&&input.amountAgorot>0n&&input.currency==='ILS';}
 async createCharge(input:ChargeRequest):Promise<ChargeResult>{
  if(!this.valid(input))return {status:'FAILED',failureCode:'PROVIDER_ERROR'};
  const existing=this.charges.get(input.idempotencyKey);if(existing)return existing;
  if(this.chargeOutcome==='error')throw Error('simulated provider outage');
  const result:ChargeResult=this.chargeOutcome==='decline'?{status:'FAILED',failureCode:'DECLINED'}:{status:'SUCCEEDED',chargeRef:this.ref('mock_ch_'),amountAgorot:input.amountAgorot};
  this.charges.set(input.idempotencyKey,result);if(result.status==='SUCCEEDED')this.chargeCount++;
  if(this.chargeOutcome==='lost-response')throw Error('simulated lost provider response');
  return result;
 }
 async getChargeStatus(idempotencyKey:string){return this.charges.get(idempotencyKey)||{status:'NOT_FOUND' as const};}
 async authorize(input:ChargeRequest):Promise<AuthorizationResult>{
  if(!this.valid(input))return {status:'FAILED',failureCode:'PROVIDER_ERROR'};
  const existing=this.authorizations.get(input.idempotencyKey);if(existing)return existing;
  if(this.authorizationOutcome==='error')throw Error('simulated provider outage');
  const result:AuthorizationResult=this.authorizationOutcome==='decline'?{status:'FAILED',failureCode:'DECLINED'}:{status:'AUTHORIZED',authorizationRef:this.ref('mock_au_'),amountAgorot:input.amountAgorot};
  this.authorizations.set(input.idempotencyKey,result);if(result.status==='AUTHORIZED')this.authorizationCount++;
  if(this.authorizationOutcome==='lost-response')throw Error('simulated lost provider response');
  return result;
 }
 async capture(input:{authorizationRef:string;amountAgorot:bigint;idempotencyKey:string}):Promise<ChargeResult>{
  const existing=this.captures.get(input.idempotencyKey);if(existing)return existing;
  const authorized=[...this.authorizations.values()].find(a=>a.status==='AUTHORIZED'&&a.authorizationRef===input.authorizationRef) as Extract<AuthorizationResult,{status:'AUTHORIZED'}>|undefined;
  if(!authorized||authorized.amountAgorot!==input.amountAgorot||this.voids.has(input.authorizationRef))return {status:'FAILED',failureCode:'PROVIDER_ERROR'};
  if(this.captureOutcome==='error')throw Error('simulated provider outage');
  const result:ChargeResult=this.captureOutcome==='decline'?{status:'FAILED',failureCode:'PROVIDER_ERROR'}:{status:'SUCCEEDED',chargeRef:this.ref('mock_ch_'),amountAgorot:input.amountAgorot};
  this.captures.set(input.idempotencyKey,result);if(result.status==='SUCCEEDED')this.chargeCount++;
  return result;
 }
 async voidAuthorization(input:{authorizationRef:string;idempotencyKey:string}){
  if(!this.voids.has(input.authorizationRef)){this.voids.add(input.authorizationRef);this.voidCount++;}
  return {status:'VOIDED' as const};
 }
}

export interface PaymentSettings {paymentProvider:'none'|'mock'}
export function paymentProvider(settings:PaymentSettings):PaymentProvider{
 return settings.paymentProvider==='mock'?new MockPaymentProvider():new UnavailablePaymentProvider();
}
