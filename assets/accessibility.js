(() => {
  'use strict';
  const root = document.documentElement;
  const widget = document.querySelector('[data-accessibility-menu]');
  if (!widget) return;
  const panel = widget.querySelector('dialog');
  const launcher = widget.querySelector('.a11y-launcher');
  const status = widget.querySelector('[data-a11y-status]');
  const size = widget.querySelector('[data-a11y-size]');
  const key = 'punky-accessibility-v1';
  const defaults = {text: 0, contrast: false, grayscale: false, links: false, motion: false};
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  let storageAvailable = true;
  function normalize(value) {
    const safe = {...defaults};
    if (!value || typeof value !== 'object') return safe;
    if (Number.isInteger(value.text)) safe.text = Math.max(-2, Math.min(5, value.text));
    for (const mode of ['contrast', 'grayscale', 'links', 'motion']) safe[mode] = value[mode] === true;
    return safe;
  }
  function read() {
    try { return normalize(JSON.parse(localStorage.getItem(key))); }
    catch { return {...defaults}; }
  }
  let preferences = read();
  const sizedElements = new Set();
  function measure(scope = document.querySelector('.page-wrapper')) {
    if (!scope) return;
    const active = root.getAttribute('data-a11y-text');
    root.removeAttribute('data-a11y-text');
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const element = node.parentElement;
      if (!node.textContent.trim() || !element || element.closest('script, style, svg, .sr-only, [hidden]')) continue;
      if (!sizedElements.has(element)) {
        element.style.setProperty('--a11y-base-font', getComputedStyle(element).fontSize);
        element.setAttribute('data-a11y-scalable', '');
        sizedElements.add(element);
      }
    }
    scope.querySelectorAll('input:not([type=hidden]), select, textarea').forEach(element => {
      if (!sizedElements.has(element)) {
        element.style.setProperty('--a11y-base-font', getComputedStyle(element).fontSize);
        element.setAttribute('data-a11y-scalable', '');
        sizedElements.add(element);
      }
    });
    if (active !== null) root.setAttribute('data-a11y-text', active);
  }
  function motion() {
    const paused = preferences.motion || media.matches;
    root.toggleAttribute('data-a11y-paused', paused);
    if (window.jQuery) {
      window.jQuery.fx.off = paused;
      if (paused) {
        window.jQuery('html, body').stop(true);
        window.jQuery('.owl-carousel').trigger('stop.owl.autoplay');
      }
    }
    if (paused) document.querySelectorAll('video').forEach(video => {
      if (preferences.motion || video.autoplay) video.pause();
    });
  }
  function apply() {
    if (preferences.text) measure();
    root.style.setProperty('--a11y-text-scale', String(1 + preferences.text / 10));
    root.toggleAttribute('data-a11y-text', preferences.text !== 0);
    for (const mode of ['contrast', 'grayscale', 'links']) root.toggleAttribute('data-a11y-' + mode, preferences[mode]);
    document.querySelector('.a11y-grayscale-overlay').hidden = !preferences.grayscale;
    for (const mode of ['contrast', 'grayscale', 'links', 'motion']) widget.querySelector('[data-a11y-action="' + mode + '"]').setAttribute('aria-pressed', String(preferences[mode]));
    widget.querySelector('[data-a11y-action="increase"]').disabled = preferences.text >= 5;
    widget.querySelector('[data-a11y-action="decrease"]').disabled = preferences.text <= -2;
    size.textContent = size.dataset.template.replace('__PERCENT__', String(100 + preferences.text * 10));
    motion();
  }
  function save(reset = false) {
    try { if (reset) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(preferences)); }
    catch { storageAvailable = false; status.textContent = status.dataset.storage; }
  }
  function close(returnFocus = true) {
    if (!panel.open) return;
    panel.close();
    launcher.setAttribute('aria-expanded', 'false');
    if (returnFocus) launcher.focus({preventScroll: true});
  }
  launcher.hidden = false;
  launcher.addEventListener('click', () => {
    if (panel.open) return close();
    panel.show(); // Non-modal: normal Tab navigation remains available outside the panel.
    launcher.setAttribute('aria-expanded', 'true');
    panel.querySelector('[data-a11y-close]').focus({preventScroll: true});
  });
  panel.querySelector('[data-a11y-close]').addEventListener('click', () => close());
  panel.addEventListener('cancel', event => { event.preventDefault(); close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel.open) { event.preventDefault(); event.stopPropagation(); close(); }
  }, true);
  panel.addEventListener('focusout', event => {
    if (event.relatedTarget && !panel.contains(event.relatedTarget) && event.relatedTarget !== launcher) close(false);
  });
  document.addEventListener('click', event => {
    if (panel.open && !widget.contains(event.target)) close(false);
  });
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-a11y-action]');
    if (!button) return;
    const action = button.dataset.a11yAction;
    if (action === 'increase') preferences.text = Math.min(5, preferences.text + 1);
    else if (action === 'decrease') preferences.text = Math.max(-2, preferences.text - 1);
    else if (action === 'reset') preferences = {...defaults};
    else if (Object.hasOwn(defaults, action)) preferences[action] = !preferences[action];
    apply(); save(action === 'reset');
    if (action === 'reset' && storageAvailable) status.textContent = status.dataset.reset;
  });
  let resizeFrame;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { if (preferences.text) { sizedElements.clear(); measure(); } });
  });
  media.addEventListener('change', motion);
  window.addEventListener('load', motion);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preferences = read(); apply(); }
  });
  const main = document.querySelector('.page-wrapper');
  if (main) new MutationObserver(records => {
    if (preferences.text && records.some(record => record.addedNodes.length)) measure();
    motion();
  }).observe(main, {childList: true, subtree: true});
  document.addEventListener('shopify:section:load', () => { sizedElements.clear(); apply(); });
  apply();
})();
