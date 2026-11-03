# Header product search

The existing header form now shows up to six Shopify product suggestions after two characters
and a 300 ms debounce. The normal GET search form remains functional without JavaScript.
No Theme Editor setting is required and no product IDs or credentials are embedded in the theme.

## Shopify language and barcode support

Current [Shopify Predictive Search documentation](https://shopify.dev/docs/api/ajax/reference/predictive-search)
lists title, product type, vendor, variant title, SKU **and variant barcode** as product search fields.
The deprecated resources[options][fields] parameter is deliberately not used. Shopify controls
indexing, matching and whether a particular product/variant is returned; this is not a promise
of exact barcode uniqueness. Products must be visible to Online Store search.

The same documentation does not list Hebrew as a supported predictive-search buyer locale.
The component respects the shopify-features predictiveSearch flag. When false, it uses the
normal locale-aware Shopify /search route plus section_id=predictive-search to obtain product
rows. If the predictive route returns 417 (unsupported locale), it switches to normal search.
This preserves a fast dropdown for Hebrew without claiming the unsupported API works there.
It uses Shopify's own search index, not a separate catalog. A normal search failure leaves the
all-results link and form submit available.

## Interaction

- After two characters: debounce, loading row, then product image/title/vendor/price/compare-at
  price/availability. Shopify Liquid money filters preserve currency and store formatting.
- Arrow Down/Up: cycle through the product options while focus remains in the input.
- Enter: open the highlighted product; without a highlight, submit the normal search form.
- Escape: cancel pending work, close suggestions, and keep/restore input focus.
- Tab: use the native focus order, including the submit button, product links and all-results
  link. Leaving the widget closes it. Pointer click outside also closes it.
- IME composition is respected. New queries abort old fetches and also use a sequence check
  so an older response cannot overwrite a newer query.
- Up to 30 recent query responses cache in memory per connected widget. Theme Editor removal
  aborts requests and listeners; reconnection restores one listener set.
- No products: explicit Hebrew empty state and search-by-name/brand hint.
- Error: a Hebrew message and a working link to the normal Shopify search results page.

The white dropdown is anchored immediately below the input and uses existing color/spacing
tokens, logical CSS and RTL reading order. On narrow screens the search remains in its existing
full-width header row. The dropdown fits that width and its internal scroll area adapts to
available viewport height, including the mobile keyboard. Controls retain touch/focus targets.

## Extension boundary

assets/predictive-search.js isolates requests in fetchResults(query, signal, native).
If a future server-side barcode resolver/app proxy is needed, replace or extend this boundary
and return the same server-rendered product fragment. Keep Admin tokens on the server and
preserve the selected-result UI/sequence checks. No custom resolver is required for fields that
Shopify currently searches. Customer JavaScript never calls the importer, Cheapersal, SerpAPI
or the Admin API.

## Verification

```powershell
node --check assets/predictive-search.js
node --test tests/predictive-search.browser.cjs
shopify theme check --path .
```

Browser tests launch headless local Chrome (override CHROME_PATH if necessary) with isolated
mock Shopify responses; they never mutate a store. They cover debounce, keyboard input,
locale-aware native and Hebrew fallback routes, 417 handling, stale responses, loading,
empty/error states, all-results URLs, mobile RTL sizing and section reconnection.
Real Hebrew matching and product visibility still require a development-theme preview in
the store. No theme upload or commit is performed automatically.
