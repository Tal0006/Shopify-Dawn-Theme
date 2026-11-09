// One-shot payment maintenance job for any scheduler (Render Cron Job, systemd timer, GitHub Actions, ...):
//   npm run maintain:dist   (after `npm run build`), with the same environment as the web service.
// Runs Groups.maintain() once and exits; safe to run repeatedly or concurrently with the web service (lease-guarded).
// Prints counts only: never configuration, connection strings, contacts or payment references.
import {config} from './config.js';
import {database} from './db.js';
import {Groups} from './groups.js';
import {Shopify} from './shopify.js';
let db:ReturnType<typeof database>|undefined;
try{
 const cfg=config();
 // The simulator keeps its state inside the web-service process; a separate job process cannot see it.
 if(cfg.paymentProvider==='mock')throw Object.assign(Error('mock'),{mock:true});
 db=database(cfg.databaseUrl);
 const summary=await new Groups(db,cfg,new Shopify(cfg)).maintain();
 console.info('Group delivery payment maintenance: '+JSON.stringify(summary));
}catch(error:any){
 console.error(error?.mock?'Payment maintenance job does not run with PAYMENT_PROVIDER=mock; call POST /internal/payment-maintenance on the service instead.':'Group delivery payment maintenance failed. Check configuration and connectivity.');
 process.exitCode=1;
}finally{await db?.end().catch(()=>{});}
