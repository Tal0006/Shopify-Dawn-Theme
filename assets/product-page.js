(() => {
  'use strict';
  if (window.fankeeProductPageLoaded) return;
  window.fankeeProductPageLoaded = true;
  const requests = new WeakMap();
  function selectImage(page, id) {
    const image = [...page.querySelectorAll('[data-product-image]')].find(node => node.dataset.productImage === id);
    if (!image) return;
    page.querySelectorAll('[data-product-image]').forEach(node => { node.hidden = node !== image; });
    page.querySelectorAll('[data-product-image-target]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.productImageTarget === id)));
  }
  function quantityState(page) {
    const input = page.querySelector('[data-quantity-controls] input');
    if (!input) return;
    const controls = input.closest('[data-quantity-controls]');
    controls.querySelector('[data-quantity-change="-1"]').disabled = !input.value || Number(input.value) <= Number(input.min || 1);
    controls.querySelector('[data-quantity-change="1"]').disabled = !!input.max && Number(input.value) >= Number(input.max);
  }
  function whatsapp(page) {
    const button = page.querySelector('[data-product-whatsapp]');
    const configured = document.querySelector('[data-store-whatsapp]');
    if (!button) return;
    button.hidden = true;
    button.removeAttribute('href');
    if (!configured) return;
    try {
      const url = new URL(configured.href);
      const host = url.hostname.toLowerCase();
      const valid = url.protocol === 'https:' && ((host === 'wa.me' && /^\/[0-9]+\/?$/.test(url.pathname)) || (['api.whatsapp.com', 'web.whatsapp.com'].includes(host) && url.pathname === '/send' && /^\+?[0-9]+$/.test(url.searchParams.get('phone') || '')));
      if (!valid) return;
      const productURL = new URL(page.dataset.productUrl, location.origin);
      const variant = page.querySelector('[name=id]')?.value;
      if (variant) productURL.searchParams.set('variant', variant);
      url.searchParams.set('text', button.dataset.message + '\n' + productURL.href);
      button.href = url.href;
      button.hidden = false;
    } catch { /* Hide the optional action when the merchant URL is not a direct WhatsApp chat. */ }
  }
  function init() {
    document.querySelectorAll('[data-product-page]').forEach(page => { quantityState(page); whatsapp(page); });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-product-image-target]');
    if (!button) return;
    selectImage(button.closest('[data-product-page]'), button.dataset.productImageTarget);
  });
  document.addEventListener('input', event => {
    const page = event.target.closest('[data-product-page]');
    if (page && event.target.matches('[name=quantity]')) quantityState(page);
  });
  document.addEventListener('change', async event => {
    const select = event.target;
    const page = select.closest('[data-product-page]');
    if (!page) return;
    if (select.matches('[name=quantity]')) { quantityState(page); return; }
    if (!select.matches('[data-product-variant]')) return;
    const form = select.closest('form');
    if (form.hasAttribute('aria-busy')) { select.value = select.dataset.currentVariant; return; }
    const previousRequest = requests.get(page);
    previousRequest?.abort();
    const controller = new AbortController();
    requests.set(page, controller);
    const id = select.value;
    const url = new URL(page.dataset.productUrl, location.origin);
    url.searchParams.set('variant', id);
    url.searchParams.set('section_id', page.dataset.sectionId);
    const status = page.querySelector('[data-product-status]');
    status.textContent = '';
    page.setAttribute('aria-busy', 'true');
    const add = form.querySelector('[name=add]');
    const previouslyDisabled = previousRequest?.previouslyDisabled ?? add.disabled;
    controller.previouslyDisabled = previouslyDisabled;
    add.disabled = true;
    const checkout = form.querySelector('.shopify-payment-button');
    if (checkout) checkout.inert = true;
    try {
      const response = await fetch(url, {headers: {Accept: 'text/html'}, credentials: 'same-origin', signal: controller.signal});
      if (!response.ok) throw Error('Variant render failed');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const fresh = [...doc.querySelectorAll('[data-product-page]')].find(node => node.dataset.productId === page.dataset.productId);
      const purchase = fresh?.querySelector('[data-product-purchase]');
      if (!purchase || purchase.querySelector('[name=id]')?.value !== id) throw Error('Unexpected variant');
      if (controller.signal.aborted || !page.isConnected) return;
      const oldQuantity = Number(form.querySelector('[name=quantity]').value);
      const oldPlan = form.querySelector('[name=selling_plan]')?.value;
      const quantity = purchase.querySelector('[name=quantity]');
      const min = Number(quantity.min || 1), step = Number(quantity.step || 1);
      let next = min + Math.max(0, Math.ceil((oldQuantity - min) / step)) * step;
      if (quantity.max) next = Math.min(next, min + Math.floor((Number(quantity.max) - min) / step) * step);
      quantity.value = Number.isFinite(next) ? Math.max(min, next) : min;
      const plan = purchase.querySelector('[name=selling_plan]');
      if (oldPlan && [...(plan?.options || [])].some(option => option.value === oldPlan && !option.disabled)) plan.value = oldPlan;
      const accordions = fresh.querySelector('.product-page__accordions');
      const currentAccordions = page.querySelector('.product-page__accordions');
      const states = new Map([...(currentAccordions?.querySelectorAll('details') || [])].map(node => [node.querySelector('summary').textContent, node.open]));
      accordions?.querySelectorAll('details').forEach(node => { const state = states.get(node.querySelector('summary').textContent); if (state !== undefined) node.open = state; });
      page.querySelector('[data-product-purchase]').replaceWith(purchase);
      if (accordions && currentAccordions) currentAccordions.replaceWith(accordions);
      else if (accordions) page.querySelector('.product-page__layout').append(accordions);
      else currentAccordions?.remove();
      const activeImage = fresh.querySelector('[data-product-image]:not([hidden])');
      if (activeImage) selectImage(page, activeImage.dataset.productImage);
      const selectedURL = new URL(location.href);
      selectedURL.searchParams.set('variant', id);
      history.replaceState(history.state, '', selectedURL);
      quantityState(page);
      whatsapp(page);
      if (purchase.querySelector('.shopify-payment-button')) window.Shopify?.PaymentButton?.init();
      purchase.querySelector('[data-product-variant]')?.focus({preventScroll: true});
      status.textContent = page.dataset.variantUpdated;
      document.dispatchEvent(new CustomEvent('storefront:variant:updated', {detail: {page, variantId: id}}));
    } catch (error) {
      if (!controller.signal.aborted && page.isConnected) {
        select.value = select.dataset.currentVariant;
        status.textContent = page.dataset.variantError;
      }
    } finally {
      if (requests.get(page) === controller) {
        page.removeAttribute('aria-busy');
        if (add.isConnected) add.disabled = previouslyDisabled;
        if (checkout?.isConnected) checkout.inert = false;
        requests.delete(page);
      }
    }
  });
  document.addEventListener('shopify:section:load', init);
  document.addEventListener('shopify:section:unload', event => {
    event.target.querySelectorAll('[data-product-page]').forEach(page => requests.get(page)?.abort());
  });
  init();
})();
