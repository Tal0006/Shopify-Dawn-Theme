// Storefront version diagnostics and storefront freshness. The theme exposes an invisible revision label and render
// time on <html> (with Shopify.theme.id/role in the console that identifies the rendered theme), and contains no
// cache machinery that could serve an old storefront or destroy carts, receipts or preferences.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const revision = require('./helpers/theme-revision.cjs');
// Everything the theme ships to the storefront (tools/, tests/ and docs are not uploaded).
const shipped = ['assets', 'layout', 'sections', 'snippets', 'templates', 'config', 'locales', 'blocks']
  .filter(dir => fs.existsSync(path.join(root, dir)))
  .flatMap(dir => fs.readdirSync(path.join(root, dir)).map(file => dir + '/' + file))
  .filter(file => /\.(liquid|js|css|json)$/.test(file));

test('Root element carries the theme revision and render time, nothing else', () => {
  const layout = read('layout/theme.liquid');
  const html = layout.slice(layout.indexOf('<html'), layout.indexOf('<head>'));
  assert.match(html, /data-theme-revision="{%- render 'theme-revision' -%}"/);
  assert.match(html, /data-rendered-at="{{ 'now' \| date: '%Y-%m-%dT%H:%M:%S%z' }}"/);
  // Only static or request-independent values: no customer, cart, settings or contact data.
  for (const attribute of html.match(/data-(theme-revision|rendered-at)="[^"]*"/g))
    assert.doesNotMatch(attribute, /customer|cart|settings|email|phone|token|shop\./, attribute);
});

test('Revision label: one maintainable source, the documented format, no secrets', () => {
  const snippet = read('snippets/theme-revision.liquid');
  assert.match(snippet, /{% doc %}[\s\S]*node tests\/helpers\/theme-revision\.cjs --write[\s\S]*{% enddoc %}/);
  const label = revision.current();
  assert.match(label, revision.FORMAT, 'YYYY-MM-DD+<short commit>');
  // The snippet outputs exactly the label: no other Liquid output, objects or filters.
  const body = snippet.replace(/{% doc %}[\s\S]*?{% enddoc %}/, '').trim();
  assert.equal(body, `{%- liquid\n  echo '${label}'\n-%}`.replace(/\n/g, body.includes('\r\n') ? '\r\n' : '\n'));
  assert.match(revision.proposed(new Date('2026-01-02T03:04:05Z')), /^2026-01-02\+[0-9a-f]{7,12}$/);
});

test('No service worker, Cache Storage, app manifest or storage-clearing cache hacks in shipped theme files', () => {
  for (const file of shipped) {
    const text = read(file);
    assert.doesNotMatch(text, /serviceWorker|caches\.(open|match|keys|delete)|CacheStorage|rel=["']manifest["']|\.webmanifest/, file);
    assert.doesNotMatch(text, /localStorage\.clear\(|sessionStorage\.clear\(|document\.cookie\s*=/, file + ' must not clear storage or write cookies');
    assert.doesNotMatch(text, /[?&](cb|cache_?bust|nocache)=|Date\.now\(\)\s*\+\s*['"]\.(css|js)/i, file + ' must not add cache-busting parameters');
  }
});

test('Theme stylesheets and scripts load through asset_url (versioned URLs), never hard-coded CDN paths', () => {
  for (const file of shipped.filter(file => file.endsWith('.liquid'))) {
    const text = read(file);
    for (const tag of text.match(/<(script|link)\b[^>]*\b(src|href)="[^"]*\.(js|css)[^"]*"[^>]*>/g) || [])
      assert.match(tag, /\|\s*(shopify_)?asset_url\b/, file + ': ' + tag);
    assert.doesNotMatch(text, /cdn\.shopify\.com\/s\/files|\/cdn\/shop\/t\/\d+\/assets\//, file + ' hard-codes a theme asset URL');
  }
});
