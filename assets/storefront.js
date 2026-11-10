(() => {
  'use strict';

  // One delegated card handler also covers recommendations and Theme Editor reloads.
  const cardCartPending = new WeakSet();
  const cardFeedbackTimers = new WeakMap();
  let cardCartQueue = Promise.resolve();
  const cartRoot = () => window.Shopify?.routes?.root || (document.querySelector('form[data-card-cart]')?.action.replace(/cart\/add.*$/, '') || '/');

  // Shopify-rendered limits and Shopify cart lines are the only inventory inputs.
  const inventoryCart = new Map();
  const inventoryButtonState = new WeakMap();
  const inventoryNodes = () => [...document.querySelectorAll('[data-inventory-variant]')];
  function inventoryRemaining(node) {
    const stock = node.dataset.inventoryFinite === 'true' ? Math.max(0, Number(node.dataset.inventoryStock)) : Infinity;
    const rule = node.dataset.inventoryRuleMax ? Number(node.dataset.inventoryRuleMax) : Infinity;
    return Math.max(0, Math.min(stock, rule) - (inventoryCart.get(node.dataset.inventoryVariant) || 0));
  }
  // Exact counts are shown only when tracked stock is low; enforcement always uses inventoryRemaining().
  const LOW_STOCK_THRESHOLD = 4;
  function inventoryStockLeft(node) {
    if (node.dataset.inventoryFinite !== 'true') return Infinity;
    return Math.max(0, Math.max(0, Number(node.dataset.inventoryStock)) - (inventoryCart.get(node.dataset.inventoryVariant) || 0));
  }
  // A per-order quantity_rule.max is a purchase limit, never stock. It is described as such only when it is
  // the binding limit (lower than tracked stock left, or stock is untracked); the stock count stays hidden.
  function inventoryPurchaseLimit(node) {
    const max = node.dataset.inventoryRuleMax ? Number(node.dataset.inventoryRuleMax) : Infinity;
    if (!Number.isFinite(max) || !node.dataset.inventoryRule) return '';
    const ruleLeft = Math.max(0, max - (inventoryCart.get(node.dataset.inventoryVariant) || 0));
    return ruleLeft < inventoryStockLeft(node) ? node.dataset.inventoryRule.replace('__COUNT__', String(max)) : '';
  }
  // One decision for both the text and its presentation tone ('limit' | 'out' | 'low' | '').
  function inventoryState(node, remaining = inventoryRemaining(node)) {
    if (!Number.isFinite(remaining)) return {text: '', tone: ''};
    const purchaseLimit = inventoryPurchaseLimit(node);
    if (purchaseLimit) return {text: purchaseLimit, tone: 'limit'};
    if (remaining === 0) return {text: (inventoryCart.get(node.dataset.inventoryVariant)||0)>0 ? node.dataset.inventoryFull : node.dataset.inventoryEmpty || node.dataset.inventoryFull, tone: 'out'};
    const stockLeft = inventoryStockLeft(node);
    if (stockLeft > LOW_STOCK_THRESHOLD) return {text: '', tone: ''};
    return {text: stockLeft === 1 ? node.dataset.inventoryOne : node.dataset.inventoryMany.replace('__COUNT__', String(stockLeft)), tone: 'low'};
  }
  const inventoryMessage = (node, remaining) => inventoryState(node, remaining).text;
  function syncInventory() {
    for (const node of inventoryNodes()) {
      if (!inventoryCart.has(node.dataset.inventoryVariant)) inventoryCart.set(node.dataset.inventoryVariant, Number(node.dataset.inventoryCart || 0));
      // Write only real changes so these live regions do not re-announce identical text on every sync.
      const state = inventoryState(node);
      if (node.textContent !== state.text) node.textContent = state.text;
      if ((node.dataset.tone || '') !== state.tone) { if (state.tone) node.dataset.tone = state.tone; else delete node.dataset.tone; }
    }
    document.querySelectorAll('form[data-card-cart]').forEach(form => {
      const button = form.querySelector('[name=add]');
      if (!button) return;
      const bundle = form.hasAttribute('data-bundle-cart');
      const selected = bundle ? [...form.querySelectorAll('[name=bundle_variant]:checked')].map(choice => String(choice.value)) : [String(form.querySelector('[name=id]')?.value)];
      const nodes = [...form.querySelectorAll('[data-inventory-variant]')].filter(node => selected.includes(node.dataset.inventoryVariant));
      if (!nodes.length) return;
      const input = !bundle && form.querySelector('[name=quantity]');
      const min = Number(input?.min || 1), step = Number(input?.step || 1);
      const remaining = nodes.length ? Math.min(...nodes.map(inventoryRemaining)) : Infinity;
      const blocked = remaining < min;
      form.dataset.inventoryBlocked = String(blocked);
      if (input && nodes.length) {
        if (Number.isFinite(remaining)) input.max = String(Math.max(0, min + Math.floor((remaining-min)/step)*step));
        else if (input.dataset.inventoryOriginalMax) input.max = input.dataset.inventoryOriginalMax;
        else input.removeAttribute('max');
        const plus = form.querySelector('[data-quantity-change="1"]');
        if (plus) plus.disabled = blocked || (input.max !== '' && Number(input.value) + step > Number(input.max));
      }
      if (!inventoryButtonState.has(button) && !bundle && !form.hasAttribute('aria-busy')) inventoryButtonState.set(button, button.disabled);
      if (!form.hasAttribute('aria-busy')) {
        if (!bundle) button.disabled = inventoryButtonState.get(button) || blocked;
        else if (blocked) button.disabled = true;
      }
    });
    document.dispatchEvent(new CustomEvent('storefront:inventory:updated'));
  }
  async function loadInventoryCart() {
    if (!inventoryNodes().length) return;
    const response = await fetch(cartRoot()+'cart.js', {headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store'});
    if (!response.ok) throw Error('Cart inventory unavailable');
    const cart = await response.json();
    if (!Array.isArray(cart.items)) throw Error('Invalid cart inventory');
    inventoryCart.clear();
    inventoryNodes().forEach(node => inventoryCart.set(node.dataset.inventoryVariant, 0));
    for (const line of cart.items) {
      const id = String(line.variant_id || line.id);
      if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) throw Error('Invalid cart quantity');
      inventoryCart.set(id, (inventoryCart.get(id)||0)+line.quantity);
    }
    syncInventory();
    document.dispatchEvent(new CustomEvent('storefront:cart:updated'));
  }
  // Returns the freshly rendered page so callers can reuse it (for example, for the header cart) without another request.
  async function refreshInventorySnapshot() {
    if (!inventoryNodes().length) return null;
    let doc = null;
    try {
      const response = await fetch(location.href, {headers:{Accept:'text/html'},credentials:'same-origin',cache:'no-store'});
      if (response.ok) {
        doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        for (const node of inventoryNodes()) {
          const fresh = [...doc.querySelectorAll('[data-inventory-variant]')].find(value => value.dataset.inventoryVariant === node.dataset.inventoryVariant);
          if (fresh) { node.dataset.inventoryStock=fresh.dataset.inventoryStock; node.dataset.inventoryFinite=fresh.dataset.inventoryFinite; node.dataset.inventoryRuleMax=fresh.dataset.inventoryRuleMax||''; }
        }
      }
      await loadInventoryCart();
    } catch { /* Retain the last known Shopify limits; never invent a new stock value. */ }
    return doc;
  }
  document.addEventListener('input', event => { if (event.target.matches('form[data-card-cart] [name=quantity]')) syncInventory(); });
  document.addEventListener('change', event => { if (event.target.closest('form[data-card-cart]')) syncInventory(); });
  document.addEventListener('shopify:section:load', syncInventory);
  document.addEventListener('storefront:discovery:loaded', syncInventory);
  document.addEventListener('storefront:variant:updated', () => queueMicrotask(syncInventory));
  window.addEventListener('focus', () => { if (!document.querySelector('form[data-card-cart][aria-busy]')) void loadInventoryCart().catch(() => {}); });
  syncInventory();

  let cartReturnFocus = null;
  let drawerPending = false;
  const drawerReady = new WeakSet();
  const closedDrawers = new WeakSet();
  const drawer = () => document.querySelector('dialog.cart-drawer');
  function cartStatus(message, error = false) {
    const status = drawer()?.querySelector('[data-cart-status]');
    if (status) { status.toggleAttribute('data-error', error); status.textContent = message; }
  }
  function openCart(opener) {
    const panel = drawer();
    if (!panel || typeof panel.showModal !== 'function') return false;
    if (!panel.open) {
      closedDrawers.delete(panel);
      cartReturnFocus = opener || document.activeElement;
      panel.inert = false;
      try { panel.showModal(); } catch { return false; }
      panel.classList.add('mini-cart-content-toggle');
      panel.closest('.mini-cart').querySelector('.cart-toggle-btn').setAttribute('aria-expanded', 'true');
      panel.querySelector('.mini-cart-close').focus({preventScroll: true});
    }
    return true;
  }
  function finishCartClose(panel) {
    // A queued native close event can arrive after the drawer has reopened.
    if (panel.open || closedDrawers.has(panel)) return;
    closedDrawers.add(panel);
    panel.classList.remove('mini-cart-content-toggle');
    panel.closest('.mini-cart')?.querySelector('.cart-toggle-btn')?.setAttribute('aria-expanded', 'false');
    const target = cartReturnFocus?.isConnected ? cartReturnFocus : document.querySelector('.cart-toggle-btn');
    target?.focus({preventScroll: true});
  }
  function closeCart() {
    const panel = drawer();
    if (panel?.open) { panel.close(); finishCartClose(panel); }
  }
  function initCart(root) {
    root.querySelectorAll('dialog.cart-drawer').forEach(panel => {
      if (drawerReady.has(panel)) return;
      drawerReady.add(panel);
      panel.addEventListener('close', () => finishCartClose(panel));

    });
  }
  initCart(document);
  document.addEventListener('shopify:section:load', event => initCart(event.target));
  document.addEventListener('shopify:section:unload', event => {
    const panel = event.target.querySelector('dialog.cart-drawer');
    if (panel?.open) panel.close();
  });
  function cardFeedback(form, message, error = false) {
    const feedback = form.querySelector('[data-card-feedback]');
    clearTimeout(cardFeedbackTimers.get(form));
    feedback.toggleAttribute('data-feedback-error', error);
    feedback.textContent = message;
    if (!error) cardFeedbackTimers.set(form, setTimeout(() => { if (feedback.isConnected) feedback.textContent = ''; }, 5500));
  }
  const cartMobile = window.matchMedia('(max-width: 991px)');
  let toastTimer;
  let toastExitTimer;
  const toastReady = new WeakSet();
  function hideCartToast(toast) {
    clearTimeout(toastTimer);
    clearTimeout(toastExitTimer);
    toast.setAttribute('data-closing', '');
    toastExitTimer = setTimeout(() => { toast.hidden = true; toast.removeAttribute('data-closing'); toast.querySelector('[data-cart-toast-message]').textContent = ''; }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  }
  function scheduleCartToast(toast) {
    clearTimeout(toastTimer);
    if (!toast.contains(document.activeElement) && !toast.matches(':hover')) toastTimer = setTimeout(() => hideCartToast(toast), 3200);
  }
  function addFeedback(form, message, error = false) {
    const toast = document.querySelector('[data-cart-toast]');
    if (!toast) { cardFeedback(form, message, error); return; }
    const inline = form.querySelector('[data-card-feedback]');
    if (inline) inline.textContent = '';
    clearTimeout(toastTimer);
    clearTimeout(toastExitTimer);
    toast.removeAttribute('data-closing');
    if (!toastReady.has(toast)) {
      toastReady.add(toast);
      toast.addEventListener('focusin', () => { clearTimeout(toastTimer); clearTimeout(toastExitTimer); toast.removeAttribute('data-closing'); });
      toast.addEventListener('focusout', () => setTimeout(() => scheduleCartToast(toast), 0));
      toast.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') clearTimeout(toastTimer); });
      toast.addEventListener('pointerleave', () => scheduleCartToast(toast));
      toast.addEventListener('pointerdown', () => clearTimeout(toastTimer));
      toast.addEventListener('pointerup', () => scheduleCartToast(toast));
    }
    toast.toggleAttribute('data-error', error);
    toast.querySelector('[data-cart-toast-message]').textContent = error ? message : toast.dataset.success;
    toast.style.removeProperty('--cart-toast-bottom');
    toast.hidden = false;
    // Keep the floating notification above the triggering purchase control.
    const button = form.querySelector('[name=add]');
    const control = button?.getBoundingClientRect(), rect = toast.getBoundingClientRect();
    if (control && control.bottom > rect.top && control.top < rect.bottom && control.top > rect.height + 24) {
      toast.style.setProperty('--cart-toast-bottom', (innerHeight - control.top + 12) + 'px');
    }
    scheduleCartToast(toast);
  }
  cartMobile.addEventListener('change', () => { const toast = document.querySelector('[data-cart-toast]'); if (toast) hideCartToast(toast); });
  // Free shipping meter (snippets/free-shipping-meter.liquid). Shopify renders it, with the money format and the
  // amount, inside the drawer section that every cart mutation already returns; nothing here computes amounts or
  // issues requests. This only (1) eases the bar from its previous value, (2) mirrors the fresh state into a cart
  // page meter outside the drawer, and (3) announces crossing the threshold once, through a persistent live region.
  function shippingMeterUpdated(items, previous) {
    const meter = items.querySelector('[data-shipping-meter]');
    const animate = (node, from) => {
      const bar = node.querySelector('.free-shipping__bar');
      if (!bar || from === undefined) return;
      const target = bar.style.getPropertyValue('--free-shipping-progress');
      bar.style.setProperty('--free-shipping-progress', String(from));
      void bar.offsetWidth;
      bar.style.setProperty('--free-shipping-progress', target);
    };
    const crossedUp = !!meter && meter.dataset.reached === 'true' && !previous?.reached;
    if (meter) {
      animate(meter, previous ? previous.progress : 0);
      if (crossedUp) meter.setAttribute('data-celebrate', '');
    }
    for (const page of document.querySelectorAll('[data-shipping-meter]')) {
      if (items.contains(page)) continue;
      if (!meter) { page.hidden = true; continue; }
      const from = Number(page.dataset.progress);
      const copy = meter.cloneNode(true);
      copy.className = meter.className.replace('free-shipping--drawer', 'free-shipping--cart');
      copy.removeAttribute('data-celebrate');
      page.replaceWith(copy);
      animate(copy, from);
      if (crossedUp) copy.setAttribute('data-celebrate', '');
    }
    const announcer = drawer()?.querySelector('[data-shipping-announcer]');
    if (!announcer) return;
    const crossedDown = !!meter && previous?.reached && meter.dataset.reached !== 'true';
    announcer.textContent = '';
    if (crossedUp || crossedDown) setTimeout(() => { announcer.textContent = meter.querySelector('[data-shipping-text]').textContent.trim(); }, 100);
  }
  function renderCardCartSection(html) {
    if (typeof html !== 'string' && !(html instanceof Document)) return false;
    const doc = html instanceof Document ? html : new DOMParser().parseFromString(html, 'text/html');
    const fresh = doc.querySelector('.storefront-header .mini-cart');
    const current = document.querySelector('.storefront-header .mini-cart');
    const freshButton = fresh?.querySelector('.cart-toggle-btn');
    const freshItems = fresh?.querySelector('.mini-cart-items');
    const button = current?.querySelector('.cart-toggle-btn');
    const items = current?.querySelector('.mini-cart-items');
    if (!freshButton || !freshItems || !button || !items) return false;
    // Keep existing controls/drawer nodes and their focus observers; replace only server-rendered cart content.
    const previousCount = button.querySelector('.cart-count')?.textContent;
    button.replaceChildren(...freshButton.childNodes);
    // Presentation only: a fresh badge animates once when the server-rendered count changed.
    const badge = button.querySelector('.cart-count');
    if (badge && previousCount !== undefined && badge.textContent !== previousCount) badge.setAttribute('data-bump', '');
    button.setAttribute('aria-label', freshButton.getAttribute('aria-label'));
    const focused = items.contains(document.activeElement) ? document.activeElement : null;
    const lineKey = focused?.closest('[data-cart-line]')?.dataset.cartLine;
    const action = focused?.matches('[data-cart-quantity]') ? '[data-cart-quantity]' : focused?.matches('[data-cart-remove]') ? '[data-cart-remove]' : focused?.matches('[data-cart-delta]') ? '[data-cart-delta="' + focused.dataset.cartDelta + '"]' : null;
    const previousMeter = items.querySelector('[data-shipping-meter]');
    const previousShipping = previousMeter ? {progress: Number(previousMeter.dataset.progress), reached: previousMeter.dataset.reached === 'true'} : null;
    // An order note still being typed (not yet saved) survives the re-render, with its open state and focus.
    const previousNote = items.querySelector('[data-cart-note]');
    const noteDraft = previousNote && previousNote.value !== previousNote.defaultValue ? previousNote.value : null;
    const noteOpen = previousNote?.closest('details')?.open;
    items.replaceChildren(...freshItems.childNodes);
    shippingMeterUpdated(items, previousShipping);
    const freshNote = items.querySelector('[data-cart-note]');
    if (freshNote) {
      if (noteDraft !== null) freshNote.value = noteDraft;
      if (noteOpen) freshNote.closest('details').open = true;
    }
    if (focused && focused === previousNote && freshNote && drawer()?.open) {
      freshNote.focus({preventScroll: true});
    } else if (focused && drawer()?.open) {
      const line = [...items.querySelectorAll('[data-cart-line]')].find(item => item.dataset.cartLine === lineKey);
      const target = action && line?.querySelector(action);
      (target && !target.disabled ? target : drawer().querySelector('.mini-cart-close')).focus({preventScroll: true});
    }
    return true;
  }
  async function refreshCardCart(sections, sectionId) {
    await loadInventoryCart().catch(() => {});
    if (sectionId && renderCardCartSection(sections?.[sectionId])) return true;
    if (sectionId) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('section_id');
        url.searchParams.set('sections', sectionId);
        const response = await fetch(url, {headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store'});
        if (response.ok && renderCardCartSection((await response.json())[sectionId])) return true;
      } catch { /* An add can succeed even when Shopify cannot render a section. */ }
    }
    // Last-resort badge state comes from Shopify, never from a locally incremented count.
    try {
      const response = await fetch(cartRoot() + 'cart.js', {headers: {Accept: 'application/json'}, credentials: 'same-origin', cache: 'no-store'});
      if (response.ok) {
        const cart = await response.json();
        const button = document.querySelector('.storefront-header .cart-toggle-btn');
        const badge = button?.querySelector('.cart-count');
        if (badge && Number.isInteger(cart.item_count)) {
          if (badge.textContent !== String(cart.item_count)) { badge.removeAttribute('data-bump'); void badge.offsetWidth; badge.setAttribute('data-bump', ''); }
          badge.textContent = String(cart.item_count);
          button.setAttribute('aria-label', button.dataset.countLabel.replace('__COUNT__', String(cart.item_count)));
        }
      }
    } catch { /* Report stale display separately; never retry the successful add. */ }
    return false;
  }
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('[data-card-cart]')) return;
    if (event.submitter && event.submitter.name !== 'add') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (cardCartPending.has(form)) return;
    const button = form.querySelector('button[name=add]');
    if (!button || button.disabled) return;
    const formData = window.fankeeCartSubmit?.consume(form) || new FormData(form);
    cardCartPending.add(form);
    const returnAddFocus = document.activeElement === button;
    const label = button.textContent;
    const feedback = form.querySelector('[data-card-feedback]');
    clearTimeout(cardFeedbackTimers.get(form));
    feedback.textContent = button.dataset.pendingLabel || '';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    form.setAttribute('aria-busy', 'true');
    button.textContent = button.dataset.pendingLabel;
    // Serialize mutations to prevent concurrent section responses from overwriting newer cart state.
    const operation = cardCartQueue.then(async () => {
      let added = false;
      try {
        const data = formData;
        const id = data.get('id');
        const quantity = Number(data.get('quantity') || 1);
        if (!Number.isInteger(quantity) || quantity < 1) throw Error('Invalid quantity');
        const properties = Object.fromEntries([...data].filter(([key]) => /^properties\[.+\]$/.test(key)).map(([key, value]) => [key.slice(11, -1), value]));
        if (!id || !/^\d+$/.test(String(id))) throw Error('Missing variant');
        const sectionId = document.querySelector('.storefront-header')?.dataset.cartSection;
        const bundled = form.hasAttribute('data-bundle-cart');
        let items = [{id: String(id), quantity, ...(data.get('selling_plan') ? {selling_plan: data.get('selling_plan')} : {}), ...(Object.keys(properties).length ? {properties} : {})}];
        if (bundled) {
          const ids = [...new Set(data.getAll('bundle_variant').map(String))];
          if (!ids.length || ids.length > 4 || ids.some(value => !/^\d+$/.test(value))) throw Error('Invalid bundle selection');
          items = ids.map(value => ({id: value, quantity: 1}));
        }
        const limited = items.some(item => [...form.querySelectorAll('[data-inventory-variant]')].some(node => node.dataset.inventoryVariant === item.id && (node.dataset.inventoryFinite === 'true' || node.dataset.inventoryRuleMax)));
        if (limited) {
          await loadInventoryCart();
          for (const item of items) {
            const node = [...form.querySelectorAll('[data-inventory-variant]')].find(node => node.dataset.inventoryVariant === item.id);
            if (node && item.quantity > inventoryRemaining(node)) throw Object.assign(Error('Inventory limit'), {inventoryMessage:inventoryMessage(node) || node.dataset.inventoryChanged});
          }
        }
        const body = {items, ...(sectionId ? {sections: [sectionId], sections_url: window.location.pathname + window.location.search} : {})};
        const response = await fetch(cartRoot() + 'cart/add.js', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin', body: JSON.stringify(body)});
        if (!response.ok) {
          const error = Error('Cart add rejected'); error.status = response.status;
          let rejection;try { rejection=await response.json(); } catch {}
          if (response.status===422) {
            // Shopify localizes 422 text, so any rejection re-syncs stock and cart lines from Shopify.
            // Only the refreshed limits (or recognizably stock-related text) select an inventory message.
            await refreshInventorySnapshot();
            const node = [...form.querySelectorAll('[data-inventory-variant]')].find(node => items.some(item => item.id===node.dataset.inventoryVariant && item.quantity>inventoryRemaining(node)));
            const stockText = /stock|inventory|sold out|can.t add more|cannot add more|only\s+\d+.*available|מלאי|אזל/i.test(String(rejection?.description||rejection?.message||''));
            if (node) error.inventoryMessage = inventoryMessage(node) || node.dataset.inventoryChanged;
            else if (stockText) error.inventoryMessage = form.querySelector('[data-inventory-variant]')?.dataset.inventoryChanged;
          }
          throw error;
        }
        added = !bundled;
        const result = await response.json();
        if (bundled && (!Array.isArray(result.items) || items.some(item => !result.items.some(line => String(line.variant_id || line.id) === item.id && Number(line.quantity) >= item.quantity)))) {
          throw Error('Incomplete bundle response');
        }
        added = true;
        const refreshed = await refreshCardCart(result.sections, sectionId);
        addFeedback(form, refreshed || !document.querySelector('.mini-cart-content') ? feedback.dataset.success : feedback.dataset.refreshError, !refreshed && !!document.querySelector('.mini-cart-content'));
      } catch (error) {
        if (window.Shopify?.designMode) console.warn('[Cart] AJAX add failed', {message: error.message, status: error.status});
        if (added) {
          const refreshed = await refreshCardCart(null, document.querySelector('.storefront-header')?.dataset.cartSection);
          addFeedback(form, refreshed ? feedback.dataset.success : feedback.dataset.refreshError, !refreshed);
        }
        else {
          if (form.hasAttribute('data-bundle-cart')) await refreshCardCart(null, document.querySelector('.storefront-header')?.dataset.cartSection);
          addFeedback(form, error.inventoryMessage || feedback.dataset.error, true);
        }
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        form.removeAttribute('aria-busy');
        button.textContent = label;
        cardCartPending.delete(form);
        syncInventory();
        document.dispatchEvent(new CustomEvent('storefront:cart:updated'));
        if(returnAddFocus && !button.disabled && document.activeElement===document.body) button.focus({preventScroll:true});

      }
    });
    cardCartQueue = operation.catch(() => {});
  }, true);
  // Back/forward cache restores a frozen DOM, so its badge and limits may predate cart changes made elsewhere.
  // Normal loads are already server-rendered from the current cart and are skipped.
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    const operation = cardCartQueue.then(async () => {
      // One page render refreshes stock and the header cart together; without limits on the page only the header is fetched.
      const doc = await refreshInventorySnapshot();
      if (doc && renderCardCartSection(doc)) { document.dispatchEvent(new CustomEvent('storefront:cart:updated')); return; }
      await refreshCardCart(null, document.querySelector('.storefront-header')?.dataset.cartSection);
      document.dispatchEvent(new CustomEvent('storefront:cart:updated'));
    });
    cardCartQueue = operation.catch(() => {});
  });
  window.fankeeCartSubmit?.ready();

  // Delegation keeps header controls working after Theme Editor section reloads.
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('.storefront-header .open-btn');
    const closer = event.target.closest('.storefront-header .menu-close');
    const cartToggle = event.target.closest('.storefront-header .cart-toggle-btn');
    const cartClose = event.target.closest('.storefront-header .mini-cart-close');
    const submenuToggle = event.target.closest('.storefront-header .submenu-toggle');
    if (opener || closer) {
      const header = (opener || closer).closest('.storefront-header');
      const menu = header.querySelector('.navigation-holder');
      const open = opener ? !menu.classList.contains('slideInn') : false;
      menu.classList.toggle('slideInn', open);
      header.querySelector('.open-btn').classList.toggle('x-close', open);
    } else if (cartToggle || cartClose) {
      const content = (cartToggle || cartClose).closest('.mini-cart').querySelector('.mini-cart-content');
      if (content.matches('dialog.cart-drawer')) { if (cartClose || content.open) closeCart(); else openCart(cartToggle); }
      else content.classList.toggle('mini-cart-content-toggle', cartClose ? false : !content.classList.contains('mini-cart-content-toggle'));
    } else if (event.target.matches('dialog.cart-drawer')) {
      const rect = event.target.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeCart();
    } else if (event.target.closest('[data-cart-continue]')) {
      closeCart();
    } else if (submenuToggle) {
      const open = submenuToggle.getAttribute('aria-expanded') !== 'true';
      navigationDisclosure(submenuToggle, open);
    } else {
      if (event.target.closest('.storefront-header .mini-cart-content, .storefront-header [data-mega-panel]')) event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // Share the add queue: server-rendered sections remain the sole source of cart state.
  function changeCart(control, quantity) {
    const panel = drawer();
    const line = control.closest('[data-cart-line]');
    const input = line?.querySelector('[data-cart-quantity]');
    if (!panel || !line || !input || drawerPending) return;
    if (!Number.isInteger(quantity) || (quantity !== 0 && (quantity < Number(input.min) || (input.max && quantity > Number(input.max)) || (quantity - Number(input.min)) % Number(input.step)))) {
      input.value = input.defaultValue; cartStatus(panel.dataset.cartError, true); return;
    }
    const focusedControl = document.activeElement;
    const restoreControl = line.contains(focusedControl);
    drawerPending = true;
    panel.setAttribute('aria-busy', 'true');
    const disabled = new Map([...panel.querySelectorAll('.cart-drawer__form button, .cart-drawer__form input')].map(el => [el, el.disabled]));
    disabled.forEach((_value, el) => { el.disabled = true; });
    cartStatus('');
    const key = line.dataset.cartLine;
    const operation = cardCartQueue.then(async () => {
      let changed = false;
      try {
        const sectionId = document.querySelector('.storefront-header').dataset.cartSection;
        const response = await fetch(cartRoot() + 'cart/change.js', {
          method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin',
          body: JSON.stringify({id: key, quantity, sections: [sectionId], sections_url: window.location.pathname + window.location.search})
        });
        if (!response.ok) throw Error('Cart change rejected');
        changed = true;
        const result = await response.json();
        const refreshed = await refreshCardCart(result.sections, sectionId);
        cartStatus(refreshed ? panel.dataset.cartUpdated : panel.dataset.cartStale, !refreshed);
      } catch {
        if (changed) await refreshCardCart(null, document.querySelector('.storefront-header').dataset.cartSection);
        input.value = input.defaultValue;
        cartStatus(changed ? panel.dataset.cartStale : panel.dataset.cartError, true);
      } finally {
        drawerPending = false;
        panel.removeAttribute('aria-busy');
        disabled.forEach((value, el) => { if (el.isConnected) el.disabled = value; });
        if (panel.open && restoreControl && (document.activeElement === document.body || document.activeElement === focusedControl)) {
          const nextLine = [...panel.querySelectorAll('[data-cart-line]')].find(item => item.dataset.cartLine === key);
          const selector = control.matches('[data-cart-quantity]') ? '[data-cart-quantity]' : control.matches('[data-cart-delta]') ? '[data-cart-delta="' + control.dataset.cartDelta + '"]' : '[data-cart-remove]';
          const next = nextLine?.querySelector(selector);
          (next && !next.disabled ? next : panel.querySelector('.mini-cart-close')).focus({preventScroll: true});
        }
      }
    });
    cardCartQueue = operation.catch(() => {});
  }
  document.addEventListener('click', event => {
    const control = event.target.closest('.cart-drawer [data-cart-delta], .cart-drawer [data-cart-remove]');
    if (!control) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (drawerPending || control.disabled) return;
    const input = control.closest('[data-cart-line]').querySelector('[data-cart-quantity]');
    changeCart(control, control.hasAttribute('data-cart-remove') ? 0 : Number(input.value) + Number(control.dataset.cartDelta) * Number(input.step));
  }, true);
  document.addEventListener('change', event => {
    if (event.target.matches('.cart-drawer [data-cart-quantity]')) changeCart(event.target, Number(event.target.value));
  });
  document.addEventListener('submit', event => {
    if (event.target.matches('.cart-drawer__form') && drawerPending) event.preventDefault();
  }, true);
  document.addEventListener('change', (event) => {
    if (event.target.closest('[data-product-page]')) return;
    if (!event.target.matches('[data-variant-select]') || !event.target.value) return;
    const url = new URL(window.location.href);
    url.searchParams.set('variant', event.target.value);
    window.location.assign(url.toString());
  });
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-quantity-change]');
    if (!button) return;
    const input = button.closest('[data-quantity-controls]').querySelector('input');
    if (Number(button.dataset.quantityChange) > 0) input.stepUp(); else input.stepDown();
    input.dispatchEvent(new Event('change', {bubbles: true}));
  });
  document.addEventListener('input', (event) => { if (event.target.matches('.storefront-validated-form input, .storefront-validated-form textarea, .storefront-validated-form select')) event.target.setCustomValidity(''); });
  document.addEventListener('invalid', (event) => {
    const input = event.target;
    if (!input.closest('.storefront-validated-form')) return;
    const strings = window.themeStrings;
    input.setCustomValidity('');
    if (input.validity.valueMissing) input.setCustomValidity(strings.required);
    else if (input.validity.typeMismatch && input.type === 'email') input.setCustomValidity(strings.invalidEmail);
    else if (input.type === 'number') input.setCustomValidity(strings.quantityError);
  }, true);
  function recommendations(root) {
    root.querySelectorAll('[data-product-recommendations]').forEach(async (section) => {
      if (section.dataset.loaded || !section.hidden) return;
      section.dataset.loaded = 'true';
      try {
        const response = await fetch(section.dataset.url);
        if (!response.ok) return;
        const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
        const content = doc.querySelector('[data-product-recommendations]');
        if (content && !content.hidden) { section.innerHTML = content.innerHTML; section.hidden = false; document.dispatchEvent(new CustomEvent('storefront:discovery:loaded', {detail: {section}})); }
      } catch { /* Hide the optional section when no recommendations are available. */ }
    });
  }
  const navigationMobile = window.matchMedia('(max-width: 991px)');
  const navigationTimers = new WeakMap();
  const navigationReady = new WeakSet();
  function placeNavigationPanel(button) {
    if (navigationMobile.matches) return;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    panel.style.setProperty('--mega-offset', '0px');
    const rect = panel.getBoundingClientRect();
    const offset = rect.x < 16 ? 16 - rect.x : rect.right > window.innerWidth - 16 ? window.innerWidth - 16 - rect.right : 0;
    panel.style.setProperty('--mega-offset', offset + 'px');
    panel.style.setProperty('--mega-available-height', Math.max(100, window.innerHeight - rect.y - 16) + 'px');
  }
  function navigationDisclosure(button, open, returnFocus = false) {
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    if (!panel) return;
    if (button.matches('[data-mega-trigger]') && open) {
      button.closest('.storefront-header').querySelectorAll('[data-mega-trigger]').forEach(other => { if (other !== button) navigationDisclosure(other, false); });
    }
    if (!open && button.matches('[data-mega-trigger]')) {
      const timers = navigationTimers.get(button.closest('[data-nav-disclosure]'));
      if (timers) { clearTimeout(timers.open); clearTimeout(timers.close); }
    }
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open && button.matches('[data-mega-trigger]')) placeNavigationPanel(button);
    if (!open && returnFocus) button.focus({preventScroll: true});
  }
  function closeNavigation(root = document, returnFocus = false) {
    root.querySelectorAll('[data-mega-trigger][aria-expanded=true]').forEach(button => navigationDisclosure(button, false, returnFocus));
  }
  function navigationMenus(root) {
    const normalizePath = path => { try { return decodeURI(path).replace(/\/$/, '') || '/'; } catch { return path; } };
    root.querySelectorAll('[data-mega-panel] a').forEach(link => {
      const rawHref = link.getAttribute('href') || '';
      const url = new URL(link.href, window.location.href);
      const current = rawHref !== '' && !rawHref.startsWith('#') && (link.getAttribute('aria-current') === 'page' || (url.origin === window.location.origin && normalizePath(url.pathname) === normalizePath(window.location.pathname) && (!url.search || url.search === window.location.search)));
      if (current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    root.querySelectorAll('[data-nav-disclosure]').forEach(item => item.querySelector('[data-mega-trigger]').classList.toggle('is-active', !!item.querySelector('a[aria-current=page]')));
    root.querySelectorAll('[data-nav-disclosure]').forEach(item => {
      if (navigationReady.has(item)) return;
      navigationReady.add(item);
      const button = item.querySelector('[data-mega-trigger]');
      const timers = {};
      navigationTimers.set(item, timers);
      item.addEventListener('pointerenter', event => {
        if (navigationMobile.matches || event.pointerType !== 'mouse') return;
        clearTimeout(timers.close);
        timers.open = setTimeout(() => navigationDisclosure(button, true), 160);
      });
      item.addEventListener('pointerleave', event => {
        if (navigationMobile.matches || event.pointerType !== 'mouse') return;
        clearTimeout(timers.open);
        timers.close = setTimeout(() => { if (!item.contains(document.activeElement)) navigationDisclosure(button, false); }, 220);
      });
      item.addEventListener('focusout', event => {
        if (event.relatedTarget && !item.contains(event.relatedTarget)) { clearTimeout(timers.open); clearTimeout(timers.close); navigationDisclosure(button, false); }
      });
    });
    root.querySelectorAll('[data-group-trigger]').forEach(button => {
      const list = document.getElementById(button.getAttribute('aria-controls'));
      list.hidden = navigationMobile.matches && button.getAttribute('aria-expanded') !== 'true';
    });
  }
  document.addEventListener('click', event => {
    const header = event.target.closest('.storefront-header');
    if (!header) closeNavigation();
    else if (event.target.closest('[data-mega-panel] a')) {
      closeNavigation(header);
      if (navigationMobile.matches) header.querySelector('.navigation-holder').classList.remove('slideInn');
    } else if (!event.target.closest('[data-nav-disclosure]')) closeNavigation(header);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    const item = event.target.closest('[data-nav-disclosure]');
    if (!item) return;
    const button = item.querySelector('[data-mega-trigger]');
    if (event.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') {
      event.preventDefault(); event.stopImmediatePropagation(); navigationDisclosure(button, false, true);
    } else if (event.key === 'ArrowDown' && event.target === button) {
      event.preventDefault(); navigationDisclosure(button, true); document.getElementById(button.getAttribute('aria-controls')).querySelector('a').focus();
    }
  }, true);
  navigationMobile.addEventListener('change', () => { closeNavigation(); navigationMenus(document); });
  window.addEventListener('resize', () => document.querySelectorAll('[data-mega-trigger][aria-expanded=true]').forEach(placeNavigationPanel));
  navigationMenus(document);
  document.addEventListener('shopify:section:load', event => navigationMenus(event.target));
  function menuState(root) {
    const menu = root.querySelector('.navigation-holder');
    const toggle = root.querySelector('.open-btn');
    if (!menu || !toggle) return;
    toggle.setAttribute('aria-controls', menu.id);
    const sync = () => {
      const open = menu.classList.contains('slideInn');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.classList.toggle('x-close', open);
    };
    new MutationObserver(sync).observe(menu, {attributes: true, attributeFilter: ['class']});
    sync();
  }
  function drawerState(root) {
    const header = root.querySelector('.storefront-header');
    if (!header) return;
    const menu = header.querySelector('.navigation-holder');
    const menuButton = header.querySelector('.open-btn');
    const cart = header.querySelector('.mini-cart-content');
    const cartButton = header.querySelector('.cart-toggle-btn');
    const mobile = window.matchMedia('(max-width: 991px)');
    function focusDrawer(drawer, button, selector, openClass) {
      const focus = () => {
        if (drawer.isConnected && drawer.classList.contains(openClass) && document.activeElement === button) drawer.querySelector(selector).focus({preventScroll: true});
      };
      requestAnimationFrame(focus);
      setTimeout(focus, 350); // Legacy drawer visibility transitions can defer focusability.
    }
    let wasMenuOpen = menu.classList.contains('slideInn');
    let wasCartOpen = cart.classList.contains('mini-cart-content-toggle');
    const sync = () => {
      const menuOpen = menu.classList.contains('slideInn');
      const cartOpen = cart.classList.contains('mini-cart-content-toggle');
      menu.inert = mobile.matches && !menuOpen;
      cart.inert = !cartOpen;
      cartButton.setAttribute('aria-expanded', String(cartOpen));
      if (mobile.matches && menuOpen && !wasMenuOpen) focusDrawer(menu, menuButton, '.menu-close', 'slideInn');
      if (cartOpen && !wasCartOpen) focusDrawer(cart, cartButton, '.mini-cart-close', 'mini-cart-content-toggle');
      if (!menuOpen && wasMenuOpen && menu.contains(document.activeElement)) menuButton.focus();
      if (!cartOpen && wasCartOpen && cart.contains(document.activeElement)) cartButton.focus();
      wasMenuOpen = menuOpen; wasCartOpen = cartOpen;
    };
    new MutationObserver(sync).observe(header, {subtree: true, attributes: true, attributeFilter: ['class']});
    mobile.addEventListener('change', sync);
    sync();
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    const header = document.querySelector('.storefront-header');
    if (!header) return;
    const cart = header.querySelector('.mini-cart-content');
    const menu = header.querySelector('.navigation-holder');
    if (cart.classList.contains('mini-cart-content-toggle')) {
      event.preventDefault();
      if (cart.matches('dialog.cart-drawer')) closeCart();
      else { cart.classList.remove('mini-cart-content-toggle'); header.querySelector('.cart-toggle-btn').focus(); }
    } else if (menu.classList.contains('slideInn')) {
      event.preventDefault(); menu.classList.remove('slideInn'); header.querySelector('.open-btn').focus();
    }
  });
  drawerState(document);
  document.addEventListener('shopify:section:load', event => drawerState(event.target));
  menuState(document);
  document.addEventListener('shopify:section:load', (event) => menuState(event.target));
  recommendations(document);
  document.addEventListener('shopify:section:load', (event) => recommendations(event.target));

  // Google review card: one-time entrance when it first scrolls into view. Content already on screen, reduced
  // motion, the accessibility pause and the Theme Editor show it immediately; CSS keeps it visible without JS.
  const reviewObservers = new WeakMap();
  function reviewReveal(scope) {
    for (const card of scope.querySelectorAll('[data-review-cta]')) {
      if (card.dataset.reviewReveal) continue;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-a11y-paused') || window.Shopify?.designMode;
      const rect = card.getBoundingClientRect();
      if (still || !('IntersectionObserver' in window) || (rect.top < window.innerHeight && rect.bottom > 0)) { card.dataset.reviewReveal = 'visible'; continue; }
      card.dataset.reviewReveal = 'pending';
      const observer = new IntersectionObserver(entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        card.dataset.reviewReveal = 'entered';
        observer.disconnect();
        reviewObservers.delete(card);
      }, {threshold: 0.2});
      observer.observe(card);
      reviewObservers.set(card, observer);
    }
  }
  reviewReveal(document);
  document.addEventListener('shopify:section:load', event => reviewReveal(event.target));
  document.addEventListener('shopify:section:unload', event => {
    for (const card of event.target.querySelectorAll('[data-review-cta]')) { reviewObservers.get(card)?.disconnect(); reviewObservers.delete(card); }
  });

  // Drawer order note: saved to cart.note when the field is committed, through the shared cart queue so it never
  // races quantity changes. The drawer form also posts the note with checkout.
  document.addEventListener('change', event => {
    const note = event.target;
    if (!(note instanceof HTMLTextAreaElement) || !note.matches('.cart-drawer [data-cart-note]')) return;
    const value = note.value;
    const operation = cardCartQueue.then(async () => {
      try {
        const response = await fetch(cartRoot() + 'cart/update.js', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin', body: JSON.stringify({note: value})});
        if (!response.ok) throw Error('Note rejected');
        if (note.isConnected && note.value === value) note.defaultValue = value;
      } catch { cartStatus(drawer()?.dataset.cartError || '', true); }
    });
    cardCartQueue = operation.catch(() => {});
  });

  // Back-in-stock requests (snippets/back-in-stock.liquid): one shared dialog posting Shopify's contact form.
  let backInStockOpener = null;
  const backInStockDialog = () => document.querySelector('[data-back-in-stock-dialog]');
  document.addEventListener('click', event => {
    const dialog = backInStockDialog();
    if (!dialog) return;
    const trigger = event.target.closest('[data-back-in-stock]');
    if (trigger) {
      event.preventDefault();
      const title = trigger.dataset.productTitle || '', url = trigger.dataset.productUrl || '';
      dialog.querySelector('[data-back-in-stock-product]').textContent = title;
      dialog.querySelector('[data-back-in-stock-field=title]').value = title;
      dialog.querySelector('[data-back-in-stock-field=url]').value = url;
      dialog.querySelectorAll('[data-back-in-stock-result]').forEach(node => node.remove());
      backInStockOpener = trigger;
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('input:not([type=hidden])')?.focus();
    } else if (event.target.closest('[data-back-in-stock-close]') || event.target === dialog) dialog.close();
  });
  document.addEventListener('close', event => {
    if (event.target !== backInStockDialog()) return;
    if (backInStockOpener?.isConnected) backInStockOpener.focus({preventScroll: true});
    backInStockOpener = null;
  }, true);
  // After Shopify reloads the page with the result, reopen the dialog to show it (only when it is ours).
  (() => {
    const dialog = backInStockDialog();
    const result = dialog?.querySelector('[data-back-in-stock-result]');
    if (!result) return;
    const ours = location.hash === '#BackInStockForm' || document.querySelectorAll('form[action$="/contact"], form[action*="/contact#"], form[action*="/contact?"]').length === 1;
    if (!ours) return;
    dialog.showModal();
    (result.matches('[role=alert]') ? dialog.querySelector('input:not([type=hidden])') : dialog.querySelector('[data-back-in-stock-close]'))?.focus();
  })();

  // Homepage shopping-assistant promo: shown only once the assistant is available; opens it through its launcher
  // and returns focus to the promo button when the panel closes.
  async function assistantPromo(root) {
    const promos = root.querySelectorAll('[data-assistant-promo]');
    if (!promos.length || !window.customElements) return;
    await customElements.whenDefined('fankee-shopping-assistant');
    const launcher = document.querySelector('fankee-shopping-assistant [data-launch]');
    if (!launcher || launcher.hidden) return;
    promos.forEach(promo => { promo.hidden = false; });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-open-shopping-assistant]');
    const assistant = document.querySelector('fankee-shopping-assistant');
    const launcher = assistant?.querySelector('[data-launch]');
    if (!button || !launcher || launcher.hidden) return;
    launcher.click();
    assistant.querySelector('dialog')?.addEventListener('close', () => setTimeout(() => { if (button.isConnected) button.focus({preventScroll: true}); }, 0), {once: true});
  });
  assistantPromo(document);
  document.addEventListener('shopify:section:load', event => assistantPromo(event.target));

  // Cart page suggestions add through the shared card flow; reload once afterwards so the cart table and totals
  // (server-rendered, not AJAX) show the new line.
  // Only a successful add (the server-rendered cart count changed) reloads; a failed add keeps its error visible.
  let cartSuggestionCount = null;
  const cartCount = () => document.querySelector('.storefront-header .cart-count')?.textContent.trim() ?? null;
  document.addEventListener('submit', event => { if (event.target.closest?.('[data-cart-recommendations]') && event.target.matches('[data-card-cart]')) cartSuggestionCount = cartCount(); }, true);
  document.addEventListener('storefront:cart:updated', () => {
    if (cartSuggestionCount === null) return;
    const changed = cartCount() !== cartSuggestionCount;
    cartSuggestionCount = null;
    if (changed && document.querySelector('[data-cart-recommendations]')) window.location.reload();
  });
})();
