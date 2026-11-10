(() => {
  'use strict';
  if (customElements.get('fankee-shopping-assistant')) return;
  class ShoppingAssistant extends HTMLElement {
    connectedCallback() {
      if (this.lifecycle) return;
      this.lifecycle = new AbortController();
      this.find = selector => this.querySelector(selector);
      this.strings = JSON.parse(this.find('[data-strings]').textContent);
      this.dialog = this.find('dialog');
      this.launcher = this.find('[data-launch]');
      this.input = this.find('textarea');
      this.status = this.find('[data-status]');
      this.results = this.find('[data-results]');
      this.form = this.find('form');
      this.summary = this.find('[data-summary]');
      this.confirmation = this.find('[data-confirm]');
      try {
        this.apiBase = new URL(this.dataset.apiBase);
        if (this.apiBase.protocol !== 'https:' || this.apiBase.username || this.apiBase.password) return;
        this.apiBase = this.apiBase.origin;
      } catch { return; }
      this.launcher.hidden = false;
      this.addEventListener('click', event => this.click(event), {signal: this.lifecycle.signal});
      this.form.addEventListener('submit', event => {
        event.preventDefault();
        if (this.form.reportValidity()) this.loadQuote();
      }, {signal: this.lifecycle.signal});
      this.dialog.addEventListener('keydown', event => {
        if (event.key !== 'Tab') return;
        const controls = [...this.dialog.querySelectorAll('button:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter(element => element.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) ||
          !this.dialog.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }, {signal: this.lifecycle.signal});
      this.dialog.addEventListener('close', () => {
        this.launcher.setAttribute('aria-expanded', 'false');
        document.documentElement.style.overflow = this.savedOverflow || '';
        window.scrollTo({top: this.scrollY, behavior: 'instant'});
        this.launcher.focus({preventScroll: true});
      }, {signal: this.lifecycle.signal});
      this.dialog.addEventListener('click', event => {
        if (event.target !== this.dialog) return;
        const rect = this.dialog.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.dialog.close();
      }, {signal: this.lifecycle.signal});
      const reposition = () => {
        cancelAnimationFrame(this.positionFrame);
        this.positionFrame = requestAnimationFrame(() => this.positionLauncher());
      };
      window.addEventListener('resize', reposition, {signal: this.lifecycle.signal});
      window.addEventListener('scroll', reposition, {passive: true, signal: this.lifecycle.signal});
      this.resizeObserver = new ResizeObserver(reposition);
      this.resizeObserver.observe(document.body);
      this.positionLauncher();
    }
    disconnectedCallback() {
      if (this.dialog?.open) this.dialog.close();
      this.lifecycle?.abort();
      this.requestController?.abort();
      this.resizeObserver?.disconnect();
      cancelAnimationFrame(this.positionFrame);
      clearTimeout(this.wakeTimer);
      clearTimeout(this.timeoutTimer);
      this.lifecycle = null;
    }
    positionLauncher() {
      this.style.removeProperty('--sa-launch-bottom');
      const obstacles = [...document.querySelectorAll('.a11y-launcher, [data-store-whatsapp], [class*="whatsapp"], [data-cart-toast], .product-sticky-atc, [data-sticky-atc], .back-to-top')];
      // Only fixed/sticky controls can overlap the floating launcher.
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (const element of obstacles) {
          if (element.hidden || !['fixed', 'sticky'].includes(getComputedStyle(element).position)) continue;
          const rect = element.getBoundingClientRect(), button = this.launcher.getBoundingClientRect();
          if (rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight &&
            rect.left < button.right + 8 && rect.right > button.left - 8 && rect.top < button.bottom + 8 && rect.bottom > button.top - 8) {
            this.style.setProperty('--sa-launch-bottom', Math.max(84, innerHeight - rect.top + 12) + 'px');
            moved = true;
          }
        }
        if (!moved) break;
      }
    }
    text(key) { return this.strings[key] || ''; }
    element(tag, text, className) {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    announce(key) { this.status.textContent = this.text(key); }
    busyState(busy) {
      this.busy = busy;
      this.find('.shopping-assistant__shell').setAttribute('aria-busy', String(busy));
      this.querySelectorAll('button:not([data-close]):not([data-launch])').forEach(button => { button.disabled = busy || button.dataset.unavailable === 'true'; });
      this.input.disabled = busy;
      this.find('[data-review]').disabled = busy || this.locked || this.quote?.canCheckout !== true;
      this.find('[data-confirm-checkout]').disabled = busy || this.locked || this.quote?.canCheckout !== true;
    }
    async request(route, body) {
      this.requestController = new AbortController();
      this.timeoutTimer = setTimeout(() => this.requestController.abort(), 90000);
      this.wakeTimer = setTimeout(() => this.announce('waking'), 12000);
      try {
        const response = await fetch(this.apiBase + '/api/v1/shopping-list/' + route, {
          method: 'POST', credentials: 'omit', redirect: 'error',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
          signal: this.requestController.signal
        });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error('Assistant request failed');
          error.code = data.code;
          error.quote = data.quote;
          throw error;
        }
        return data;
      } finally {
        clearTimeout(this.timeoutTimer);
        clearTimeout(this.wakeTimer);
      }
    }
    acceptQuote(quote) {
      if (!quote || typeof quote.quoteId !== 'string' || !Number.isInteger(quote.revision) ||
        !Array.isArray(quote.items) || !Array.isArray(quote.resolvedItems)) throw Error('Invalid quote');
      this.quote = quote;
      this.locked = false;
      this.form.hidden = true;
      this.results.hidden = false;
      this.confirmation.hidden = true;
      this.summary.hidden = false;
      this.renderQuote();
      this.announce('results');
      if (this.dialog.open) this.results.focus({preventScroll: true});
    }
    handleError(error, checkout = false) {
      if (error.code === 'QUOTE_CHANGED' && error.quote) {
        this.acceptQuote(error.quote);
        this.announce('changed');
      } else if (checkout) {
        this.locked = true;
        this.confirmation.hidden = true;
        this.results.hidden = false;
        this.announce(error.code === 'QUOTE_EXPIRED' ? 'expired' : 'uncertain');
      } else {
        this.announce(error.code === 'QUOTE_EXPIRED' ? 'expired' : 'error');
      }
    }
    async loadQuote() {
      if (this.busy) return;
      this.quote = null;
      this.locked = true;
      this.results.hidden = true;
      this.confirmation.hidden = true;
      this.summary.hidden = true;
      this.busyState(true);
      this.announce('loading');
      try { this.acceptQuote(await this.request('quote', {message: this.input.value})); }
      catch (error) { this.form.hidden = false; this.handleError(error); }
      finally { this.busyState(false); }
    }
    edit(index) {
      if (this.busy) return;
      if (this.quote) this.input.value = this.quote.items.map(item => item.requested.originalText).join('\n');
      this.quote = null;
      this.form.hidden = false;
      this.results.hidden = true;
      this.confirmation.hidden = true;
      this.summary.hidden = true;
      this.status.textContent = '';
      this.input.focus();
      if (Number.isInteger(index)) {
        const lines = this.input.value.split('\n'), start = lines.slice(0, index).reduce((n, line) => n + line.length + 1, 0);
        this.input.setSelectionRange(start, start + lines[index].length);
      }
    }
    purchasable(product) {
      const count = product.quantity;
      return product.availableForSale && !product.requiresSellingPlan && !product.requiresComponents &&
        count >= product.minimum && (product.maximum === null || count <= product.maximum) &&
        (count - product.minimum) % product.increment === 0;
    }
    money(value) {
      if (!value || typeof value.amount !== 'string' || !/^[0-9]+(?:\.[0-9]+)?$/.test(value.amount)) return '?';
      try { return new Intl.NumberFormat(document.documentElement.lang || 'he', {style: 'currency', currency: value.currencyCode}).format(Number(value.amount)); }
      catch { return '?'; }
    }
    productCard(product, itemIndex, choose = false) {
      const card = this.element('div', '', 'shopping-assistant__card');
      try {
        const url = new URL(product.imageUrl);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const image = this.element('img');
          image.src = url.href; image.alt = product.title;
          image.width = 64; image.height = 76; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
          image.addEventListener('error', () => image.remove(), {once: true});
          card.append(image);
        }
      } catch { /* An image is optional. */ }
      const details = this.element('div');
      details.append(this.element('strong', product.title));
      if (product.variantTitle && product.variantTitle.toLowerCase() !== 'default title') details.append(this.element('p', product.variantTitle));
      details.append(this.element('p', this.text('quantity') + ': ' + product.quantity));
      details.append(this.element('p', this.money(product.unitPrice) + ' ' + this.text('unit')));
      details.append(this.element('p', this.money(product.lineTotal)));
      const available = this.purchasable(product);
      details.append(this.element('p', this.text(available ? 'available' : 'unavailable_short')));
      if (choose) {
        const button = this.element('button', this.text('choose') + ': ' + product.title);
        button.type = 'button'; button.dataset.choose = String(itemIndex); button.dataset.variant = product.variantId;
        button.dataset.unavailable = String(!available); button.disabled = !available;
        details.append(button);
      }
      card.append(details);
      return card;
    }
    renderQuote() {
      this.results.replaceChildren();
      this.quote.items.forEach((item, index) => {
        const article = this.element('section', '', 'shopping-assistant__item');
        article.append(this.element('h3', item.requested.originalText));
        article.append(this.element('p', this.text(item.status)));
        if (item.status === 'matched' && item.bestMatch) article.append(this.productCard(item.bestMatch, index));
        else if (['ambiguous', 'unavailable'].includes(item.status)) {
          (item.candidates || []).forEach(product => article.append(this.productCard(product, index, item.status === 'ambiguous')));
        }
        if (item.status !== 'matched') {
          const actions = this.element('div', '', 'shopping-assistant__actions');
          for (const action of ['edit_item', 'remove']) {
            const button = this.element('button', this.text(action));
            button.type = 'button'; button.dataset[action === 'remove' ? 'remove' : 'editItem'] = String(index);
            actions.append(button);
          }
          article.append(actions);
        }
        this.results.append(article);
      });
      this.find('[data-total]').textContent = this.money(this.quote.subtotal);
      this.find('[data-blocked]').hidden = this.quote.canCheckout === true;
      this.busyState(this.busy);
    }
    async choose(index, variantId) {
      if (this.busy || !this.quote) return;
      this.busyState(true);
      this.announce('loading');
      try {
        this.acceptQuote(await this.request('resolve', {quoteId: this.quote.quoteId, revision: this.quote.revision, itemIndex: index, variantId}));
      } catch (error) { this.handleError(error); }
      finally { this.busyState(false); }
    }
    async checkout() {
      if (this.busy || this.locked || !this.quote?.canCheckout || this.confirmation.hidden) return;
      this.busyState(true);
      this.announce('loading');
      try {
        const result = await this.request('checkout', {
          quoteId: this.quote.quoteId, revision: this.quote.revision, confirmed: true,
          lines: this.quote.resolvedItems.map(product => ({variantId: product.variantId, quantity: product.quantity}))
        });
        const url = new URL(result.checkoutUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid checkout');
        window.location.assign(url.href);
      } catch (error) { this.handleError(error, true); }
      finally { this.busyState(false); }
    }
    click(event) {
      const button = event.target.closest('button');
      if (!button || !this.contains(button) || button.disabled) return;
      if (button.hasAttribute('data-launch')) {
        if (!this.dialog.open) {
          this.scrollY = window.scrollY;
          this.savedOverflow = document.documentElement.style.overflow;
          this.dialog.showModal();
          document.documentElement.style.overflow = 'hidden';
          this.launcher.setAttribute('aria-expanded', 'true');
          (this.form.hidden ? this.results : this.input).focus({preventScroll: true});
        }
      } else if (button.hasAttribute('data-close')) this.dialog.close();
      else if (this.busy) return;
      else if (button.hasAttribute('data-edit')) this.edit();
      else if (button.hasAttribute('data-edit-item')) this.edit(Number(button.dataset.editItem));
      else if (button.hasAttribute('data-remove') && this.quote) {
        const lines = this.quote.items.filter((_, index) => index !== Number(button.dataset.remove)).map(item => item.requested.originalText);
        this.input.value = lines.join('\n');
        if (lines.length) this.loadQuote(); else { this.quote = null; this.edit(); }
      } else if (button.hasAttribute('data-choose')) this.choose(Number(button.dataset.choose), button.dataset.variant);
      else if (button.hasAttribute('data-review') && this.quote?.canCheckout && !this.locked) {
        this.results.hidden = true;
        this.confirmation.hidden = false;
        this.find('[data-confirm-summary]').textContent = this.text('subtotal') + ': ' + this.money(this.quote.subtotal);
        this.confirmation.focus();
      } else if (button.hasAttribute('data-back')) {
        this.confirmation.hidden = true;
        this.results.hidden = false;
        this.results.focus();
      } else if (button.hasAttribute('data-confirm-checkout')) this.checkout();
    }
  }
  customElements.define('fankee-shopping-assistant', ShoppingAssistant);
})();
