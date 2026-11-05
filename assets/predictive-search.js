(() => {
  'use strict';
  if (customElements.get('fankee-predictive-search')) return;
  class FankeePredictiveSearch extends HTMLElement {
    connectedCallback() {
      if (this.listeners) return;
      this.input = this.querySelector('input[name=q]');
      this.panel = this.querySelector('[data-search-panel]');
      this.results = this.querySelector('[data-search-results]');
      this.loading = this.querySelector('[data-search-loading]');
      this.status = this.querySelector('[data-search-status]');
      this.all = this.querySelector('[data-search-all]');
      if (!this.input || !this.panel || !this.results || !this.loading || !this.status || !this.all) return;
      this.listeners = new AbortController();
      this.cache = new Map(); this.sequence = 0; this.active = -1;
      this.listId = this.input.id + '-results';
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-autocomplete', 'list');
      this.input.setAttribute('aria-haspopup', 'listbox');
      this.input.setAttribute('aria-expanded', 'false');
      this.input.setAttribute('aria-controls', this.listId);
      this.input.setAttribute('autocomplete', 'off');
      this.ensureList();
      this.setAttribute('data-search-enhanced', '');
      this.clearButton = this.querySelector('[data-search-clear]');
      this.updateClear();
      try { this.nativeSupported = JSON.parse(document.getElementById('shopify-features')?.textContent || '{}').predictiveSearch !== false; }
      catch { this.nativeSupported = true; }
      const options = {signal: this.listeners.signal};
      this.input.addEventListener('input', event => { if (!event.isComposing) this.schedule(); }, options);
      this.input.addEventListener('compositionstart', () => { this.composing = true; this.cancel(); this.close(); }, options);
      this.input.addEventListener('compositionend', () => { this.composing = false; this.schedule(); }, options);
      this.input.addEventListener('focus', () => { if (!this.ignoreFocus && this.query().length >= 2) this.schedule(); }, options);
      this.clearButton?.addEventListener('click', () => {
        this.input.value = ''; this.input.dispatchEvent(new Event('input', {bubbles: true})); this.input.focus();
      }, options);
      this.addEventListener('keydown', event => this.keydown(event), options);
      this.addEventListener('focusout', event => {
        if (event.relatedTarget && this.contains(event.relatedTarget)) return;
        clearTimeout(this.blurTimer);
        // Native Tab focus can briefly be on body between focusout and focusin.
        this.blurTimer = setTimeout(() => { if (this.isConnected && !this.contains(document.activeElement)) { this.cancel(); this.close(); } }, 0);
      }, options);
      this.querySelector('form').addEventListener('submit', () => { this.cancel(); this.close(); }, options);
      document.addEventListener('pointerdown', event => { if (!this.contains(event.target)) { this.cancel(); this.close(); } }, options);
      window.addEventListener('resize', () => this.position(), options);
      window.visualViewport?.addEventListener('resize', () => this.position(), options);
      this.addEventListener('pointerover', event => {
        const option = event.target.closest('[role=option]');
        if (option) this.select(this.options().indexOf(option));
      }, options);
    }
    disconnectedCallback() {
      clearTimeout(this.blurTimer); this.cancel(); this.listeners?.abort(); this.listeners = null;
    }
    updateClear() { if (this.clearButton) this.clearButton.hidden = !this.input.value.length; }
    query() { return this.input.value.trim(); }
    options() { return [...this.results.querySelectorAll('[role=option]')]; }
    ensureList() {
      let list = this.results.querySelector('[role=listbox]');
      if (!list) { list = document.createElement('ul'); list.setAttribute('role', 'listbox'); list.className = 'predictive-search__list'; this.results.append(list); }
      list.id = this.listId;
      this.options().forEach((option, index) => { option.id = this.listId + '-' + index; option.setAttribute('aria-selected', 'false'); });
    }
    cancel() { clearTimeout(this.timer); this.timer = null; this.request?.abort(); this.request = null; this.sequence = (this.sequence || 0) + 1; }
    schedule() {
      this.updateClear(); this.cancel(); this.close(); this.select(-1);
      if (this.composing || [...this.query()].length < 2) { this.status.textContent = ''; return; }
      const query = this.query();
      const link = new URL(this.dataset.searchUrl, location.origin);
      link.searchParams.set('q', query); link.searchParams.set('type', 'product'); link.searchParams.set('options[prefix]', 'last');
      this.all.href = link.href;
      const sequence = this.sequence;
      this.timer = setTimeout(() => { this.timer = null; this.search(query, sequence); }, 150);
    }
    // Storefront-only request boundary. A future app-proxy adapter can replace it without UI changes.
    async fetchResults(query, signal, native = this.nativeSupported) {
      const url = new URL(native ? this.dataset.predictiveUrl : this.dataset.searchUrl, location.origin);
      if (url.origin !== location.origin) throw Error('Search must use this storefront');
      url.searchParams.set('q', query); url.searchParams.set('section_id', 'predictive-search');
      if (native) {
        url.searchParams.set('resources[type]', 'product'); url.searchParams.set('resources[limit]', '6');
        url.searchParams.set('resources[options][unavailable_products]', 'last');
      } else { url.searchParams.set('type', 'product'); url.searchParams.set('options[prefix]', 'last'); }
      const response = await fetch(url, {signal, credentials: 'same-origin', headers: {Accept: 'text/html'}});
      if (native && response.status === 417) { this.nativeSupported = false; return this.fetchResults(query, signal, false); }
      if (!response.ok) throw Error('Search unavailable');
      return response.text();
    }
    async search(query, sequence) {
      if (!this.isConnected || sequence !== this.sequence || query !== this.query()) return;
      this.results.replaceChildren(); this.ensureList();
      this.loading.hidden = false; this.results.setAttribute('aria-busy', 'true');
      this.status.textContent = this.dataset.loadingLabel; this.open();
      const controller = new AbortController(); this.request = controller;
      try {
        const html = this.cache.get(query) ?? await this.fetchResults(query, controller.signal);
        if (sequence !== this.sequence || query !== this.query() || !this.isConnected) return;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const fragment = doc.querySelector('[data-predictive-fragment]');
        if (!fragment) throw Error('Missing search fragment');
        // Only Shopify's server-rendered product fragment is inserted; never upstream HTML or raw query strings.
        this.results.replaceChildren(...fragment.childNodes); this.ensureList();
        if (this.cache.size >= 30) this.cache.delete(this.cache.keys().next().value);
        this.cache.set(query, html);
        const count = this.options().length;
        this.status.textContent = count ? this.dataset.countLabel.replace('__COUNT__', String(count)) : this.dataset.emptyLabel;
      } catch (error) {
        if (controller.signal.aborted || sequence !== this.sequence || !this.isConnected) return;
        this.results.replaceChildren(); this.ensureList();
        const message = document.createElement('p'); message.className = 'predictive-search__empty'; message.textContent = this.dataset.errorLabel;
        this.results.prepend(message); this.status.textContent = this.dataset.errorLabel;
      } finally {
        if (sequence === this.sequence && this.isConnected) {
          this.loading.hidden = true; this.results.removeAttribute('aria-busy'); this.request = null; this.position();
        }
      }
    }
    position() {
      if (!this.panel || this.panel.hidden) return;
      const viewport = window.visualViewport;
      const bottom = (viewport?.height || innerHeight) + (viewport?.offsetTop || 0);
      this.panel.style.setProperty('--predictive-available-height', Math.max(96, bottom - this.getBoundingClientRect().bottom - 20) + 'px');
    }
    open() { this.panel.hidden = false; this.input.setAttribute('aria-expanded', 'true'); this.position(); }
    close() { if (!this.panel) return; this.panel.hidden = true; this.input.setAttribute('aria-expanded', 'false'); this.status.textContent = ''; this.select(-1); }
    select(index) {
      this.active = index;
      const options = this.options();
      options.forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
      if (options[index]) { this.input.setAttribute('aria-activedescendant', options[index].id); options[index].scrollIntoView({block: 'nearest'}); }
      else this.input.removeAttribute('aria-activedescendant');
    }
    keydown(event) {
      if (event.isComposing || this.composing) return;
      if (event.key === 'Escape' && (!this.panel.hidden || this.request || this.timer)) {
        event.preventDefault(); this.cancel(); this.close(); this.ignoreFocus = true; this.input.focus(); this.ignoreFocus = false; return;
      }
      if (event.target !== this.input || this.panel.hidden) return;
      const options = this.options();
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
        event.preventDefault();
        const next = event.key === 'ArrowDown' ? (this.active + 1) % options.length : (this.active < 0 ? options.length - 1 : (this.active - 1 + options.length) % options.length);
        this.select(next);
      } else if (event.key === 'Enter' && options[this.active]) {
        event.preventDefault(); options[this.active].click();
      }
    }
  }
  customElements.define('fankee-predictive-search', FankeePredictiveSearch);
})();
