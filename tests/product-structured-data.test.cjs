// Product structured data (Google Merchant Center / rich results).
// 1. Static contract: one Product JSON-LD source, rendered from the layout head on product pages, no client-side data.
// 2. Rendering: snippets/product-structured-data.liquid rendered with liquidjs and Shopify-compatible filter shims for
//    representative product cases. Runs when liquidjs is resolvable (e.g. NODE_PATH pointing at an install); skipped
//    otherwise. The theme itself has no runtime dependency on it.
// 3. Live: with THEME_PREVIEW_URL (e.g. http://127.0.0.1:9292) and PRODUCT_PATHS (comma-separated /products/... paths),
//    the server-rendered HTML of real product pages is validated. Skipped otherwise.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function files(dir) { return fs.readdirSync(path.join(root, dir), {withFileTypes: true}).flatMap(entry => entry.isDirectory() ? files(dir + '/' + entry.name) : [dir + '/' + entry.name]); }

const AVAILABILITY = new Set(['https://schema.org/InStock', 'https://schema.org/OutOfStock']);
function offersOf(data) {
  assert.equal(data['@context'], 'https://schema.org');
  if (data['@type'] === 'Product') return [[data, data.offers]];
  assert.equal(data['@type'], 'ProductGroup');
  assert.ok(Array.isArray(data.hasVariant) && data.hasVariant.length > 0, 'ProductGroup without variants');
  return data.hasVariant.map(variant => { assert.equal(variant['@type'], 'Product'); return [variant, variant.offers]; });
}
function assertValid(data, label = '') {
  assert.ok(typeof data.name === 'string' && data.name.length > 0, label + ' name');
  assert.match(data.url, /^https?:\/\/[^/]+\/.*products\//, label + ' url');
  const pairs = offersOf(data);
  for (const [item, offer] of pairs) {
    assert.ok(offer && offer['@type'] === 'Offer', label + ' Product without Offer');
    assert.equal(typeof offer.price, 'number', label + ' price must be a JSON number');
    assert.ok(Number.isFinite(offer.price) && offer.price >= 0, label + ' price');
    assert.match(offer.priceCurrency, /^[A-Z]{3}$/, label + ' priceCurrency');
    assert.ok(AVAILABILITY.has(offer.availability), label + ' availability ' + offer.availability);
    assert.match(offer.url, /^https?:\/\/[^/]+\/.*products\//, label + ' offer url');
    assert.ok(typeof item.name === 'string' && item.name.length > 0, label + ' variant name');
  }
  return pairs.map(([, offer]) => offer);
}
function jsonLd(html) { return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1])); }

test('Exactly one Product JSON-LD source, server-rendered from the layout head on product pages', () => {
  const sources = ['layout', 'sections', 'snippets', 'blocks', 'templates'].filter(dir => fs.existsSync(path.join(root, dir))).flatMap(files)
    .filter(file => /\.(liquid|json)$/.test(file) && /application\/ld\+json|schema\.org\/(Product|Offer)|"@type":\s*"(Product|Offer)/.test(read(file)));
  assert.deepEqual(sources, ['snippets/product-structured-data.liquid']);
  for (const file of ['layout/theme.liquid', 'layout/password.liquid', ...files('sections'), ...files('snippets')].filter(file => file.endsWith('.liquid'))) {
    const count = (read(file).replace(/{% doc %}[\s\S]*?{% enddoc %}/, '').match(/render 'product-structured-data'/g) || []).length;
    assert.equal(count, file === 'layout/theme.liquid' ? 1 : 0, file);
  }
  const layout = read('layout/theme.liquid'), head = layout.slice(0, layout.indexOf('</head>'));
  assert.match(head, /if request\.page_type == 'product' and product -%}\s*{% render 'product-structured-data', sd_product: product %}/);
  const snippet = read('snippets/product-structured-data.liquid');
  assert.doesNotMatch(snippet, /inventory_quantity/, 'exact inventory must never be emitted');
  assert.doesNotMatch(snippet, /\|\s*money/, 'price must not use locale money formatting');
  assert.match(snippet, /sd_variant\.available/);
  for (const file of files('assets').filter(file => file.endsWith('.js'))) assert.doesNotMatch(read(file), /ld\+json/, file + ' must not build structured data');
});

let Liquid;
try { ({Liquid} = require('liquidjs')); } catch { Liquid = null; }

test('Rendered Product/Offer structured data for representative products', {skip: Liquid ? false : 'liquidjs not resolvable (set NODE_PATH to an install to run)'}, async t => {
  const engine = new Liquid({strictFilters: true});
  // Shopify-compatible shims for the filters the snippet uses that differ from liquidjs defaults.
  engine.registerFilter('json', value => JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'));
  engine.registerFilter('image_url', (image, ...args) => '//fanakee.com/cdn/shop/files/' + image.src + '?width=' + Object.fromEntries(args.filter(Array.isArray)).width);
  engine.registerFilter('divided_by', (a, b) => Number.isInteger(a) && Number.isInteger(b) ? Math.floor(a / b) : a / b);
  const source = read('snippets/product-structured-data.liquid').replace(/{% doc %}[\s\S]*?{% enddoc %}/, '');
  const template = engine.parse(source);
  const base = 'https://fanakee.com/products/fixture';
  const image = name => ({src: name + '.jpg', width: 1200, height: 1200});
  const variant = overrides => ({id: 101, title: 'Default Title', price: 1190, compare_at_price: null, available: true, sku: 'FNK-1', barcode: '7290000000015', featured_image: null, inventory_management: 'shopify', inventory_policy: 'deny', inventory_quantity: 7, ...overrides});
  const product = overrides => ({id: 900, title: 'מוצר בדיקה', description: '<p>תיאור <b>מוצר</b></p>', vendor: 'פאנקי', has_only_default_variant: true, featured_image: image('main'), images: [image('main')], variants: [variant({})], ...overrides});
  const render = async (sd_product, currency = 'ILS') => {
    const html = await engine.render(template, {sd_product, canonical_url: base, cart: {currency: {iso_code: currency}}, shop: {name: 'פאנקי'}});
    const blocks = jsonLd(html);
    assert.equal(blocks.length, 1, 'one JSON-LD block');
    return {data: blocks[0], html};
  };

  await t.test('single variant, in stock (tracked inventory)', async () => {
    const {data, html} = await render(product({}));
    assert.equal(data['@type'], 'Product');
    const [offer] = assertValid(data);
    assert.deepEqual({price: offer.price, currency: offer.priceCurrency, availability: offer.availability, url: offer.url}, {price: 11.9, currency: 'ILS', availability: 'https://schema.org/InStock', url: base});
    assert.match(html, /"price": 11\.90,/);
    assert.equal(data.sku, 'FNK-1');
    assert.equal(data.gtin, '7290000000015');
    assert.equal(data.brand.name, 'פאנקי');
    assert.equal(data.description, 'תיאור מוצר');
    assert.equal(data.image, 'https://fanakee.com/cdn/shop/files/main.jpg?width=1200');
    assert.ok(!html.includes('"7"') && !/inventory/i.test(html), 'no inventory counts');
  });
  await t.test('single variant, sold out', async () => {
    const {data} = await render(product({variants: [variant({available: false, inventory_quantity: 0})]}));
    const [offer] = assertValid(data);
    assert.equal(offer.availability, 'https://schema.org/OutOfStock');
    assert.equal(offer.price, 11.9);
  });
  await t.test('sale price uses the current price, not compare-at', async () => {
    const {data} = await render(product({variants: [variant({price: 990, compare_at_price: 1590})]}));
    assert.equal(assertValid(data)[0].price, 9.9);
  });
  await t.test('multiple variants become a ProductGroup with one Offer per variant', async () => {
    const {data} = await render(product({has_only_default_variant: false, images: [image('main'), image('b')], variants: [
      variant({id: 1, title: '1 ליטר', price: 1190, featured_image: image('b')}),
      variant({id: 2, title: '3 ליטר', price: 2990, available: false, sku: '', barcode: ''}),
      variant({id: 3, title: '5 ליטר', price: 123450, barcode: 'ABC-12'}),
    ]}));
    assert.equal(data['@type'], 'ProductGroup');
    assert.equal(data.productGroupID, '900');
    assert.equal(data.url, base);
    const offers = assertValid(data);
    assert.deepEqual(offers.map(offer => [offer.price, offer.availability, offer.url]), [
      [11.9, 'https://schema.org/InStock', base + '?variant=1'],
      [29.9, 'https://schema.org/OutOfStock', base + '?variant=2'],
      [1234.5, 'https://schema.org/InStock', base + '?variant=3'],
    ]);
    assert.equal(data.hasVariant[0].name, 'מוצר בדיקה - 1 ליטר');
    assert.equal(data.hasVariant[0].image, 'https://fanakee.com/cdn/shop/files/b.jpg?width=1200');
    assert.equal(data.hasVariant[1].image, 'https://fanakee.com/cdn/shop/files/main.jpg?width=1200');
    assert.ok(!('sku' in data.hasVariant[1]) && !('gtin' in data.hasVariant[1]));
    assert.ok(!('gtin' in data.hasVariant[2]), 'malformed barcode is not emitted as GTIN');
  });
  await t.test('untracked inventory is in stock', async () => {
    const {data} = await render(product({variants: [variant({inventory_management: null, inventory_quantity: 0, available: true})]}));
    assert.equal(assertValid(data)[0].availability, 'https://schema.org/InStock');
  });
  await t.test('continue-selling variant is purchasable and shown in stock, without its quantity', async () => {
    const {data, html} = await render(product({variants: [variant({inventory_policy: 'continue', inventory_quantity: -3, available: true})]}));
    assert.equal(assertValid(data)[0].availability, 'https://schema.org/InStock');
    assert.ok(!html.includes('-3'));
  });
  await t.test('product without SKU, barcode, vendor, description or images still has a complete Offer', async () => {
    const {data} = await render(product({vendor: '', description: '', featured_image: null, images: [], variants: [variant({sku: '', barcode: ''})]}));
    assertValid(data);
    for (const key of ['sku', 'gtin', 'brand', 'description', 'image']) assert.ok(!(key in data), key);
  });
  await t.test('zero price and store currency stay numeric and explicit', async () => {
    const {data, html} = await render(product({variants: [variant({price: 0})]}), 'USD');
    const [offer] = assertValid(data);
    assert.equal(offer.price, 0);
    assert.equal(offer.priceCurrency, 'USD');
    assert.match(html, /"price": 0\.00,/);
  });
  await t.test('merchant text cannot break out of the script element', async () => {
    const {data, html} = await render(product({title: 'A </script><script>x()</script> "q"'}));
    assert.equal(data.name, 'A </script><script>x()</script> "q"');
    assert.equal((html.match(/<\/script>/g) || []).length, 1);
  });
  await t.test('canonical URL query strings are not carried into the schema', async () => {
    const html = await engine.render(template, {sd_product: product({}), canonical_url: base + '?variant=5', cart: {currency: {iso_code: 'ILS'}}, shop: {name: 'x'}});
    assert.equal(jsonLd(html)[0].url, base);
  });
});

const preview = process.env.THEME_PREVIEW_URL, paths = (process.env.PRODUCT_PATHS || '').split(',').map(item => item.trim()).filter(Boolean);
test('Live product pages emit valid structured data in initial HTML', {skip: preview && paths.length ? false : 'set THEME_PREVIEW_URL and PRODUCT_PATHS to check a preview'}, async () => {
  for (const item of paths) {
    const html = await (await fetch(new URL(item, preview))).text();
    const blocks = jsonLd(html).filter(block => ['Product', 'ProductGroup'].includes(block['@type']));
    assert.equal(blocks.length, 1, item + ': exactly one Product/ProductGroup');
    assertValid(blocks[0], item);
  }
});
