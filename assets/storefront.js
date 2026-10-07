(() => {
  'use strict';
  // Delegation keeps header controls working after Theme Editor section reloads.
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('.storefront-header .open-btn');
    const closer = event.target.closest('.storefront-header .menu-close');
    const cartToggle = event.target.closest('.storefront-header .cart-toggle-btn');
    const cartClose = event.target.closest('.storefront-header .mini-cart-close');
    const parentLink = event.target.closest('.storefront-header .menu-item-has-children > a');
    if (opener || closer) {
      const header = (opener || closer).closest('.storefront-header');
      const menu = header.querySelector('.navigation-holder');
      const open = opener ? !menu.classList.contains('slideInn') : false;
      menu.classList.toggle('slideInn', open);
      header.querySelector('.open-btn').classList.toggle('x-close', open);
    } else if (cartToggle || cartClose) {
      const content = (cartToggle || cartClose).closest('.mini-cart').querySelector('.mini-cart-content');
      content.classList.toggle('mini-cart-content-toggle', cartClose ? false : !content.classList.contains('mini-cart-content-toggle'));
    } else if (parentLink && window.matchMedia('(max-width: 991px)').matches) {
      const submenu = parentLink.parentElement.querySelector('.sub-menu');
      const visible = getComputedStyle(submenu).display !== 'none';
      submenu.style.display = visible ? 'none' : 'block';
      parentLink.classList.toggle('rotate', !visible);
    } else {
      if (event.target.closest('.storefront-header .mini-cart-content')) event.stopPropagation();
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
  menuState(document);
  document.addEventListener('shopify:section:load', (event) => menuState(event.target));
  recommendations(document);
  document.addEventListener('shopify:section:load', (event) => recommendations(event.target));
})();
