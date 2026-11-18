// Business finance ("כספים", admin only): manually recorded income and expenses in ILS, stored as integer agorot.
// Money is BigInt end to end (parsing, sums, monthly equivalents); numbers leave this module only as safe integers.
//
// One source of truth: every total (KPI cards, the monthly chart, the filtered list) is read from the actual rows in
// business_transactions. A recurring charge ("חיוב קבוע", always an expense) is a definition in
// business_recurring_transactions that RECORDS one immutable expense row per billing date once that date is due
// (see recordIn). Recorded rows keep the amount and fields of their day; changes to a charge apply only from today on.
//
// OPS_COSTS (environment, possibly USD, no start date) is never counted here. The admin imports an entry explicitly as
// a recurring expense; import_key (unique) keeps that to one import per entry, and the panel then shows it as imported.
import {createHash,randomUUID} from 'node:crypto';
import {transaction,type Database,type Queryable} from './db.js';
import {ApiError} from './domain.js';
import {auditStrict,audit,type AuditAction} from './audit.js';
import type {CostEntry} from './system.js';

export const TYPES=['INCOME','EXPENSE'] as const;
export const PAYMENT_METHODS=['CARD','BANK_TRANSFER','CASH','STANDING_ORDER','OTHER'] as const;
export const SOURCES=['MANUAL','SHOPIFY','CARDCOM','GROUP_DELIVERY','SYSTEM'] as const;
export const FREQUENCIES=['MONTHLY','QUARTERLY','YEARLY'] as const;
export const RANGES=['6m','12m','year'] as const;
export type TxType=typeof TYPES[number];export type Frequency=typeof FREQUENCIES[number];export type Range=typeof RANGES[number];
export const TYPE_LABELS:Record<TxType,string>={INCOME:'הכנסה',EXPENSE:'הוצאה'};
export const PAYMENT_LABELS:Record<string,string>={CARD:'אשראי',BANK_TRANSFER:'העברה בנקאית',CASH:'מזומן',STANDING_ORDER:'הוראת קבע',OTHER:'אחר'};
export const SOURCE_LABELS:Record<string,string>={MANUAL:'ידני',SHOPIFY:'Shopify',CARDCOM:'Cardcom',GROUP_DELIVERY:'משלוח קבוצתי',SYSTEM:'מערכת'};
export const FREQUENCY_LABELS:Record<Frequency,string>={MONTHLY:'חודשי',QUARTERLY:'רבעוני',YEARLY:'שנתי'};
export const RANGE_LABELS:Record<Range,string>={'6m':'6 חודשים','12m':'12 חודשים',year:'השנה'};
// Suggestions only: any category text is accepted.
export const CATEGORY_SUGGESTIONS:Record<TxType,string[]>={
 EXPENSE:['Shopify','Render','Shipfn','Cardcom','פרסום','משלוחים','מלאי','אריזות','תוכנה ושירותים','שונות'],
 INCOME:['מכירות Shopify','משלוח קבוצתי','הכנסה אחרת'],
};
const STEP:Record<Frequency,number>={MONTHLY:1,QUARTERLY:3,YEARLY:12};
export const MAX_AGOROT=1000000000n;// ₪10,000,000 (also a CHECK in migration 011)
const TZ='Asia/Jerusalem';


// ₪1,234.56 from integer agorot (BigInt arithmetic; no floating point). Kept LTR inside the RTL page.
export function ils(agorot:number|bigint,sign:'auto'|'always'='auto'){
 let v=BigInt(agorot);const negative=v<0n;if(negative)v=-v;
 const text='₪'+new Intl.NumberFormat('en-US').format(v/100n)+'.'+String(v%100n).padStart(2,'0');
 return (negative?'−':sign==='always'&&v>0n?'+':'')+text;
}

// ---- Validation -------------------------------------------------------------------------------------------------
export type FieldErrors=Partial<Record<'type'|'amount'|'date'|'category'|'description'|'paymentMethod'|'source'|'notes'|'recurring'|'frequency'|'startDate'|'endDate'|'importKey',string>>;
export class FinanceInputError extends ApiError {constructor(public fields:FieldErrors){super(422,'INVALID_TRANSACTION','לא ניתן לשמור את התנועה. יש לתקן את השדות המסומנים.');}}
export interface TransactionInput {type:TxType;amountAgorot:bigint;date:string;category:string;description:string|null;paymentMethod:string|null;source:string;notes:string|null;
 recurring:boolean;frequency:Frequency|null;startDate:string|null;endDate:string|null;importKey:string|null}

// "1234", "1234.5", "1,234.56", "₪ 99.90" → agorot. No exponent, no sign, at most two decimals, never via floats.
export function parseAmount(value:unknown):bigint|null{
 if(typeof value!=='string')return null;
 const raw=value.replace(/[\s\u00a0₪]/g,'');
 if(!/^(?:\d{1,8}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,2})?$/.test(raw))return null;
 const [whole,fraction='']=raw.replace(/,/g,'').split('.');
 const agorot=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 return agorot>0n&&agorot<=MAX_AGOROT?agorot:null;
}
const amountOf=(body:any):bigint|null=>{
 // JSON clients may send integer agorot; forms send shekels as text. A float, a negative number or zero is rejected.
 if(body?.amountAgorot!==undefined){
  const v=body.amountAgorot;
  const n=typeof v==='number'&&Number.isSafeInteger(v)?BigInt(v):typeof v==='string'&&/^\d{1,10}$/.test(v)?BigInt(v):null;
  return n!==null&&n>0n&&n<=MAX_AGOROT?n:null;
 }
 return parseAmount(typeof body?.amount==='number'?String(body.amount):body?.amount);
};
export function isDate(value:unknown):value is string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const [y,m,d]=value.split('-').map(Number);
 return y>=2000&&y<=2100&&m>=1&&m<=12&&d>=1&&d<=daysIn(y,m);
}
const clean=(value:unknown,max:number,multiline=false):string|null|undefined=>{
 if(value===undefined||value===null)return null;
 if(typeof value!=='string')return undefined;
 const text=value.replace(multiline?/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g:/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim();
 if(!text)return null;
 return text.length<=max?text:undefined;
};
const truthy=(value:unknown)=>value===true||value==='on'||value==='yes'||value==='true'||value==='1';
export const IMPORT_KEY=/^ops-costs:[a-f0-9]{16}$/;

// Same rules for HTML forms and JSON. Recurrence fields are ignored unless recurring is set (the form hides them).
export function validate(body:any,importKeys:Set<string>=new Set()):TransactionInput{
 const errors:FieldErrors={};
 const type=TYPES.includes(body?.type)?body.type as TxType:(errors.type='יש לבחור הכנסה או הוצאה.',null);
 const amount=amountOf(body);if(amount===null)errors.amount='יש להזין סכום חיובי בשקלים (עד שתי ספרות אחרי הנקודה, עד ₪10,000,000).';
 const date=isDate(body?.date)?body.date:(errors.date='יש להזין תאריך תקין.',null);
 const category=clean(body?.category,60);if(!category)errors.category='יש להזין קטגוריה (עד 60 תווים).';
 const description=clean(body?.description,200);if(description===undefined)errors.description='התיאור ארוך מדי (עד 200 תווים).';
 const notes=clean(body?.notes,1000,true);if(notes===undefined)errors.notes='ההערות ארוכות מדי (עד 1000 תווים).';
 const method=body?.paymentMethod===undefined||body?.paymentMethod===null||body?.paymentMethod===''?null:PAYMENT_METHODS.includes(body.paymentMethod)?body.paymentMethod:(errors.paymentMethod='אמצעי התשלום אינו תקין.',null);
 const source=body?.source===undefined||body?.source===null||body?.source===''?'MANUAL':SOURCES.includes(body.source)?body.source:(errors.source='המקור אינו תקין.','MANUAL');
 const recurring=truthy(body?.recurring);
 let frequency:Frequency|null=null,startDate:string|null=null,endDate:string|null=null;
 if(recurring){
  if(type==='INCOME')errors.recurring='חיוב קבוע אפשרי רק להוצאה.';
  frequency=FREQUENCIES.includes(body?.frequency)?body.frequency:(errors.frequency='יש לבחור תדירות חיוב.',null);
  const optionalDate=(value:unknown,field:'startDate'|'endDate')=>value===undefined||value===null||value===''?null:isDate(value)?value:(errors[field]='יש להזין תאריך תקין או להשאיר ריק.',null);
  startDate=optionalDate(body?.startDate,'startDate');endDate=optionalDate(body?.endDate,'endDate');
  const from=startDate??date;
  if(endDate&&from&&endDate<from)errors.endDate='תאריך הסיום חייב להיות אחרי תאריך ההתחלה.';
 }
 const importKey=body?.importKey===undefined||body?.importKey===null||body?.importKey===''?null:
  typeof body.importKey==='string'&&IMPORT_KEY.test(body.importKey)&&importKeys.has(body.importKey)?body.importKey:(errors.importKey='העלות לייבוא אינה מוגדרת עוד ב־OPS_COSTS.',null);
 if(importKey&&!recurring)errors.recurring='עלות מ־OPS_COSTS מיובאת כחיוב קבוע.';
 if(Object.keys(errors).length)throw new FinanceInputError(errors);
 return {type:type!,amountAgorot:amount!,date:date!,category:category!,description:description??null,paymentMethod:method,source,notes:notes??null,recurring,frequency,startDate,endDate,importKey};
}

// ---- Dates (calendar arithmetic on integers; Israel time decides "today") ------------------------------------------
export const daysIn=(y:number,m:number)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const pad=(n:number)=>String(n).padStart(2,'0');
const ymd=(y:number,m:number,d:number)=>y+'-'+pad(m)+'-'+pad(d);
const parts=(date:string)=>date.split('-').map(Number) as [number,number,number];
export const israelDate=(now:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const addMonths=(month:string,delta:number)=>{const [y,m]=month.split('-').map(Number);const i=y*12+(m-1)+delta;return Math.floor(i/12)+'-'+pad(i%12+1);};
export const monthEnd=(month:string)=>{const [y,m]=month.split('-').map(Number);return ymd(y,m,daysIn(y,m));};
// Billing date k of a recurring definition: k*step months after the anchor month, on the anchor's day or the last day.
export function occurrence(anchor:string,frequency:Frequency,k:number){
 const [y,m,d]=parts(anchor);const i=y*12+(m-1)+k*STEP[frequency],yy=Math.floor(i/12),mm=i%12+1;
 return ymd(yy,mm,Math.min(d,daysIn(yy,mm)));
}
// First billing date on or after `from` (and not after `end`), or null.
export function nextOccurrence(anchor:string,frequency:Frequency,end:string|null,from:string){
 const [ay,am]=parts(anchor),[fy,fm]=parts(from),diff=(fy*12+fm)-(ay*12+am);
 for(let k=Math.max(0,Math.floor(diff/STEP[frequency]));k<Math.max(0,Math.floor(diff/STEP[frequency]))+3;k++){
  const date=occurrence(anchor,frequency,k);
  if(date>=from)return end&&date>end?null:date;
 }
 return null;
}
// Monthly equivalent in agorot (rounded half up): quarterly / 3, yearly / 12.
export const monthlyEquivalent=(agorot:bigint,frequency:Frequency)=>{const n=BigInt(STEP[frequency]);return (agorot*2n+n)/(2n*n);};

export const addDays=(date:string,days:number)=>{const [y,m,d]=parts(date);return new Date(Date.UTC(y,m-1,d+days)).toISOString().slice(0,10);};
// Billing dates of a schedule within [from, until], never past `end`.
export function dueDates(anchor:string,frequency:Frequency,from:string,until:string,end:string|null){
 const last=end&&end<until?end:until,out:string[]=[];
 if(from>last)return out;
 const [ay,am]=parts(anchor),[fy,fm]=parts(from>anchor?from:anchor);
 for(let k=Math.max(0,Math.floor(((fy*12+fm)-(ay*12+am))/STEP[frequency])-1);;k++){
  const date=occurrence(anchor,frequency,k);
  if(date>last)return out;
  if(date>=from)out.push(date);
 }
}
const FREQUENCY_OF:Record<number,Frequency>={1:'MONTHLY',3:'QUARTERLY',12:'YEARLY'};
const LOCK=4330012;// serializes recording and recurring-charge changes (pg_advisory_xact_lock)
export const SYSTEM_ACTOR='system:recurring';
export const OPS_ACTOR='system:ops-costs';
export type OpsState='SYNCED'|'FREE'|'NOT_COUNTED'|'MANUAL_AMOUNT'|'STOPPED'|'PENDING';

const big=(value:unknown)=>BigInt(String(value??'0'));
const num=(value:bigint)=>{if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<-BigInt(Number.MAX_SAFE_INTEGER))throw Error('amount out of range');return Number(value);};
const COLUMNS=`t.id,t.type,t.amount_agorot::text AS amount_agorot,to_char(t.transaction_date,'YYYY-MM-DD') AS transaction_date,t.category,t.description,t.payment_method,t.source,t.notes,
 t.recurring_definition_id,to_char(t.recurring_occurrence_date,'YYYY-MM-DD') AS recurring_occurrence_date,t.created_at,t.updated_at`;
export interface Transaction {id:string;type:TxType;amountAgorot:number;date:string;category:string;description:string|null;paymentMethod:string|null;source:string;notes:string|null;
 recurring:false;recurringDefinitionId:string|null;occurrenceDate:string|null;createdAt:string;updatedAt:string}
const row=(r:any):Transaction=>({id:r.id,type:r.type,amountAgorot:num(big(r.amount_agorot)),date:r.transaction_date,category:r.category,description:r.description,paymentMethod:r.payment_method,
 source:r.source,notes:r.notes,recurring:false,recurringDefinitionId:r.recurring_definition_id??null,occurrenceDate:r.recurring_occurrence_date??null,
 createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()});
const REC_COLUMNS=`r.id,r.amount_agorot::text AS amount_agorot,r.category,r.description,r.payment_method,r.source,r.notes,r.frequency_months,to_char(r.start_date,'YYYY-MM-DD') AS start_date,
 to_char(r.end_date,'YYYY-MM-DD') AS end_date,to_char(r.effective_from,'YYYY-MM-DD') AS effective_from,r.active,r.deactivated_at,r.import_key,r.managed_by,r.deactivated_reason,r.amount_source,r.created_at,r.updated_at,
 (SELECT to_char(MAX(o.recurring_occurrence_date),'YYYY-MM-DD') FROM business_transactions o WHERE o.recurring_definition_id=r.id) AS last_occurrence,
 (SELECT COUNT(*)::int FROM business_transactions o WHERE o.recurring_definition_id=r.id) AS occurrences`;
export interface Recurring {id:string;type:'EXPENSE';amountAgorot:number;category:string;description:string|null;paymentMethod:string|null;source:string;notes:string|null;recurring:true;
 frequency:Frequency;startDate:string;endDate:string|null;effectiveFrom:string;active:boolean;deactivatedAt:string|null;importKey:string|null;managedBy:'OPS_COSTS'|null;deactivatedReason:'ADMIN'|'OPS_SYNC'|null;amountSource:'OPS_CONFIG'|'MANUAL'|null;lastOccurrence:string|null;occurrences:number;createdAt:string;updatedAt:string}
const recRow=(r:any):Recurring=>({id:r.id,type:'EXPENSE',amountAgorot:num(big(r.amount_agorot)),category:r.category,description:r.description,paymentMethod:r.payment_method,source:r.source,notes:r.notes,
 recurring:true,frequency:FREQUENCY_OF[Number(r.frequency_months)],startDate:r.start_date,endDate:r.end_date,effectiveFrom:r.effective_from,active:!!r.active,
 deactivatedAt:r.deactivated_at?new Date(r.deactivated_at).toISOString():null,importKey:r.import_key,managedBy:r.managed_by??null,deactivatedReason:r.deactivated_reason??null,amountSource:r.amount_source??null,lastOccurrence:r.last_occurrence??null,occurrences:Number(r.occurrences??0),
 createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()});
export type Item={kind:'transaction';transaction:Transaction}|{kind:'recurring';recurring:Recurring};
export type RecurringStatus='ACTIVE'|'SCHEDULED'|'ENDED'|'INACTIVE';
// The next billing date that is not recorded yet (the first one new terms would apply to), or null.
export function nextBilling(r:Pick<Recurring,'startDate'|'frequency'|'endDate'|'effectiveFrom'|'lastOccurrence'|'active'>,today:string){
 if(!r.active)return null;
 const from=[today,r.effectiveFrom,r.lastOccurrence?addDays(r.lastOccurrence,1):r.startDate].sort().at(-1)!;
 return nextOccurrence(r.startDate,r.frequency,r.endDate,from);
}
export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const notFound=()=>new ApiError(404,'TRANSACTION_NOT_FOUND','התנועה לא נמצאה.');
const opsManaged=()=>new ApiError(409,'OPS_MANAGED','החיוב מנוהל דרך OPS_COSTS. הסכום, התדירות וההפסקה נקבעים שם (הסרה מ־OPS_COSTS מפסיקה אותו).');
const occurrenceLocked=()=>new ApiError(409,'RECURRING_OCCURRENCE','זהו חיוב שנרשם מחיוב קבוע, והוא נשמר כפי שנרשם. לשינוי החיובים הבאים יש לערוך את החיוב הקבוע.');

export interface ListFilters {q:string;type:string;category:string;month:string;page:number}
export function listFilters(query:any):ListFilters{
 const str=(v:unknown,max:number)=>typeof v==='string'?v.trim().slice(0,max):'';
 const page=Number.parseInt(String(query?.page??'1'),10);
 return {q:str(query?.q,100),type:TYPES.includes(query?.type)?query.type:'',category:str(query?.category,60),month:typeof query?.month==='string'&&/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)?query.month:'',
  page:Number.isSafeInteger(page)&&page>0&&page<=10000?page:1};
}
export const rangeOf=(value:unknown):Range=>RANGES.includes(value as Range)?value as Range:'6m';

// OPS_COSTS entry → stable import key (service name + currency; a changed amount or frequency is the same cost).
export const importKeyOf=(cost:Pick<CostEntry,'service'|'currency'>)=>'ops-costs:'+createHash('sha256').update(cost.service.trim().toLowerCase()+'|'+cost.currency).digest('hex').slice(0,16);
const guessCategory=(service:string)=>{const s=service.toLowerCase();return s.includes('shopify')?'Shopify':s.includes('render')?'Render':s.includes('shipfn')?'Shipfn':s.includes('cardcom')?'Cardcom':'תוכנה ושירותים';};
const detailOf=(t:{type:string})=>t.type;
const recDetail=(r:{frequency:Frequency},suffix='')=>'RECURRING_'+r.frequency+suffix;
// The ILS amount (agorot) OPS_COSTS gives the finance page for a cost: financeAmountIls when set, otherwise the price of
// an ILS cost. Null for a free cost and for a foreign-currency cost without financeAmountIls (never converted).
export const opsFinanceAgorot=(cost:CostEntry|undefined):number|null=>!cost||cost.amountCents<=0?null:cost.financeAgorot??(cost.currency==='ILS'?cost.amountCents:null);

export class Finance {
 constructor(private db:Database,private costs:CostEntry[]=[],private now:()=>Date=()=>new Date()){}
 today(){return israelDate(this.now());}
 private opsEntries(){const entries=new Map<string,CostEntry>();for(const cost of this.costs)entries.set(importKeyOf(cost),cost);return entries;}
 // Amount, frequency and stopping of an OPS-managed charge belong to OPS_COSTS while OPS_COSTS gives it an ILS amount
 // (amount_source OPS_CONFIG). A hand-imported charge of a foreign-currency cost keeps the admin's amount (MANUAL) and
 // stays editable until OPS_COSTS defines financeAmountIls for it.
 opsLocked(r:Pick<Recurring,'managedBy'|'importKey'|'amountSource'>){
  const cost=r.managedBy==='OPS_COSTS'&&r.importKey?this.opsEntries().get(r.importKey):undefined;
  return r.amountSource==='OPS_CONFIG'&&opsFinanceAgorot(cost)!==null;
 }

 // ---- OPS_COSTS synchronization ----------------------------------------------------------------------------------
 // Runs under the recording lock before every recording, so it is serialized and idempotent: nothing is written when
 // OPS_COSTS and the managed charges already agree. Only charges with managed_by='OPS_COSTS' are ever touched.
 // The ILS amount is opsFinanceAgorot(entry): the ILS price, or financeAmountIls (never an exchange rate).
 //  - entry with an ILS amount and no charge → a charge starting on the 1st of the current month (no earlier history);
 //  - ILS amount or frequency changed → dates already due are recorded with the old terms, new ones apply from today;
 //    a change of a foreign provider price alone changes nothing here;
 //  - a hand-imported (MANUAL) charge is taken over (OPS_CONFIG) once OPS_COSTS gives it an ILS amount;
 //  - entry gone, free, or without an ILS amount → the charge is stopped (OPS_SYNC); recorded rows stay. Exception: a
 //    MANUAL charge of a still-configured foreign cost keeps the admin's amount;
 //  - ILS amount back after an OPS_SYNC stop → reactivated from today (no backfill). An ADMIN stop is respected.
 private async syncIn(db:Queryable,today:string){
  const entries=this.opsEntries(),first=today.slice(0,7)+'-01',yesterday=addDays(today,-1);
  const defs=new Map((await db.query('SELECT '+REC_COLUMNS+" FROM business_recurring_transactions r WHERE r.managed_by='OPS_COSTS'")).rows.map(recRow).map(d=>[d.importKey!,d]));
  const log=(action:AuditAction,id:string,amount:bigint,detail:string)=>auditStrict(db,{action,actor:OPS_ACTOR,target:id,result:'OK',amountAgorot:num(amount),detail});
  for(const [key,cost] of entries){
   const agorot=opsFinanceAgorot(cost);
   if(agorot===null)continue;
   const amount=BigInt(agorot),months=STEP[cost.frequency],d=defs.get(key);
   if(!d){
    if((await db.query('SELECT 1 FROM business_recurring_transactions WHERE import_key=$1',[key])).rows.length)continue;
    const id=randomUUID();
    await db.query(`INSERT INTO business_recurring_transactions(id,amount_agorot,category,description,source,frequency_months,start_date,effective_from,import_key,managed_by,amount_source,created_by,updated_by)
     VALUES($1,$2::bigint,$3,$4,'SYSTEM',$5,$6::date,$6::date,$7,'OPS_COSTS','OPS_CONFIG',$8,$8)`,[id,amount.toString(),guessCategory(cost.service),cost.service.slice(0,200),months,first,key,OPS_ACTOR]);
    await log('finance.recurring_create',id,amount,'OPS_COSTS_SYNC');
    continue;
   }
   const terms=BigInt(d.amountAgorot)!==amount||d.frequency!==cost.frequency,takeover=d.amountSource!=='OPS_CONFIG';
   if(d.active&&(terms||takeover)){
    if(terms)await this.recordIn(db,yesterday,d.id);
    await db.query(`UPDATE business_recurring_transactions SET amount_agorot=$2::bigint,frequency_months=$3,amount_source='OPS_CONFIG',
     effective_from=CASE WHEN $6::boolean THEN GREATEST(effective_from,$4::date) ELSE effective_from END,updated_at=NOW(),updated_by=$5 WHERE id=$1`,
     [d.id,amount.toString(),months,today,OPS_ACTOR,terms]);
    await log('finance.recurring_update',d.id,amount,terms?'OPS_COSTS_SYNC':'OPS_COSTS_SYNC_TAKEOVER');
   }else if(!d.active&&d.deactivatedReason==='OPS_SYNC'){
    await db.query(`UPDATE business_recurring_transactions SET active=true,deactivated_at=NULL,deactivated_reason=NULL,amount_source='OPS_CONFIG',amount_agorot=$2::bigint,frequency_months=$3,effective_from=GREATEST(effective_from,$4::date),
     updated_at=NOW(),updated_by=$5 WHERE id=$1`,[d.id,amount.toString(),months,today,OPS_ACTOR]);
    await log('finance.recurring_update',d.id,amount,'OPS_COSTS_SYNC_REACTIVATE');
   }
  }
  for(const d of defs.values()){
   const cost=entries.get(d.importKey!);
   if(!d.active||opsFinanceAgorot(cost)!==null)continue;
   if(cost&&cost.amountCents>0&&d.amountSource==='MANUAL')continue;// the admin's ILS amount for a configured foreign cost
   await this.recordIn(db,yesterday,d.id);
   await db.query("UPDATE business_recurring_transactions SET active=false,deactivated_at=NOW(),deactivated_reason='OPS_SYNC',updated_at=NOW(),updated_by=$2 WHERE id=$1",[d.id,OPS_ACTOR]);
   await log('finance.recurring_deactivate',d.id,BigInt(d.amountAgorot),'OPS_COSTS_SYNC');
  }
 }

 // ---- Recording (materialization) ----------------------------------------------------------------------------
 // Records every billing date of every active charge that is due (on or before `until`) and not recorded yet, with
 // the charge's current amount and fields. Deterministic (dates come from the schedule), idempotent (UNIQUE pair +
 // ON CONFLICT DO NOTHING) and serialized with charge changes by a transaction-scoped advisory lock. Never records a
 // future date. Runs at the start of every finance read, so no scheduler is needed for correctness.
 private async recordIn(db:Queryable,until:string,onlyId?:string){
  await db.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  const defs=(await db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.active'+(onlyId?' AND r.id=$1':''),onlyId?[onlyId]:[])).rows.map(recRow);
  let recorded=0;
  for(const d of defs){
   const from=[d.effectiveFrom,d.startDate,d.lastOccurrence?addDays(d.lastOccurrence,1):d.startDate].sort().at(-1)!;
   for(const date of dueDates(d.startDate,d.frequency,from,until,d.endDate)){
    const r=await db.query(`INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,description,payment_method,source,recurring,created_by,updated_by,recurring_definition_id,recurring_occurrence_date)
     VALUES($1,'EXPENSE',$2::bigint,$3::date,$4,$5,$6,$7,false,$8,$8,$9,$3::date) ON CONFLICT (recurring_definition_id,recurring_occurrence_date) DO NOTHING RETURNING id`,
     [randomUUID(),String(d.amountAgorot),date,d.category,d.description,d.paymentMethod,d.source,SYSTEM_ACTOR,d.id]);
    recorded+=r.rows.length;
   }
  }
  return recorded;
 }
 async record(){const today=this.today();return transaction(this.db,async db=>{await db.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);await this.syncIn(db,today);return this.recordIn(db,today);});}

 async find(id:string):Promise<Item>{
  if(!UUID.test(id))throw notFound();
  const t=(await this.db.query('SELECT '+COLUMNS+' FROM business_transactions t WHERE t.id=$1',[id])).rows[0];
  if(t)return {kind:'transaction',transaction:row(t)};
  const r=(await this.db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.id=$1',[id])).rows[0];
  if(r)return {kind:'recurring',recurring:recRow(r)};
  throw notFound();
 }
 // ---- Changes: each change and its audit row commit together; refusals are audited as DENIED/FAILED --------------
 async create(body:any,actor:string):Promise<{transaction:Transaction}|{recurring:Recurring}>{
  const recurring=body?.recurring===true||['on','yes','true','1'].includes(body?.recurring);
  return this.audited(recurring?'finance.recurring_create':'finance.transaction_create',actor,null,async()=>{
   // import_key is reserved for OPS_COSTS synchronization: a manual charge never carries one.
   const input=validate({...body,importKey:undefined}),id=randomUUID(),today=this.today();
   if(!input.recurring)return transaction(this.db,async db=>{
    await db.query(`INSERT INTO business_transactions(id,type,amount_agorot,transaction_date,category,description,payment_method,source,notes,recurring,created_by,updated_by)
     VALUES($1,$2,$3::bigint,$4::date,$5,$6,$7,$8,$9,false,$10,$10)`,[id,input.type,input.amountAgorot.toString(),input.date,input.category,input.description,input.paymentMethod,input.source,input.notes,actor]);
    const created=row((await db.query('SELECT '+COLUMNS+' FROM business_transactions t WHERE t.id=$1',[id])).rows[0]);
    await auditStrict(db,{action:'finance.transaction_create',actor,target:id,result:'OK',amountAgorot:created.amountAgorot,detail:detailOf(created)});
    return {transaction:created};
   });
   const start=input.startDate??input.date;
   return transaction(this.db,async db=>{
    await db.query('SELECT pg_advisory_xact_lock($1)',[LOCK]);
    await db.query(`INSERT INTO business_recurring_transactions(id,amount_agorot,category,description,payment_method,source,notes,frequency_months,start_date,end_date,effective_from,created_by,updated_by)
     VALUES($1,$2::bigint,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$9::date,$11,$11)`,
     [id,input.amountAgorot.toString(),input.category,input.description,input.paymentMethod,input.source,input.notes,STEP[input.frequency!],start,input.endDate,actor]);
    // A start in the past records the billing dates since then (an explicit choice of the admin); never future ones.
    await this.recordIn(db,today,id);
    const created=recRow((await db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.id=$1',[id])).rows[0]);
    await auditStrict(db,{action:'finance.recurring_create',actor,target:id,result:'OK',amountAgorot:created.amountAgorot,detail:recDetail(created)});
    return {recurring:created};
   });
  });
 }
 async update(id:string,body:any,actor:string):Promise<{previous:Transaction;transaction:Transaction}|{previous:Recurring;recurring:Recurring;effectiveFrom:string|null}>{
  const item=await this.audited('finance.transaction_update',actor,id,()=>this.find(id));
  if(item.kind==='transaction')return this.audited('finance.transaction_update',actor,id,async()=>{
   const current=item.transaction;
   if(current.recurringDefinitionId)throw occurrenceLocked();
   const input=validate({...body,importKey:undefined});
   if(input.recurring)throw new FinanceInputError({recurring:'תנועה רגילה אינה הופכת לחיוב קבוע. יש להוסיף חיוב קבוע חדש.'});
   return transaction(this.db,async db=>{
    const result=await db.query(`UPDATE business_transactions SET type=$2,amount_agorot=$3::bigint,transaction_date=$4::date,category=$5,description=$6,payment_method=$7,source=$8,notes=$9,updated_at=NOW(),updated_by=$10
     WHERE id=$1 AND recurring_definition_id IS NULL RETURNING id`,[id,input.type,input.amountAgorot.toString(),input.date,input.category,input.description,input.paymentMethod,input.source,input.notes,actor]);
    if(!result.rows.length)throw notFound();
    const updated=row((await db.query('SELECT '+COLUMNS+' FROM business_transactions t WHERE t.id=$1',[id])).rows[0]);
    await auditStrict(db,{action:'finance.transaction_update',actor,target:id,result:'OK',amountAgorot:updated.amountAgorot,detail:detailOf(updated)});
    return {previous:current,transaction:updated};
   });
  });
  return this.audited('finance.recurring_update',actor,id,async()=>{
   const current=item.recurring;
   if(!current.active)throw new ApiError(409,'RECURRING_INACTIVE','החיוב הקבוע הופסק ואינו ניתן לעריכה. ניתן להוסיף חיוב קבוע חדש.');
   const input=validate({...body,importKey:undefined});
   if(!input.recurring||input.type!=='EXPENSE')throw new FinanceInputError({recurring:'חיוב קבוע נשאר חיוב קבוע. כדי לעצור אותו יש להשתמש ב"הפסקה".'});
   const today=this.today(),start=input.startDate??input.date;
   return transaction(this.db,async db=>{
    // Dates that were already due are recorded with the OLD terms first; new terms start today (or with the next
    // billing date not recorded yet). Recorded rows are never updated.
    await this.recordIn(db,addDays(today,-1),id);
    const terms=BigInt(current.amountAgorot)!==input.amountAgorot||current.frequency!==input.frequency||current.startDate!==start||current.endDate!==input.endDate;
    if(terms&&this.opsLocked(current))throw new FinanceInputError({amount:'הסכום, התדירות והתאריכים של חיוב זה מנוהלים במשתנה OPS_COSTS. כאן ניתן לשנות קטגוריה, תיאור, אמצעי תשלום והערות.'});
    const result=await db.query(`UPDATE business_recurring_transactions SET amount_agorot=$2::bigint,category=$3,description=$4,payment_method=$5,source=$6,notes=$7,frequency_months=$8,start_date=$9::date,end_date=$10::date,
     effective_from=CASE WHEN $11::boolean THEN GREATEST(effective_from,$12::date) ELSE effective_from END,updated_at=NOW(),updated_by=$13 WHERE id=$1 AND active RETURNING id`,
     [id,input.amountAgorot.toString(),input.category,input.description,input.paymentMethod,input.source,input.notes,STEP[input.frequency!],start,input.endDate,terms,today,actor]);
    if(!result.rows.length)throw new ApiError(409,'RECURRING_INACTIVE','החיוב הקבוע הופסק ואינו ניתן לעריכה.');
    await this.recordIn(db,today,id);
    const updated=recRow((await db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.id=$1',[id])).rows[0]);
    await auditStrict(db,{action:'finance.recurring_update',actor,target:id,result:'OK',amountAgorot:updated.amountAgorot,detail:recDetail(updated,terms?'_TERMS':'_DETAILS')});
    return {previous:current,recurring:updated,effectiveFrom:terms?nextBilling(updated,today):null};
   });
  });
 }
 // A one-off row is deleted. A recurring charge with recorded rows is stopped (deactivated): the rows stay as history
 // and nothing is recorded from today on; a charge that never recorded anything is deleted outright.
 async remove(id:string,confirmed:boolean,actor:string):Promise<{deleted:Transaction}|{deleted:Recurring}|{deactivated:Recurring}>{
  const item=await this.audited('finance.transaction_delete',actor,id,async()=>{
   if(!confirmed)throw new ApiError(400,'DELETE_CONFIRMATION_REQUIRED','נדרש אישור מפורש למחיקת התנועה.');
   return this.find(id);
  });
  if(item.kind==='transaction')return this.audited('finance.transaction_delete',actor,id,async()=>{
   const current=item.transaction;
   if(current.recurringDefinitionId)throw occurrenceLocked();
   return transaction(this.db,async db=>{
    const result=await db.query('DELETE FROM business_transactions WHERE id=$1 AND recurring_definition_id IS NULL RETURNING id',[id]);
    if(!result.rows.length)throw notFound();
    await auditStrict(db,{action:'finance.transaction_delete',actor,target:id,result:'OK',amountAgorot:current.amountAgorot,detail:detailOf(current)});
    return {deleted:current};
   });
  });
  return this.audited('finance.recurring_deactivate',actor,id,async()=>transaction(this.db,async db=>{
   await this.recordIn(db,addDays(this.today(),-1),id);
   const current=recRow((await db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.id=$1',[id])).rows[0]??(()=>{throw notFound();})());
   if(this.opsLocked(current))throw opsManaged();
   if(!current.active)return {deactivated:current};
   if(!current.occurrences){
    await db.query('DELETE FROM business_recurring_transactions WHERE id=$1',[id]);
    await auditStrict(db,{action:'finance.recurring_delete',actor,target:id,result:'OK',amountAgorot:current.amountAgorot,detail:recDetail(current)});
    return {deleted:current};
   }
   await db.query('UPDATE business_recurring_transactions SET active=false,deactivated_at=NOW(),deactivated_reason=\'ADMIN\',updated_at=NOW(),updated_by=$2 WHERE id=$1',[id,actor]);
   await auditStrict(db,{action:'finance.recurring_deactivate',actor,target:id,result:'OK',amountAgorot:current.amountAgorot,detail:recDetail(current)});
   return {deactivated:recRow((await db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.id=$1',[id])).rows[0])};
  }));
 }
 private async audited<T>(action:AuditAction,actor:string,target:string|null,run:()=>Promise<T>):Promise<T>{
  try{return await run();}
  catch(error){await audit(this.db,{action,actor,target:target&&UUID.test(target)?target:null,result:error instanceof ApiError&&error.status<500?'DENIED':'FAILED',detail:error instanceof ApiError?error.code:null});throw error;}
 }

 // ---- Reads: actual business_transactions only (after recording what is due) ---------------------------------------
 async summary(rangeValue:unknown){
  await this.record();
  const range=rangeOf(rangeValue),today=this.today(),month=today.slice(0,7);
  const count=range==='6m'?6:range==='12m'?12:Number(month.slice(5,7));
  const months=Array.from({length:count},(_,i)=>addMonths(month,i-count+1));
  const rows=(await this.db.query(`SELECT to_char(transaction_date,'YYYY-MM') AS month,type,(recurring_definition_id IS NOT NULL) AS occurrence,SUM(amount_agorot)::text AS total
   FROM business_transactions WHERE NOT recurring AND transaction_date BETWEEN $1::date AND $2::date GROUP BY 1,2,3`,[months[0]+'-01',monthEnd(month)])).rows;
  const totals=new Map(months.map(m=>[m,{income:0n,expense:0n,recurring:0n}]));
  for(const r of rows){const t=totals.get(r.month);if(!t)continue;const v=big(r.total);if(r.type==='INCOME')t.income+=v;else{t.expense+=v;if(r.occurrence)t.recurring+=v;}}
  const current=totals.get(month)!;
  const recurring=await this.recurring(today);
  const active=recurring.filter(r=>r.status==='ACTIVE');
  const monthly=active.reduce((sum,r)=>sum+BigInt(r.monthlyAgorot),0n);
  return {
   today,month,range,
   kpis:{incomeAgorot:num(current.income),expenseAgorot:num(current.expense),profitAgorot:num(current.income-current.expense),
    recurringMonthlyAgorot:num(monthly),recurringActive:active.length,recurringThisMonthAgorot:num(current.recurring)},
   chart:months.map(m=>({month:m,incomeAgorot:num(totals.get(m)!.income),expenseAgorot:num(totals.get(m)!.expense)})),
   recurring,
  };
 }
 // The recurring-charges card: definitions with their state and the next billing date that is not recorded yet.
 async recurring(today=this.today()){
  const rank:Record<RecurringStatus,number>={ACTIVE:0,SCHEDULED:1,ENDED:2,INACTIVE:3};
  const rows=(await this.db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r ORDER BY r.amount_agorot DESC,r.created_at,r.id')).rows.map(recRow),entries=this.opsEntries();
  return rows.map(r=>{
   const status:RecurringStatus=!r.active?'INACTIVE':r.startDate>today?'SCHEDULED':r.endDate&&r.endDate<today?'ENDED':'ACTIVE';
   const cost=r.managedBy==='OPS_COSTS'&&r.importKey?entries.get(r.importKey):undefined;
   // The provider's own price, shown as secondary information for a foreign-currency cost.
   const provider=cost&&cost.currency!=='ILS'?{amountCents:cost.amountCents,currency:cost.currency,frequency:cost.frequency}:null;
   return {...r,anchor:r.startDate,status,opsLocked:this.opsLocked(r),provider,nextDate:status==='ACTIVE'||status==='SCHEDULED'?nextBilling(r,today):null,monthlyAgorot:num(monthlyEquivalent(BigInt(r.amountAgorot),r.frequency))};
  }).sort((x,y)=>rank[x.status]-rank[y.status]);
 }
 // "תנועות אחרונות": actual rows, newest first; recorded billing dates are marked and link to their charge.
 async list(query:any){
  await this.record();
  const f=listFilters(query),size=25;
  const where:string[]=['NOT t.recurring'],values:any[]=[];
  const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace('?','$'+values.length));};
  if(f.type)add('t.type=?',f.type);
  if(f.category)add('t.category=?',f.category);
  if(f.month){add('t.transaction_date>=?::date',f.month+'-01');add('t.transaction_date<=?::date',monthEnd(f.month));}
  if(f.q){values.push('%'+f.q.replace(/[\\%_]/g,'\\$&')+'%');const p='$'+values.length;where.push(`(t.description ILIKE ${p} OR t.category ILIKE ${p} OR t.notes ILIKE ${p})`);}
  const filter=' WHERE '+where.join(' AND ');
  const stats=(await this.db.query(`SELECT COUNT(*)::int AS n,COALESCE(SUM(t.amount_agorot) FILTER (WHERE t.type='INCOME'),0)::text AS income,COALESCE(SUM(t.amount_agorot) FILTER (WHERE t.type='EXPENSE'),0)::text AS expense FROM business_transactions t`+filter,values)).rows[0];
  const pageCount=Math.max(1,Math.ceil(stats.n/size)),page=Math.min(f.page,pageCount);
  const rows=(await this.db.query(`SELECT `+COLUMNS+`,r.frequency_months FROM business_transactions t LEFT JOIN business_recurring_transactions r ON r.id=t.recurring_definition_id`+filter+
   ` ORDER BY t.transaction_date DESC,t.created_at DESC,t.id LIMIT ${size} OFFSET ${(page-1)*size}`,values)).rows;
  const categories=(await this.db.query('SELECT DISTINCT category FROM business_transactions WHERE NOT recurring ORDER BY category')).rows.map(r=>r.category as string);
  return {
   filters:{...f,page},
   entries:rows.map(r=>{const t=row(r);return {...t,occurrence:!!t.recurringDefinitionId,frequency:r.frequency_months?FREQUENCY_OF[Number(r.frequency_months)]:null};}),
   totals:{incomeAgorot:num(big(stats.income)),expenseAgorot:num(big(stats.expense)),profitAgorot:num(big(stats.income)-big(stats.expense))},
   pagination:{page,pageSize:size,total:stats.n as number,pageCount},
   categories,
  };
 }
 // OPS_COSTS entries and how each is represented. SYNCED entries appear as charges in "חיובים קבועים"; the others are
 // listed separately and never counted (free, non-ILS without an ILS charge, or stopped by the admin).
 async opsCosts(){
  const entries=this.opsEntries(),defs=new Map<string,Recurring>();
  if(entries.size)for(const r of (await this.db.query('SELECT '+REC_COLUMNS+' FROM business_recurring_transactions r WHERE r.import_key=ANY($1::text[])',[[...entries.keys()]])).rows.map(recRow))defs.set(r.importKey!,r);
  return this.costs.map(cost=>{
   const d=defs.get(importKeyOf(cost));
   const agorot=opsFinanceAgorot(cost);
   const state:OpsState=cost.amountCents<=0?'FREE':agorot!==null?(d?.active?'SYNCED':d&&d.deactivatedReason==='ADMIN'?'STOPPED':'PENDING'):
    d?.active&&d.amountSource==='MANUAL'?'MANUAL_AMOUNT':'NOT_COUNTED';
   return {service:cost.service,amountCents:cost.amountCents,currency:cost.currency,frequency:cost.frequency,note:cost.note,state,recurringId:d?.id??null,
    financeAgorot:state==='MANUAL_AMOUNT'?d!.amountAgorot:agorot,financeSource:state==='MANUAL_AMOUNT'?'MANUAL':agorot!==null?(cost.financeAgorot!==null?'FINANCE_AMOUNT':'ILS_PRICE'):null};
  });
 }
}
