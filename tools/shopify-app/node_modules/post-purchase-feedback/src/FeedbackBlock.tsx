// Thank you page survey about the ordering and site experience (Polaris web components, Preact).
//
// - The survey is optional and fully separate from the order confirmation: every failure (backend asleep or down, no
//   session token, timeout) shows one calm message and nothing else changes on the page.
// - The block contains only the survey. A Google review request is deliberately not shown here (customers haven't
//   received their products yet); it is a separate, future feature sent after confirmed delivery.
// - Text direction follows the buyer's language (Hebrew -> RTL), which Shopify applies to the whole checkout.
import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {EMPTY_DRAFT,LIMITS,alreadySubmitted,buildPayload,createSender,orderNumericId,rememberSubmitted,validateDraft,
 type Draft,type DraftErrors,type FlagStorage} from './feedback';

type Fetch=(input:string,init?:RequestInit)=>Promise<Response>;
/** The part of the Thank you page API this block uses (the real `shopify` global satisfies it). */
export interface SurveyApi {
 i18n:{translate:(key:string,options?:Record<string,unknown>)=>unknown};
 orderConfirmation:{value:{order:{id:string};number?:string}|undefined|null};
 sessionToken:{get():Promise<string>};
 storage:FlagStorage;
 extension:{editor?:unknown};
}
export type Translate=(key:string,options?:Record<string,unknown>)=>string;
export type Phase='checking'|'form'|'done';

export interface ViewProps {
 t:Translate;phase:Phase;draft:Draft;errors:DraftErrors;sending:boolean;failed:boolean;editor:boolean;showSurvey:boolean;
 onDraft:(change:Partial<Draft>)=>void;onSubmit:()=>void;
}
const yesNo=(value:boolean|null)=>value===true?['yes']:value===false?['no']:[];
const firstValue=(event:Event)=>{const values=(event.currentTarget as unknown as {values?:string[]})?.values;return Array.isArray(values)?values[0]:undefined;};
const textValue=(event:Event)=>String((event.currentTarget as unknown as {value?:string})?.value??'');

/** Pure view: everything it shows comes from props (rendered to HTML in the tests). */
export function FeedbackView(p:ViewProps){
 const {t,draft,errors}=p;
 if(!p.showSurvey||p.phase==='checking')return null;
 if(p.phase==='done')return <s-section heading={t('heading')}>
  <s-banner tone="success">{t('success')}</s-banner>
 </s-section>;
 return <s-section heading={t('heading')}>
  <s-stack gap="base">
   <s-paragraph>{t('intro')}</s-paragraph>
   <s-text color="subdued">{t('privacy')}</s-text>
   <s-choice-list label={t('rating_label')} name="rating" values={draft.rating?[String(draft.rating)]:[]} error={errors.rating?t('rating_error'):undefined}
    disabled={p.sending} onChange={event=>{const v=Number(firstValue(event));p.onDraft({rating:Number.isInteger(v)&&v>=1&&v<=5?v:null});}}>
    {[1,2,3,4,5].map(r=><s-choice key={r} value={String(r)}>{t('rating_'+r)}</s-choice>)}
   </s-choice-list>
   <s-choice-list label={t('missing_label')} name="missingProducts" variant="inline" values={yesNo(draft.missingProducts)} error={errors.missingProducts?t('choice_error'):undefined}
    disabled={p.sending} onChange={event=>{const v=firstValue(event);p.onDraft({missingProducts:v==='yes'?true:v==='no'?false:null});}}>
    <s-choice value="no">{t('no')}</s-choice>
    <s-choice value="yes">{t('yes')}</s-choice>
   </s-choice-list>
   {draft.missingProducts===true?
    <s-text-area label={t('missing_details_label')} name="missingProductsDetails" maxLength={LIMITS.missingProductsDetails} rows={3}
     value={draft.missingProductsDetails} disabled={p.sending} onInput={event=>p.onDraft({missingProductsDetails:textValue(event)})}/>:null}
   <s-choice-list label={t('problem_label')} name="encounteredProblem" variant="inline" values={yesNo(draft.encounteredProblem)} error={errors.encounteredProblem?t('choice_error'):undefined}
    disabled={p.sending} onChange={event=>{const v=firstValue(event);p.onDraft({encounteredProblem:v==='yes'?true:v==='no'?false:null});}}>
    <s-choice value="no">{t('no')}</s-choice>
    <s-choice value="yes">{t('yes')}</s-choice>
   </s-choice-list>
   {draft.encounteredProblem===true?
    <s-text-area label={t('problem_details_label')} name="problemDetails" maxLength={LIMITS.problemDetails} rows={3}
     value={draft.problemDetails} disabled={p.sending} onInput={event=>p.onDraft({problemDetails:textValue(event)})}/>:null}
   <s-text-area label={t('improvement_label')} name="improvementFeedback" maxLength={LIMITS.improvementFeedback} rows={3}
    value={draft.improvementFeedback} disabled={p.sending} onInput={event=>p.onDraft({improvementFeedback:textValue(event)})}/>
   {p.failed?<s-banner tone="critical">{t('failure')}</s-banner>:null}
   {p.editor?<s-text color="subdued">{t('editor_note')}</s-text>:null}
   <s-button variant="primary" loading={p.sending} disabled={p.sending} onClick={()=>p.onSubmit()}>{t('submit')}</s-button>
  </s-stack>
 </s-section>;
}

/** Stateful block: reads the order and the storage flag, and sends the survey once. */
export function FeedbackBlock({api,fetcher}:{api:SurveyApi;fetcher?:Fetch}){
 const doFetch:Fetch=fetcher||((input,init)=>fetch(input,init));
 const t:Translate=(key,options)=>{const value=api.i18n.translate(key,options);return typeof value==='string'?value:Array.isArray(value)?value.join(''):key;};
 const confirmation=api.orderConfirmation.value;
 const orderId=orderNumericId(confirmation?.order?.id);
 const editor=Boolean(api.extension.editor);
 const [phase,setPhase]=useState<Phase>('checking');
 const [draft,setDraft]=useState<Draft>(EMPTY_DRAFT);
 const [errors,setErrors]=useState<DraftErrors>({});
 const [sending,setSending]=useState(false);
 const [failed,setFailed]=useState(false);
 const sender=useMemo(()=>createSender({fetch:doFetch,sessionToken:()=>api.sessionToken.get()}),[]);
 // A synchronous guard as well: two clicks in the same frame happen before `sending` re-renders.
 const busy=useRef(false);
 useEffect(()=>{
  let live=true;
  if(!orderId){setPhase('form');return;}
  alreadySubmitted(api.storage,orderId).then(done=>{if(live)setPhase(done?'done':'form');});
  return ()=>{live=false;};
 },[orderId]);
 const onDraft=(change:Partial<Draft>)=>{
  setDraft(current=>({...current,...change}));
  setErrors(current=>{const next={...current};for(const key of Object.keys(change))delete next[key as keyof DraftErrors];return next;});
  setFailed(false);
 };
 const onSubmit=async()=>{
  if(busy.current||!orderId||!confirmation)return;
  const problems=validateDraft(draft);setErrors(problems);
  if(Object.keys(problems).length)return;
  if(editor){setPhase('done');return;}
  busy.current=true;setSending(true);setFailed(false);
  const result=await sender.send(buildPayload(draft,{id:confirmation.order.id,number:confirmation.number}));
  busy.current=false;setSending(false);
  if(result==='ok'){await rememberSubmitted(api.storage,orderId);setDraft(EMPTY_DRAFT);setPhase('done');}
  else setFailed(true);
 };
 return <FeedbackView t={t} phase={phase} draft={draft} errors={errors} sending={sending} failed={failed} editor={editor}
  showSurvey={Boolean(orderId)} onDraft={onDraft} onSubmit={onSubmit}/>;
}
