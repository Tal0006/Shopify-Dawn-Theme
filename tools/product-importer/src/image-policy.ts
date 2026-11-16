/**
 * Product image source policy. This is an application safeguard against accidental automatic
 * use of images whose usage rights are unknown; it is not a legal determination.
 */
export type ImageUsagePolicy='APPROVED'|'DISCOVERY_ONLY'|'MANUAL_APPROVED'|'UNKNOWN';
export interface ImageUsageClassification{usagePolicy:ImageUsagePolicy;autoAttachAllowed:boolean;reason:string}
export interface ClassifiableImage{imageUrl:string;source:string}

/** Providers whose results are search/catalog discoveries unless explicitly approved. */
export const DISCOVERY_PROVIDERS=['barcodelookup','go-upc','open-products-facts','upcitemdb','serpapi'] as const;
/** Providers that may be approved as a whole. Search results (serpapi) are only approvable per domain. */
const APPROVABLE_PROVIDERS=new Set(['barcodelookup','go-upc','open-products-facts','upcitemdb','authorized-api']);
/** Built-in default: only the store's own authorized API is approved for automatic attachment. */
export const DEFAULT_APPROVED_PROVIDERS=['authorized-api'];
// Shared registrable suffixes that must never approve every site beneath them.
const SHARED_SUFFIXES=new Set(['co.il','org.il','net.il','ac.il','gov.il','muni.il','k12.il','idf.il',
  'co.uk','org.uk','ac.uk','gov.uk','com.au','net.au','org.au','co.nz','co.jp','com.br','com.cn','com.tr',
  'github.io','pages.dev','vercel.app','netlify.app','herokuapp.com','web.app','firebaseapp.com',
  'blogspot.com','wordpress.com','myshopify.com','shopify.com','cdn.shopify.com','wixstatic.com',
  'squarespace-cdn.com','cloudinary.com','res.cloudinary.com','cloudfront.net','amazonaws.com','googleusercontent.com',
  'azureedge.net','akamaized.net','fastly.net','r2.dev','workers.dev','imgur.com','pinimg.com','fbcdn.net']);
const HOSTNAME=/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalized hostname of an http(s) URL, or undefined when the value is not a parseable URL. */
export function urlHostname(value:unknown):string|undefined{
  if(typeof value!=='string')return;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'&&url.protocol!=='http:')return;
    return url.hostname.toLowerCase().replace(/\.$/,'')||undefined;
  }catch{return;}
}
/** Comma-separated bare hostnames; invalid, wildcard-only and shared-suffix entries are ignored. */
export function parseApprovedDomains(value:unknown):string[]{
  if(typeof value!=='string')return [];
  const domains=new Set<string>();
  for(const raw of value.split(',')){
    let entry=raw.trim().toLowerCase().replace(/^\*\./,'').replace(/^\./,'').replace(/\.$/,'');
    // Bare hostnames only: a scheme, path, port, credentials or wildcard is a configuration mistake.
    if(!entry||/[\s/\\:@?#*%]/.test(entry))continue;
    try{entry=new URL('https://'+entry+'/').hostname;}catch{continue;}
    if(HOSTNAME.test(entry)&&!SHARED_SUFFIXES.has(entry))domains.add(entry);
  }
  return [...domains];
}
/** Exact hostname or a true subdomain. Never substring matching. */
export function hostMatchesDomain(host:string|undefined,domain:string):boolean{
  if(!host||!domain)return false;
  return host===domain||host.endsWith('.'+domain);
}
export function parseApprovedProviders(value:unknown):string[]{
  if(typeof value!=='string'||!value.trim())return [...DEFAULT_APPROVED_PROVIDERS];
  return [...new Set(value.split(',').map(s=>s.trim().toLowerCase()).filter(name=>APPROVABLE_PROVIDERS.has(name)))];
}
/** Log-safe domain: hostname characters only, never a path or signed query. */
export function logDomain(value:unknown):string{
  const host=typeof value==='string'&&!value.includes('/')?value.toLowerCase():urlHostname(value);
  return host&&/^[a-z0-9.-]{1,253}$/.test(host)?host:'unknown';
}

export class ImageSourcePolicy{
  readonly approvedDomains:readonly string[];
  readonly approvedProviders:readonly string[];
  constructor(options:{approvedDomains?:string[];approvedProviders?:string[]}={}){
    this.approvedDomains=Object.freeze([...(options.approvedDomains??[])]);
    this.approvedProviders=Object.freeze([...(options.approvedProviders??DEFAULT_APPROVED_PROVIDERS)]
      .filter(name=>APPROVABLE_PROVIDERS.has(name)));
  }
  /** The approved domain that covers this image URL's own hostname, if any. */
  approvedDomainFor(imageUrl:string):string|undefined{
    if(!imageUrl.startsWith('https://'))return;
    const host=urlHostname(imageUrl);
    return this.approvedDomains.find(domain=>hostMatchesDomain(host,domain));
  }
  /**
   * Recomputed from server-held data on every decision; provider-supplied policy fields are ignored.
   * Domain approval uses the (validated, post-redirect) image hostname, not the page that shows it.
   */
  classify(image:ClassifiableImage):ImageUsageClassification{
    // Manual URLs and uploads are only ever approved per image by the admin, never by provider or domain.
    if(image.source==='manual'||image.source==='manual-upload')
      return {usagePolicy:'UNKNOWN',autoAttachAllowed:false,reason:'manual-unconfirmed'};
    if(image.source!=='serpapi'&&this.approvedProviders.includes(image.source))
      return {usagePolicy:'APPROVED',autoAttachAllowed:true,reason:'approved-provider'};
    if(this.approvedDomainFor(image.imageUrl))
      return {usagePolicy:'APPROVED',autoAttachAllowed:true,reason:'approved-domain'};
    if((DISCOVERY_PROVIDERS as readonly string[]).includes(image.source))
      return {usagePolicy:'DISCOVERY_ONLY',autoAttachAllowed:false,reason:'source-not-approved'};
    return {usagePolicy:'UNKNOWN',autoAttachAllowed:false,reason:'unknown-provider'};
  }
}
export function imageSourcePolicyFromEnv(env:NodeJS.ProcessEnv):ImageSourcePolicy{
  return new ImageSourcePolicy({approvedDomains:parseApprovedDomains(env.PRODUCT_IMAGE_APPROVED_DOMAINS),
    approvedProviders:parseApprovedProviders(env.PRODUCT_IMAGE_APPROVED_PROVIDERS)});
}
export const DEFAULT_IMAGE_SOURCE_POLICY=new ImageSourcePolicy();
