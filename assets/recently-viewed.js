(() => {
 'use strict';
 if (document.documentElement.hasAttribute('data-recently-viewed-ready')) return;
 document.documentElement.setAttribute('data-recently-viewed-ready', '');
 const key = 'fankee:recently-viewed:v1';
 const valid = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}-]{0,254}$/u.test(value);
 const requests = new Map();
 const controllers = new Map();
 const ready = new WeakSet();
 const history = () => {
  try {
   const value = JSON.parse(localStorage.getItem(key) || '[]');
   return Array.isArray(value) ? [...new Set(value.filter(valid))].slice(0, 10) : [];
  } catch { return []; }
 };
 async function initialize(section) {
  if (ready.has(section)) return;
  ready.add(section);
  const current = section.dataset.currentHandle;
  if (!valid(current)) return;
  const prior = history().filter(handle => handle !== current);
  try { localStorage.setItem(key, JSON.stringify([current, ...prior].slice(0, 10))); } catch { /* Storage can be disabled. */ }
  if (!prior.length) return;
  const controller = new AbortController();
  controllers.set(section, controller);
  try {
   const url = new URL(section.dataset.searchUrl, location.origin);
   if (url.origin !== location.origin) return;
   url.searchParams.set('q', prior.join('|'));
   url.searchParams.set('type', 'product');
   url.searchParams.set('section_id', section.dataset.sectionId);
   // One render request for the bounded list, not one request per product.
   let request = requests.get(url.href);
   if (!request) {
    request = fetch(url, {signal: controller.signal}).then(response => {
     if (!response.ok) throw new Error('History unavailable');
     return response.text();
    });
    requests.set(url.href, request);
   }
   const html = await request;
   if (controller.signal.aborted || !section.isConnected) return;
   const parsed = new DOMParser().parseFromString(html, 'text/html');
   const cards = parsed.querySelector('[data-recently-viewed] .product-discovery__grid');
   if (!cards) return;
   const target = section.querySelector('.product-discovery__grid');
   const seen = new Set();
   for (const handle of prior) {
    const card = [...cards.children].find(node => node.dataset.historyHandle === handle);
    if (!card || seen.has(handle)) continue;
    seen.add(handle);
    target.append(card);
   }
   if (!target.children.length) return;
   section.hidden = false;
   document.dispatchEvent(new CustomEvent('storefront:discovery:loaded', {detail: {section}}));
  } catch { /* Optional discovery fails closed without affecting purchase controls. */ }
  finally { controllers.delete(section); }
 }
 const setup = root => {
  if (root.matches?.('[data-recently-viewed]')) initialize(root);
  root.querySelectorAll('[data-recently-viewed]').forEach(initialize);
 };
 setup(document);
 document.addEventListener('shopify:section:load', event => setup(event.target));
 document.addEventListener('shopify:section:unload', event => {
  for (const [section, controller] of controllers) if (event.target.contains(section)) {
   controller.abort(); controllers.delete(section);
  }
 });
 window.addEventListener('pagehide', () => { controllers.forEach(controller => controller.abort()); controllers.clear(); }, {once: true});
})();
