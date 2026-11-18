// Shopify Admin API authentication for a Dev Dashboard app acting on our own store (same organization): the client
// credentials grant. There is no static Admin token. The access token lives only in this process's memory.
//
//   POST https://{shop}.myshopify.com/admin/oauth/access_token   (application/x-www-form-urlencoded)
//   grant_type=client_credentials&client_id=...&client_secret=...
//   -> {access_token, scope, expires_in}
//
// - A cached token is reused until shortly before it expires (expires_in from the response, never assumed).
// - Concurrent callers share one in-flight token request (single flight).
// - The granted scopes must include write_orders (it also grants read access to orders); otherwise authentication
//   fails closed and no Admin API request is made.
// - The client secret is sent only in the token request body. It is never logged, returned or put into an error.
export const REQUIRED_SCOPES=['write_orders'] as const;
export interface ShopifyAuthSettings {domain:string;clientId:string;clientSecret:string}
export type ShopifyAuthErrorKind='CREDENTIALS_REJECTED'|'TOKEN_REQUEST_FAILED'|'INVALID_TOKEN_RESPONSE'|'SCOPE_MISSING';
export class ShopifyAuthError extends Error {
 constructor(public kind:ShopifyAuthErrorKind){super('Shopify Admin authentication failed ('+kind+')');this.name='ShopifyAuthError';}
}
type CachedToken={value:string;refreshAt:number;scopes:Set<string>};
export class ShopifyAdminAuth {
 private cached:CachedToken|null=null;
 private inflight:Promise<CachedToken>|null=null;
 constructor(private settings:ShopifyAuthSettings,private http:typeof fetch=fetch,private timeoutMs=15000,private now:()=>number=()=>Date.now()){}
 /** A valid access token: the cached one, or one fresh token request shared by every concurrent caller. */
 async accessToken():Promise<string>{
  if(this.cached&&this.now()<this.cached.refreshAt)return this.cached.value;
  if(!this.inflight)this.inflight=this.acquire().then(token=>{this.cached=token;return token;}).finally(()=>{this.inflight=null;});
  return (await this.inflight).value;
 }
 /** Drop the cached token if it is the one that was rejected (a newer token is kept). */
 invalidate(token:string){if(this.cached?.value===token)this.cached=null;}
 private async acquire():Promise<CachedToken>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeoutMs);
  let response:Response;
  try{
   response=await this.http('https://'+this.settings.domain+'/admin/oauth/access_token',{method:'POST',redirect:'error',signal:controller.signal,
    headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:this.settings.clientId,client_secret:this.settings.clientSecret}).toString()});
  }catch{clearTimeout(timer);throw new ShopifyAuthError('TOKEN_REQUEST_FAILED');}
  try{
   if(response.status===400||response.status===401||response.status===403)throw new ShopifyAuthError('CREDENTIALS_REJECTED');
   if(!response.ok)throw new ShopifyAuthError('TOKEN_REQUEST_FAILED');
   let body:any;try{body=await response.json();}catch{throw new ShopifyAuthError('INVALID_TOKEN_RESPONSE');}
   const value=body?.access_token,expiresIn=body?.expires_in,scope=body?.scope;
   if(typeof value!=='string'||value.length<8||value.length>500||/\s/.test(value)||!Number.isSafeInteger(expiresIn)||expiresIn<=0||typeof scope!=='string')
    throw new ShopifyAuthError('INVALID_TOKEN_RESPONSE');
   const scopes=new Set(scope.split(/[\s,]+/).filter(Boolean));
   if(REQUIRED_SCOPES.some(required=>!scopes.has(required)))throw new ShopifyAuthError('SCOPE_MISSING');
   // Refresh ahead of expiry: a tenth of the lifetime, at most 5 minutes (24-hour tokens refresh ~5 minutes early).
   const margin=Math.min(300,Math.floor(expiresIn/10));
   return {value,refreshAt:this.now()+(expiresIn-margin)*1000,scopes};
  }finally{clearTimeout(timer);}
 }
}
