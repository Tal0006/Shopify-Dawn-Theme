(() => {
  'use strict';

  // One delegated card handler also covers recommendations and Theme Editor reloads.
  const cardCartPending = new WeakSet();
  const cardFeedbackTimers = new WeakMap();
  let cardCartQueue = Promise.resolve();
  const cartRoot = () => window.Shopify?.routes?.root || (document.querySelector('form[data-card-cart]')?.action.replace(/cart\/add.*$/, '') || '/');
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
    if (!cartMobile.matches || !toast) { cardFeedback(form, message, error); return; }
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
  function renderCardCartSection(html) {
    if (typeof html !== 'string') return false;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fresh = doc.querySelector('.storefront-header .mini-cart');
    const current = document.querySelector('.storefront-header .mini-cart');
    const freshButton = fresh?.querySelector('.cart-toggle-btn');
    const freshItems = fresh?.querySelector('.mini-cart-items');
    const button = current?.querySelector('.cart-toggle-btn');
    const items = current?.querySelector('.mini-cart-items');
    if (!freshButton || !freshItems || !button || !items) return false;
    // Keep existing controls/drawer nodes and their focus observers; replace only server-rendered cart content.
    button.replaceChildren(...freshButton.childNodes);
    button.setAttribute('aria-label', freshButton.getAttribute('aria-label'));
    const focused = items.contains(document.activeElement) ? document.activeElement : null;
    const lineKey = focused?.closest('[data-cart-line]')?.dataset.cartLine;
    const action = focused?.matches('[data-cart-quantity]') ? '[data-cart-quantity]' : focused?.matches('[data-cart-remove]') ? '[data-cart-remove]' : focused?.matches('[data-cart-delta]') ? '[data-cart-delta="' + focused.dataset.cartDelta + '"]' : null;
    items.replaceChildren(...freshItems.childNodes);
    if (focused && drawer()?.open) {
      const line = [...items.querySelectorAll('[data-cart-line]')].find(item => item.dataset.cartLine === lineKey);
      const target = action && line?.querySelector(action);
      (target && !target.disabled ? target : drawer().querySelector('.mini-cart-close')).focus({preventScroll: true});
    }
    return true;
  }
  async function refreshCardCart(sections, sectionId) {
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
    const shouldOpenDrawer = !!drawer() && !cartMobile.matches;
    let drawerMessage = '';
    let drawerError = false;
    cardCartPending.add(form);
    const label = button.textContent;
    const feedback = form.querySelector('[data-card-feedback]');
    clearTimeout(cardFeedbackTimers.get(form));
    feedback.textContent = '';
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
        const body = {items, ...(sectionId ? {sections: [sectionId], sections_url: window.location.pathname + window.location.search} : {})};
        const response = await fetch(cartRoot() + 'cart/add.js', {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin', body: JSON.stringify(body)});
        if (!response.ok) { const error = Error('Cart add rejected'); error.status = response.status; throw error; }
        added = !bundled;
        const result = await response.json();
        if (bundled && (!Array.isArray(result.items) || items.some(item => !result.items.some(line => String(line.variant_id || line.id) === item.id && Number(line.quantity) >= item.quantity)))) {
          throw Error('Incomplete bundle response');
        }
        added = true;
        const refreshed = await refreshCardCart(result.sections, sectionId);
        if (shouldOpenDrawer) { drawerMessage = refreshed ? drawer().dataset.cartAdded : feedback.dataset.refreshError; drawerError = !refreshed; }
        else addFeedback(form, refreshed || !document.querySelector('.mini-cart-content') ? feedback.dataset.success : feedback.dataset.refreshError, !refreshed && !!document.querySelector('.mini-cart-content'));
      } catch (error) {
        if (window.Shopify?.designMode) console.warn('[Cart] AJAX add failed', {message: error.message, status: error.status});
        if (added) {
          const refreshed = await refreshCardCart(null, document.querySelector('.storefront-header')?.dataset.cartSection);
          if (shouldOpenDrawer) { drawerMessage = refreshed ? drawer()?.dataset.cartAdded : feedback.dataset.refreshError; drawerError = !refreshed; }
          else addFeedback(form, refreshed ? feedback.dataset.success : feedback.dataset.refreshError, !refreshed);
        }
        else {
          if (form.hasAttribute('data-bundle-cart')) await refreshCardCart(null, document.querySelector('.storefront-header')?.dataset.cartSection);
          addFeedback(form, feedback.dataset.error, true);
        }
      } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        form.removeAttribute('aria-busy');
        button.textContent = label;
        cardCartPending.delete(form);
        if (drawerMessage) {
          if (cartMobile.matches) addFeedback(form, drawerMessage, drawerError);
          else if (openCart(button)) cartStatus(drawerMessage, drawerError);
          else addFeedback(form, feedback.dataset.success);
        }
      }
    });
    cardCartQueue = operation.catch(() => {});
  }, true);
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
})();
