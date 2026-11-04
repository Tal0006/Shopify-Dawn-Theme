import {Router} from 'express';
import {isIP} from 'node:net';
import {QuoteService} from '../shopping/quote-service.js';
import {CheckoutService} from '../shopping/checkout-service.js';
import {rateLimit} from '../middleware/rate-limit.js';
export function shoppingListRoutes(quotes:QuoteService,checkout:CheckoutService){
 const routes=Router();
 const buyer=(ip:string|undefined)=>{const clean=ip?.replace(/^::ffff:/,'');return {ip:clean&&isIP(clean)?clean:undefined};};
 routes.post('/quote',async(req,res)=>res.json(await quotes.create(req.body?.message,buyer(req.ip))));
 routes.post('/resolve',async(req,res)=>res.json(await quotes.resolve(req.body,buyer(req.ip))));
 routes.post('/checkout',rateLimit(10),async(req,res)=>res.json(await checkout.checkout(req.body,buyer(req.ip))));
 return routes;
}
