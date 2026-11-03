import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CheapersalProductCatalogProvider } from './catalog.js';
import { ShopifyAdmin } from './shopify.js';
import { createProductImageProvider } from './images.js';
import { Importer } from './importer.js';
import { AppError } from './validation.js';
export function createApp(importer: Importer, port:number) {
  const app = express();
  const csrf = randomBytes(32).toString('hex');
  const host = '127.0.0.1:' + port, origin = 'http://' + host;
  app.disable('x-powered-by');
  app.use((req,res,next) => {
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({error:'הגישה אינה מורשית'});
    next();
  });
  app.use(express.json({limit:'4kb'}));
  app.get('/api/session',(_req,res) => res.json({csrf}));
  app.use('/api', (req,res,next) => {
    if (req.method !== 'POST') return next();
    const value = req.headers['x-csrf-token'];
    if (req.headers.origin !== origin || !req.is('application/json') || typeof value !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value) || !timingSafeEqual(Buffer.from(value),Buffer.from(csrf)))
      return res.status(403).json({error:'הגישה אינה מורשית'});
    next();
  });
  app.post('/api/preview',async (req,res) => res.json(await importer.preview(req.body?.barcode,req.body?.price,req.body?.manualImageUrl)));
  app.post('/api/image-selection',async (req,res) => res.json(await importer.selectImage(req.body?.previewId,req.body?.candidateIndex)));
  app.post('/api/import',async (req,res) => res.json(await importer.confirm(req.body?.previewId)));
  app.use(express.static(fileURLToPath(new URL('../public/',import.meta.url)),{etag:false}));
  app.use((_req,res) => { res.status(404).json({error:'העמוד לא נמצא'}); });
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction) => {
    res.status(error instanceof AppError ? error.status : 500).json({
      error:error instanceof AppError ? error.message : 'לא ניתן להשלים את הבקשה'});
  });
  return app;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  try {
    const app = createApp(new Importer(new CheapersalProductCatalogProvider(process.env.CHEAPERSAL_API_KEY ?? ''),
      new ShopifyAdmin({domain:process.env.SHOPIFY_STORE_DOMAIN ?? '', token:process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        clientId:process.env.SHOPIFY_CLIENT_ID, clientSecret:process.env.SHOPIFY_CLIENT_SECRET,
        trackInventory:process.env.SHOPIFY_TRACK_INVENTORY === 'true'}),createProductImageProvider(process.env)),port);
    app.listen(port,'127.0.0.1',() => console.log('Product importer: http://127.0.0.1:' + port));
  } catch (error) { console.error(error instanceof AppError ? error.message : 'Importer configuration failed'); process.exitCode = 1; }
}
