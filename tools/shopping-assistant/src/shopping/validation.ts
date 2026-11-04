import {ApiError} from '../middleware/errors.js';
export const MAX_ITEMS=20, MAX_QUANTITY=20, MAX_TOTAL_QUANTITY=100;
export function invalid(code='INVALID_INPUT',message='הבקשה אינה תקינה.'){return new ApiError(400,code,message);}
export function quantity(value:unknown):number {
  if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>MAX_QUANTITY)throw invalid('INVALID_QUANTITY','יש לבחור כמות שלמה בין 1 ל-20.');
  return value;
}
export function variantId(value:unknown):string {
  if(typeof value!=='string'||!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/.test(value))throw invalid('INVALID_VARIANT','המזהה שנבחר אינו תקין.');
  return value;
}
