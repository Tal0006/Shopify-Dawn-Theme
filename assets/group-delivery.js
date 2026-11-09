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
 class GroupDelivery extends HTMLElement {
  // Render cold starts can take close to a minute: announce the wait, then fail at a finite limit.
  static wakeDelay=12000;
  static requestTimeout=90000;
  static cartTimeout=10000;
  connectedCallback(){
   if(this.lifecycle)return;
   this.lifecycle=new AbortController();this.requests=new Set();this.busy=false;this.pending=false;
   this.areas=[];this.area=null;this.options=[];this.active=-1;
   // Payment verification lives in memory only (never in storage); member payment state comes from /membership.
   this.verification=null;this.member=null;this.paymentStep=this.querySelector('[data-payment-step]');
   this.areaInput=this.querySelector('[data-area-input]');this.areaList=this.querySelector('[data-area-list]');this.areaStatus=this.querySelector('[data-area-selected]');
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
   this.areaInput.addEventListener('input',()=>this.onAreaInput(),options);
   this.areaInput.addEventListener('keydown',event=>this.onAreaKeydown(event),options);
   this.areaInput.addEventListener('click',()=>this.openAreas(),options);
   // Focus returned by perform() after an action must not reopen the listbox; only a shopper's own focus does.
   this.areaInput.addEventListener('focus',()=>{if(!this.restoringFocus)this.openAreas();},options);
   // pointerdown keeps focus in the input, so selection never loses the combobox context.
   this.areaList.addEventListener('pointerdown',event=>{
    const option=event.target.closest('[role=option]');if(!option)return;
    event.preventDefault();const area=this.areas.find(item=>item.publicId===option.dataset.areaId);if(area)this.selectArea(area);
   },options);
   this.querySelector('[data-area-picker]').addEventListener('focusout',event=>{if(!this.querySelector('[data-area-picker]').contains(event.relatedTarget))this.closeAreas();},options);
   document.addEventListener('pointerdown',event=>{if(!this.querySelector('[data-area-picker]')?.contains(event.target))this.closeAreas();},options);
   // The only geolocation request; it needs this explicit click.
   this.querySelector('[data-geolocate]').addEventListener('click',()=>{void this.locate();},options);
   this.querySelector('[data-verify-payment]').addEventListener('click',event=>{void this.perform(()=>this.startVerification(),event.currentTarget);},options);
   this.querySelector('[data-mock-payment]').addEventListener('click',event=>{const button=event.target.closest('[data-mock-outcome]');if(button)void this.perform(()=>this.simulateVerification(button.dataset.mockOutcome),button);},options);
   // A verification is bound to the contact it was started with; editing either field requires a new one.
   this.querySelector('[data-contact-fields]').addEventListener('input',()=>{if(this.verification&&this.verification.contact!==this.contactKey())this.resetVerification('reverify');},options);
   this.querySelector('[data-approve-payment]').addEventListener('click',event=>{void this.perform(()=>this.decide('approve'),event.currentTarget);},options);
   this.querySelector('[data-decline-payment]').addEventListener('click',event=>{void this.perform(()=>this.decide('decline'),event.currentTarget);},options);
   void this.perform(async()=>{
    const results=await Promise.allSettled([this.loadAreas(),this.cart()]);
    const receipt=this.latestReceipt();
    if(receipt)this.showMembership(await this.withReceipt(receipt.publicId,()=>this.membership(receipt)));
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
   this.areaList.hidden=false;this.areaInput.setAttribute('aria-expanded','true');
   this.setActive(this.options.findIndex(area=>area.publicId===this.area?.publicId));
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
   finally{
    if(this.lifecycle!==lifecycle)return;this.busy=false;loading?.removeAttribute('aria-busy');this.removeAttribute('aria-busy');this.querySelectorAll('form').forEach(form=>form.inert=false);this.controls();
    // Forms are inert while busy, so an action names its next focus target and it is applied here.
    const next=this.focusAfter;this.focusAfter=null;
    const restore=element=>{this.restoringFocus=true;try{element.focus({preventScroll:true});}finally{this.restoringFocus=false;}};
    if(next?.isConnected&&!next.disabled&&!next.closest('[hidden]'))restore(next);
    else if(focus?.isConnected&&this.contains(focus)&&!focus.disabled&&document.activeElement===document.body)restore(focus);
   }
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
   this.paymentStep.hidden=joined;
   const button=this.querySelector('[data-join-button]');
   button.textContent=joined?this.dataset.updateLabel:this.pending?this.dataset.startLabel:this.dataset.joinLabel;
   // New joins wait for a verified payment method; pledge updates by existing members do not.
   const verified=this.verification?.status==='VERIFIED';
   button.disabled=(this.pending?!this.foundPlace:!this.group||!['OPEN','THRESHOLD_REACHED'].includes(this.group.status))||(!joined&&!verified);
   this.renderMember();
  }
  contactKey(){const form=this.querySelector('[data-join-group]');return form.querySelector('[name=email]').value.trim().toLowerCase()+'\n'+form.querySelector('[name=phone]').value.replace(/[\s()-]/g,'');}
  // Verification UI state: required | verifying | verified | failed | cancelled | expired | reverify.
  paymentState(state){
   this.paymentStep.dataset.state=state;
   const key={required:'payRequired',verifying:'payVerifying',verified:'payVerified',failed:'payFailed',cancelled:'payCancelled',expired:'payExpired',reverify:'payReverify'}[state]||'payRequired';
   this.querySelector('[data-payment-status]').textContent=this.dataset[key]||'';
   this.querySelector('[data-verify-payment]').hidden=state==='verified'||state==='verifying';
   if(state!=='verifying')this.querySelector('[data-mock-payment]').hidden=true;
  }
  resetVerification(state='required'){this.verification=null;this.paymentState(state);this.controls();}
  // Starts a provider verification for the entered contact. Nothing is charged; no card data passes through here.
  async startVerification(){
   if(this.receiptFor(this.group?.publicId))return;
   const form=this.querySelector('[data-join-group]'),fields=[form.querySelector('[name=email]'),form.querySelector('[name=phone]')];
   const invalid=fields.find(field=>!field.checkValidity());
   if(invalid){invalid.reportValidity();throw failure('INVALID_CONTACT');}
   this.verification=null;
   const result=await this.api('/payment-verifications',{email:fields[0].value,phone:fields[1].value});
   const verification=result.verification;
   if(typeof verification?.id!=='string'||!UUID.test(verification.id)||typeof result.verificationToken!=='string'||!TOKEN.test(result.verificationToken)||verification.status!=='PENDING')throw failure('INVALID_RESPONSE');
   // Only the development simulator is wired today. A hosted provider page is added together with a real adapter.
   if(result.next?.type!=='mock')throw failure('PAYMENTS_UNAVAILABLE');
   this.verification={id:verification.id,token:result.verificationToken,status:'PENDING',contact:this.contactKey()};
   this.paymentState('verifying');this.querySelector('[data-mock-payment]').hidden=false;
   this.message.textContent=this.dataset.payVerifying;
   this.focusAfter=this.querySelector('[data-mock-outcome]');
  }
  // Development simulator: the server asks its mock provider for the result; the browser never asserts "verified".
  async simulateVerification(outcome){
   const verification=this.verification;
   if(!verification||!['verified','failed','cancelled'].includes(outcome))return;
   const result=await this.api('/payment-verifications/'+verification.id+'/mock-result',{outcome},verification.token);
   const status=result.verification?.status;
   if(!['PENDING','VERIFIED','FAILED','CANCELLED','EXPIRED','USED'].includes(status))throw failure('INVALID_RESPONSE');
   if(this.verification!==verification)return;
   verification.status=status;
   const state={VERIFIED:'verified',FAILED:'failed',CANCELLED:'cancelled',EXPIRED:'expired',USED:'expired'}[status]||'verifying';
   if(status!=='VERIFIED'&&status!=='PENDING')this.verification=null;
   this.paymentState(state);this.controls();
   this.message.textContent=this.querySelector('[data-payment-status]').textContent;
   this.focusAfter=status==='VERIFIED'?this.querySelector('[data-join-button]'):this.querySelector('[data-verify-payment]');
  }
  membership(receipt){return this.api('/groups/'+receipt.publicId+'/membership',undefined,receipt.memberToken);}
  showMembership(result){this.show(result.group);this.setMember(result.member);}
  // Keeps only the member's own, display-safe payment state, in memory. The server states which actions are allowed.
  setMember(member){
   const valid=member&&typeof member==='object'&&['VERIFIED','NOT_STARTED'].includes(member.paymentMethod)&&typeof member.approval?.status==='string'&&typeof member.charge?.status==='string';
   const amount=value=>Number.isSafeInteger(value)&&value>0?value:null;
   this.member=valid&&this.group?{groupId:this.group.publicId,active:member.active!==false,paymentMethod:member.paymentMethod,
    approval:{status:member.approval.status,amountAgorot:amount(member.approval.amountAgorot),nonce:typeof member.approval.nonce==='string'&&/^[a-f0-9]{32}$/.test(member.approval.nonce)?member.approval.nonce:null,review:['CART_CHANGED','CART_UNAVAILABLE'].includes(member.approval.review)?member.approval.review:null,previousAmountAgorot:amount(member.approval.previousAmountAgorot)},
    charge:{status:member.charge.status,amountAgorot:amount(member.charge.amountAgorot)},
    actions:{approve:member.actions?.approve===true,decline:member.actions?.decline===true}}:null;
   this.renderMember();
  }
  // verified | awaiting_store | required | changed | declined | approved | processing | authorized | paid | failed |
  // invalidated | expired | cancelled | refund | legacy
  memberState(member){
   if(member.paymentMethod!=='VERIFIED')return 'legacy';
   const group=this.group.status,approval=member.approval.status,charge=member.charge.status;
   if(charge==='SUCCEEDED')return group==='CANCELLED'?'refund':'paid';
   if(charge==='VOIDED'||(['CANCELLED','EXPIRED'].includes(group)&&approval!=='NOT_REQUIRED'))return 'cancelled';
   if(charge==='PENDING')return 'processing';
   if(charge==='AUTHORIZED')return 'authorized';
   if(approval==='APPROVED'&&charge==='FAILED')return 'failed';
   if(approval==='INVALIDATED')return 'invalidated';
   if(approval==='REQUIRED')return member.approval.review==='CART_CHANGED'?'changed':'required';
   const plain={APPROVED:'approved',DECLINED:'declined',EXPIRED:'expired'}[approval];
   if(plain)return plain;
   return group==='THRESHOLD_REACHED'?'awaiting_store':'verified';
  }
  renderMember(){
   const box=this.querySelector('[data-member-payment]');if(!box)return;
   const member=this.receiptFor(this.group?.publicId)&&this.member?.groupId===this.group?.publicId&&this.member.active?this.member:null;
   box.hidden=!member;if(!member)return;
   const state=this.memberState(member),d=this.dataset;
   box.dataset.state=state;
   const titles={awaiting_store:d.memberAwaitingStoreTitle,required:d.memberRequiredTitle,declined:d.memberRequiredTitle,changed:d.memberChangedTitle,approved:d.memberApprovedTitle,processing:d.memberProcessingTitle,authorized:d.memberAuthorizedTitle,paid:d.memberPaidTitle,failed:d.memberFailedTitle,invalidated:d.memberInvalidatedTitle,cancelled:d.memberCancelledTitle,refund:d.memberCancelledTitle};
   const details={verified:d.memberVerified,awaiting_store:d.memberAwaitingStore,legacy:d.memberLegacy,required:d.memberRequired,changed:d.memberChanged,declined:d.memberDeclined,approved:d.memberApproved,processing:d.memberProcessing,authorized:d.memberAuthorized,paid:d.memberPaid,failed:d.memberFailed,invalidated:d.memberInvalidated,expired:d.memberExpired,cancelled:d.memberCancelled,refund:d.memberRefund};
   box.querySelector('[data-member-pay-title]').textContent=titles[state]||d.memberTitle;
   box.querySelector('[data-member-pay-detail]').textContent=details[state]||'';
   const charged=['paid','refund'].includes(state);
   const shown=charged?member.charge.amountAgorot:['required','changed','declined','approved','failed','processing','authorized'].includes(state)?member.approval.amountAgorot:null;
   const amount=box.querySelector('[data-member-pay-amount]');amount.hidden=shown===null;
   if(shown!==null){amount.querySelector('[data-member-pay-amount-label]').textContent=charged?d.memberCharged:d.memberAmount;amount.querySelector('bdi').textContent=this.currency.format(shown/100);}
   const approve=box.querySelector('[data-approve-payment]'),decline=box.querySelector('[data-decline-payment]');
   const canApprove=member.actions.approve&&!!member.approval.nonce&&member.approval.amountAgorot!==null;
   approve.hidden=!canApprove;decline.hidden=!member.actions.decline;
   if(canApprove)approve.textContent=(state==='failed'?d.retryLabel:d.approveLabel).replace('__AMOUNT__',this.currency.format(member.approval.amountAgorot/100));
   decline.textContent=state==='approved'?d.withdraw:d.decline;
   // The exact-amount promise and the fixed deadline accompany every open approval decision.
   // A re-priced cart shows what was approved before, next to the new amount that needs fresh consent.
   const previous=box.querySelector('[data-member-pay-previous]'),before=state==='changed'?member.approval.previousAmountAgorot:null;
   previous.hidden=before===null;if(before!==null)previous.textContent=d.memberPrevious.replace('__AMOUNT__',this.currency.format(before/100));
   const exact=box.querySelector('[data-member-pay-exact]');exact.hidden=!canApprove;exact.textContent=d.memberExact||'';
   const deadline=box.querySelector('[data-member-pay-deadline]'),due=this.group.approvals?.deadline;
   const showDeadline=(canApprove||state==='approved')&&typeof due==='string'&&Number.isFinite(Date.parse(due));
   deadline.hidden=!showDeadline;
   if(showDeadline)deadline.textContent=d.memberDeadline.replace('__DEADLINE__',new Intl.DateTimeFormat(d.locale||'he',{dateStyle:'medium',timeStyle:'short'}).format(new Date(due)));
  }
  // Explicit member decision. The amount and nonce echo what the member was shown; the server charges its own stored
  // amount and refuses a stale screen. Repeated clicks are single-flight here and idempotent on the server.
  async decide(decision){
   const receipt=this.receiptFor(this.group?.publicId),member=this.member;
   if(!receipt||member?.groupId!==receipt.publicId)return;
   const body=decision==='approve'?{decision,approvalNonce:member.approval.nonce,amountAgorot:member.approval.amountAgorot}:{decision};
   let result;
   try{result=await this.withReceipt(receipt.publicId,()=>this.api('/groups/'+receipt.publicId+'/payment-approval',body,receipt.memberToken));}
   catch(error){
    // Show the current amount/state instead of a stale approval screen.
    if(['PAYMENT_AMOUNT_CHANGED','PAYMENT_APPROVAL_NOT_AVAILABLE','PAYMENT_METHOD_REQUIRED'].includes(error?.code))try{this.showMembership(await this.membership(receipt));}catch{}
    throw error;
   }
   this.showMembership(result);
   const state=this.member?this.memberState(this.member):'';
   this.message.textContent={paid:this.dataset.memberPaid,failed:this.dataset.memberFailed,processing:this.dataset.memberProcessing,authorized:this.dataset.memberAuthorized,declined:this.dataset.memberDeclined,approved:this.dataset.memberApproved,changed:this.dataset.memberChanged,invalidated:this.dataset.memberInvalidated,cancelled:this.dataset.memberCancelled}[state]||'';
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
  // The only search endpoint: read-only and area-based. The service resolves areaPublicId; free text is never sent.
  // Search never creates a group: a miss shows the no-group state, and only Join (/groups/join) may create one.
  async find(){
   this.closeAreas();const area=this.chosenArea();if(!area)throw failure('AREA_REQUIRED');
   const lines=await this.cart();if(!lines.length)throw failure('CART_EMPTY');
   this.foundPlace=area;
   const result=await this.api('/groups/find',{areaPublicId:area.publicId,lines});
   if(result.group){this.show(result.group);this.message.textContent=this.dataset.found;}
   else{this.showPending(area.name);this.message.textContent=this.dataset.noneFound;}
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
     this.show(result.group);this.setMember(result.member);this.pledge(result);this.message.textContent=this.dataset.updated;
    }catch(error){
     // Closed groups keep the receipt; show their current state instead of leaving a stale panel.
     if(error?.code==='GROUP_CLOSED')try{this.show((await this.api('/groups/'+id)).group);}catch{}
     throw error;
    }
    return;
   }
   if(!this.foundPlace||(!this.group&&!this.pending))throw failure('DEFAULT');
   const form=this.querySelector('[data-join-group]');
   // The verification secret goes to the service once, with the join; the service decides whether it is valid.
   const verification=this.verification;
   if(verification?.status!=='VERIFIED'||verification.contact!==this.contactKey())throw failure('PAYMENT_VERIFICATION_REQUIRED');
   const body={areaPublicId:this.foundPlace.publicId,lines,email:form.querySelector('[name=email]').value,phone:form.querySelector('[name=phone]').value,verificationId:verification.id,verificationToken:verification.token};
   // A shown group is joined directly; with no group yet, the service re-checks the same area under its lock and
   // creates the group only now, with this shopper as its first member.
   let result;
   try{result=await this.api(this.group?'/groups/'+this.group.publicId+'/join':'/groups/join',body);}
   catch(error){
    // Rejected or unusable verification: start again. Other failures (duplicate, closed, network) keep it.
    if(['PAYMENT_VERIFICATION_REQUIRED','PAYMENTS_UNAVAILABLE'].includes(error?.code)&&this.verification===verification)this.resetVerification('expired');
    throw error;
   }
   if(!TOKEN.test(result.memberToken)||!UUID.test(result.group?.publicId))throw failure('INVALID_RESPONSE');
   const saved={publicId:result.group.publicId,memberToken:result.memberToken,savedAt:Date.now()};
   this.receipts.set(saved.publicId,saved);this.persist(saved);
   this.verification=null;this.paymentState('required');
   form.reset();this.show(result.group);this.setMember(result.member);this.pledge(result);this.message.textContent=result.created===true?this.dataset.started:this.dataset.joined;
  }
  pledge(result){if(Number.isSafeInteger(result.validatedPledgeAgorot)&&result.validatedPledgeAgorot>=0){const pledge=this.querySelector('[data-validated-pledge]');pledge.hidden=false;pledge.querySelector('bdi').textContent=this.currency.format(result.validatedPledgeAgorot/100);}}
  share(){
   if(!this.group)return;
   // Share only the storefront path and public aggregates, without URL parameters or receipts.
   const page=new URL(location.pathname,location.origin);
   const text=this.dataset.shareText.replace('__AREA__',this.group.areaName).replace('__AMOUNT__',this.currency.format(this.group.pledgedTotalAgorot/100)).replace('__TARGET__',this.currency.format(this.group.thresholdAgorot/100));
   window.open('https://wa.me/?text='+encodeURIComponent(text+'\n'+page.href),'_blank','noopener,noreferrer');
  }
  // Members refresh through their receipt (group + own payment state); everyone else reads the public aggregate.
  async refresh(){
   if(!this.group)return;
   const id=this.group.publicId,receipt=this.receiptFor(id);
   if(receipt)this.showMembership(await this.withReceipt(id,()=>this.membership(receipt)));
   else this.show((await this.api('/groups/'+id)).group);
  }
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
   // Public approval progress: counts only.
   const approvals=this.querySelector('[data-approvals-summary]'),counts=group.approvals;
   const showCounts=group.status==='PAYMENT_OPEN'&&Number.isSafeInteger(counts?.approved)&&Number.isSafeInteger(counts?.waiting)&&Number.isSafeInteger(counts?.approvedPledgeTotalAgorot);
   approvals.hidden=!showCounts;
   if(showCounts)approvals.textContent=this.dataset.approvals.replace('__APPROVED__',counts.approved).replace('__WAITING__',counts.waiting)+' · '+this.dataset.approvalsValue.replace('__AMOUNT__',this.currency.format(counts.approvedPledgeTotalAgorot/100)).replace('__TARGET__',this.currency.format(group.thresholdAgorot/100));
   if(this.member?.groupId!==group.publicId)this.member=null;
   // Members of a group in its payment phase see their payment panel instead of a "closed" notice.
   const memberPhase=!!this.receiptFor(group.publicId)&&['APPROVED','PAYMENT_OPEN','CONFIRMED','CANCELLED'].includes(group.status);
   if(!['OPEN','THRESHOLD_REACHED'].includes(group.status)&&!memberPhase)this.message.textContent=this.dataset.closed;
   this.controls();
  }
 }
 customElements.define('fankee-group-delivery',GroupDelivery);
})();
