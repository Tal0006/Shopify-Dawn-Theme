import type {Money} from '../domain/types.js';
import {unavailable} from '../middleware/errors.js';
function scale(currency:string) {
  if(!/^[A-Z]{3}$/.test(currency))throw unavailable();
  return new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!;
}
export function minor(money:Money):bigint {
  const digits=scale(money.currencyCode),match=/^(\d{1,18})(?:\.(\d{1,8}))?$/.exec(money.amount);
  if(!match)throw unavailable();
  const fraction=match[2] || '';
  if(/[^0]/.test(fraction.slice(digits)))throw unavailable();
  return BigInt(match[1])*10n**BigInt(digits)+BigInt(fraction.slice(0,digits).padEnd(digits,'0') || '0');
}
export function money(value:bigint,currencyCode:string):Money {
  const digits=scale(currencyCode),s=value.toString().padStart(digits+1,'0');
  return {amount:digits?s.slice(0,-digits)+'.'+s.slice(-digits):s,currencyCode};
}
export function multiply(unit:Money,count:number):Money {return money(minor(unit)*BigInt(count),unit.currencyCode);}
export function sum(values:Money[]):Money|null {
  if(!values.length)return null;
  const currency=values[0].currencyCode;
  if(values.some(value=>value.currencyCode!==currency))return null;
  return money(values.reduce((total,value)=>total+minor(value),0n),currency);
}
