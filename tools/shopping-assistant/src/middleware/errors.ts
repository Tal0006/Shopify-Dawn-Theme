import type {ErrorRequestHandler} from 'express';
export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string,public quote?:unknown){super(message);}
}
export const unavailable=()=>new ApiError(502,'SHOPIFY_UNAVAILABLE','לא ניתן לבדוק את המוצרים כרגע. נסו שוב בעוד רגע.');
export function errorHandler(debug=false):ErrorRequestHandler {
  return (error:unknown,_req,res,_next)=>{
    const known=error instanceof ApiError;
    const parser=(error as {type?:string})?.type;
    const code=known?error.code:parser==='entity.too.large'?'BODY_TOO_LARGE':parser==='entity.parse.failed'?'INVALID_JSON':'INTERNAL_ERROR';
    const status=known?error.status:parser==='entity.too.large'?413:parser==='entity.parse.failed'?400:500;
    if(debug)console.warn('Shopping assistant request failed:',code);
    res.status(status).json({code,message:known?error.message:'לא ניתן להשלים את הבקשה כרגע.',...(known&&error.quote?{quote:error.quote}:{})});
  };
}
