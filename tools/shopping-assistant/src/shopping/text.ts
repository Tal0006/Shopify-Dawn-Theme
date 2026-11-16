// Base text normalization shared by parsing, intent detection and matching.
export function normalize(value:string):string {
  return value.normalize('NFKC').replace(/\p{M}/gu,'').replace(/[״׳"'‘’“”]/g,'').replace(/[^\p{L}\p{N}\s.]/gu,' ').replace(/\s+/g,' ').trim().toLowerCase();
}
// Bounded cache for pure text functions on the matching hot path (each quote scores up to
// 20 items x 4 searches x 160 variants). Cleared when full, so memory stays bounded.
export function memoize<T>(fn:(key:string)=>T,limit=20000):(key:string)=>T {
  const cache=new Map<string,T>();
  return key=>{
    const hit=cache.get(key);
    if(hit!==undefined||cache.has(key))return hit as T;
    if(cache.size>=limit)cache.clear();
    const value=fn(key);cache.set(key,value);return value;
  };
}
