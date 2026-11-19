// One retention run for cancellation requests (npm run cancellations:retention), e.g. as a Render Cron Job. The web
// service already runs the same job at startup and every 6 hours; this entry point needs only DATABASE_URL and
// CANCELLATION_RETENTION_DAYS. Without a retention period it deletes nothing and exits 0 with a warning.
import {database} from './db.js';
import {Cancellations,cancellationConfig} from './cancellations.js';
let db:ReturnType<typeof database>|undefined;
try{
 const url=process.env.DATABASE_URL;
 if(!url)throw Error('Missing database configuration');
 const cfg=cancellationConfig(process.env);
 if(cfg.retentionProblem||cfg.retentionDays===null){
  console.warn(cfg.retentionProblem||'CANCELLATION_RETENTION_DAYS is not configured; no cancellation request was deleted.');
 }else{
  db=database(url);
  const result=await new Cancellations(db,cfg,{adminOrigin:()=>''}).purgeExpired();
  console.info('Cancellation retention complete: personal data removed from '+result.purged+' request(s).');
 }
}catch{
 // Never print a connection string, a credential or request content.
 console.error('Cancellation retention failed. Check database configuration and connectivity.');
 process.exitCode=1;
}finally{await db?.end().catch(()=>{});}
