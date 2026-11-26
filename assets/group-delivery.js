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
 // Filtering only; the server resolves areas by publicId and never trusts a typed name.
 const areaKey=name=>String(name).normalize('NFKC').toLocaleLowerCase().replace(/[\s'"״׳.()-]+/g,' ').trim();
 const REASONS=new Set(['AVAILABLE','QUANTITY_REDUCED','UNAVAILABLE']),VARIANT=/^[1-9]\d{0,19}$/;
 const count=value=>Number.isSafeInteger(value)&&value>=0;
 // One-time code input: typed or pasted text ("123 456", full-width or Arabic-Indic digits) becomes at most 6 ASCII digits.
 const digits=value=>String(value).normalize('NFKC').replace(/[٠-٩۰-۹]/g,d=>String(d.charCodeAt(0)&15)).replace(/\D/g,'').slice(0,6);
 // The member read (POST /groups/:id/member) as the service documents it; anything else is ignored.
 const PAYMENT_STATUSES=new Set(['CARD_RESERVED','CONSENT_REQUIRED','CHARGE_PENDING','CHARGED','PAYMENT_FAILED','CANCELED']);
 // Card membership state from the member read; null for groups without cards. Never a token or a Cardcom id.
 const paymentShape=payment=>payment&&PAYMENT_STATUSES.has(payment.status)&&count(payment.approvedAmountAgorot)&&(payment.pendingAmountAgorot===null||count(payment.pendingAmountAgorot))
  ?{status:payment.status,approvedAmountAgorot:payment.approvedAmountAgorot,pendingAmountAgorot:payment.pendingAmountAgorot}:null;
 // Only Cardcom's own HTTPS page may receive the shopper.
 const CARDCOM_HOSTS=new Set(['secure.cardcom.solutions']);
 const RESERVATION_FINAL=new Set(['RESERVATION_FAILED','EXPIRED','CANCELED']);
 const memberShape=member=>{
  if(!member||!['PLEDGED','WITHDRAWN'].includes(member.status)||!count(member.pledgedTotalAgorot)||!['OK','UNAVAILABLE'].includes(member.cartCheck))return null;
  if(member.cart!==null&&!(Array.isArray(member.cart)&&member.cart.every(line=>line&&VARIANT.test(line.variantId)&&count(line.quantity)&&line.quantity>0&&count(line.restorableQuantity)&&line.restorableQuantity<=line.quantity&&
   count(line.storedUnitAgorot)&&(line.currentUnitAgorot===null||count(line.currentUnitAgorot))&&typeof line.available==='boolean'&&typeof line.priceChanged==='boolean'&&REASONS.has(line.reason)&&(line.title===null||typeof line.title==='string'))))return null;
  return {status:member.status,pledgedTotalAgorot:member.pledgedTotalAgorot,cartCheck:member.cartCheck,cart:member.cart,payment:paymentShape(member.payment)};
 };
 class GroupDelivery extends HTMLElement {
  // Render cold starts can take close to a minute: announce the wait, then fail at a finite limit.
  static wakeDelay=12000;
  static requestTimeout=90000;
  static cartTimeout=10000;
  // Return from Cardcom: a short, bounded check (the webhook normally finishes first).
  static verifyAttempts=6;
  static verifyInterval=1500;
  connectedCallback(){
   if(this.lifecycle)return;
   this.lifecycle=new AbortController();this.requests=new Set();this.busy=false;this.pending=false;
   this.areas=[];this.area=null;this.options=[];this.active=-1;
   this.areaInput=this.querySelector('[data-area-input]');this.areaList=this.querySelector('[data-area-list]');this.areaStatus=this.querySelector('[data-area-selected]');
   this.message=this.querySelector('[data-group-message]');this.group=null;this.noticeText=this.querySelector('[data-notice]').textContent;this.querySelector('[data-validated-pledge]').hidden=true;
   // A (re)connected section starts from the area search; a group appears only through resume() or a new search.
   this.querySelector('[data-group-panel]').hidden=true;this.querySelector('[data-resume]').hidden=true;this.recovery=null;this.querySelector('[data-otp]').hidden=true;this.querySelector('[data-join-group]').hidden=false;
   this.currency=new Intl.NumberFormat(this.dataset.locale||'he',{style:'currency',currency:'ILS'});
   this.withdrawLabel=this.querySelector('[data-withdraw]').textContent;this.withdrawText=this.querySelector('[data-withdraw-text]').textContent;
   this.labels=JSON.parse(this.querySelector('[data-group-labels]').textContent);
   try{this.errors=JSON.parse(this.querySelector('[data-group-errors]')?.textContent||'{}');}catch{this.errors={};}
   try{
    this.origin=new URL(this.dataset.serviceUrl);
    if(this.origin.username||this.origin.password||this.origin.search||this.origin.hash||this.origin.pathname!=='/'||!(this.origin.protocol==='https:'||(this.origin.protocol==='http:'&&['127.0.0.1','localhost'].includes(this.origin.hostname))))throw Error();
   }catch{this.message.textContent=this.dataset.setup;this.querySelectorAll('button').forEach(button=>button.disabled=true);return;}
   // Legacy single receipt (sessionStorage); current receipts are one localStorage key per group under receiptPrefix.
   this.storageKey='fankee-group-delivery:'+this.origin.origin;
   this.receiptPrefix=this.storageKey+':receipt:';
   // A card reservation in progress: {reservationId, memberToken, publicId, savedAt}. Kept until the service reports a
   // final state; never contains contacts, card data or anything from Cardcom.
   this.reservationKey=this.storageKey+':reservation';
   this.loadReceipts();
   // The return page marker (?gd_result=success|failed) is only a hint; the service decides. It is removed from the URL.
   try{const url=new URL(location.href),result=url.searchParams.get('gd_result');if(result){this.returnResult=result==='failed'?'failed':'success';url.searchParams.delete('gd_result');history.replaceState(history.state,'',url.pathname+url.search+url.hash);}}catch{}
   const options={signal:this.lifecycle.signal};
   this.querySelector('[data-find-group]').addEventListener('submit',event=>{event.preventDefault();void this.perform(()=>this.find(),event.submitter);},options);
   this.querySelector('[data-join-group]').addEventListener('submit',event=>{event.preventDefault();void this.perform(()=>this.join(),event.submitter);},options);
   this.querySelector('[data-share]').addEventListener('click',()=>this.share(),options);
   this.querySelector('[data-refresh]').addEventListener('click',event=>{void this.perform(()=>this.refresh(),event.currentTarget);},options);
   // Returning member: review before restoring the cart, and withdrawal only through its confirmation dialog.
   this.querySelector('[data-restore]').addEventListener('click',event=>{void this.perform(()=>this.review('restore'),event.currentTarget);},options);
   this.querySelector('[data-show-pledge]').addEventListener('click',event=>{void this.perform(()=>this.review('pledge'),event.currentTarget);},options);
   this.querySelector('[data-restore-confirm]').addEventListener('click',event=>{void this.perform(()=>this.restore(),event.currentTarget);},options);
   this.querySelector('[data-restore-cancel]').addEventListener('click',()=>this.closeReview(),options);
   this.querySelector('[data-withdraw]').addEventListener('click',()=>{const dialog=this.querySelector('[data-withdraw-dialog]');if(!dialog.open&&!this.busy)dialog.showModal();},options);
   this.querySelector('[data-withdraw-cancel]').addEventListener('click',()=>this.querySelector('[data-withdraw-dialog]').close(),options);
   this.querySelector('[data-withdraw-confirm]').addEventListener('click',event=>{void this.perform(()=>this.withdraw(),event.currentTarget);},options);
   // Card reservation consent gates the button; a changed pledge has its own explicit consent.
   this.querySelector('[data-reserve-consent]').addEventListener('change',()=>this.controls(),options);
   this.querySelector('[data-consent-change-check]').addEventListener('change',event=>{this.querySelector('[data-consent-change-confirm]').disabled=!event.currentTarget.checked||this.busy;},options);
   this.querySelector('[data-consent-change-confirm]').addEventListener('click',event=>{void this.perform(()=>this.confirmPledge(),event.currentTarget);},options);
   this.querySelector('[data-verify-primary]').addEventListener('click',()=>this.verifyActions?.primary?.(),options);
   this.querySelector('[data-verify-secondary]').addEventListener('click',()=>this.verifyActions?.secondary?.(),options);
   this.areaInput.addEventListener('input',()=>this.onAreaInput(),options);
   this.areaInput.addEventListener('keydown',event=>this.onAreaKeydown(event),options);
   // Tapping the field while the list is open must not rebuild it (that would reset its scroll position).
   this.areaInput.addEventListener('click',()=>{if(this.areaList.hidden)this.openAreas();},options);
   this.areaInput.addEventListener('focus',()=>this.openAreas(),options);
   // An option is chosen on click, which browsers send only for a tap: a finger that scrolls the list gets
   // pointercancel instead. Choosing on pointerdown selected (and closed) on the first touch of every swipe.
   // pointerdown only keeps focus in the input, so the keyboard and the combobox context stay.
   this.areaList.addEventListener('pointerdown',event=>{
    if(!event.target.closest('[role=option]'))return;
    event.preventDefault();
    // A finger on a list that is still moving (a fling) only stops it, as in native lists; it is not a choice.
    // Mouse and keyboard scrolling are never a fling, so their next click always counts.
    this.areaPress={x:event.clientX,y:event.clientY,scroll:this.areaList.scrollTop,stops:event.pointerType==='touch'&&performance.now()-this.areaScrolled<150};
   },options);
   this.areaScrolled=-Infinity;
   this.areaList.addEventListener('scroll',()=>{this.areaScrolled=performance.now();},{...options,passive:true});
   this.areaList.addEventListener('click',event=>{
    const option=event.target.closest('[role=option]'),press=this.areaPress;this.areaPress=null;
    if(!option||!press||press.stops||Math.abs(this.areaList.scrollTop-press.scroll)>2||Math.hypot(event.clientX-press.x,event.clientY-press.y)>12)return;
    const area=this.areas.find(item=>item.publicId===option.dataset.areaId);if(area)this.selectArea(area);
   },options);
   this.querySelector('[data-area-picker]').addEventListener('focusout',event=>{if(!this.querySelector('[data-area-picker]').contains(event.relatedTarget))this.closeAreas();},options);
   // Outside: a tap closes the list, a swipe that scrolls the page does not (touch scrolling ends in pointercancel,
   // never pointerup). pointerup, not click: iOS sends no click for taps on plain content.
   // A press that starts in the picker is never an outside tap, even if the page moved under the pointer meanwhile.
   const inPicker=target=>!!this.querySelector('[data-area-picker]')?.contains(target);
   document.addEventListener('pointerdown',event=>{this.pressOutside=!inPicker(event.target);},{...options,capture:true});
   document.addEventListener('pointerup',event=>{if(this.pressOutside&&!inPicker(event.target))this.closeAreas();this.pressOutside=false;},options);
   // Keep the open list inside the visible screen (the on-screen keyboard shrinks it on phones).
   window.visualViewport?.addEventListener('resize',()=>{if(!this.areaList.hidden)this.fitAreas();},options);
   // The only geolocation request; it needs this explicit click.
   this.querySelector('[data-geolocate]').addEventListener('click',()=>{void this.locate();},options);
   this.querySelector('[data-resume-primary]').addEventListener('click',()=>this.resumeActions?.primary?.(),options);
   this.querySelector('[data-resume-secondary]').addEventListener('click',()=>this.resumeActions?.secondary?.(),options);
   this.querySelector('[data-resume-list]').addEventListener('click',event=>{const button=event.target.closest('button[data-resume-group]');if(button)this.resumeActions?.pick?.(button.dataset.resumeGroup);},options);
   // Membership recovery by emailed code (offered after ALREADY_JOINED without a receipt here).
   this.querySelector('[data-otp-start]').addEventListener('click',event=>{void this.perform(()=>this.recoveryStart(),event.currentTarget);},options);
   for(const selector of ['[data-otp-back]','[data-otp-cancel]'])this.querySelector(selector).addEventListener('click',()=>{if(!this.busy)this.hideOtp(true);},options);
   this.querySelector('[data-otp-form]').addEventListener('submit',event=>{event.preventDefault();void this.perform(()=>this.recoveryVerify(),event.submitter);},options);
   this.querySelector('[data-otp-resend]').addEventListener('click',event=>{if(event.currentTarget.getAttribute('aria-disabled')==='true')return;void this.perform(()=>this.recoveryStart(true),event.currentTarget);},options);
   this.querySelector('[data-otp-input]').addEventListener('input',event=>{const input=event.currentTarget,clean=digits(input.value);if(input.value!==clean)input.value=clean;this.otpError('');},options);
   // Back/forward cache: the restored snapshot is never trusted (see resync()).
   window.addEventListener('pageshow',event=>{if(event.persisted)this.resync();},options);
   void this.perform(async()=>{
    const results=await Promise.allSettled([this.loadAreas(),this.cart()]);
    // Back from Cardcom: the reservation is confirmed (or not) by the service first, then the normal resume runs.
    await this.verifyReturn();
    await this.resume();
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
   });
  }
  // Server-owned list of active areas (publicId + name only).
  async loadAreas(){
   const data=await this.api('/areas');
   if(!Array.isArray(data.areas))throw failure('INVALID_RESPONSE');
   this.areas=data.areas.filter(area=>area&&typeof area.publicId==='string'&&UUID.test(area.publicId)&&typeof area.name==='string'&&area.name.trim()).map(area=>({publicId:area.publicId,name:area.name,key:areaKey(area.name)}));
   if(this.area&&!this.areas.some(area=>area.publicId===this.area.publicId))this.clearArea();
   if(!this.areas.length)throw failure('AREAS_EMPTY');
  }
  openAreas(){if(!this.areas.length||this.busy)return;this.renderAreas(this.area&&this.areaInput.value===this.area.name?'':this.areaInput.value);}
  renderAreas(query){
   const key=areaKey(query);
   // Names (or words) that start with the query come first, then other substring matches, each in server order.
   const starts=area=>area.key.startsWith(key)||area.key.includes(' '+key);
   this.options=this.areas.filter(area=>!key||area.key.includes(key)).sort((a,b)=>key?Number(starts(b))-Number(starts(a)):0);
   this.areaStatus.hidden=true;
   if(!this.options.length){
    this.closeAreas();
    if(key){this.areaStatus.hidden=false;this.areaStatus.dataset.state='empty';this.areaStatus.textContent=this.dataset.areaEmpty;}
    return;
   }
   const listId=this.areaList.id;
   this.areaList.replaceChildren(...this.options.map((area,index)=>{
    const option=document.createElement('li');option.id=listId+'-'+index;option.setAttribute('role','option');option.dataset.areaId=area.publicId;
    option.setAttribute('aria-selected',String(this.area?.publicId===area.publicId));option.textContent=area.name;return option;
   }));
   this.areaList.hidden=false;this.areaInput.setAttribute('aria-expanded','true');this.fitAreas();
   this.setActive(this.options.findIndex(area=>area.publicId===this.area?.publicId));
  }
  // The list uses the visible space below the field (the on-screen keyboard excluded), up to 6 options high. With
  // room for fewer than 4, the page first moves the field up (never above the sticky header area) so the list fits.
  fitAreas(){
   const view=window.visualViewport,bottom=()=>(view?view.offsetTop+view.height:window.innerHeight)-16;
   let field=this.areaInput.getBoundingClientRect(),space=bottom()-field.bottom;
   if(space<200){const lift=Math.min(200-space,field.top-(view?view.offsetTop:0)-120);if(lift>0){window.scrollBy(0,lift);field=this.areaInput.getBoundingClientRect();space=bottom()-field.bottom;}}
   this.areaList.style.setProperty('--group-area-list-max',Math.round(Math.max(140,Math.min(280,space)))+'px');
  }
  closeAreas(){
   if(!this.areaList)return;
   this.areaList.hidden=true;this.areaInput.setAttribute('aria-expanded','false');this.areaInput.removeAttribute('aria-activedescendant');this.active=-1;
   if(this.area)this.showSelectedArea();
  }
  setActive(index){
   this.active=index;
   [...this.areaList.children].forEach((option,i)=>option.toggleAttribute('data-active',i===index));
   const option=this.areaList.children[index];
   if(option){this.areaInput.setAttribute('aria-activedescendant',option.id);option.scrollIntoView({block:'nearest'});}
   else this.areaInput.removeAttribute('aria-activedescendant');
  }
  onAreaKeydown(event){
   if(event.isComposing)return;
   const open=!this.areaList.hidden;
   if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    if(!open){this.openAreas();if(this.areaList.hidden)return;}
    const last=this.options.length-1;
    this.setActive(event.key==='ArrowDown'?(this.active<last?this.active+1:0):(this.active>0?this.active-1:last));
   }else if(event.key==='Enter'&&open&&this.active>=0){event.preventDefault();this.selectArea(this.options[this.active]);}
   else if(event.key==='Escape'){
    if(open){event.preventDefault();event.stopPropagation();this.closeAreas();}
    else if(this.areaInput.value){event.preventDefault();this.areaInput.value='';this.clearArea();this.invalidateSearch();}
   }else if(event.key==='Tab')this.closeAreas();
  }
  onAreaInput(){
   if(this.area&&this.areaInput.value!==this.area.name)this.clearArea();
   this.invalidateSearch();this.renderAreas(this.areaInput.value);
  }
  selectArea(area){
   const changed=this.area?.publicId!==area.publicId;
   this.area=area;this.areaInput.value=area.name;this.closeAreas();this.showSelectedArea();
   if(changed)this.invalidateSearch();
  }
  showSelectedArea(){this.areaStatus.hidden=false;this.areaStatus.dataset.state='selected';this.areaStatus.textContent=this.dataset.areaSelectedLabel.replace('__AREA__',this.area.name);}
  clearArea(){this.area=null;this.areaStatus.hidden=true;this.areaStatus.textContent='';}
  // A typed name counts only when it exactly equals one listed area; otherwise the shopper must pick from the list.
  chosenArea(){
   if(this.area&&this.areaInput.value===this.area.name)return this.area;
   const key=areaKey(this.areaInput.value),exact=key?this.areas.filter(area=>area.key===key):[];
   if(exact.length===1){this.selectArea(exact[0]);return exact[0];}
   return null;
  }
  // Explicit button only. Coarse (~1 km) coordinates are sent once to pick a town; nothing stores them.
  async locate(){
   if(this.busy||!this.origin)return;
   if(!navigator.geolocation){this.message.textContent=this.dataset.geoUnsupported;return;}
   let position;
   try{position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:10000,maximumAge:300000}));}
   catch(error){if(this.isConnected)this.message.textContent=error?.code===1?this.dataset.geoDenied:this.dataset.geoError;return;}
   if(!this.isConnected)return;
   const latitude=Math.round(position.coords.latitude*100)/100,longitude=Math.round(position.coords.longitude*100)/100;
   await this.perform(async()=>{
    const result=await this.api('/areas/nearest',{latitude,longitude});
    const area=typeof result.area?.publicId==='string'?this.areas.find(item=>item.publicId===result.area.publicId):undefined;
    if(!area){this.message.textContent=this.dataset.geoNone;return;}
    this.selectArea(area);this.message.textContent=this.dataset.geoSelected.replace('__AREA__',area.name);
   },this.querySelector('[data-geolocate]'));
  }
  disconnectedCallback(){const dialog=this.querySelector('[data-withdraw-dialog]');if(dialog?.open)dialog.close();clearInterval(this.otpTimer);clearTimeout(this.pollTimer);this.recovery=null;this.lifecycle?.abort();this.requests?.forEach(request=>request.abort());this.lifecycle=null;}
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
  // Runs a request on behalf of a stored receipt and deletes the receipt only on a definitive rejection.
  async withReceipt(publicId,request){
   try{return await request();}
   catch(error){
    if(this.receiptFor(publicId)&&RECEIPT_INVALIDATING_CODES.has(error?.code)){this.forgetReceipt(publicId);this.controls();}
    throw error;
   }
  }
  // ---- Card reservation (Cardcom) ----
  readReservation(){
   for(const store of [storage('localStorage'),storage('sessionStorage')]){
    try{const value=JSON.parse(store?.getItem(this.reservationKey)||'null');
     if(value&&UUID.test(value.reservationId)&&TOKEN.test(value.memberToken)&&(value.publicId===null||UUID.test(value.publicId))&&Number.isSafeInteger(value.savedAt))return value;}catch{}
   }
   return null;
  }
  saveReservation(value){
   const text=JSON.stringify(value);let saved=false;
   try{storage('localStorage').setItem(this.reservationKey,text);saved=storage('localStorage').getItem(this.reservationKey)===text;}catch{}
   if(!saved)try{storage('sessionStorage').setItem(this.reservationKey,text);}catch{}
  }
  clearReservation(){for(const store of [storage('localStorage'),storage('sessionStorage')])try{store?.removeItem(this.reservationKey);}catch{}}
  showVerify(state,text,actions={}){
   const box=this.querySelector('[data-verify]');box.hidden=false;box.dataset.state=state;
   this.querySelector('[data-verify-text]').textContent=text;
   this.verifyActions={primary:actions.primary?.action,secondary:actions.secondary?.action};
   const first=this.querySelector('[data-verify-primary]'),second=this.querySelector('[data-verify-secondary]');
   first.textContent=actions.primary?.label||'';first.hidden=!actions.primary;second.textContent=actions.secondary?.label||'';second.hidden=!actions.secondary;
  }
  hideVerify(){const box=this.querySelector('[data-verify]');if(box)box.hidden=true;this.verifyActions=null;}
  // Sends the shopper to Cardcom's secure page after explicit consent to the server-validated amount. Nothing is
  // charged (CreateTokenOnly); the membership exists only once the service verifies the token with Cardcom.
  async reserve(lines,receipt){
   const consent=this.querySelector('[data-reserve-consent]');
   if(!consent.checked)throw failure('CONSENT_REQUIRED');
   const form=this.querySelector('[data-join-group]');
   const body={lines,consent:{accepted:true,amountAgorot:this.consentAmount()},...(receipt?{}:{areaPublicId:this.foundPlace?.publicId,email:form.querySelector('[name=email]').value,phone:form.querySelector('[name=phone]').value})};
   const path=receipt?'/groups/'+receipt.publicId+'/reserve':this.group?'/groups/'+this.group.publicId+'/reserve':'/groups/reserve';
   if(!receipt&&!this.foundPlace)throw failure('DEFAULT');
   let result;
   try{result=await this.api(path,body,receipt?.memberToken);}
   catch(error){
    // The cart is priced again by the service: show the new amount and ask for consent again.
    if(error?.code==='PLEDGE_AMOUNT_CHANGED'&&Number.isSafeInteger(error.details?.newAmountAgorot)){this.validatedPledge=error.details.newAmountAgorot;consent.checked=false;this.pledge({validatedPledgeAgorot:this.validatedPledge});}
    if(error?.code==='ALREADY_JOINED'&&!receipt&&await this.offerRecovery(body))return;
    throw error;
   }
   let page;try{page=new URL(result.redirectUrl);}catch{throw failure('INVALID_RESPONSE');}
   if(page.protocol!=='https:'||!CARDCOM_HOSTS.has(page.hostname)||!UUID.test(result.reservation?.id)||(!receipt&&!TOKEN.test(result.memberToken)))throw failure('INVALID_RESPONSE');
   this.saveReservation({reservationId:result.reservation.id,memberToken:receipt?receipt.memberToken:result.memberToken,publicId:receipt?receipt.publicId:null,savedAt:Date.now()});
   form.reset();consent.checked=false;
   this.message.textContent=this.dataset.reserveRedirecting;
   location.assign(page.href);
  }
  // After Cardcom: asks the service (which checks Cardcom server-to-server) a few times, briefly. Success saves the
  // membership receipt; a final failure says plainly that nothing was charged; still pending offers a re-check.
  async verifyReturn(){
   const pending=this.readReservation();if(!pending)return;
   if(Date.now()-pending.savedAt>3*3600000){this.clearReservation();return;}
   this.showVerify('pending',this.dataset.reserveVerifying);
   const returned=this.returnResult;this.returnResult=null;
   let view=null;
   for(let attempt=0;attempt<GroupDelivery.verifyAttempts;attempt++){
    try{view=(await this.api('/reservations/'+pending.reservationId,returned==='failed'&&attempt===0?{returned:'failed'}:{},pending.memberToken))?.reservation;}
    catch(error){
     if(error?.name==='AbortError')throw error;
     if(error?.code==='RESERVATION_NOT_FOUND'){this.clearReservation();this.reservationFailed();return;}
     view=null;
    }
    if(view?.status==='CARD_RESERVED'&&UUID.test(view.groupPublicId)){
     this.clearReservation();
     const saved={publicId:view.groupPublicId,memberToken:pending.memberToken,savedAt:Date.now()};
     this.receipts.set(saved.publicId,saved);this.persist(saved);
     this.showVerify('success',this.dataset.reserveSuccess);
     return;
    }
    if(RESERVATION_FINAL.has(view?.status)){this.clearReservation();this.reservationFailed();return;}
    if(attempt<GroupDelivery.verifyAttempts-1)await new Promise(resolve=>{this.pollTimer=setTimeout(resolve,GroupDelivery.verifyInterval);});
    if(!this.isConnected)return;
   }
   this.showVerify('pending',this.dataset.reservePending,{primary:{label:this.dataset.reserveCheckAgain,action:()=>{void this.perform(async()=>{await this.verifyReturn();await this.resume();});}},
    secondary:{label:this.dataset.reserveRetry,action:()=>{void this.perform(async()=>{const p=this.readReservation();if(p)try{await this.api('/reservations/'+p.reservationId+'/cancel',{},p.memberToken);}catch{}this.clearReservation();this.reservationFailed();});}}});
  }
  reservationFailed(){this.showVerify('failed',this.dataset.reserveFailed,{primary:{label:this.dataset.reserveRetry,action:()=>{this.hideVerify();this.searchNew();}}});}
  // Explicit consent to a pending higher pledge (the approved amount kept counting until now).
  async confirmPledge(){
   const id=this.group?.publicId,receipt=this.receiptFor(id),member=this.currentMember();
   if(!receipt||member?.payment?.status!=='CONSENT_REQUIRED')return;
   if(!this.querySelector('[data-consent-change-check]').checked)throw failure('CONSENT_REQUIRED');
   try{
    const result=await this.withReceipt(id,()=>this.api('/groups/'+id+'/confirm-pledge',{confirm:true,amountAgorot:member.payment.pendingAmountAgorot},receipt.memberToken));
    this.show(result.group);this.pledge(result);
    await this.loadMember(id);this.message.textContent=this.dataset.consentConfirmed;
   }catch(error){
    // Re-priced meanwhile: the new amount is shown and needs a new tick.
    if(error?.code==='PLEDGE_AMOUNT_CHANGED')await this.loadMember(id);
    throw error;
   }finally{this.controls();}
  }
  async perform(action,trigger){
   if(this.busy)return;const lifecycle=this.lifecycle,focus=document.activeElement;this.busy=true;const loading=trigger||(focus?.matches('button')&&this.contains(focus)?focus:null);loading?.setAttribute('aria-busy','true');this.setAttribute('aria-busy','true');this.querySelectorAll('form').forEach(form=>form.inert=true);this.message.textContent='';
   try{await action();}catch(error){if(this.lifecycle===lifecycle&&this.isConnected&&error.name!=='AbortError')this.message.textContent=this.errorMessage(error);}
   finally{if(this.lifecycle!==lifecycle)return;this.busy=false;if(this.resyncQueued){this.resyncQueued=false;queueMicrotask(()=>this.resync());}loading?.removeAttribute('aria-busy');this.removeAttribute('aria-busy');this.querySelectorAll('form').forEach(form=>form.inert=false);this.controls();const next=this.focusAfter;this.focusAfter=null;if(next?.isConnected&&!next.hidden&&!next.disabled){next.focus();return;}if(focus?.isConnected&&this.contains(focus)&&!focus.disabled&&document.activeElement===document.body)focus.focus({preventScroll:true});}
  }
  errorMessage(error){const code=typeof error?.code==='string'&&Object.hasOwn(this.errors,error.code)?error.code:'DEFAULT';return this.errors[code]||'';}
  invalidateSearch(){
   this.foundPlace=null;this.hideOtp();
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
   // Card groups: a new membership (or a withdrawn member's renewal) goes through the consent block and Cardcom.
   const reserving=this.reserving(joined);
   const reserve=this.querySelector('[data-reserve]'),consent=this.querySelector('[data-reserve-consent]');
   reserve.hidden=!reserving;
   const amount=this.consentAmount();
   if(reserving)this.querySelector('[data-reserve-total]').textContent=amount!==null?this.dataset.reserveAmount.replace('__AMOUNT__',this.currency.format(amount/100)):'';
   else consent.checked=false;
   this.querySelector('[data-notice]').textContent=this.cardMode()?this.dataset.noticeCard:this.noticeText;
   button.textContent=reserving?this.dataset.reserveButton:joined?(this.restored?this.dataset.updateRestored:this.cartDiffers()?this.dataset.updateCurrent:this.dataset.updateLabel):this.pending?this.dataset.startLabel:this.dataset.joinLabel;
   button.disabled=(this.pending?!this.foundPlace:!this.group||!['OPEN','THRESHOLD_REACHED'].includes(this.group.status))||(reserving&&(!consent.checked||amount===null));
   this.renderMember(joined,button);
  }
  // Returning device. Only membership receipts are durable (one per joined group); an area, a search result or a
  // geolocation suggestion is never stored, so it can never be restored. Each receipt (newest first, at most 6) is
  // checked with the service; a receipt the service rejects is dropped (withReceipt), temporary failures keep it.
  //  - confirmed PLEDGED member of a current group (OPEN, THRESHOLD_REACHED or APPROVED) -> "my delivery" panel;
  //    other confirmed active memberships are listed, newest receipt first (a shopper can hold one per group);
  //  - WITHDRAWN member of a group that still takes pledges -> inactive-membership notice with an explicit renew;
  //  - current group but the member read failed temporarily -> the group with the recovery path, not labelled as mine;
  //  - the group itself could not be loaded now -> notice with a retry, nothing presented as current;
  //  - COMPLETED, EXPIRED or otherwise closed group -> short history notice; the area search stays the main flow.
  // Nobody is ever moved to another group automatically.
  async resume(){
   this.clearResume();
   const receipts=[...this.receipts.values()].sort((a,b)=>b.savedAt-a.savedAt).slice(0,6);
   if(!receipts.length)return;
   const current=['OPEN','THRESHOLD_REACHED','APPROVED'],items=[];let rejected=null;
   for(const receipt of receipts){
    const id=receipt.publicId;let group=null,member=null,failed=false;
    try{group=this.checkGroup((await this.withReceipt(id,()=>this.api('/groups/'+id))).group);if(group.publicId!==id)throw failure('INVALID_RESPONSE');}
    catch(error){if(error?.name==='AbortError')throw error;failed=!!this.receiptFor(id);if(!failed&&RECEIPT_INVALIDATING_CODES.has(error?.code))rejected??=error;}
    if(group&&current.includes(group.status)){
     // A rejected token removes only this receipt (withReceipt); the other receipts are still evaluated.
     try{member=await this.loadMember(id);}catch(error){if(error?.name==='AbortError')throw error;if(RECEIPT_INVALIDATING_CODES.has(error?.code))rejected??=error;}
     if(!this.receiptFor(id))continue;
     if(!member)failed=true;
    }
    if(group||failed)items.push({id,group,member:member&&{...member},failed});
   }
   // A receipt the service rejected is reported as before (unless the shopper's own delivery is shown instead).
   if(!this.decide(items)&&rejected)this.message.textContent=this.errorMessage(rejected);
  }
  // Startup decision from the checked receipts (see resume()); true when the shopper's own delivery is shown.
  decide(items){
   const current=['OPEN','THRESHOLD_REACHED','APPROVED'],open=['OPEN','THRESHOLD_REACHED'];
   const mine=items.filter(item=>item.group&&current.includes(item.group.status)&&item.member?.status==='PLEDGED');
   if(mine.length){this.showMine(mine,mine[0].id);return true;}
   this.member=null;
   const withdrawn=items.find(item=>item.group&&open.includes(item.group.status)&&item.member?.status==='WITHDRAWN');
   if(withdrawn){
    this.renderResume({text:this.dataset.membershipInactive,detail:this.dataset.area.replace('__AREA__',withdrawn.group.areaName),
     primary:{label:this.dataset.searchNew,action:()=>this.searchNew()},
     secondary:{label:this.dataset.renewHere,action:()=>{this.clearResume();this.member=withdrawn.member;this.show(withdrawn.group);this.focusPanel();}}});
    return false;
   }
   // Current group, membership not confirmable right now (temporary member-read failure): the group stays visible with
   // the existing recovery path, but it is not labelled as the shopper's delivery until the service confirms it.
   const unconfirmed=items.find(item=>item.failed&&item.group&&current.includes(item.group.status));
   if(unconfirmed){this.clearResume();this.show(unconfirmed.group);return false;}
   if(items.some(item=>item.failed)){
    this.renderResume({text:this.dataset.membershipUnverified,primary:{label:this.dataset.retry,action:()=>{void this.perform(()=>this.resume());}}});
    return false;
   }
   const past=items.find(item=>item.group&&!current.includes(item.group.status));
   if(past)this.renderResume({text:past.group.status==='COMPLETED'?this.dataset.previousCompleted:this.dataset.previousClosed,detail:this.dataset.area.replace('__AREA__',past.group.areaName),
    primary:{label:this.dataset.searchNew,action:()=>this.searchNew()},
    secondary:{label:this.dataset.viewPrevious,action:()=>{this.member=null;this.show(past.group);this.focusPanel();}}});
   return false;
  }
  showMine(mine,id){
   const chosen=mine.find(item=>item.id===id)||mine[0];
   this.member=chosen.member;this.show(chosen.group);
   const others=mine.filter(item=>item!==chosen);
   if(!others.length){this.clearResume();return;}
   this.renderResume({text:this.dataset.otherMemberships.replace('__COUNT__',String(others.length)),list:others.map(item=>({id:item.id,label:this.dataset.showMembership.replace('__AREA__',item.group.areaName)})),
    pick:pick=>{this.showMine(mine,pick);this.focusPanel();}});
  }
  renderResume({text,detail='',primary=null,secondary=null,list=[],pick=null}){
   const box=this.querySelector('[data-resume]');
   this.resumeActions={primary:primary?.action,secondary:secondary?.action,pick};
   this.querySelector('[data-resume-text]').textContent=text;
   const extra=this.querySelector('[data-resume-detail]');extra.textContent=detail;extra.hidden=!detail;
   const first=this.querySelector('[data-resume-primary]'),second=this.querySelector('[data-resume-secondary]');
   first.textContent=primary?.label||'';first.hidden=!primary;second.textContent=secondary?.label||'';second.hidden=!secondary;
   const listBox=this.querySelector('[data-resume-list]');listBox.replaceChildren(...list.map(item=>{const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='group-delivery__secondary';button.dataset.resumeGroup=item.id;button.textContent=item.label;li.append(button);return li;}));listBox.hidden=!list.length;
   box.hidden=false;
  }
  clearResume(){this.resumeActions=null;const box=this.querySelector('[data-resume]');if(box)box.hidden=true;}
  searchNew(){
   if(this.group&&!this.currentMember()?.status){const panel=this.querySelector('[data-group-panel]');panel.hidden=true;this.group=null;this.controls();}
   this.areaInput.focus();
  }
  focusPanel(){const title=this.querySelector('[data-group-title]');title.tabIndex=-1;title.focus({preventScroll:false});}
  // Back/forward cache restore (mostly mobile): the page snapshot may show an old search or a group that has since
  // changed. Search state is dropped, receipts are re-read (another tab may have joined or withdrawn) and re-checked,
  // and the cart is read again. No reload, and nothing in storage is removed here.
  resync(){
   if(!this.origin||!this.receipts)return;
   if(this.busy){this.resyncQueued=true;return;}
   const dialog=this.querySelector('[data-withdraw-dialog]');if(dialog.open)dialog.close();
   this.closeReview(false);this.closeAreas();this.hideOtp();this.hideVerify();
   this.loadReceipts();this.member=null;this.restored=false;this.foundPlace=null;this.group=null;this.pending=false;
   this.clearArea();this.areaInput.value='';
   const panel=this.querySelector('[data-group-panel]');panel.hidden=true;panel.removeAttribute('data-group-pending');
   this.querySelector('[data-validated-pledge]').hidden=true;this.clearResume();this.message.textContent='';
   this.controls();
   void this.perform(async()=>{await Promise.allSettled([this.cart()]);await this.verifyReturn();await this.resume();});
  }
  // The member read for this browser's receipt, or null. Temporary failures keep the page and the receipt as they are;
  // only the definitive receipt rejections (via withReceipt) remove it. strict callers get every error.
  async loadMember(publicId,strict=false){
   const receipt=this.receiptFor(publicId);if(!receipt)return null;
   try{
    const member=memberShape((await this.withReceipt(publicId,()=>this.api('/groups/'+publicId+'/member',{},receipt.memberToken)))?.member);
    if(!member)throw failure('INVALID_RESPONSE');
    this.member={publicId,...member};
    return this.member;
   }catch(error){if(strict||RECEIPT_INVALIDATING_CODES.has(error?.code))throw error;return null;}
  }
  currentMember(){return this.member&&this.member.publicId===this.group?.publicId&&this.receiptFor(this.member.publicId)?this.member:null;}
  // Same variants and quantities as the stored pledge (prices are compared by the service, not here).
  cartDiffers(){
   const member=this.currentMember();
   if(!member||member.status!=='PLEDGED'||!Array.isArray(member.cart)||!Array.isArray(this.lines)||!this.lines.length)return false;
   const stored=new Map(member.cart.map(line=>[String(line.variantId),line.quantity]));
   return stored.size!==this.lines.length||this.lines.some(line=>stored.get(String(line.variantId))!==line.quantity);
  }
  renderMember(joined,button){
   const member=joined?this.currentMember():null,lines=Array.isArray(this.lines)?this.lines:null;
   const empty=joined&&lines!==null&&lines.length===0,pledged=member?.status==='PLEDGED';
   const open=!!this.group&&['OPEN','THRESHOLD_REACHED'].includes(this.group.status);
   const box=this.querySelector('[data-member]'),differs=this.cartDiffers();
   box.hidden=!member;
   // Shown only for a confirmed active membership, so the group never looks like a remembered search.
   this.querySelector('[data-mine]').hidden=!pledged;
   if(member){
    this.querySelector('[data-member-pledge]').textContent=pledged?this.dataset.currentPledge.replace('__AMOUNT__',this.currency.format(member.pledgedTotalAgorot/100)):this.dataset.withdrawnState;
    const cartLine=this.querySelector('[data-member-cart]'),note=this.querySelector('[data-member-note]');
    cartLine.hidden=note.hidden=!differs;
    if(differs){cartLine.textContent=this.dataset.currentCartTotal.replace('__AMOUNT__',this.currency.format((this.cartTotal||0)/100));note.textContent=this.dataset.cartDiffers;}
   }
   // Receipt here but Shopify's cart is empty (expired, cleared or never in this browser) while the group is open:
   // recovery instead of an update. Closed groups keep their normal state (nothing can be updated there).
   const recovering=empty&&open&&(!member||pledged);
   this.querySelector('[data-recovery]').hidden=!recovering;
   if(lines)this.querySelector('[data-empty-cart]').hidden=lines.length>0||recovering;
   if(!recovering&&this.reviewMode==='restore')this.closeReview(false);
   // An empty cart never offers the update action in an open group: it must never read as a withdrawal.
   button.hidden=empty&&open;
   const payment=member?.payment||null,withdraw=this.querySelector('[data-withdraw]');
   // A card member whose charge started (or happened) has no self-service cancellation.
   withdraw.hidden=!(pledged&&open&&(!payment||['CARD_RESERVED','CONSENT_REQUIRED'].includes(payment.status)));
   withdraw.textContent=payment?this.dataset.cancelJoin:this.withdrawLabel;
   this.querySelector('[data-withdraw-text]').textContent=payment?this.dataset.cancelText:this.withdrawText;
   const line=this.querySelector('[data-member-payment]'),text={CARD_RESERVED:this.dataset.paymentReserved,CONSENT_REQUIRED:this.dataset.paymentReserved,CHARGE_PENDING:this.dataset.paymentChargePending,CHARGED:this.dataset.paymentCharged,PAYMENT_FAILED:this.dataset.paymentFailed}[payment?.status]||'';
   line.textContent=pledged?text:'';line.hidden=!pledged||!text;
   // Pending higher amount: shown with its own consent; the approved pledge keeps counting until then.
   const change=this.querySelector('[data-consent-change]');
   const waiting=pledged&&open&&payment?.status==='CONSENT_REQUIRED'&&Number.isSafeInteger(payment.pendingAmountAgorot);
   if(waiting){
    const label=this.dataset.consentChanged.replace('__OLD__',this.currency.format(payment.approvedAmountAgorot/100)).replace('__NEW__',this.currency.format(payment.pendingAmountAgorot/100));
    const title=this.querySelector('[data-consent-change-text]');if(title.textContent!==label){title.textContent=label;this.querySelector('[data-consent-change-check]').checked=false;}
   }else this.querySelector('[data-consent-change-check]').checked=false;
   change.hidden=!waiting;
   this.querySelector('[data-consent-change-confirm]').disabled=!waiting||!this.querySelector('[data-consent-change-check]').checked;
  }
  // The amount the shopper consents to: the service-validated pledge from the search, otherwise (renewing from the
  // group panel) the Shopify cart total; the service re-prices it and asks again (PLEDGE_AMOUNT_CHANGED) if it differs.
  consentAmount(){return Number.isSafeInteger(this.validatedPledge)&&this.validatedPledge>0?this.validatedPledge:Number.isSafeInteger(this.cartTotal)&&this.cartTotal>0?this.cartTotal:null;}
  // Card mode of the group being joined: a shown group says so itself; a not-yet-created one follows the search.
  cardMode(){return this.group?this.group.cardReservation===true:this.pending&&this.findCard===true;}
  // A new card membership, or the renewal of a withdrawn card member, needs consent + Cardcom now.
  reserving(joined){
   if(!this.cardMode())return false;
   if(!joined)return true;
   const member=this.currentMember();return member?.status==='WITHDRAWN';
  }
  // Fresh member read (Shopify re-checked now), listed before anything changes. 'restore' explains every change and
  // offers to add only the available lines; 'pledge' lists the stored pledge.
  async review(mode){
   const id=this.group?.publicId;if(!this.receiptFor(id))return;
   const member=await this.loadMember(id,true);
   const list=this.querySelector('[data-review-list]'),note=this.querySelector('[data-review-note]'),actions=this.querySelector('[data-review-actions]');
   const money=agorot=>this.currency.format(agorot/100);
   const lines=Array.isArray(member.cart)?member.cart:[];
   this.querySelector('[data-review-title]').textContent=mode==='restore'?this.dataset.restoreReview:this.dataset.pledgeItems;
   list.replaceChildren(...lines.map(line=>{
    const item=document.createElement('li'),name=document.createElement('strong');
    name.textContent=line.title||this.dataset.restoreItem;item.append(name);
    const detail=text=>{const span=document.createElement('span');span.textContent=text;item.append(span);};
    detail(this.dataset.restoreQuantityLabel.replace('__QUANTITY__',String(mode==='restore'&&line.restorableQuantity>0?line.restorableQuantity:line.quantity)));
    if(mode==='restore'){
     item.dataset.state=line.reason==='UNAVAILABLE'?'unavailable':line.reason==='QUANTITY_REDUCED'||line.priceChanged?'changed':'unchanged';
     if(line.reason==='UNAVAILABLE')detail(this.dataset.restoreUnavailable);
     else{
      if(line.reason==='QUANTITY_REDUCED')detail(this.dataset.restoreQuantity.replace('__OLD__',String(line.quantity)).replace('__NEW__',String(line.restorableQuantity)));
      if(line.priceChanged&&line.currentUnitAgorot!==null)detail(this.dataset.restorePrice.replace('__OLD__',money(line.storedUnitAgorot)).replace('__NEW__',money(line.currentUnitAgorot)));
      if(item.dataset.state==='unchanged')detail(this.dataset.restoreUnchanged);
     }
    }
    return item;
   }));
   let text='';
   if(mode==='pledge')text=member.status==='PLEDGED'?this.dataset.currentPledge.replace('__AMOUNT__',money(member.pledgedTotalAgorot)):this.dataset.withdrawnState;
   else if(member.cartCheck!=='OK'||!Array.isArray(member.cart))text=this.dataset.restoreCheckUnavailable;
   else if(!lines.some(line=>line.restorableQuantity>0))text=this.dataset.restoreNone;
   note.hidden=!text;note.textContent=text;
   actions.hidden=mode!=='restore'||!!text;
   this.reviewMode=mode;
   this.querySelector('[data-review]').hidden=false;
   this.querySelector('[data-review-title]').focus();
  }
  closeReview(returnFocus=true){
   const review=this.querySelector('[data-review]'),wasOpen=!review.hidden;
   review.hidden=true;this.reviewMode=null;
   if(returnFocus&&wasOpen)this.querySelector('[data-restore]:not([hidden])')?.focus();
  }
  // Adds only the lines Shopify accepts now, through Shopify's cart API (Shopify prices them; stored prices are only
  // shown for comparison). The pledge is not touched: the shopper updates it explicitly afterwards.
  async restore(){
   const member=this.currentMember();
   const items=(Array.isArray(member?.cart)?member.cart:[]).filter(line=>line.restorableQuantity>0).map(line=>({id:line.variantId,quantity:line.restorableQuantity}));
   if(!items.length)return;
   const url=new URL(this.dataset.cartAddUrl,location.origin);if(url.origin!==location.origin)throw failure('RESTORE_FAILED');
   const controller=new AbortController();this.requests.add(controller);
   const timer=setTimeout(()=>controller.abort(),GroupDelivery.cartTimeout);
   try{
    let response;
    try{response=await fetch(url,{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items})});}
    catch{throw failure('RESTORE_FAILED');}
    if(!response.ok)throw failure('RESTORE_FAILED');
   }finally{clearTimeout(timer);this.requests.delete(controller);}
   this.restored=true;
   this.closeReview(false);
   await this.cart();
   // The header badge and cart drawer refresh through storefront.js's own cart helpers.
   document.dispatchEvent(new CustomEvent('storefront:cart:changed'));
   this.message.textContent=this.dataset.restored;
   this.controls();
   // Forms are inert while busy; perform() moves focus here once they are interactive again.
   this.focusAfter=this.querySelector('[data-join-button]');
  }
  // Explicit withdrawal after the confirmation dialog; the receipt stays so the member can pledge again later.
  async withdraw(){
   const id=this.group?.publicId,receipt=this.receiptFor(id),dialog=this.querySelector('[data-withdraw-dialog]');
   if(!receipt){dialog.close();return;}
   let result;
   try{result=await this.withReceipt(id,()=>this.api('/groups/'+id+'/withdraw',{confirm:true},receipt.memberToken));}
   finally{dialog.close();}
   const card=!!this.currentMember()?.payment;
   this.show(result.group);
   this.member={publicId:id,status:'WITHDRAWN',pledgedTotalAgorot:0,cartCheck:'OK',cart:[],payment:card?{status:'CANCELED',approvedAmountAgorot:0,pendingAmountAgorot:null}:null};
   this.restored=false;this.closeReview(false);
   this.querySelector('[data-validated-pledge]').hidden=true;
   this.message.textContent=card?this.dataset.canceledNoCharge:this.dataset.withdrawn;
   this.controls();
   this.focusAfter=this.querySelector('[data-join-button]:not([hidden])')||this.querySelector('[data-refresh]');
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
    if(!response.ok){
     const error=failure(typeof data?.code==='string'?data.code:response.status===429?'RATE_LIMITED':response.status>=500?'SERVICE_UNAVAILABLE':'DEFAULT');
     if(data?.details&&typeof data.details==='object'&&Object.values(data.details).every(Number.isSafeInteger))error.details=data.details;
     throw error;
    }
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
    this.querySelector('[data-current-cart]').textContent=this.currency.format(cart.total_price/100);this.cartTotal=cart.total_price;
    if(cart.items.some(item=>item.selling_plan_allocation||Object.keys(item.properties||{}).length))throw failure('CART_UNAVAILABLE');
    this.lines=cart.items.map(item=>({variantId:String(item.variant_id||item.id),quantity:item.quantity}));
    return this.lines;
   }finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  // The only search endpoint: read-only and area-based. The service resolves areaPublicId; free text is never sent.
  // Search never creates a group: a miss shows the no-group state, and only Join (/groups/join) may create one.
  async find(){
   this.closeAreas();const area=this.chosenArea();if(!area)throw failure('AREA_REQUIRED');
   const lines=await this.cart();if(!lines.length)throw failure('CART_EMPTY');
   this.foundPlace=area;
   const result=await this.api('/groups/find',{areaPublicId:area.publicId,lines});
   this.findCard=result.cardReservationRequired===true;
   this.validatedPledge=Number.isSafeInteger(result.validatedPledgeAgorot)?result.validatedPledgeAgorot:null;this.hideVerify();
   if(result.group){this.show(result.group);this.message.textContent=this.dataset.found;}
   else{this.showPending(area.name);this.message.textContent=this.dataset.noneFound;}
   if(result.withinStandardRadius===true)this.message.textContent=this.dataset.standard;
   this.pledge(result);
  }
  async join(){
   const lines=await this.cart();
   const receipt=this.receiptFor(this.group?.publicId);
   // An empty cart is never a withdrawal (the service rejects it too); withdrawing has its own confirmed action.
   if(!lines.length&&receipt)throw failure('EMPTY_CART_CANNOT_UPDATE_PLEDGE');
   if(!lines.length&&!receipt)throw failure('CART_EMPTY');
   if(this.reserving(!!receipt))return this.reserve(lines,receipt);
   if(receipt){
    const id=receipt.publicId;
    try{
     const result=await this.withReceipt(id,()=>this.api('/groups/'+id+'/update-pledge',{lines},receipt.memberToken));
     this.show(result.group);this.pledge(result);
     this.restored=false;await this.loadMember(id);
     // Card member, higher cart: nothing changed yet; the consent block asks for the new amount.
     if(result.consentRequired){this.controls();this.message.textContent=this.errors.PLEDGE_AMOUNT_CHANGED||'';this.focusAfter=this.querySelector('[data-consent-change-text]');}
     else this.message.textContent=this.dataset.updated;
    }catch(error){
     // Closed groups keep the receipt; show their current state instead of leaving a stale panel.
     if(error?.code==='GROUP_CLOSED')try{this.show((await this.api('/groups/'+id)).group);}catch{}
     throw error;
    }
    return;
   }
   if(!this.foundPlace||(!this.group&&!this.pending))throw failure('DEFAULT');
   const form=this.querySelector('[data-join-group]');
   const body={areaPublicId:this.foundPlace.publicId,lines,email:form.querySelector('[name=email]').value,phone:form.querySelector('[name=phone]').value};
   // A shown group is joined directly; with no group yet, the service re-checks the same area under its lock and
   // creates the group only now, with this shopper as its first member.
   let result;
   try{result=await this.api(this.group?'/groups/'+this.group.publicId+'/join':'/groups/join',body);}
   catch(error){if(error?.code==='ALREADY_JOINED'&&await this.offerRecovery(body))return;throw error;}
   if(!TOKEN.test(result.memberToken)||!UUID.test(result.group?.publicId))throw failure('INVALID_RESPONSE');
   const saved={publicId:result.group.publicId,memberToken:result.memberToken,savedAt:Date.now()};
   this.receipts.set(saved.publicId,saved);this.persist(saved);
   this.member={publicId:saved.publicId,status:'PLEDGED',pledgedTotalAgorot:Number.isSafeInteger(result.validatedPledgeAgorot)?result.validatedPledgeAgorot:0,cartCheck:'OK',cart:lines.map(line=>({variantId:line.variantId,quantity:line.quantity}))};
   form.reset();this.show(result.group);this.pledge(result);this.message.textContent=result.created===true?this.dataset.started:this.dataset.joined;
  }
  // ALREADY_JOINED without this browser's receipt: offer recovery by emailed code for the group being joined. The
  // details just typed are kept in memory for the request only (never stored). False when no group can be named.
  async offerRecovery(body){
   if(!this.group){
    // The area's group was created by someone else since the search; read it (read-only) to name the membership.
    let found=null;try{found=(await this.api('/groups/find',{areaPublicId:body.areaPublicId})).group;}catch{}
    if(!found)return false;this.show(found);
   }
   if(this.receiptFor(this.group.publicId))return false;
   this.recovery={publicId:this.group.publicId,email:body.email,phone:body.phone,challengeId:null,expiresAt:0,resendAt:0,locked:false};
   this.showOtp('offer');
   this.focusAfter=this.querySelector('[data-otp-title]');
   return true;
  }
  showOtp(step){
   this.querySelector('[data-otp]').hidden=false;this.querySelector('[data-join-group]').hidden=true;
   this.querySelector('[data-otp-offer]').hidden=step!=='offer';this.querySelector('[data-otp-form]').hidden=step!=='code';
  }
  // Leaves recovery (Back, a new search, a back/forward restore, success). Back returns to the filled-in join form.
  hideOtp(returnFocus=false){
   const box=this.querySelector('[data-otp]');if(!box)return;
   clearInterval(this.otpTimer);this.otpTimer=null;this.recovery=null;
   const input=this.querySelector('[data-otp-input]');input.value='';this.otpError('');
   if(box.hidden)return;
   box.hidden=true;this.querySelector('[data-join-group]').hidden=false;
   if(returnFocus)this.querySelector('[data-join-button]')?.focus();
  }
  otpError(text){
   const error=this.querySelector('[data-otp-error]'),input=this.querySelector('[data-otp-input]');if(!error)return;
   if(error.textContent!==text)error.textContent=text;
   if(text)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');
  }
  // Resend availability. The wait text is read with the button (aria-describedby) but is not a live region, so it is
  // not announced every second; the button stays focusable and inert (aria-disabled) until the cooldown ends.
  otpTick(){
   const r=this.recovery,button=this.querySelector('[data-otp-resend]'),wait=this.querySelector('[data-otp-wait]');
   const left=r?Math.max(0,Math.ceil((r.resendAt-Date.now())/1000)):0;
   button.setAttribute('aria-disabled',String(left>0));
   wait.textContent=left>0?this.dataset.recoveryWait.replace('__SECONDS__',String(left)):'';
   if(!left){clearInterval(this.otpTimer);this.otpTimer=null;}
  }
  // Asks the service to email a code to the membership's stored address. The answer is the same whether or not the
  // details match, so this step always continues to the code form.
  async recoveryStart(resend=false){
   const r=this.recovery;if(!r)return;
   this.otpError('');
   let result;
   try{result=await this.api('/groups/'+r.publicId+'/recovery/start',{email:r.email,phone:r.phone});}
   catch(error){
    if(this.recovery!==r||error?.name==='AbortError')throw error;
    if(!resend)throw error;
    this.otpError(this.errorMessage(error));this.focusAfter=this.querySelector('[data-otp-input]');return;
   }
   if(this.recovery!==r)return;
   if(result?.ok!==true||typeof result.challengeId!=='string'||!UUID.test(result.challengeId)||!count(result.expiresInSeconds)||!count(result.resendAfterSeconds))throw failure('INVALID_RESPONSE');
   const now=Date.now();
   Object.assign(r,{challengeId:result.challengeId,expiresAt:now+result.expiresInSeconds*1000,resendAt:now+result.resendAfterSeconds*1000,locked:false});
   this.showOtp('code');
   const input=this.querySelector('[data-otp-input]');input.value='';
   clearInterval(this.otpTimer);this.otpTick();this.otpTimer=setInterval(()=>this.otpTick(),1000);
   this.focusAfter=input;
  }
  // Errors stay inside the code form (one alert region); the code is checked locally only for format and expiry.
  async recoveryVerify(){
   const r=this.recovery,input=this.querySelector('[data-otp-input]');if(!r?.challengeId)return;
   const code=digits(input.value);input.value=code;this.focusAfter=input;
   if(code.length!==6){this.otpError(this.dataset.recoveryFormat);return;}
   if(Date.now()>=r.expiresAt){this.otpError(this.dataset.recoveryExpired);return;}
   if(r.locked){this.otpError(this.errors.TOO_MANY_ATTEMPTS||'');return;}
   let result;
   try{result=await this.api('/groups/'+r.publicId+'/recovery/verify',{challengeId:r.challengeId,code});}
   catch(error){
    if(this.recovery!==r||error?.name==='AbortError')throw error;
    if(error?.code==='TOO_MANY_ATTEMPTS')r.locked=true;
    this.otpError(this.errorMessage(error));input.select();return;
   }
   if(this.recovery!==r)return;
   if(!TOKEN.test(result?.memberToken)||!['PLEDGED','WITHDRAWN'].includes(result?.member?.status))throw failure('INVALID_RESPONSE');
   const group=this.checkGroup(result.group);if(group.publicId!==r.publicId)throw failure('INVALID_RESPONSE');
   await this.recovered(group,result.memberToken);
  }
  // Success: this device's own receipt, saved exactly like a join receipt (its own key; nothing else is touched),
  // then the membership is shown as the returning-device logic would: mine (PLEDGED), inactive (WITHDRAWN), or
  // history (completed or closed). Recovery never changes the membership itself.
  async recovered(group,memberToken){
   const id=group.publicId,saved={publicId:id,memberToken,savedAt:Date.now()};
   this.receipts.set(id,saved);this.persist(saved);
   this.hideOtp();this.querySelector('[data-join-group]').reset();
   this.member=null;this.restored=false;this.clearResume();
   const current=['OPEN','THRESHOLD_REACHED','APPROVED'].includes(group.status),open=['OPEN','THRESHOLD_REACHED'].includes(group.status);
   if(current){await Promise.allSettled([this.cart()]);await this.loadMember(id);}
   this.show(group);
   const area=this.dataset.area.replace('__AREA__',group.areaName);
   if(!current)this.renderResume({text:group.status==='COMPLETED'?this.dataset.previousCompleted:this.dataset.previousClosed,detail:area,primary:{label:this.dataset.searchNew,action:()=>this.searchNew()}});
   else if(open&&this.currentMember()?.status==='WITHDRAWN')this.renderResume({text:this.dataset.membershipInactive,detail:area});
   this.message.textContent=this.dataset.recoverySuccess;
   const title=this.querySelector('[data-group-title]');title.tabIndex=-1;this.focusAfter=title;
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
  checkGroup(group){
   if(!group||!Object.hasOwn(this.labels,group.status)||typeof group.publicId!=='string'||!UUID.test(group.publicId)||typeof group.areaName!=='string'||!['thresholdAgorot','pledgedTotalAgorot','remainingAmountAgorot','progressPercent','participantCount'].every(key=>Number.isSafeInteger(group[key])&&group[key]>=0)||group.thresholdAgorot===0||!Number.isFinite(Date.parse(group.expiresAt)))throw failure('INVALID_RESPONSE');
   return group;
  }
  show(group){
   this.checkGroup(group);
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
   // COMPLETED: the delivery was completed and the group is history. Its receipt stays with it; joining the area's
   // next delivery is the normal area search and join, never an automatic move.
   if(group.status==='COMPLETED')this.message.textContent=this.dataset.deliveryCompleted;
   else if(!['OPEN','THRESHOLD_REACHED'].includes(group.status))this.message.textContent=this.dataset.closed;
   this.controls();
  }
 }
 customElements.define('fankee-group-delivery',GroupDelivery);
})();
