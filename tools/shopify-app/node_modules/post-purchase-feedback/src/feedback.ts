// Pure logic for the Thank you page survey (no Shopify globals, so it is unit-tested directly).
//
// Privacy: answers travel only in the POST body to the Fankee backend over HTTPS. Nothing goes into a URL, cookie or
// browser storage; the only stored value is a "this order already answered" flag (the numeric order id) in the
// extension's own storage, which only hides the form. The backend's one-response-per-order rule stays authoritative.

/** The Fankee backend (tools/group-delivery on Render), the same service the storefront sections use. */
export const BACKEND_ORIGIN='https://fankee-group-delivery.onrender.com';
export const FEEDBACK_ENDPOINT=BACKEND_ORIGIN+'/api/post-purchase-feedback';
export const FEEDBACK_VERSION=1;
/** Same limits as the backend (characters). */
export const LIMITS={missingProductsDetails:500,problemDetails:1000,improvementFeedback:1000} as const;
/** A cold Render instance can take close to a minute to answer. */
export const SUBMIT_TIMEOUT_MS=60000;
export const STORAGE_KEY='feedback-submitted-v1';

export interface Draft {
 rating:number|null;
 missingProducts:boolean|null;missingProductsDetails:string;
 encounteredProblem:boolean|null;problemDetails:string;
 improvementFeedback:string;
}
export const EMPTY_DRAFT:Draft={rating:null,missingProducts:null,missingProductsDetails:'',encounteredProblem:null,problemDetails:'',improvementFeedback:''};
export type DraftErrors=Partial<Record<'rating'|'missingProducts'|'encounteredProblem',true>>;

/** gid://shopify/Order/123 -> "123"; anything else -> null (the survey is then not shown). */
export function orderNumericId(gid: unknown): string | null {
  const match =
    typeof gid === 'string'
      ? /^gid:\/\/shopify\/(?:Order|OrderIdentity)\/([1-9][0-9]{0,19})$/.exec(gid)
      : null;

  return match ? match[1] : null;
}
/** The three answers the form needs before it is sent (the texts are optional). */
export function validateDraft(draft:Draft):DraftErrors{
 const errors:DraftErrors={};
 if(!(Number.isInteger(draft.rating)&&draft.rating!>=1&&draft.rating!<=5))errors.rating=true;
 if(typeof draft.missingProducts!=='boolean')errors.missingProducts=true;
 if(typeof draft.encounteredProblem!=='boolean')errors.encounteredProblem=true;
 return errors;
}
const text=(value:string,max:number)=>{const trimmed=value.trim();return trimmed?trimmed.slice(0,max):null;};
/**
 * The exact request body: the order identifiers and the answers only. Details are sent only with a "yes" answer, so a
 * shopper who typed details and then changed the answer to "no" never sends them.
 */
export function buildPayload(draft:Draft,order:{id:string;number?:string|null}){
 const confirmation=typeof order.number==='string'&&/^[A-Za-z0-9]{4,20}$/.test(order.number)?order.number:null;
 return {
  orderId:order.id,
  ...(confirmation?{confirmationNumber:confirmation}:{}),
  rating:draft.rating,
  missingProducts:draft.missingProducts===true,
  missingProductsDetails:draft.missingProducts===true?text(draft.missingProductsDetails,LIMITS.missingProductsDetails):null,
  encounteredProblem:draft.encounteredProblem===true,
  problemDetails:draft.encounteredProblem===true?text(draft.problemDetails,LIMITS.problemDetails):null,
  improvementFeedback:text(draft.improvementFeedback,LIMITS.improvementFeedback),
  version:FEEDBACK_VERSION,
 };
}

type Fetch=(input:string,init?:RequestInit)=>Promise<Response>;
async function timed(fetcher:Fetch,url:string,init:RequestInit,timeoutMs:number){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{return await fetcher(url,{...init,signal:controller.signal});}finally{clearTimeout(timer);}
}
export type SendResult='ok'|'failed';
/**
 * Sends one submission at a time: a second call while one is in flight gets the same promise (a double click sends
 * one request). Never throws: every failure (no token, network, timeout, any non-2xx) is 'failed', so the Thank you
 * page is never affected.
 */
export function createSender(deps:{fetch:Fetch;sessionToken:()=>Promise<string>;endpoint?:string;timeoutMs?:number}){
 let inflight:Promise<SendResult>|null=null;
 const run=async(body:unknown):Promise<SendResult>=>{
  try {
  console.log('[feedback] requesting session token');

  const token = await deps.sessionToken();

  console.log('[feedback] session token received');

  if (typeof token !== 'string' || !token) {
    console.error('[feedback] empty session token');
    return 'failed';
  }

  console.log('[feedback] sending request to backend');

  const response = await timed(
    deps.fetch,
    deps.endpoint || FEEDBACK_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
    },
    deps.timeoutMs ?? SUBMIT_TIMEOUT_MS,
  );

  console.log('[feedback] backend status', response.status);

  if (!response.ok) return 'failed';

  const json = await response.json().catch(() => null);
  return json && json.ok === true ? 'ok' : 'failed';
} catch (error) {
  console.error('[feedback] submit failed', error);
  return 'failed';
}
 };
 return {
  send(body:unknown):Promise<SendResult>{
   if(!inflight)inflight=run(body).finally(()=>{inflight=null;});
   return inflight;
  },
  get busy(){return inflight!==null;},
 };
}

export interface FlagStorage {read<T=unknown>(key:string):Promise<T|null>;write(key:string,data:any):Promise<void>}
/** Whether this order already answered on this device (UX only). Storage errors mean "not answered". */
export async function alreadySubmitted(storage:FlagStorage,orderId:string){
 try{return (await storage.read<string>(STORAGE_KEY))===orderId;}catch{return false;}
}
/** Remembers the order id only (never an answer). */
export async function rememberSubmitted(storage:FlagStorage,orderId:string){
 try{await storage.write(STORAGE_KEY,orderId);}catch{/* UX only */}
}
