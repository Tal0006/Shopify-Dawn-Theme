(() => {
 'use strict';
 const home = document.querySelector('[data-storefront-home]');
 if (!home || !('IntersectionObserver' in window)) return;
 const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
 const targets = '.storefront-hero-heading, .storefront-hero-subtitle, .hero-btn, .trust-strip__list, .catalog-section-header, .catalog-category, .catalog-home .catalog-card';
 let observer;
 const showAll = () => {
  observer?.disconnect();
  home.querySelectorAll('[data-storefront-reveal]').forEach(node => { node.dataset.storefrontReveal = 'visible'; });
 };
 const setup = (scope = home) => {
  if (reduced.matches || document.documentElement.hasAttribute('data-a11y-paused') || window.Shopify?.designMode) { showAll(); return; }
  observer ||= new IntersectionObserver(entries => {
   for (const entry of entries) if (entry.isIntersecting) {
    entry.target.dataset.storefrontReveal = 'visible';
    observer.unobserve(entry.target);
   }
  }, {threshold: 0.05});
  scope.querySelectorAll(targets).forEach(node => {
   if (node.hasAttribute('data-storefront-reveal')) return;
   const rect = node.getBoundingClientRect();
   // Above-the-fold content is never hidden after its initial paint.
   if (rect.top < innerHeight && rect.bottom > 0) { node.dataset.storefrontReveal = 'visible'; return; }
   node.dataset.storefrontReveal = 'pending';
   observer.observe(node);
  });
 };
 setup();
 reduced.addEventListener('change', () => { if (reduced.matches) showAll(); });
 const preferences = new MutationObserver(() => { if (document.documentElement.hasAttribute('data-a11y-paused')) showAll(); });
 preferences.observe(document.documentElement, {attributes: true, attributeFilter: ['data-a11y-paused']});
 document.addEventListener('shopify:section:load', event => { if (home.contains(event.target)) setup(event.target); });
 document.addEventListener('shopify:section:unload', event => {
  event.target.querySelectorAll('[data-storefront-reveal]').forEach(node => observer?.unobserve(node));
 });
 window.addEventListener('pagehide', () => { showAll(); preferences.disconnect(); }, {once: true});
})();
