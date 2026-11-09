import {randomUUID} from 'node:crypto';
import type {Queryable} from './db.js';
import type {Config} from './config.js';
import {ApiError,areaReference,coordinates,distance,localityKey,placeName,type Location} from './domain.js';
export interface AreaRow {id:string;public_id:string;name:string;slug:string;latitude:number;longitude:number;active:boolean;sort_order:number;created_at:Date;updated_at:Date}
// Public shape: no coordinates. Nearest-area matching happens on the server.
const publicArea=(area:AreaRow)=>({publicId:area.public_id,name:area.name});
const adminArea=(area:AreaRow)=>({publicId:area.public_id,name:area.name,slug:area.slug,latitude:area.latitude,longitude:area.longitude,active:area.active,sortOrder:area.sort_order});
// Accepts JSON numbers and the decimal strings of HTML admin forms; nothing else.
function number(value:unknown,min:number,max:number,integer=false):number{
 const parsed=typeof value==='number'?value:typeof value==='string'&&/^-?\d{1,6}(?:\.\d{1,7})?$/.test(value.trim())?Number(value.trim()):NaN;
 if(!Number.isFinite(parsed)||parsed<min||parsed>max||(integer&&!Number.isInteger(parsed)))throw new ApiError(400,'INVALID_INPUT','יש לבדוק את שם האזור, הקואורדינטות וסדר התצוגה.');
 return parsed;
}
export class Areas{
 constructor(private db:Queryable,private config:Pick<Config,'areaSuggestionRadius'>){}
 async list(){return (await this.db.query('SELECT * FROM delivery_areas WHERE active ORDER BY sort_order,name')).rows.map(publicArea);}
 // The coordinates exist only for this computation: they are never stored, logged or returned.
 async nearest(body:any){
  const point=coordinates(body);let best:{area:AreaRow;km:number}|undefined;
  for(const area of (await this.db.query('SELECT * FROM delivery_areas WHERE active')).rows as AreaRow[]){
   const km=distance(point,{lat:area.latitude,lng:area.longitude});
   if(km<=this.config.areaSuggestionRadius&&(!best||km<best.km))best={area,km};
  }
  return {area:best?publicArea(best.area):null};
 }
 // Only active areas accept new searches and joins. Inactive areas keep their historical groups.
 async resolve(db:Queryable,value:unknown):Promise<AreaRow>{
  const area=(await db.query('SELECT * FROM delivery_areas WHERE public_id=$1 AND active',[areaReference(value)])).rows[0];
  if(!area)throw new ApiError(400,'INVALID_AREA','האזור שנבחר אינו זמין. בחרו אזור מהרשימה.');
  return area;
 }
 place(area:AreaRow):Location{return {areaName:area.name,key:area.slug,lat:null,lng:null,areaId:area.id};}
 // Legacy free text: an exact alias of an active area becomes that area; coordinates and other spellings stay legacy.
 async legacyPlace(db:Queryable,place:Location):Promise<Location>{
  if(place.lat!==null)return place;
  const area=(await db.query('SELECT a.* FROM delivery_area_aliases x JOIN delivery_areas a ON a.id=x.area_id WHERE x.alias_key=$1 AND a.active',[place.key])).rows[0];
  return area?this.place(area):place;
 }
 async adminList(){return (await this.db.query('SELECT * FROM delivery_areas ORDER BY sort_order,name')).rows.map(adminArea);}
 private async alias(key:string,areaId:string){await this.db.query('INSERT INTO delivery_area_aliases(alias_key,area_id) VALUES($1,$2) ON CONFLICT (alias_key) DO NOTHING',[key,areaId]);}
 private async nameTaken(key:string,exceptId?:string){
  return (await this.db.query('SELECT 1 FROM delivery_areas WHERE (slug=$1 OR id IN (SELECT area_id FROM delivery_area_aliases WHERE alias_key=$1)) AND ($2::uuid IS NULL OR id<>$2::uuid)',[key,exceptId||null])).rows.length>0;
 }
 // form=true: HTML admin form, where an unchecked "active" checkbox is simply absent.
 async create(input:any,form=false){
  const name=placeName(input?.name),slug=localityKey(name);
  const latitude=number(input?.latitude,-90,90),longitude=number(input?.longitude,-180,180);
  const sortOrder=input?.sortOrder===undefined||input?.sortOrder===''?0:number(input.sortOrder,0,100000,true);
  const active=form?input?.active==='on':input?.active===undefined?true:input.active===true;
  if(!form&&input?.active!==undefined&&typeof input.active!=='boolean')throw new ApiError(400,'INVALID_INPUT');
  if(await this.nameTaken(slug))throw new ApiError(409,'AREA_EXISTS','כבר קיים אזור בשם הזה.');
  const area=(await this.db.query('INSERT INTO delivery_areas(id,public_id,name,slug,latitude,longitude,active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (slug) DO NOTHING RETURNING *',
   [randomUUID(),randomUUID(),name,slug,latitude,longitude,active,sortOrder])).rows[0];
  if(!area)throw new ApiError(409,'AREA_EXISTS','כבר קיים אזור בשם הזה.');
  await this.alias(slug,area.id);
  return adminArea(area);
 }
 // The slug never changes, so existing groups and aliases keep pointing at the same area after a rename.
 async update(id:unknown,input:any,form=false){
  const current=(await this.db.query('SELECT * FROM delivery_areas WHERE public_id=$1',[areaReference(id)])).rows[0] as AreaRow|undefined;
  if(!current)throw new ApiError(404,'AREA_NOT_FOUND','האזור לא נמצא.');
  const name=input?.name===undefined?current.name:placeName(input.name);
  if(name!==current.name&&await this.nameTaken(localityKey(name),current.id))throw new ApiError(409,'AREA_EXISTS','כבר קיים אזור בשם הזה.');
  const latitude=input?.latitude===undefined?current.latitude:number(input.latitude,-90,90);
  const longitude=input?.longitude===undefined?current.longitude:number(input.longitude,-180,180);
  const sortOrder=input?.sortOrder===undefined?current.sort_order:number(input.sortOrder,0,100000,true);
  if(!form&&input?.active!==undefined&&typeof input.active!=='boolean')throw new ApiError(400,'INVALID_INPUT');
  const active=form?input?.active==='on':input?.active===undefined?current.active:input.active;
  const area=(await this.db.query('UPDATE delivery_areas SET name=$1,latitude=$2,longitude=$3,sort_order=$4,active=$5,updated_at=NOW() WHERE id=$6 RETURNING *',
   [name,latitude,longitude,sortOrder,active,current.id])).rows[0];
  if(name!==current.name)await this.alias(localityKey(name),current.id);
  return adminArea(area);
 }
}
