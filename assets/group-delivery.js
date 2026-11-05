(() => {
 'use strict';
 if(customElements.get('fankee-group-delivery'))return;
 class GroupDelivery extends HTMLElement {
  connectedCallback(){
   if(this.lifecycle)return;
   this.lifecycle=new AbortController();this.requests=new Set();this.coords=null;this.busy=false;
   this.message=this.querySelector('[data-group-message]');this.group=null;this.querySelector('[data-validated-pledge]').hidden=true;
   this.currency=new Intl.NumberFormat(this.dataset.locale||'he',{style:'currency',currency:'ILS'});
   this.labels=JSON.parse(this.querySelector('[data-group-labels]').textContent);
   try{
    this.origin=new URL(this.dataset.serviceUrl);
    if(this.origin.username||this.origin.password||this.origin.search||this.origin.hash||this.origin.pathname!=='/'||!(this.origin.protocol==='https:'||(this.origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(this.origin.hostname))))throw Error();
   }catch{this.message.textContent=this.dataset.setup;this.querySelectorAll('button').forEach(button=>button.disabled=true);return;}
   this.storageKey='fankee-group-delivery:'+this.origin.origin;
   try{const saved=JSON.parse(sessionStorage.getItem(this.storageKey)||'null');this.receipt=/^[a-f0-9]{64}$/.test(saved?.memberToken)&&/^[a-f0-9-]{36}$/.test(saved?.publicId)?saved:null;}catch{this.receipt=null;}
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
   void this.perform(async()=>{await this.cart();if(this.receipt)this.show((await this.api('/groups/'+this.receipt.publicId)).group);});
  }
  disconnectedCallback(){this.lifecycle?.abort();this.requests?.forEach(request=>request.abort());this.lifecycle=null;}
  async perform(action,trigger){
   if(this.busy)return;const lifecycle=this.lifecycle,focus=document.activeElement;this.busy=true;const loading=trigger||(focus?.matches('button')&&this.contains(focus)?focus:null);loading?.setAttribute('aria-busy','true');this.setAttribute('aria-busy','true');this.querySelectorAll('form').forEach(form=>form.inert=true);this.message.textContent='';
   try{await action();}catch(error){if(this.lifecycle===lifecycle&&this.isConnected&&error.name!=='AbortError')this.message.textContent=error.message===this.dataset.empty?this.dataset.empty:error.code==='ALREADY_JOINED'?this.dataset.duplicate:['CART_UNAVAILABLE','SHOPIFY_UNAVAILABLE'].includes(error.code)?this.dataset.shopifyError:error.code==='INVALID_CART'?this.dataset.invalidCart:error.code==='GROUP_NOT_OPEN'?this.dataset.closed:this.dataset.error;}
   finally{if(this.lifecycle!==lifecycle)return;this.busy=false;loading?.removeAttribute('aria-busy');this.removeAttribute('aria-busy');this.querySelectorAll('form').forEach(form=>form.inert=false);this.controls();if(focus?.isConnected&&this.contains(focus)&&!focus.disabled&&document.activeElement===document.body)focus.focus({preventScroll:true});}
  }
  invalidateSearch(){this.foundPlace=null;if(!this.receipt||this.receipt.publicId!==this.group?.publicId){this.group=null;this.querySelector('[data-group-panel]').hidden=true;this.querySelector('[data-validated-pledge]').hidden=true;}this.controls();}
  controls(){
   if(!this.origin)return;
   const joined=this.receipt&&this.group?.publicId===this.receipt.publicId;
   this.querySelector('[data-contact-fields]').disabled=!!joined;
   this.querySelector('[data-contact-fields]').hidden=!!joined;
   this.querySelector('[data-validated-pledge]').dataset.joined=String(!!joined);
   this.querySelector('[data-pledge-label]').textContent=joined?this.dataset.pledgeLabel:this.dataset.estimate;
   this.querySelector('[data-share]').disabled=!this.group;
   const button=this.querySelector('[data-join-button]');
   button.textContent=joined?this.dataset.updateLabel:this.dataset.joinLabel;
   button.disabled=!this.group||!['OPEN','THRESHOLD_REACHED'].includes(this.group.status);
  }
  async api(path,body,token){
   const controller=new AbortController();this.requests.add(controller);
   const timer=setTimeout(()=>controller.abort(),12000);
   try{
    const response=await fetch(this.origin.origin+'/api/v1'+path,{method:body?'POST':'GET',credentials:'omit',signal:controller.signal,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok){const error=new Error(this.dataset.error);error.code=data.code;throw error;}
    return data;
   }finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  async cart(){
   const url=new URL(this.dataset.cartUrl,location.origin);if(url.origin!==location.origin)throw Error();
   const controller=new AbortController();this.requests.add(controller);const timer=setTimeout(()=>controller.abort(),10000);
   try{
    const response=await fetch(url,{credentials:'same-origin',signal:controller.signal});
    if(!response.ok)throw Error();const cart=await response.json();
    if(cart.currency!=='ILS'||!Number.isSafeInteger(cart.total_price)||!Array.isArray(cart.items))throw Error();
    this.querySelector('[data-empty-cart]').hidden=cart.items.length>0;
    this.querySelector('[data-current-cart]').textContent=this.currency.format(cart.total_price/100);
    if(cart.items.some(item=>item.selling_plan_allocation||Object.keys(item.properties||{}).length))throw Object.assign(Error(),{code:'CART_UNAVAILABLE'});
    this.lines=cart.items.map(item=>({variantId:String(item.variant_id||item.id),quantity:item.quantity}));
    return this.lines;
   }finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  place(){return {areaName:this.querySelector('[name=area]').value.trim(),...(this.coords||{})};}
  async find(){
   const lines=await this.cart();if(!lines.length)throw Error(this.dataset.empty);
   this.foundPlace=this.place();
   const result=await this.api('/groups/find-or-create',{location:this.foundPlace,lines});
   this.show(result.group);this.message.textContent=this.dataset.found;
   if(result.withinStandardRadius===true)this.message.textContent=this.dataset.standard;
   this.pledge(result);
  }
  async join(){
   const lines=await this.cart();
   const joined=this.receipt?.publicId===this.group?.publicId;
   if(!lines.length&&!joined)throw Error(this.dataset.empty);
   if(joined){
    const result=await this.api('/groups/'+this.group.publicId+'/update-pledge',{lines},this.receipt.memberToken);
    this.show(result.group);this.pledge(result);this.message.textContent=this.dataset.updated;
   }else{
    if(!this.foundPlace)throw Error();
    const form=this.querySelector('[data-join-group]');
    const result=await this.api('/groups/'+this.group.publicId+'/join',{location:this.foundPlace,lines,email:form.querySelector('[name=email]').value,phone:form.querySelector('[name=phone]').value});
    if(!/^[a-f0-9]{64}$/.test(result.memberToken))throw Error();
    this.receipt={publicId:result.group.publicId,memberToken:result.memberToken};
    try{sessionStorage.setItem(this.storageKey,JSON.stringify(this.receipt));}catch{/* Receipt remains usable in this tab until navigation. */}
    form.reset();this.show(result.group);this.pledge(result);this.message.textContent=this.dataset.joined;
   }
  }
  pledge(result){if(Number.isSafeInteger(result.validatedPledgeAgorot)&&result.validatedPledgeAgorot>=0){const pledge=this.querySelector('[data-validated-pledge]');pledge.hidden=false;pledge.querySelector('bdi').textContent=this.currency.format(result.validatedPledgeAgorot/100);}}
  share(){
   if(!this.group)return;
   // Share only the storefront path and public aggregates, without URL parameters or receipts.
   const page=new URL(location.pathname,location.origin);
   const text=this.dataset.shareText.replace('__AREA__',this.group.areaName).replace('__AMOUNT__',this.currency.format(this.group.pledgedTotalAgorot/100)).replace('__TARGET__',this.currency.format(this.group.thresholdAgorot/100));
   window.open('https://wa.me/?text='+encodeURIComponent(text+'\n'+page.href),'_blank','noopener,noreferrer');
  }
  async refresh(){if(this.group)this.show((await this.api('/groups/'+this.group.publicId)).group);}
  show(group){
   if(!group||!Object.hasOwn(this.labels,group.status)||typeof group.publicId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(group.publicId)||typeof group.areaName!=='string'||!['thresholdAgorot','pledgedTotalAgorot','remainingAmountAgorot','progressPercent','participantCount'].every(key=>Number.isSafeInteger(group[key])&&group[key]>=0)||group.thresholdAgorot===0||!Number.isFinite(Date.parse(group.expiresAt)))throw Error();
   this.group=group;this.querySelector('[data-group-panel]').hidden=false;
   this.querySelector('[data-group-title]').textContent=this.dataset.area.replace('__AREA__',group.areaName);
   this.querySelector('[data-group-state]').textContent=this.labels[group.status];
   this.querySelector('[data-pledged]').textContent=this.currency.format(group.pledgedTotalAgorot/100);this.querySelector('[data-threshold]').textContent=this.currency.format(group.thresholdAgorot/100);
   const percent=Math.max(0,Math.min(100,group.progressPercent));this.querySelector('[role=progressbar]').setAttribute('aria-valuenow',String(percent));
   this.querySelector('[data-progress-fill]').style.transform='scaleX('+(percent/100)+')';
   this.querySelector('[data-percent]').textContent=percent+'%';
   const success=group.status==='THRESHOLD_REACHED',almost=group.status==='OPEN'&&percent>=80&&percent<100;
   this.querySelector('[data-group-panel]').dataset.milestone=percent>=100?'success':percent>=80?'almost':percent>=50?'middle':'normal';
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
