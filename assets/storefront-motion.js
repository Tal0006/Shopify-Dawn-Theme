(() => {
 'use strict';
 const home = document.querySelector('[data-storefront-home], [data-storefront-collection]') || (document.querySelector('[data-storefront-discovery]') && document);
 if (!home || !('IntersectionObserver' in window)) return;
 const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
 const targets = '.storefront-hero-heading, .storefront-hero-subtitle, .hero-btn, .trust-strip__list, .group-delivery-promo__surface, .catalog-section-header, .catalog-category, .catalog-home .catalog-card, .collection-page .catalog-card';
 let observer;
 const showAll = () => {
  observer?.disconnect();
  home.querySelectorAll('[data-storefront-reveal]').forEach(node => { node.dataset.storefrontReveal = 'visible'; });
 };
 // Positions come from the observer's first report (computed after layout), so setup never forces a reflow:
 // content on screen at that report is never hidden; content outside the viewport becomes pending (instant, no
 // transition, and off screen) and reveals when it scrolls in.
 const observed = new WeakSet();
 const setup = (scope = home) => {
  if (reduced.matches || document.documentElement.hasAttribute('data-a11y-paused') || window.Shopify?.designMode) { showAll(); return; }
  observer ||= new IntersectionObserver(entries => {
   // Items of one grid that arrive together reveal in a short stagger (max 200ms); the delay is then
   // cleared so it never slows hover transitions.
   const batch = new Map();
   for (const entry of entries) {
    const node = entry.target;
    if (!entry.isIntersecting) {
     if (!node.dataset.storefrontReveal) node.dataset.storefrontReveal = 'pending';
     continue;
    }
    if (node.dataset.storefrontReveal === 'pending') {
     const index = batch.get(node.parentElement) || 0;
     batch.set(node.parentElement, index + 1);
     if (index) {
      node.style.setProperty('--fk-reveal-delay', Math.min(index, 4) * 50 + 'ms');
      setTimeout(() => node.style.removeProperty('--fk-reveal-delay'), 700);
     }
    }
    node.dataset.storefrontReveal = 'visible';
    observer.unobserve(node);
   }
  }, {threshold: 0.05});
  scope.querySelectorAll(targets).forEach(node => {
   if (node.hasAttribute('data-storefront-reveal') || observed.has(node)) return;
   observed.add(node);
   observer.observe(node);
  });
 };
 document.addEventListener('storefront:discovery:loaded', event => setup(event.detail.section));
 setup();
 reduced.addEventListener('change', () => { if (reduced.matches) showAll(); });
 const preferences = new MutationObserver(() => { if (document.documentElement.hasAttribute('data-a11y-paused')) showAll(); });
 preferences.observe(document.documentElement, {attributes: true, attributeFilter: ['data-a11y-paused']});
 document.addEventListener('shopify:section:load', event => { if (home.contains(event.target)) setup(event.target); });
 document.addEventListener('shopify:section:unload', event => {
  event.target.querySelectorAll(targets).forEach(node => observer?.unobserve(node));
 });
 window.addEventListener('pagehide', () => { showAll(); preferences.disconnect(); }, {once: true});
})();
