(() => {
 'use strict';
 if (window.fankeeBundleLoaded) return;
 window.fankeeBundleLoaded = true;
 const states = new Map();
 function update(section) {
  const state = states.get(section);
  if (!state) return;
  const busy = state.form.hasAttribute('aria-busy');
  const pageBusy = document.querySelector('[data-product-page]')?.hasAttribute('aria-busy');
  const choices = [...state.form.querySelectorAll('[name=bundle_variant]')];
  if (!busy) {
   let total = 0;
   for (const choice of choices) if (choice.checked && !choice.disabled) total += Number(choice.dataset.price);
   const valid = Number.isSafeInteger(total) && total >= 0;
   const formatted = valid ? state.format.format(total / 100) : '—';
   const output = section.querySelector('[data-bundle-total]');
   if (output.textContent !== formatted) output.textContent = formatted;
   state.button.disabled = state.form.dataset.inventoryBlocked === 'true' || !valid || state.variantValid === false || pageBusy || !choices.some(choice => choice.checked && !choice.disabled);
  }
  // Inert preserves form serialization and prevents selection changes mid-request.
  section.querySelector('.bundle-section__items').inert = busy;
 }
 function sync(section, id) {
  const state = states.get(section);
  if (!state) return;
  const page = [...document.querySelectorAll('[data-product-page]')].find(page => page.dataset.productId === section.dataset.productId);
  const purchase = page?.querySelector('[data-product-purchase]');
  const variant = purchase?.dataset.selectedVariant === String(id) ? {
   price: Number(purchase.dataset.selectedPrice),
   available: purchase.dataset.selectedAvailable === 'true',
   safe: purchase.dataset.selectedUnitSafe === 'true'
  } : null;
  const choice = section.querySelector('[data-bundle-main-choice]');
  if (!variant || !Number.isSafeInteger(variant.price) || variant.price < 0 || !choice) { state.variantValid = false; state.button.disabled = true; return; }
  state.variantValid = true;
  const selectable = variant.available && variant.safe;
  const rowLimit=section.querySelector('[data-bundle-main] [data-inventory-variant]');
  const pageLimit=purchase.querySelector('[data-inventory-variant]');
  if(rowLimit&&pageLimit) Object.assign(rowLimit.dataset,pageLimit.dataset);
  choice.value = String(id); choice.dataset.price = variant.price;
  choice.disabled = !selectable;
  if (!selectable) choice.checked = false;
  else if (state.previousDisabled) choice.checked = true;
  state.previousDisabled = !selectable;
  state.form.querySelector('[name=id]').value = String(id);
  const row = section.querySelector('[data-bundle-main]');
  row.classList.toggle('bundle-item--quiet', !selectable);
  const price = page?.querySelector('.product-page__price .catalog-price');
  if (price) row.querySelector('[data-bundle-price]').replaceChildren(price.cloneNode(true));
  row.querySelector('[data-bundle-availability]').textContent = !variant.safe ? section.dataset.optionsRequired : variant.available ? section.dataset.inStock : section.dataset.soldOut;
  update(section);
 }
 function init() {
  document.querySelectorAll('[data-bundle]').forEach(section => {
   if (states.has(section)) return;
   const form = section.querySelector('[data-bundle-cart]');
   const state = {form, button: form.querySelector('[name=add]'), format: new Intl.NumberFormat(section.dataset.locale || 'he', {style:'currency', currency:section.dataset.currency || 'ILS'})};
   state.previousDisabled = section.querySelector('[data-bundle-main-choice]').disabled;
   states.set(section, state);
   state.observer = new MutationObserver(() => update(section));
   state.observer.observe(form, {attributes:true, attributeFilter:['aria-busy']});
   update(section);
  });
 }
 document.addEventListener('storefront:inventory:updated', () => { for(const [section] of states) update(section); });
 document.addEventListener('change', event => {
  const section = event.target.closest('[data-bundle]');
  if (section) update(section);
  if (event.target.matches('[data-product-variant]')) {
   for (const [bundle, state] of states) state.button.disabled = true;
  }
 });
 document.addEventListener('storefront:variant:updated', event => {
  for (const [section] of states) if (section.dataset.productId === event.detail.page.dataset.productId) sync(section, event.detail.variantId);
 });
 // Product page removes aria-busy after success or failure, restoring safe selection.
 const pageObservers = new Map();
 function observePages() {
  document.querySelectorAll('[data-product-page]').forEach(page => {
   if (pageObservers.has(page)) return;
   const observer = new MutationObserver(() => {
    if (page.hasAttribute('aria-busy')) return;
    for (const [section] of states) if (section.dataset.productId === page.dataset.productId) sync(section, page.querySelector('[name=id]')?.value);
   });
   observer.observe(page,{attributes:true,attributeFilter:['aria-busy']});pageObservers.set(page,observer);
  });
 }
 document.addEventListener('shopify:section:load', () => { init(); observePages(); });
 document.addEventListener('shopify:section:unload', event => {
  for (const [section,state] of states) if (event.target.contains(section)) { state.observer.disconnect(); states.delete(section); }
  for (const [page,observer] of pageObservers) if (event.target.contains(page)) { observer.disconnect(); pageObservers.delete(page); }
 });
 init(); observePages();
})();
