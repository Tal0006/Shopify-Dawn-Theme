import {CARDCOM_API_ORIGIN,type CardcomSettings} from './payments-config.js';
// The single Cardcom boundary (Low Profile JSON API v11, https://secure.cardcom.solutions/swagger/v11/swagger.json).
// Routes and domain code never see raw Cardcom JSON: every call returns a typed, validated result, and every failure is
// a CardcomError with a fixed kind. Nothing here logs or rethrows request/response bodies, credentials or tokens.
//
// Field names and semantics below follow the official v11 OpenAPI document. Points that the document leaves open are
// marked VERIFY and are isolated here (see README "Cardcom points to verify").
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GetLpResult ResponseCode values that mean "the page is still open / not completed yet" (documented on
// LowProfileResult.PendingReason as 5117/5118/5119). Anything else non-zero is a definitive failure of that page.
const LP_PENDING=new Set([5117,5118,5119]);
// Transactions/Transaction: a repeated ExternalUniqTranId is answered with 608 (documented on ExternalUniqTranId).
export const DUPLICATE_EXTERNAL_ID=608;
// Successful card-check codes (Cardcom KB "Preventing Duplicate Transactions When Charging Tokens": charge = 0,
// J2 verification = 701, J5 authorization = 700). Reservations are J2 only: 700 / JParameter 5 is never accepted.
export const J2_SUCCESS=701,J5_SUCCESS=700;
// ExternalUniqTranId: "a string of up to 25 characters" (same KB article). Ours are 'G' + 24 hex digits.
export const EXTERNAL_ID=/^[A-Za-z0-9]{1,25}$/;
// Card expiry for CardExpirationMMYY, normalized explicitly. Cardcom documents TokenInfo.CardMonth/CardYear as integers
// ("card expiration month/year"); TransactionInfo documents CardYear as YY. A 4-digit year (2000-2099) or a 2-digit
// year (0-99) is accepted; anything else is refused (null), never guessed.
export function cardExpiry(month:unknown,year:unknown):{month:number;year:number;mmyy:string}|null{
 if(typeof month!=='number'||!Number.isInteger(month)||month<1||month>12)return null;
 if(typeof year!=='number'||!Number.isInteger(year))return null;
 const full=year>=2000&&year<=2099?year:year>=0&&year<=99?2000+year:null;
 if(full===null)return null;
 return {month,year:full,mmyy:String(month).padStart(2,'0')+String(full%100).padStart(2,'0')};
}
// VERIFY: Cardcom documents the Operation enum by name; NSwag may serialize it as the string or as its index (2).
const CREATE_TOKEN_ONLY=['CreateTokenOnly',2];
// VERIFY: the hosted page URL host. Only this host may receive the shopper.
export const CARDCOM_PAGE_HOSTS=['secure.cardcom.solutions'];

export type CardcomErrorKind='TIMEOUT'|'NETWORK'|'HTTP'|'INVALID_RESPONSE'|'REJECTED';
// An ambiguous outcome (TIMEOUT/NETWORK/HTTP 5xx/INVALID_RESPONSE) means Cardcom may or may not have acted on it.
// REJECTED is Cardcom's own non-success answer to a request it did not perform.
export class CardcomError extends Error {
 constructor(public kind:CardcomErrorKind,public operation:string,public responseCode:number|null=null){super('Cardcom '+operation+' '+kind);this.name='CardcomError';}
 get ambiguous(){return this.kind!=='REJECTED';}
}
export interface TokenReservationRequest {
 /** Our random reservation id, echoed back by Cardcom (ReturnValue). Never PII. */
 reservationId:string;
 amountAgorot:bigint;
 successUrl:string;failedUrl:string;webhookUrl:string;
 productName:string;language:'he'|'en';
}
export interface TokenReservationPage {lowProfileId:string;url:string}
export type LowProfileOutcome=
 |{state:'SUCCESS';lowProfileId:string;returnValue:string;token:string;tokenExpiresOn:string|null;cardMonth:number;cardYear:number;cardExpirationMMYY:string;last4:string|null;brand:string|null;responseCode:number}
 |{state:'PENDING';responseCode:number}
 // DECLINED: the card check failed. J5_NOT_ALLOWED: Cardcom reports a J5 authorization instead of the J2 check we
 // asked for. NOT_J2: the result is a success of another kind (e.g. a regular charge); never a reservation.
 |{state:'FAILED';responseCode:number;reason:'DECLINED'|'J5_NOT_ALLOWED'|'NOT_J2'};
export interface ChargeRequest {token:string;cardExpirationMMYY:string;amountAgorot:bigint;externalUniqTranId:string}
export type ChargeOutcome=
 |{state:'SUCCEEDED';transactionId:number;responseCode:0}
 |{state:'DUPLICATE';responseCode:number}
 |{state:'FAILED';responseCode:number};
export type ChargeLookup={state:'SUCCEEDED';transactionId:number}|{state:'NOT_CONFIRMED';responseCode:number|null};
/** Domain view of Cardcom; tests replace the HTTP layer, never this contract. */
export interface CardcomGateway {
 createTokenReservation(request:TokenReservationRequest):Promise<TokenReservationPage>;
 getLowProfileResult(lowProfileId:string):Promise<LowProfileOutcome>;
 chargeToken(request:ChargeRequest):Promise<ChargeOutcome>;
 findChargeByExternalId(externalUniqTranId:string):Promise<ChargeLookup>;
}
// Agorot -> Cardcom decimal amount (12.36). Exact for every value the domain allows (< 10^9 agorot).
export const cardcomAmount=(agorot:bigint)=>{if(agorot<=0n||agorot>100000000000n)throw Error('Invalid amount');return Number(agorot)/100;};
const intOf=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?value:null;
const textOf=(value:unknown,max=200)=>typeof value==='string'&&value.length<=max?value:null;
export class CardcomService implements CardcomGateway {
 constructor(private settings:CardcomSettings,private http:typeof fetch=fetch,private timeoutMs=15000,private base=CARDCOM_API_ORIGIN){}
 // One POST with its own AbortController and timeout. Only the HTTP status class and our operation name can leave.
 private async post(operation:string,path:string,body:Record<string,unknown>):Promise<Record<string,unknown>>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  let response:Response;
  try{
   response=await this.http(this.base+path,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({TerminalNumber:this.settings.terminalNumber,ApiName:this.settings.apiName,...body}),signal:controller.signal,redirect:'error'});
  }catch{clearTimeout(timer);throw new CardcomError(controller.signal.aborted?'TIMEOUT':'NETWORK',operation);}
  try{
   let data:unknown;
   try{data=await response.json();}catch{throw new CardcomError(controller.signal.aborted?'TIMEOUT':'INVALID_RESPONSE',operation);}
   if(!data||typeof data!=='object'||Array.isArray(data))throw new CardcomError('INVALID_RESPONSE',operation);
   const record=data as Record<string,unknown>;
   // 400/401 carry ErrorInfo {ResponseCode, Description}: Cardcom refused the request and performed nothing.
   if(response.status===400||response.status===401)throw new CardcomError('REJECTED',operation,intOf(record.ResponseCode));
   if(!response.ok)throw new CardcomError('HTTP',operation);
   return record;
  }finally{clearTimeout(timer);}
 }
 async createTokenReservation(request:TokenReservationRequest):Promise<TokenReservationPage>{
  if(!GUID.test(request.reservationId))throw Error('Invalid reservation id');
  const data=await this.post('LowProfile/Create','/api/v11/LowProfile/Create',{
   Operation:'CreateTokenOnly',
   ReturnValue:request.reservationId,
   // VERIFY: Amount is required by the schema. With CreateTokenOnly + J2 nothing is charged; it is the amount shown to
   // the cardholder for the reservation (the amount the shopper approved).
   Amount:cardcomAmount(request.amountAgorot),
   ISOCoinId:1,
   SuccessRedirectUrl:request.successUrl,FailedRedirectUrl:request.failedUrl,CancelRedirectUrl:request.failedUrl,
   WebHookUrl:request.webhookUrl,
   ProductName:request.productName.slice(0,250),
   Language:request.language,
   // J2: simple card validation, no authorization hold (J5 is never used).
   AdvancedDefinition:{JValidateType:2}
  });
  const code=intOf(data.ResponseCode);
  if(code!==0)throw new CardcomError('REJECTED','LowProfile/Create',code);
  const lowProfileId=textOf(data.LowProfileId,64),url=textOf(data.Url,2000);
  if(!lowProfileId||!GUID.test(lowProfileId)||!url)throw new CardcomError('INVALID_RESPONSE','LowProfile/Create');
  let page:URL;try{page=new URL(url);}catch{throw new CardcomError('INVALID_RESPONSE','LowProfile/Create');}
  if(page.protocol!=='https:'||page.username||page.password||!CARDCOM_PAGE_HOSTS.includes(page.hostname))throw new CardcomError('INVALID_RESPONSE','LowProfile/Create');
  return {lowProfileId:lowProfileId.toLowerCase(),url:page.href};
 }
 // Server-to-server source of truth for a Low Profile page. Success requires every documented field to agree:
 // ResponseCode 0, the same LowProfileId and TerminalNumber, Operation CreateTokenOnly, a GUID token and a card expiry.
 async getLowProfileResult(lowProfileId:string):Promise<LowProfileOutcome>{
  if(!GUID.test(lowProfileId))throw Error('Invalid LowProfileId');
  const data=await this.post('LowProfile/GetLpResult','/api/v11/LowProfile/GetLpResult',{LowProfileId:lowProfileId});
  const code=intOf(data.ResponseCode);
  if(code===null)throw new CardcomError('INVALID_RESPONSE','LowProfile/GetLpResult');
  if(code===J5_SUCCESS)return {state:'FAILED',responseCode:code,reason:'J5_NOT_ALLOWED'};
  if(code!==0&&code!==J2_SUCCESS)return LP_PENDING.has(code)?{state:'PENDING',responseCode:code}:{state:'FAILED',responseCode:code,reason:'DECLINED'};
  // When Cardcom includes the card-check transaction, it must be a J2 check: ResponseCode 0 or 701 and JParameter 2.
  const check=data.TranzactionInfo&&typeof data.TranzactionInfo==='object'?data.TranzactionInfo as Record<string,unknown>:null;
  if(check){
   const checkCode=intOf(check.ResponseCode),j=check.JParameter===undefined||check.JParameter===null?null:String(check.JParameter);
   if(checkCode===J5_SUCCESS||j==='5')return {state:'FAILED',responseCode:checkCode??code,reason:'J5_NOT_ALLOWED'};
   if(checkCode!==0&&checkCode!==J2_SUCCESS)return {state:'FAILED',responseCode:checkCode??code,reason:'DECLINED'};
   if(j!==null&&j!=='2')return {state:'FAILED',responseCode:checkCode,reason:'NOT_J2'};
  }
  const id=textOf(data.LowProfileId,64),terminal=intOf(data.TerminalNumber),returnValue=textOf(data.ReturnValue,250);
  const token=data.TokenInfo&&typeof data.TokenInfo==='object'?data.TokenInfo as Record<string,unknown>:null;
  const tokenValue=textOf(token?.Token,64);
  if(!id||id.toLowerCase()!==lowProfileId.toLowerCase()||terminal!==this.settings.terminalNumber||!CREATE_TOKEN_ONLY.includes(data.Operation as any)||
   returnValue===null||!tokenValue||!GUID.test(tokenValue))throw new CardcomError('INVALID_RESPONSE','LowProfile/GetLpResult');
  // Card expiry is needed to charge the token later (CardExpirationMMYY). TokenInfo carries CardMonth/CardYear.
  const expiry=cardExpiry(token!.CardMonth,token!.CardYear);
  if(!expiry)throw new CardcomError('INVALID_RESPONSE','LowProfile/GetLpResult');
  const ex=textOf(token!.TokenExDate,16);
  const tokenExpiresOn=ex&&/^\d{8}$/.test(ex)?ex.slice(0,4)+'-'+ex.slice(4,6)+'-'+ex.slice(6,8):null;
  // CreateTokenOnly may return no TranzactionInfo, so last 4 digits and brand are often absent.
  const last4=textOf(check?.Last4CardDigitsString,4),brand=textOf(check?.Brand,20);
  return {state:'SUCCESS',lowProfileId:id.toLowerCase(),returnValue,token:tokenValue,tokenExpiresOn,
   cardMonth:expiry.month,cardYear:expiry.year,cardExpirationMMYY:expiry.mmyy,responseCode:code,
   last4:last4&&/^\d{4}$/.test(last4)?last4:null,brand:brand&&/^[A-Za-z]{2,20}$/.test(brand)?brand:null};
 }
 // One token charge. ExternalUniqTranId is our charge id, so Cardcom refuses a second transaction for it (608).
 async chargeToken(request:ChargeRequest):Promise<ChargeOutcome>{
  if(!GUID.test(request.token)||!/^(0[1-9]|1[0-2])\d{2}$/.test(request.cardExpirationMMYY)||!EXTERNAL_ID.test(request.externalUniqTranId))throw Error('Invalid charge request');
  let data:Record<string,unknown>;
  try{
   data=await this.post('Transactions/Transaction','/api/v11/Transactions/Transaction',{
    Amount:cardcomAmount(request.amountAgorot),Token:request.token,CardExpirationMMYY:request.cardExpirationMMYY,
    ExternalUniqTranId:request.externalUniqTranId,
    // Cardcom KB: with true, a repeated ExternalUniqTranId is not charged and the original response is returned.
    ExternalUniqUniqTranIdResponse:true,
    // No CVV2: Cardcom documents CVV2 for card-number charges only, not for tokens. CVV is never stored.
    NumOfPayments:1,ISOCoinId:1
   });
  }catch(error){
   // A 400/401 refusal performed nothing; report it as a failed charge with Cardcom's code.
   if(error instanceof CardcomError&&error.kind==='REJECTED')return {state:'FAILED',responseCode:error.responseCode??-1};
   throw error;
  }
  const code=intOf(data.ResponseCode);
  if(code===null)throw new CardcomError('INVALID_RESPONSE','Transactions/Transaction');
  if(code===DUPLICATE_EXTERNAL_ID)return {state:'DUPLICATE',responseCode:code};
  if(code!==0)return {state:'FAILED',responseCode:code};
  const transactionId=intOf(data.TranzactionId);
  if(transactionId===null||transactionId<=0)throw new CardcomError('INVALID_RESPONSE','Transactions/Transaction');
  return {state:'SUCCEEDED',transactionId,responseCode:0};
 }
 // Reconciliation: did a transaction with our ExternalUniqTranId succeed? Only a clear success is reported as such.
 async findChargeByExternalId(externalUniqTranId:string):Promise<ChargeLookup>{
  if(!EXTERNAL_ID.test(externalUniqTranId))throw Error('Invalid external id');
  let data:Record<string,unknown>;
  try{data=await this.post('Transactions/GetTransactionByExternalUniqTran','/api/v11/Transactions/GetTransactionByExternalUniqTran',{ExternalUniqTranId:externalUniqTranId});}
  catch(error){if(error instanceof CardcomError&&error.kind==='REJECTED')return {state:'NOT_CONFIRMED',responseCode:error.responseCode};throw error;}
  const code=intOf(data.ResponseCode),transactionId=intOf(data.TranzactionId);
  if(code===0&&transactionId!==null&&transactionId>0)return {state:'SUCCEEDED',transactionId};
  return {state:'NOT_CONFIRMED',responseCode:code};
 }
}
