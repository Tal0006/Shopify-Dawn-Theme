
import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
export interface Queryable { query(sql:string,values?:any[]):Promise<{rows:any[];rowCount?:number|null}> }
export interface Connection extends Queryable {release():void}
export interface Database extends Queryable {connect():Promise<Connection>}
export function database(url:string):pg.Pool {
 const pool=new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:15000});
 pool.on('error',()=>console.error('Group delivery database connection interrupted.'));
 return pool;
}
export async function transaction<T>(db:Database,fn:(db:Queryable)=>Promise<T>):Promise<T>{
 const client=await db.connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function migrate(db:Database){
 await transaction(db,async client=>{
  // Take a PostgreSQL transaction advisory lock before bootstrap DDL can race.
  await client.query('SELECT pg_advisory_xact_lock(4330001)');
  // The durable row also documents the single migration stream.
  await client.query('CREATE TABLE IF NOT EXISTS schema_migration_lock (id integer PRIMARY KEY)');
  await client.query('INSERT INTO schema_migration_lock(id) VALUES(1) ON CONFLICT DO NOTHING');
  await client.query('SELECT id FROM schema_migration_lock WHERE id=1 FOR UPDATE');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of (await readdir(dir)).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
   if((await client.query('SELECT name FROM schema_migrations WHERE name=$1',[name])).rows.length)continue;
   await client.query(await readFile(new URL(name,dir),'utf8'));
   await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);
  }
 });
}
