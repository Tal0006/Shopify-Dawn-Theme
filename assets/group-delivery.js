(() => {
 'use strict';
 if(customElements.get('fankee-group-delivery'))return;
 // Every failure carries a code from the section's data-group-errors table; server text is never displayed.
 const failure=code=>Object.assign(new Error(code),{code});
 const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,TOKEN=/^[a-f0-9]{64}$/;
 // Only definitive server rejections of the receipt itself delete it. Network/timeout/5xx, RATE_LIMITED,
 // SHOPIFY_UNAVAILABLE and GROUP_CLOSED (an approved group still needs its members) all keep it.
 const RECEIPT_INVALIDATING_CODES=new Set(['MEMBER_AUTH_REQUIRED','GROUP_NOT_FOUND']);
 const storage=name=>{try{return window[name]||null;}catch{return null;}};
 class GroupDelivery extends HTMLElement {
  // Render cold starts can take close to a minute: announce the wait, then fail at a finite limit.
  static wakeDelay=12000;
  static requestTimeout=90000;
  static cartTimeout=10000;
  connectedCallback(){
   if(this.lifecycle)return;
   this.lifecycle=new AbortController();this.requests=new Set();this.coords=null;this.busy=false;this.pending=false;
   this.message=this.querySelector('[data-group-message]');this.group=null;this.querySelector('[data-validated-pledge]').hidden=true;
   this.currency=new Intl.NumberFormat(this.dataset.locale||'he',{style:'currency',currency:'ILS'});
   this.labels=JSON.parse(this.querySelector('[data-group-labels]').textContent);
   try{this.errors=JSON.parse(this.querySelector('[data-group-errors]')?.textContent||'{}');}catch{this.errors={};}
   try{
    this.origin=new URL(this.dataset.serviceUrl);
    if(this.origin.username||this.origin.password||this.origin.search||this.origin.hash||this.origin.pathname!=='/'||!(this.origin.protocol==='https:'||(this.origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(this.origin.hostname))))throw Error();
   }catch{this.message.textContent=this.dataset.setup;this.querySelectorAll('button').forEach(button=>button.disabled=true);return;}
   // Legacy single receipt (sessionStorage); current receipts are one localStorage key per group under receiptPrefix.
   this.storageKey='fankee-group-delivery:'+this.origin.origin;
   this.receiptPrefix=this.storageKey+':receipt:';
   this.loadReceipts();
   const options={signal:this.lifecycle.signal};
   this.querySelector('[data-find-group]').addEventListener('submit',event=>{event.preventDefault();void this.perform(()=>this.find(),event.submitter);},options);
   this.querySelector('[data-join-group]').addEventListener('submit',event=>{event.preventDefault();void this.perform(()=>this.join(),event.submitter);},options);
   this.querySelector('[data-share]').addEventListener('click',()=>this.share(),options);
   this.querySelector('[data-refresh]').addEventListener('click',event=>{void this.perform(()=>this.refresh(),event.currentTarget);},options);
   this.querySelector('[name=area]').addEventListener('input',()=>{this.coords=null;this.invalidateSearch();},options);
   this.querySelector('[data-geolocate]').addEventListener('click',()=>{
    if(!navigator.geolocation){this.message.textContent=this.dataset.geoError;return;}
    // This is the only geolocation invocation; explicit customer click is required.
    navigator.geolocation.getCurrentPosition(position=>{
     if(!this.isConnected)return;
     this.coords={lat:Math.round(position.coords.latitude*100)/100,lng:Math.round(position.coords.longitude*100)/100};this.invalidateSearch();
     this.message.textContent=this.dataset.geoReady;
    },()=>{if(this.isConnected)this.message.textContent=this.dataset.geoError;},{enableHighAccuracy:false,timeout:10000,maximumAge:300000});
   },options);
   void this.perform(async()=>{
    await this.cart();
    const receipt=this.latestReceipt();
    if(receipt)this.show((await this.withReceipt(receipt.publicId,()=>this.api('/groups/'+receipt.publicId))).group);
   });
  }
  disconnectedCallback(){this.lifecycle?.abort();this.requests?.forEach(request=>request.abort());this.lifecycle=null;}
  // Receipts: {publicId, memberToken, savedAt}. No contact details, cart, coordinates or payment data are stored.
  readReceipt(store,key){
   try{
    const value=JSON.parse(store.getItem(key)||'null');
    return value&&TOKEN.test(value.memberToken)&&UUID.test(value.publicId)?{publicId:value.publicId,memberToken:value.memberToken,savedAt:Number.isSafeInteger(value.savedAt)?value.savedAt:0}:null;
   }catch{return null;}
  }
  loadReceipts(){
   this.receipts=new Map();
   // Read sessionStorage fallbacks first so durable localStorage copies win.
   for(const store of [storage('sessionStorage'),storage('localStorage')]){
    if(!store)continue;
    try{
     for(let index=0;index<store.length;index++){
      const key=store.key(index);
      if(!key?.startsWith(this.receiptPrefix))continue;
      const receipt=this.readReceipt(store,key);
      if(receipt&&receipt.publicId===key.slice(this.receiptPrefix.length))this.receipts.set(receipt.publicId,receipt);
     }
    }catch{/* Storage may be blocked; receipts then live only in memory. */}
   }
   const session=storage('sessionStorage'),legacy=session&&this.readReceipt(session,this.storageKey);
   if(legacy){
    const receipt=this.receipts.get(legacy.publicId)||{...legacy,savedAt:Date.now()};
    this.receipts.set(receipt.publicId,receipt);
    // Drop the legacy copy only once a durable copy is confirmed.
    if(this.persist(receipt,true))try{session.removeItem(this.storageKey);}catch{}
   }
  }
  persist(receipt,durableOnly=false){
   const key=this.receiptPrefix+receipt.publicId,value=JSON.stringify({publicId:receipt.publicId,memberToken:receipt.memberToken,savedAt:receipt.savedAt});
   const local=storage('localStorage');
   try{
    local.setItem(key,value);
    if(local.getItem(key)===value){try{storage('sessionStorage')?.removeItem(key);}catch{}return true;}
   }catch{/* Private mode or quota: fall back below. */}
   if(!durableOnly)try{storage('sessionStorage')?.setItem(key,value);}catch{}
   return false;
  }
  forgetReceipt(publicId){
   this.receipts.delete(publicId);
   for(const store of [storage('localStorage'),storage('sessionStorage')]){
    try{store?.removeItem(this.receiptPrefix+publicId);}catch{}
   }
   const session=storage('sessionStorage');
   if(session&&this.readReceipt(session,this.storageKey)?.publicId===publicId)try{session.removeItem(this.storageKey);}catch{}
  }
  receiptFor(publicId){return typeof publicId==='string'?this.receipts.get(publicId):undefined;}
  latestReceipt(){let latest;for(const receipt of this.receipts.values())if(!latest||receipt.savedAt>latest.savedAt)latest=receipt;return latest;}
  // Runs a request on behalf of a stored receipt and deletes the receipt only on a definitive rejection.
  async withReceipt(publicId,request){
   try{return await request();}
   catch(error){
    if(this.receiptFor(publicId)&&RECEIPT_INVALIDATING_CODES.has(error?.code)){this.forgetReceipt(publicId);this.controls();}
    throw error;
   }
  }
  async perform(action,trigger){
   if(this.busy)return;const lifecycle=this.lifecycle,focus=document.activeElement;this.busy=true;const loading=trigger||(focus?.matches('button')&&this.contains(focus)?focus:null);loading?.setAttribute('aria-busy','true');this.setAttribute('aria-busy','true');this.querySelectorAll('form').forEach(form=>form.inert=true);this.message.textContent='';
   try{await action();}catch(error){if(this.lifecycle===lifecycle&&this.isConnected&&error.name!=='AbortError')this.message.textContent=this.errorMessage(error);}
   finally{if(this.lifecycle!==lifecycle)return;this.busy=false;loading?.removeAttribute('aria-busy');this.removeAttribute('aria-busy');this.querySelectorAll('form').forEach(form=>form.inert=false);this.controls();if(focus?.isConnected&&this.contains(focus)&&!focus.disabled&&document.activeElement===document.body)focus.focus({preventScroll:true});}
  }
  errorMessage(error){const code=typeof error?.code==='string'&&Object.hasOwn(this.errors,error.code)?error.code:'DEFAULT';return this.errors[code]||'';}
  invalidateSearch(){
   this.foundPlace=null;
   if(!this.receiptFor(this.group?.publicId)){
    this.group=null;this.pending=false;
    const panel=this.querySelector('[data-group-panel]');panel.hidden=true;panel.removeAttribute('data-group-pending');
    this.querySelector('[data-validated-pledge]').hidden=true;
   }
   this.controls();
  }
  controls(){
   if(!this.origin)return;
   const joined=!!this.receiptFor(this.group?.publicId);
   this.querySelector('[data-contact-fields]').disabled=joined;
   this.querySelector('[data-contact-fields]').hidden=joined;
   this.querySelector('[data-validated-pledge]').dataset.joined=String(joined);
   this.querySelector('[data-pledge-label]').textContent=joined?this.dataset.pledgeLabel:this.dataset.estimate;
   this.querySelector('[data-share]').disabled=!this.group;
   const button=this.querySelector('[data-join-button]');
   button.textContent=joined?this.dataset.updateLabel:this.pending?this.dataset.startLabel:this.dataset.joinLabel;
   button.disabled=this.pending?!this.foundPlace:!this.group||!['OPEN','THRESHOLD_REACHED'].includes(this.group.status);
  }
  async api(path,body,token){
   // One controller per request: lifecycle aborts (disconnect) stay silent; the finite timeout reports REQUEST_TIMEOUT.
   const controller=new AbortController();this.requests.add(controller);let timedOut=false;
   const wake=setTimeout(()=>{if(this.isConnected&&!controller.signal.aborted)this.message.textContent=this.dataset.waking||'';},GroupDelivery.wakeDelay);
   const timer=setTimeout(()=>{timedOut=true;controller.abort();},GroupDelivery.requestTimeout);
   const interrupted=error=>{if(timedOut)return failure('REQUEST_TIMEOUT');return controller.signal.aborted?error:null;};
   try{
    let response;
    try{response=await fetch(this.origin.origin+'/api/v1'+path,{method:body?'POST':'GET',credentials:'omit',signal:controller.signal,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch(error){throw interrupted(error)||failure('NETWORK_ERROR');}
    let data=null;
    try{data=await response.json();}catch(error){const stop=interrupted(error);if(stop)throw stop;}
    // Hosting proxies can answer without the service's JSON body; classify by status alone.
    if(!response.ok)throw failure(typeof data?.code==='string'?data.code:response.status===429?'RATE_LIMITED':response.status>=500?'SERVICE_UNAVAILABLE':'DEFAULT');
    if(!data||typeof data!=='object')throw failure('INVALID_RESPONSE');
    return data;
   }finally{
    clearTimeout(wake);clearTimeout(timer);this.requests.delete(controller);
    if(this.message.textContent&&this.message.textContent===this.dataset.waking)this.message.textContent='';
   }
  }
  async cart(){
   const url=new URL(this.dataset.cartUrl,location.origin);if(url.origin!==location.origin)throw failure('CART_READ_FAILED');
   const controller=new AbortController();this.requests.add(controller);let timedOut=false;
   const timer=setTimeout(()=>{timedOut=true;controller.abort();},GroupDelivery.cartTimeout);
   try{
    let cart;
    try{
     const response=await fetch(url,{credentials:'same-origin',signal:controller.signal});
     if(!response.ok)throw failure('CART_READ_FAILED');cart=await response.json();
    }catch(error){if(controller.signal.aborted&&!timedOut)throw error;throw failure('CART_READ_FAILED');}
    if(!Number.isSafeInteger(cart?.total_price)||!Array.isArray(cart?.items))throw failure('CART_READ_FAILED');
    if(cart.currency!=='ILS')throw failure('CART_CURRENCY');
    this.querySelector('[data-empty-cart]').hidden=cart.items.length>0;
    this.querySelector('[data-current-cart]').textContent=this.currency.format(cart.total_price/100);
    if(cart.items.some(item=>item.selling_plan_allocation||Object.keys(item.properties||{}).length))throw failure('CART_UNAVAILABLE');
    this.lines=cart.items.map(item=>({variantId:String(item.variant_id||item.id),quantity:item.quantity}));
    return this.lines;
   }finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  place(){return {areaName:this.querySelector('[name=area]').value.trim(),...(this.coords||{})};}
  // Read-only search. Temporary safety net for a service older than the staged rollout: it answers /groups/find with
  // 404 NOT_FOUND, so fall back once to the deprecated /groups/find-or-create. Remove in the staged-deployment cleanup
  // (tools/group-delivery/README.md), together with the legacy route.
  async search(body){
   try{return await this.api('/groups/find',body);}
   catch(error){if(error?.code!=='NOT_FOUND')throw error;return this.api('/groups/find-or-create',body);}
  }
  async find(){
   const lines=await this.cart();if(!lines.length)throw failure('CART_EMPTY');
   this.foundPlace=this.place();
   const result=await this.search({location:this.foundPlace,lines});
   if(result.group){this.show(result.group);this.message.textContent=this.dataset.found;}
   else{this.showPending(this.foundPlace.areaName);this.message.textContent=this.dataset.noneFound;}
   if(result.withinStandardRadius===true)this.message.textContent=this.dataset.standard;
   this.pledge(result);
  }
  async join(){
   const lines=await this.cart();
   const receipt=this.receiptFor(this.group?.publicId);
   if(!lines.length&&!receipt)throw failure('CART_EMPTY');
   if(receipt){
    const id=receipt.publicId;
    try{
     const result=await this.withReceipt(id,()=>this.api('/groups/'+id+'/update-pledge',{lines},receipt.memberToken));
     this.show(result.group);this.pledge(result);this.message.textContent=this.dataset.updated;
    }catch(error){
     // Closed groups keep the receipt; show their current state instead of leaving a stale panel.
     if(error?.code==='GROUP_CLOSED')try{this.show((await this.api('/groups/'+id)).group);}catch{}
     throw error;
    }
    return;
   }
   if(!this.foundPlace||(!this.group&&!this.pending))throw failure('DEFAULT');
   const form=this.querySelector('[data-join-group]');
   const body={location:this.foundPlace,lines,email:form.querySelector('[name=email]').value,phone:form.querySelector('[name=phone]').value};
   // A shown group is joined directly; with no group yet, the service re-checks the area under its lock and
   // creates the group only now, with this shopper as its first member.
   const result=await this.api(this.group?'/groups/'+this.group.publicId+'/join':'/groups/join',body);
   if(!TOKEN.test(result.memberToken)||!UUID.test(result.group?.publicId))throw failure('INVALID_RESPONSE');
   const saved={publicId:result.group.publicId,memberToken:result.memberToken,savedAt:Date.now()};
   this.receipts.set(saved.publicId,saved);this.persist(saved);
   form.reset();this.show(result.group);this.pledge(result);this.message.textContent=result.created===true?this.dataset.started:this.dataset.joined;
  }
  pledge(result){if(Number.isSafeInteger(result.validatedPledgeAgorot)&&result.validatedPledgeAgorot>=0){const pledge=this.querySelector('[data-validated-pledge]');pledge.hidden=false;pledge.querySelector('bdi').textContent=this.currency.format(result.validatedPledgeAgorot/100);}}
  share(){
   if(!this.group)return;
   // Share only the storefront path and public aggregates, without URL parameters or receipts.
   const page=new URL(location.pathname,location.origin);
   const text=this.dataset.shareText.replace('__AREA__',this.group.areaName).replace('__AMOUNT__',this.currency.format(this.group.pledgedTotalAgorot/100)).replace('__TARGET__',this.currency.format(this.group.thresholdAgorot/100));
   window.open('https://wa.me/?text='+encodeURIComponent(text+'\n'+page.href),'_blank','noopener,noreferrer');
  }
  async refresh(){if(this.group){const id=this.group.publicId;this.show((await this.withReceipt(id,()=>this.api('/groups/'+id))).group);}}
  // No group exists for the searched area yet. Nothing has been created; the join button will start one.
  showPending(areaName){
   this.group=null;this.pending=true;
   const panel=this.querySelector('[data-group-panel]');panel.hidden=false;panel.setAttribute('data-group-pending','');
   this.querySelector('[data-group-title]').textContent=this.dataset.pendingTitle.replace('__AREA__',areaName);
   this.querySelector('[data-group-state]').textContent=this.dataset.pendingState;
   this.querySelector('[data-milestone-message]').hidden=true;
   this.controls();
  }
  show(group){
   if(!group||!Object.hasOwn(this.labels,group.status)||typeof group.publicId!=='string'||!UUID.test(group.publicId)||typeof group.areaName!=='string'||!['thresholdAgorot','pledgedTotalAgorot','remainingAmountAgorot','progressPercent','participantCount'].every(key=>Number.isSafeInteger(group[key])&&group[key]>=0)||group.thresholdAgorot===0||!Number.isFinite(Date.parse(group.expiresAt)))throw failure('INVALID_RESPONSE');
   this.group=group;this.pending=false;
   const panel=this.querySelector('[data-group-panel]');panel.hidden=false;panel.removeAttribute('data-group-pending');
   this.querySelector('[data-group-title]').textContent=this.dataset.area.replace('__AREA__',group.areaName);
   this.querySelector('[data-group-state]').textContent=this.labels[group.status];
   this.querySelector('[data-pledged]').textContent=this.currency.format(group.pledgedTotalAgorot/100);this.querySelector('[data-threshold]').textContent=this.currency.format(group.thresholdAgorot/100);
   const percent=Math.max(0,Math.min(100,group.progressPercent));this.querySelector('[role=progressbar]').setAttribute('aria-valuenow',String(percent));
   this.querySelector('[data-progress-fill]').style.transform='scaleX('+(percent/100)+')';
   this.querySelector('[data-percent]').textContent=percent+'%';
   const success=group.status==='THRESHOLD_REACHED',almost=group.status==='OPEN'&&percent>=80&&percent<100;
   panel.dataset.milestone=percent>=100?'success':percent>=80?'almost':percent>=50?'middle':'normal';
   this.querySelector('[data-milestone-message]').hidden=!success&&!almost;
   this.querySelector('[data-milestone-title]').textContent=success?this.dataset.reached:almost?this.dataset.almost:'';
   this.querySelector('[data-milestone-detail]').textContent=success?this.dataset.waiting:almost?this.dataset.remaining.replace('__AMOUNT__',this.currency.format(group.remainingAmountAgorot/100)):'';
   this.querySelector('[data-remaining]').textContent=this.dataset.remaining.replace('__AMOUNT__',this.currency.format(group.remainingAmountAgorot/100));
   this.querySelector('[data-participants]').textContent=group.participantCount===1?this.dataset.countOne:this.dataset.count.replace('__COUNT__',group.participantCount);
   const time=this.querySelector('[data-expiry]');time.dateTime=group.expiresAt;time.textContent=new Intl.DateTimeFormat(this.dataset.locale||'he').format(new Date(group.expiresAt));
   if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))this.message.textContent=this.dataset.closed;
   this.controls();
  }
 }
 customElements.define('fankee-group-delivery',GroupDelivery);
})();
