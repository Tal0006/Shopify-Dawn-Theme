
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import type {Request,Response} from 'express';
import type {Config} from './config.js';
import type {Database} from './db.js';
import {ApiError,hash} from './domain.js';
export const same=(a:unknown,b:string)=>typeof a==='string'&&timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
export class Auth{
 private cookie:string;
 constructor(private db:Database,private config:Config){this.cookie=config.production?'__Host-group_admin':'group_admin';}
 private options(){return {httpOnly:true,secure:this.config.production,sameSite:'strict' as const,path:'/'};}
 private token(req:Request){return req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(this.cookie+'='))?.slice(this.cookie.length+1)||'';}
 async session(req:Request){
  const token=this.token(req);if(!/^[a-f0-9]{64}$/.test(token))return undefined;
  return (await this.db.query('SELECT token_hash,csrf FROM admin_sessions WHERE token_hash=$1 AND expires_at>NOW()',[hash(token)])).rows[0];
 }
 async limit(req:Request,namespace:string,max:number,seconds:number){
  const key=createHmac('sha256',this.config.secret).update(namespace+':'+(req.ip||'unknown')).digest('hex');
  const bucket=Math.floor(Date.now()/(seconds*1000));
  const row=(await this.db.query("INSERT INTO request_limits(key,bucket,hits,expires_at) VALUES($1,$2,1,NOW()+($3::int * INTERVAL '1 second')) ON CONFLICT(key,bucket) DO UPDATE SET hits=request_limits.hits+1 RETURNING hits",[key,bucket,seconds*2])).rows[0];
  if(row.hits>max)throw new ApiError(429,'RATE_LIMITED','יותר מדי בקשות. נסו שוב מאוחר יותר.');
  // Only ephemeral throttling/session records expire; no member or group retention assumptions.
  await this.db.query('DELETE FROM request_limits WHERE expires_at<NOW()');
 }
 async login(req:Request,res:Response){
  await this.limit(req,'login',10,900);
  const usernameOK=same(req.body?.username,this.config.username),passwordOK=same(req.body?.password,this.config.password);
  if(!usernameOK||!passwordOK)throw new ApiError(401,'LOGIN_FAILED','שם המשתמש או הסיסמה אינם נכונים');
  await this.db.query('DELETE FROM admin_sessions WHERE token_hash=$1 OR expires_at<=NOW()',[hash(this.token(req))]);
  const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
  await this.db.query("INSERT INTO admin_sessions(token_hash,csrf,expires_at) VALUES($1,$2,NOW()+INTERVAL '8 hours')",[hash(token),csrf]);
  res.cookie(this.cookie,token,{...this.options(),maxAge:8*3600000});res.redirect(303,'/admin');
 }
 async logout(req:Request,res:Response){await this.db.query('DELETE FROM admin_sessions WHERE token_hash=$1',[hash(this.token(req))]);res.clearCookie(this.cookie,this.options());res.redirect(303,'/admin');}
}
