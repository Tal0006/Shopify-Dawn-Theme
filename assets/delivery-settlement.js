// Delivery settlement selection before checkout (snippets/delivery-settlement.liquid).
// One shared choice for every cart form on the page (cart drawer and cart page). The Shopify cart attribute
// "יישוב למשלוח" is the persisted source of truth; the select also posts it with the cart form, so checkout
// records the latest choice even when an AJAX save is still running or failed. Shopify Local Delivery stays the
// final delivery-eligibility check: this only guides customers before the regular checkout.
(() => {
  'use strict';
  if (customElements.get('fankee-delivery-settlement')) return;
  const ATTRIBUTE = 'יישוב למשלוח';
  const cartRoot = () => window.Shopify?.routes?.root || '/';

  // kind: 'neutral' (nothing chosen) | 'supported' (approved settlement) | 'unsupported' (not listed).
  // null until the first selector connects, which seeds it from the server-rendered cart attribute.
  let choice = null;
  let validation = false; // true after checkout was attempted without a choice
  let saved = null; // attribute value Shopify is known to hold
  let saving = Promise.resolve();
  let pendingSaves = 0;
  let ticket = 0;

  function readChoice(select) {
    const option = select.selectedOptions[0];
    if (option?.hasAttribute('data-approved')) return {kind: 'supported', value: option.value};
    return {kind: option?.hasAttribute('data-not-listed') ? 'unsupported' : 'neutral', value: ''};
  }
  function applyChoice(select) {
    const options = [...select.options];
    const option = choice.kind === 'supported' ? options.find(item => item.hasAttribute('data-approved') && item.value === choice.value)
      : choice.kind === 'unsupported' ? options.find(item => item.hasAttribute('data-not-listed')) : options[0];
    if (option && !option.selected) option.selected = true;
  }
  const paragraph = text => Object.assign(document.createElement('p'), {textContent: text});
  function messages(element, state) {
    const {supported, unsupported, group, required} = element.dataset;
    if (state === 'supported') return [supported];
    if (state === 'unsupported') return [unsupported, group];
    if (state === 'required') return [required];
    return [];
  }
  function checkoutButtons(element) {
    const form = element.closest('form');
    return form ? [...form.elements].filter(control => control instanceof HTMLButtonElement && control.name === 'checkout') : [];
  }

  class DeliverySettlement extends HTMLElement {
    get select() { return this.querySelector('[data-settlement-select]'); }
    connectedCallback() {
      const select = this.select;
      if (!(select instanceof HTMLSelectElement)) return;
      if (choice === null) {
        choice = readChoice(select);
        saved = choice.value;
      }
      // Cart re-renders insert fresh server markup; the in-memory choice is the latest customer intent.
      this.render();
    }
    render() {
      const select = this.select;
      if (!(select instanceof HTMLSelectElement) || choice === null) return;
      applyChoice(select);
      const state = choice.kind === 'neutral' && validation ? 'required' : choice.kind;
      this.dataset.state = state;
      if (state === 'required') select.setAttribute('aria-invalid', 'true');
      else select.removeAttribute('aria-invalid');
      const message = this.querySelector('[data-settlement-message]');
      const texts = messages(this, state);
      // Only change the live region when its text changes, so cart re-renders do not repeat announcements.
      if (message && message.textContent !== texts.join('')) message.replaceChildren(...texts.map(paragraph));
      const cta = this.querySelector('[data-settlement-cta]');
      if (cta) cta.hidden = state !== 'unsupported';
      for (const button of checkoutButtons(this)) {
        if (choice.kind === 'supported') button.removeAttribute('aria-disabled');
        else button.setAttribute('aria-disabled', 'true');
      }
    }
    // Re-announces a message that is already shown (a repeated blocked checkout).
    announce() {
      const message = this.querySelector('[data-settlement-message]');
      if (!message) return;
      const texts = messages(this, this.dataset.state);
      message.replaceChildren();
      setTimeout(() => { if (message.isConnected && !message.childNodes.length) message.replaceChildren(...texts.map(paragraph)); }, 60);
    }
  }
  const renderAll = () => { for (const element of document.querySelectorAll('fankee-delivery-settlement')) element.render?.(); };

  // Saves through Shopify's AJAX cart API without a page reload. The attribute key is replaced, never duplicated;
  // an empty value removes it. Only the newest choice is sent, in order.
  function persist() {
    const value = choice.value, current = ++ticket;
    pendingSaves++;
    saving = saving.then(async () => {
      if (current !== ticket || value === saved) return;
      const response = await fetch(cartRoot() + 'cart/update.js', {
        method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, credentials: 'same-origin',
        body: JSON.stringify({attributes: {[ATTRIBUTE]: value}})
      });
      if (!response.ok) throw Error('Settlement not saved');
      saved = value;
    }).catch(() => { /* The cart form still posts the choice with checkout; a later change retries. */ })
      .finally(() => { pendingSaves--; });
  }

  document.addEventListener('change', event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches('fankee-delivery-settlement [data-settlement-select]')) return;
    choice = readChoice(select);
    validation = false;
    renderAll();
    persist();
  });

  // Checkout gate for every cart form that renders a selector (mouse, touch, keyboard and implicit submission).
  document.addEventListener('submit', event => {
    const form = event.target, button = event.submitter;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement) || button.name !== 'checkout') return;
    const element = form.querySelector('fankee-delivery-settlement');
    if (!element || choice === null) return;
    if (choice.kind !== 'supported') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const repeated = choice.kind === 'unsupported' || validation;
      validation = choice.kind === 'neutral';
      renderAll();
      if (repeated) element.announce();
      const cta = element.querySelector('[data-settlement-cta]');
      (choice.kind === 'unsupported' && cta && !cta.hidden ? cta : element.select)?.focus();
      return;
    }
    // Let a running save finish first so the stored attribute and the checkout submission agree.
    if (pendingSaves) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.hasAttribute('aria-busy')) return;
      button.setAttribute('aria-busy', 'true');
      saving.then(() => {
        button.removeAttribute('aria-busy');
        if (form.isConnected && button.isConnected && button.form === form && choice.kind === 'supported') form.requestSubmit(button);
      });
    }
  }, true);

  customElements.define('fankee-delivery-settlement', DeliverySettlement);
})();
