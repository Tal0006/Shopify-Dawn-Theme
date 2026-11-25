// In-page subcategories (snippets/category-chips.liquid): choosing a chip replaces the products shown in its section
// without leaving the page. The chips stay real links, so they work without JavaScript and in a new tab.
// - Collection page: the same section, rendered by Shopify for the chosen collection (filters, sorting and pages included).
// - Homepage row: sections/category-products.liquid, shown in steps of the row's own size.
// The page URL never changes. The choice is kept in history.state, so it survives reload and Back from a product.
(() => {
  'use strict';
  const CACHE_MS = 120000, TIMEOUT_MS = 20000;
  const states = new WeakMap();
  const cache = new Map();
  // Once the cart changed, counts printed in kept or cached cards may be old: storefront.js then takes them from the cart.
  let cartChanged = false;
  document.addEventListener('storefront:cart:updated', () => { cartChanged = true; cache.clear(); });

  const clean = href => { const url = new URL(href, location.href); url.searchParams.delete('section_id'); url.hash = ''; return url; };
  const address = url => url.pathname + url.search;
  const carried = search => [...new URLSearchParams(search)].filter(([name]) => name === 'sort_by' || name.startsWith('filter.'));
  const remembered = () => history.state?.fankeeSubcategories || {};

  function remember(state, url) {
    const all = {...remembered()};
    if (url) all[state.id] = url; else delete all[state.id];
    try { history.replaceState({...history.state, fankeeSubcategories: all}, ''); } catch { /* Only the memory is lost. */ }
  }

  function setup(root) {
    if (states.has(root)) return states.get(root);
    const results = root.querySelector('[data-subcategory-results]');
    const chips = [...root.querySelectorAll('[data-subcategory]')];
    if (!results || !chips.length) return null;
    const row = root.dataset.subcategoryMode === 'row';
    const start = chips.find(chip => chip.hasAttribute('aria-current'));
    const state = {root, results, chips, row, id: root.dataset.subcategoryRoot, selected: start, active: null, original: null, start: start ? clean(start.href) : clean(location.href), header: root.querySelector('[data-subcategory-header]'), count: root.querySelector('[data-subcategory-count]'), status: root.querySelector('[data-subcategory-status]'), error: root.querySelector('[data-subcategory-error]'), request: null, retry: null, queue: [], next: ''};
    if (!row) state.start.search = new URLSearchParams(carried(location.search)).toString();
    chips.forEach(chip => {
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-controls', results.id);
      // The link is not followed any more, so the browser must not prefetch its page (snippets/page-navigation.liquid).
      chip.setAttribute('data-no-prefetch', '');
      chip.removeAttribute('aria-current');
    });
    states.set(root, state);
    press(state, start);
    const saved = remembered()[state.id];
    if (saved) {
      const url = clean(saved), chip = chips.find(item => clean(item.href).pathname === url.pathname);
      if (chip && url.origin === location.origin) void show(state, url, {chip, quiet: true});
    }
    return state;
  }

  function press(state, chip) {
    state.selected = chip;
    state.chips.forEach(item => item.setAttribute('aria-pressed', String(item === chip)));
    const list = chip?.closest('.category-chips');
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const box = list.getBoundingClientRect(), item = chip.getBoundingClientRect();
    if (item.left < box.left) list.scrollBy({left: item.left - box.left - 16}); else if (item.right > box.right) list.scrollBy({left: item.right - box.right + 16});
  }

  const say = (state, text) => { if (state.status) state.status.textContent = text; };

  async function load(state, url) {
    const key = address(url) + '|' + state.id, saved = cache.get(key);
    if (saved && Date.now() - saved.time < CACHE_MS) return saved.html;
    const target = new URL(url), section = state.root.dataset.subcategorySection;
    target.searchParams.set('section_id', section);
    const request = state.request, timer = setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(target, {headers: {Accept: 'text/html'}, credentials: 'same-origin', signal: request.signal});
      if (!response.ok) throw Error('Subcategory unavailable');
      let html = await response.text();
      // One product can appear in two homepage rows: give this row's cards their own form ids.
      if (state.row) html = html.replaceAll('CardProductForm-' + section + '-', 'CardProductForm-' + state.id + '-sub-');
      cache.set(key, {html, time: Date.now()});
      return html;
    } finally { clearTimeout(timer); }
  }

  function read(state, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const part = doc.querySelector('[data-subcategory-results]');
    if (!part) throw Error('Subcategory section missing');
    doc.querySelectorAll('a[href*="section_id="]').forEach(link => link.setAttribute('href', address(clean(link.getAttribute('href')))));
    part.querySelectorAll('.catalog-pagination a, .catalog-active-filters a, .collection-page__empty a').forEach(link => link.setAttribute('data-no-prefetch', ''));
    return {doc, part};
  }

  function refreshed(state) {
    if (cartChanged) state.results.querySelectorAll('[data-inventory-cart]').forEach(node => { node.dataset.inventoryCart = '0'; });
    document.dispatchEvent(new CustomEvent('storefront:discovery:loaded', {detail: {section: state.results}}));
  }

  function keepOriginal(state) {
    state.original ||= {nodes: [...state.results.childNodes], header: state.header ? [...state.header.childNodes] : null, className: state.header?.className, count: state.count?.textContent};
  }

  function restore(state) {
    if (!state.original) return;
    state.results.replaceChildren(...state.original.nodes);
    if (state.header) { state.header.replaceChildren(...state.original.header); state.header.className = state.original.className; }
    if (state.count) state.count.textContent = state.original.count;
    state.active = null; state.queue = []; state.next = '';
    refreshed(state);
  }

  // Homepage rows show one step of cards; the rest wait in the queue, and further pages are fetched only when needed.
  function step(state, grid) {
    grid.querySelector('[data-subcategory-more]')?.remove();
    const cards = state.queue.splice(0, Number(state.root.dataset.subcategoryLimit) || 8);
    grid.append(...cards);
    const left = state.total - grid.querySelectorAll('.catalog-card').length;
    if (left > 0 && (state.queue.length || state.next)) {
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'catalog-more'; more.dataset.subcategoryMore = '';
      const count = document.createElement('span'), text = document.createElement('span');
      count.className = 'catalog-more__count'; count.textContent = (left === 1 ? state.status.dataset.moreOne : state.status.dataset.moreOther.replace('__COUNT__', String(left)));
      text.className = 'catalog-more__text'; text.textContent = state.status.dataset.more;
      more.append(count, ' ', text); grid.append(more);
    }
    return cards[0];
  }

  function render(state, html) {
    const {doc, part} = read(state, html);
    keepOriginal(state);
    state.total = Number(part.dataset.resultsCount) || 0;
    if (state.row) {
      const grid = part.querySelector('.catalog-grid');
      state.queue = grid ? [...grid.querySelectorAll(':scope > .catalog-card')] : [];
      state.next = part.dataset.resultsNext || '';
      state.queue.forEach(card => card.remove());
      if (grid && state.queue.length) step(state, grid);
      if (state.count) state.count.textContent = part.dataset.resultsText || '';
    } else if (state.header) {
      const header = doc.querySelector('.collection-page__header');
      if (header) { state.header.className = header.className; state.header.replaceChildren(...header.childNodes); }
    }
    state.results.replaceChildren(...part.childNodes);
    refreshed(state);
  }

  function busy(state, on) {
    state.root.toggleAttribute('data-subcategory-loading', on);
    if (on) state.results.setAttribute('aria-busy', 'true'); else state.results.removeAttribute('aria-busy');
  }

  function fail(state, retry) {
    state.retry = retry;
    if (state.error) state.error.hidden = false;
    say(state, '');
  }

  // Shows one view. `chip` is the subcategory it belongs to; `toTop` is used for page links, which start at the top.
  async function show(state, url, {chip = state.selected, quiet = false, toTop = false} = {}) {
    const key = address(url), previous = state.selected;
    if (key === (state.active || address(state.start)) && !state.root.hasAttribute('data-subcategory-loading')) { press(state, chip); return; }
    state.request?.abort();
    const request = state.request = new AbortController();
    if (state.error) state.error.hidden = true;
    press(state, chip);
    if (key === address(state.start) && chip === state.chips.find(item => clean(item.href).pathname === state.start.pathname)) {
      restore(state); busy(state, false); remember(state, '');
      say(state, state.status?.dataset.loaded.replace('__NAME__', chip?.dataset.subcategory || '') || '');
      return;
    }
    busy(state, true);
    if (!quiet) say(state, state.status?.dataset.loading || '');
    try {
      const html = await load(state, url);
      if (state.request !== request) return;
      render(state, html);
      state.active = key;
      remember(state, key);
      const grid = state.results.querySelector('.catalog-grid');
      if (grid) grid.scrollLeft = 0;
      if (!quiet) say(state, (state.status?.dataset.loaded || '').replace('__NAME__', chip?.dataset.subcategory || '') + (state.total ? ' (' + state.total + ')' : ''));
      if (toTop) {
        const target = state.results.querySelector('.collection-page__count');
        target?.setAttribute('tabindex', '-1');
        target?.focus({preventScroll: true});
        state.results.scrollIntoView({block: 'start'});
      }
    } catch (error) {
      if (state.request !== request) return;
      // The products on screen did not change, so the chip goes back to the one they belong to.
      const shown = state.active ? new URL(state.active, location.href) : state.start;
      press(state, state.chips.find(item => clean(item.href).pathname === shown.pathname) || previous);
      fail(state, () => show(state, url, {chip, toTop}));
      if (quiet) remember(state, state.active || '');
    } finally {
      if (state.request === request) busy(state, false);
    }
  }

  async function more(state, button) {
    if (button.hasAttribute('aria-busy')) return;
    button.setAttribute('aria-busy', 'true');
    const grid = button.closest('.catalog-grid'), request = state.request = new AbortController();
    try {
      if (!state.queue.length && state.next) {
        const {part} = read(state, await load(state, clean(state.next)));
        if (state.request !== request) return;
        state.queue = [...part.querySelectorAll('.catalog-grid > .catalog-card')];
        state.queue.forEach(card => card.remove());
        state.next = part.dataset.resultsNext || '';
      }
      if (state.error) state.error.hidden = true;
      const first = step(state, grid);
      refreshed(state);
      first?.querySelector('h2 a, h3 a')?.focus({preventScroll: false});
    } catch {
      if (state.request !== request) return;
      button.removeAttribute('aria-busy');
      fail(state, () => more(state, button));
    }
  }

  const rootOf = node => { const root = node.closest?.('[data-subcategory-root]'); return root ? states.get(root) || setup(root) : null; };
  const plain = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

  document.addEventListener('click', event => {
    const state = event.target instanceof Element && rootOf(event.target);
    if (!state || event.defaultPrevented || !plain(event)) return;
    const chip = event.target.closest('[data-subcategory]');
    if (chip) {
      event.preventDefault();
      const url = clean(chip.href);
      // Filters and sorting the shopper chose on a collection page stay on when switching.
      if (!state.row) for (const [name, value] of carried(state.active ? new URL(state.active, location.href).search : state.start.search)) url.searchParams.append(name, value);
      void show(state, url, {chip});
      return;
    }
    if (event.target.closest('[data-subcategory-retry]')) {
      const retry = state.retry; state.retry = null;
      state.chips.find(item => item === state.selected)?.focus({preventScroll: true});
      void retry?.();
      return;
    }
    const button = event.target.closest('[data-subcategory-more]');
    if (button) { void more(state, button); return; }
    // Page, sort and filter links of the subcategory on screen.
    const link = event.target.closest('a[href]');
    if (!link || !state.active || state.row || !state.results.contains(link) || link.target) return;
    const url = clean(link.href);
    if (url.origin !== location.origin || url.pathname !== new URL(state.active, location.href).pathname) return;
    event.preventDefault();
    void show(state, url, {toTop: true});
  });

  document.addEventListener('keydown', event => {
    if (event.key !== ' ' || !(event.target instanceof Element) || !event.target.matches('[data-subcategory][role=button]')) return;
    event.preventDefault();
    if (!event.repeat) event.target.click();
  });

  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.catalog-filters')) return;
    const state = rootOf(form);
    if (!state?.active || state.row || !state.results.contains(form)) return;
    const url = clean(form.action);
    url.search = '';
    for (const [name, value] of new FormData(form)) if (value !== '') url.searchParams.append(name, String(value));
    event.preventDefault();
    void show(state, url, {toTop: true});
  });

  const init = scope => {
    if (scope.matches?.('[data-subcategory-root]')) setup(scope);
    scope.querySelectorAll('[data-subcategory-root]').forEach(setup);
  };
  init(document);
  document.addEventListener('shopify:section:load', event => init(event.target));
  document.addEventListener('shopify:section:unload', event => event.target.querySelectorAll('[data-subcategory-root]').forEach(root => states.get(root)?.request?.abort()));
})();
