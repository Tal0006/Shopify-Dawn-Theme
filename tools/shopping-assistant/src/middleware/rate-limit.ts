import type {RequestHandler} from 'express';
export function rateLimit(limit=30,windowMs=60000,now=Date.now):RequestHandler{
 const buckets=new Map<string,{count:number;expires:number}>();
 return(req,res,next)=>{
  const time=now();for(const [ip,b] of buckets)if(b.expires<=time)buckets.delete(ip);
  const ip=req.ip||'unknown',b=buckets.get(ip)||{count:0,expires:time+windowMs};
  if(b.count>=limit||(!buckets.has(ip)&&buckets.size>=5000)){
   res.set('Retry-After',String(Math.max(1,Math.ceil((b.expires-time)/1000))));
   return res.status(429).json({code:'RATE_LIMITED',message:'יש לנסות שוב בעוד רגע.'});
  }
  b.count++;buckets.set(ip,b);next();
 };
}
export function concurrencyLimit(max=8):RequestHandler{
 let active=0;
 return(_req,res,next)=>{
  if(active>=max)return res.status(429).json({code:'SERVER_BUSY',message:'יש לנסות שוב בעוד רגע.'});
  active++;let done=false;const release=()=>{if(!done){active--;done=true;}};
  res.once('finish',release);res.once('close',release);next();
 };
}
