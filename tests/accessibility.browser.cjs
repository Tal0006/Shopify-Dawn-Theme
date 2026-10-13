const {test} = require('node:test');
const assert = require('node:assert/strict');
const base = process.env.ACCESSIBILITY_PREVIEW_URL || 'http://127.0.0.1:9292';
const debug = process.env.ACCESSIBILITY_DEBUG_URL || 'http://127.0.0.1:9333';
// Requires Shopify theme dev and an isolated Chrome session with remote debugging enabled.
test('Storefront accessibility browser checks', {timeout: 120000}, async t => {
  const tab = await (await fetch(debug + '/json/new?about:blank', {method: 'PUT'})).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, {once: true}));
  const pending = new Map(); let id = 0; const errors = [];
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.id) { const request = pending.get(message.id); pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, {resolve, reject}); ws.send(JSON.stringify({id: next, method, params})); });
  const ev = async expression => { const result = await call('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visit = async path => {
    await call('Page.navigate', {url: base + path}); await sleep(800);
    for (let n = 0; n < 60; n++) { if (await ev('document.readyState === "complete" && !!document.querySelector(".a11y-launcher:not([hidden])")')) return; await sleep(150); }
    throw Error('Page did not load accessibility assets: ' + path);
  };
  const key = async (value, code, number) => { for (const type of ['keyDown','keyUp']) await call('Input.dispatchKeyEvent', {type, key: value, code, windowsVirtualKeyCode: number, ...(type === 'keyDown' && value === 'Enter' ? {text: '\r'} : {})}); };
  const action = name => ev(`document.querySelector('[data-a11y-action="${name}"]').click()`);
  try {
    await call('Page.enable'); await call('Runtime.enable'); await call('Accessibility.enable');
    await call('Emulation.setDeviceMetricsOverride', {width: 1280, height: 900, deviceScaleFactor: 1, mobile: false});
    await visit('/'); await ev('localStorage.removeItem("punky-accessibility-v1")'); await visit('/');
    const links = await ev('({product:document.querySelector(".catalog-card__image").getAttribute("href"),collection:document.querySelector(".catalog-category").getAttribute("href")})');
    await t.test('Skip link moves keyboard focus to the main landmark', async () => {
      await ev('document.querySelector(".a11y-skip-link").focus()'); await key('Enter', 'Enter', 13);
      assert.equal(await ev('document.activeElement.id'), 'MainContent'); assert.equal(await ev('document.querySelectorAll("main").length'), 1);
    });
    await t.test('Keyboard panel opening, Escape focus return and no Tab trap', async () => {
      await ev('document.querySelector(".a11y-launcher").focus()'); await key('Enter', 'Enter', 13);
      assert.equal(await ev('document.querySelector("#AccessibilityPanel").open'), true);
      assert.equal(await ev('document.activeElement.hasAttribute("data-a11y-close")'), true);
      await key('Escape', 'Escape', 27);
      assert.equal(await ev('document.querySelector("#AccessibilityPanel").open'), false);
      assert.equal(await ev('document.activeElement.className'), 'a11y-launcher');
      await ev('document.querySelector(".a11y-launcher").click();document.querySelector("[data-a11y-action=reset]").focus()');
      await key('Tab', 'Tab', 9); await key('Tab', 'Tab', 9);
      assert.equal(await ev('document.activeElement.closest("#AccessibilityPanel") !== null'), false);
    });
    await t.test('Preferences persist, text scale is bounded and reset preserves unrelated storage', async () => {
      await ev('document.querySelector(".a11y-launcher").click()');
      const before = await ev('parseFloat(getComputedStyle(document.querySelector(".storefront-hero-heading")).fontSize)'); await action('increase');
      const after = await ev('parseFloat(getComputedStyle(document.querySelector(".storefront-hero-heading")).fontSize)'); assert.ok(Math.abs(after / before - 1.1) < .01);
      for (const mode of ['contrast','grayscale','links','motion']) await action(mode);
      await visit('/');
      assert.deepEqual(await ev('JSON.parse(localStorage.getItem("punky-accessibility-v1"))'), {text: 1, contrast: true, grayscale: true, links: true, motion: true});
      assert.equal(await ev('getComputedStyle(document.querySelector(".hero-area")).backgroundColor'), 'rgb(0, 0, 0)');
      assert.equal(await ev('getComputedStyle(document.querySelector(".a11y-grayscale-overlay")).backdropFilter'), 'grayscale(1)');
      await ev('document.querySelector(".a11y-launcher").click();localStorage.setItem("accessibility-test-unrelated","keep")');
      for (let n = 0; n < 10; n++) await action('increase');
      assert.equal(await ev('JSON.parse(localStorage.getItem("punky-accessibility-v1")).text'), 5);
      assert.equal(await ev('document.querySelector("[data-a11y-action=increase]").disabled'), true);
      for (let n = 0; n < 12; n++) await action('decrease');
      assert.equal(await ev('JSON.parse(localStorage.getItem("punky-accessibility-v1")).text'), -2);
      await action('reset'); assert.equal(await ev('localStorage.getItem("punky-accessibility-v1")'), null);
      assert.equal(await ev('localStorage.getItem("accessibility-test-unrelated")'), 'keep'); await ev('localStorage.removeItem("accessibility-test-unrelated")');
    });
    await t.test('System reduced motion remains active after reset', async () => {
      await call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]}); await action('reset');
      assert.equal(await ev('document.documentElement.hasAttribute("data-a11y-paused")'), true); assert.equal(await ev('window.jQuery.fx.off'), true);
      await call('Emulation.setEmulatedMedia', {features: []});
    });
    await t.test('Core pages have named controls, image alternatives and no overflow', async () => {
      for (const path of ['/',links.collection,links.product,'/cart','/search?q=*&type=product','/pages/contact']) {
        await visit(path);
        const audit = await ev(`(() => { const images=[...document.querySelectorAll('main img')];return {dir:document.documentElement.dir,overflow:document.documentElement.scrollWidth>innerWidth,errors:/Liquid error|Translation missing/i.test(document.body.innerText),missingAlt:images.filter(i=>!i.hasAttribute('alt')).length,unnamedImageLinks:images.filter(i=>!i.alt&&i.parentElement.tagName==='A'&&!i.parentElement.getAttribute('aria-label')&&!i.parentElement.innerText.trim()).length,h1:document.querySelector('main').querySelectorAll('h1').length};})()`);
        assert.equal(audit.dir,'rtl',path); assert.equal(audit.overflow,false,path); assert.equal(audit.errors,false,path); assert.equal(audit.missingAlt,0,path); assert.equal(audit.unnamedImageLinks,0,path); assert.equal(audit.h1,1,path);
        const tree=await call('Accessibility.getFullAXTree'); const unnamed=tree.nodes.filter(n=>!n.ignored&&['button','textbox','searchbox','combobox'].includes(n.role?.value)&&!n.name?.value);
        assert.deepEqual(unnamed.map(n=>n.role.value),[],path);
      }
    });
    await t.test('Product thumbnails are native keyboard buttons', async () => {
      await visit(links.product); assert.ok(await ev('document.querySelectorAll(".product-thumbnil-active button[aria-label]").length>0'));
      await ev('document.querySelector(".product-thumbnil-active button").focus()'); await key('Enter','Enter',13); assert.ok(await ev('!!document.querySelector(".product-active .owl-item.active")'));
    });
    await t.test('320px mobile menus, cart and text enlargement remain keyboard usable', async () => {
      await call('Emulation.setDeviceMetricsOverride',{width:320,height:844,deviceScaleFactor:1,mobile:true}); await visit('/');
      await ev('document.querySelector(".open-btn").focus()'); await key('Enter','Enter',13); await sleep(400);
      assert.equal(await ev('document.querySelector("#navbar").inert'),false); assert.equal(await ev('document.activeElement.className'),'menu-close');
      await ev('document.querySelector(".submenu-toggle").focus()'); await key('Enter','Enter',13); assert.equal(await ev('document.querySelector(".submenu-toggle").getAttribute("aria-expanded")'),'true');
      await key('Escape','Escape',27); assert.equal(await ev('document.querySelector("[data-mega-trigger]").getAttribute("aria-expanded")'),'false');
      await key('Escape','Escape',27); assert.equal(await ev('document.querySelector("#navbar").inert'),true); assert.ok(await ev('document.activeElement.classList.contains("open-btn")'));
      await ev('document.querySelector(".cart-toggle-btn").focus()'); await key('Enter','Enter',13); await sleep(400); assert.equal(await ev('document.querySelector(".mini-cart-content").inert'),false);
      await key('Escape','Escape',27); assert.equal(await ev('document.activeElement.className'),'cart-toggle-btn');
      await ev('document.querySelector(".a11y-launcher").click()'); for(let n=0;n<5;n++)await action('increase'); assert.equal(await ev('document.documentElement.scrollWidth<=innerWidth'),true);
      assert.equal(await ev('document.querySelector(".a11y-launcher").offsetWidth>=44'),true); await action('reset');
    });
    assert.deepEqual(errors,[]);
  } finally {
    await ev('localStorage.removeItem("punky-accessibility-v1");localStorage.removeItem("accessibility-test-unrelated")').catch(()=>{});
    ws.close(); await fetch(debug+'/json/close/'+tab.id).catch(()=>{});
  }
});