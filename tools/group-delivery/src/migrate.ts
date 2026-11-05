import {database,migrate} from './db.js';
let db:ReturnType<typeof database>|undefined;
try{
 const url=process.env.DATABASE_URL;
 if(!url)throw Error('Missing database configuration');
 db=database(url);await migrate(db);
 console.info('Group delivery migrations complete');
}catch{
 // Never let a driver URL/parser error print a connection string or credential.
 console.error('Group delivery migration failed. Check database configuration and connectivity.');
 process.exitCode=1;
}finally{await db?.end().catch(()=>{});}
