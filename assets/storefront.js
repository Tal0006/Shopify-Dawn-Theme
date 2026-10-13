(() => {
  'use strict';
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
      content.classList.toggle('mini-cart-content-toggle', cartClose ? false : !content.classList.contains('mini-cart-content-toggle'));
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
  document.addEventListener('change', (event) => {
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
        if (content && !content.hidden) { section.innerHTML = content.innerHTML; section.hidden = false; }
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
      event.preventDefault(); cart.classList.remove('mini-cart-content-toggle'); header.querySelector('.cart-toggle-btn').focus();
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
