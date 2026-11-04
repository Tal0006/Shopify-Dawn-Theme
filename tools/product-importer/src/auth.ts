import type { Request, Response, NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AuthConfig { username:string; password:string; production:boolean; origin:string }
interface Session { csrf:string; expires:number }
const digest = (value:string) => createHash('sha256').update(value).digest();
export function sameSecret(a:unknown,b:string):boolean {
  return typeof a === 'string' && timingSafeEqual(digest(a),digest(b));
}
export function authConfig(env:NodeJS.ProcessEnv, port:number):AuthConfig {
  const username=env.IMPORTER_USERNAME?.trim(), password=env.IMPORTER_PASSWORD;
  if(!username || !password || password.length<12) throw Error('Configure IMPORTER_USERNAME and IMPORTER_PASSWORD (at least 12 characters)');
  const production=env.NODE_ENV==='production';
  const value=env.APP_ORIGIN?.trim() || env.RENDER_EXTERNAL_URL?.trim() || 'http://127.0.0.1:'+port;
  let url:URL;
  try { url=new URL(value); } catch { throw Error('Invalid APP_ORIGIN'); }
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' ||
      (production ? url.protocol!=='https:' : !['http:','https:'].includes(url.protocol)))
    throw Error('APP_ORIGIN must be an HTTPS origin in production');
  return {username,password,production,origin:url.origin};
}
export function createAuth(config:AuthConfig, now=Date.now) {
  const sessions=new Map<string,Session>();
  const attempts=new Map<string,{count:number; expires:number}>();
  let total={count:0,expires:now()+15*60_000};
  const cookie=config.production?'__Host-importer_session':'importer_session';
  const lifetime=8*60*60_000;
  const options={httpOnly:true,secure:config.production,sameSite:'strict' as const,path:'/'};
  const sessionKey=(req:Request) => {
    const value=req.headers.cookie?.split(';').map(value=>value.trim()).find(value=>value.startsWith(cookie+'='))?.slice(cookie.length+1);
    return value && /^[a-f0-9]{64}$/.test(value) ? digest(value).toString('hex') : undefined;
  };
  const session=(req:Request) => {
    const key=sessionKey(req), value=key?sessions.get(key):undefined;
    if(value && value.expires<=now()){sessions.delete(key!);return undefined;}return value;
  };
  return {
    session,
    require(req:Request,res:Response,next:NextFunction) {
      if(session(req)) return next();
      if(req.path.toLowerCase()==='/api' || req.path.toLowerCase().startsWith('/api/') || req.path==='/logout') return res.status(401).json({error:'גישה אינה מורשית'});
      res.redirect(303,'/login');
    },
    login(req:Request,res:Response) {
      const time=now();
      for(const [key,value] of attempts)if(value.expires<=time)attempts.delete(key);
      if(total.expires<=time)total={count:0,expires:time+15*60_000};
      const ip=req.ip || 'unknown';
      const attempt=attempts.get(ip) || {count:0,expires:time+15*60_000};
      if(attempt.count>=10 || total.count>=100 || attempts.size>=1000) {
        res.set('Retry-After','900');return res.status(429).type('html').send(loginPage('יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.'));
      }
      attempt.count++;total.count++;attempts.set(ip,attempt);
      const userOK=sameSecret(req.body?.username,config.username), passwordOK=sameSecret(req.body?.password,config.password);
      if(!userOK || !passwordOK)return res.status(401).type('html').send(loginPage('שם המשתמש או הסיסמה אינם נכונים'));
      attempts.delete(ip);
      const previous=sessionKey(req);if(previous)sessions.delete(previous);
      for(const [key,value] of sessions)if(value.expires<=time)sessions.delete(key);
      if(sessions.size>=20)sessions.delete(sessions.keys().next().value!);
      const token=randomBytes(32).toString('hex');
      sessions.set(digest(token).toString('hex'),{csrf:randomBytes(32).toString('hex'),expires:time+lifetime});
      res.cookie(cookie,token,{...options,maxAge:lifetime});
      res.redirect(303,'/');
    },
    logout(req:Request,res:Response) {
      const key=sessionKey(req);if(key)sessions.delete(key);
      res.clearCookie(cookie,options);res.json({ok:true});
    }
  };
}
export function loginPage(error='') {
  // Error text is application-owned; credentials and submitted values are never reflected.
  return '<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>כניסה לכלי הייבוא</title><link rel="stylesheet" href="/login.css"></head><body><main><h1>כניסה לכלי הייבוא</h1><p role="alert">'+error+'</p><form action="/login" method="post"><label for="username">שם משתמש</label><input id="username" name="username" autocomplete="username" required maxlength="256"><label for="password">סיסמה</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">כניסה</button></form></main></body></html>';
}
