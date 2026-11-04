# Fankee Shopping Assistant MVP

Independent public Node.js 22 / TypeScript / Express service. No imports from or changes to
Product Importer or the Shopify theme. No UI, LLM, WhatsApp integration, Admin API, or payment page.

## Local setup

```powershell
cd tools/shopping-assistant
npm install
Copy-Item .env.example .env # first setup only; never replace existing credentials
npm run dev
```

Open http://127.0.0.1:4320/health. There is intentionally no homepage/UI.
Run npm run build and npm test. npm start executes dist/server.js, without requiring .env.
For a compiled local run that reads .env: node --env-file=.env dist/server.js.
All automated tests inject mock Shopify responses; external HTTP is blocked.

## Environment

| Variable | Purpose |
| --- | --- |
| SHOPIFY_STORE_DOMAIN | Required canonical myshopify.com hostname; example uses 9erfua-w1.myshopify.com |
| SHOPIFY_STOREFRONT_API_VERSION | Defaults to 2026-10; quarterly YYYY-MM version |
| PORT | Defaults to 4320; Render supplies its own PORT |
| NODE_ENV | development locally; production on Render |
| SHOPIFY_STOREFRONT_PRIVATE_TOKEN | Optional server-only **Storefront** private token, never an Admin token |
| ALLOWED_ORIGINS | Exact comma-separated origins. Local defaults: http://127.0.0.1:4320,http://localhost:4320. Production default: no browser origins |
| SHOPPING_ASSISTANT_DEBUG | true enables only sanitized error codes outside production |
| TRUST_PROXY_HOPS | 0 locally. Set 1 behind Render managed ingress; 0 is the default outside Render |

For the future website use ALLOWED_ORIGINS=https://fanakee.com,https://www.fanakee.com.
No wildcard CORS and no credentialed cookies are used. CORS restricts browser access,
not arbitrary HTTP clients; this is a public API with rate/concurrency limits, not admin authentication.
Origin-less server-to-server requests are permitted and rate limited. WhatsApp verification is not implemented.

Render Web Service: root tools/shopping-assistant; Node 22;
build npm ci --include=dev && npm run build; start npm start; health /health.
Set production origins and TRUST_PROXY_HOPS=1, and keep the server behind managed ingress.
The server binds 0.0.0.0. Never copy importer credentials into this service.

## Architecture

- domain/types.ts: channel-independent contracts.
- shopping/parser.ts: deterministic Hebrew-list parsing and limits.
- shopping/matcher.ts: conservative title/vendor/variant token overlap.
- shopping/money.ts: decimal strings to BigInt minor units using currency precision.
- shopping/quote-service.ts: bounded, expiring server-held quotes and candidate resolution.
- shopping/checkout-service.ts: explicit confirmation, current variant checks, cart creation.
- shopify/queries.ts and storefront-client.ts: Storefront GraphQL, native fetch, no Admin endpoints.
- routes/shopping-list.ts: HTTP delivery only; future WebsiteAdapter/WhatsAppAdapter can call
  the same services with a validated BuyerContext.
- middleware/: bounded rate/concurrency limits and safe error handling.

Use a single process/instance for the MVP. Quotes live for 15 minutes, at most 500 stored quotes.
They are lost on restart. Quote IDs are unguessable capability IDs: do not log/share them.
Horizontal scaling requires shared quote state, locks, idempotency and rate limiting before deployment.

## API

### GET /health
200: {"status":"ok"}. No configuration or secrets.

### POST /api/v1/shopping-list/quote
JSON: {"message":"2 מרכך מקסימה בייבי\nאקונומיקה סנו\n3 נוזל רצפות לבנדר"}

Returns 200 for all normal matching outcomes:
- quoteId, revision, expiresAt
- items: requested/original text, quantity, status, reason, heuristic confidence
- bestMatch and candidates: only actual Shopify variants; IDs, title, handle, vendor,
  optional image, unitPrice, quantity, lineTotal and availability/quantity rules
- resolvedItems, ambiguousItems, notFoundItems, unavailableItems
- subtotal: {"amount":"31.80","currencyCode":"ILS"} or null
- currencyCode, subtotalLabel: "סה״כ מוצרים", canCheckout

The subtotal covers **resolved items only** and is partial if anything is unresolved.
With no resolved products or mixed currencies it is null, rather than inventing a currency or
converting currencies. canCheckout requires every item resolved/purchasable, one currency,
and aggregate quantity rules/limits. Repeated lines for the same variant aggregate at checkout;
a combined quantity above 20 also blocks checkout, even if each individual line was smaller.
Shipping, taxes, promotions and checkout adjustments may change the actual Shopify cost.

Parser accepts newline/comma/semicolon lists, 2 name, 2x name, name x2, ×, trailing
bare integers, and common Hebrew quantity words (אחת, שתי, שלוש, etc.).
Missing quantity means 1. Bare trailing numbers mean quantity: use an explicit unit
(e.g. 1 ליטר) when describing a size; ambiguous size-first syntax should be rewritten
as a product name first. Limits: 4000 characters, 20 items, 180 normalized characters/name,
quantity 1–20 per variant and 100 total units. Invalid lines reject the whole request,
never silently disappear.

Matching normalizes Unicode, Hebrew marks, quotes, punctuation and whitespace. It measures
request-token coverage across title/vendor/variant name, with conservative one-edit tolerance
for long words. It does not invent synonyms or translate merchant option names.
Multiple plausible variants return ambiguous, regardless of stock. A clearly identified
unavailable variant stays unavailable; another scent/size is not silently substituted.
Search queries are capped at 8 products x 20 variants; responses show at most 10 candidate variants per item. A unique exact normalized title (or title plus specified variant) can match despite product search pagination. Duplicate exact products, unspecified meaningful variants, and incomplete variant lists require selection. Non-exact truncated results require customer selection or a more specific list.
Confidence values are heuristic, not statistical probabilities. A single match needs at least
0.85 token coverage; low-confidence plausible results still require confirmation by selection.
Products requiring selling plans or bundle components cannot be purchased by this MVP.

### POST /api/v1/shopping-list/resolve

```json
{
  "quoteId": "<quoteId returned by quote>",
  "revision": 1,
  "itemIndex": 0,
  "variantId": "gid://shopify/ProductVariant/<actual candidate ID>"
}
```

Only a candidate from the held ambiguous item is allowed. Shopify is queried again for the
variant; browser title/price fields are ignored. Response is a new quote revision.
If a selected variant is now unavailable, the quote remains blocked.
Not-found items require a corrected/new shopping list; no substitution/removal endpoint is included.

### POST /api/v1/shopping-list/checkout

```json
{
  "quoteId": "<quoteId>",
  "revision": 2,
  "confirmed": true,
  "lines": [
    {"variantId":"gid://shopify/ProductVariant/<actual selected ID>","quantity":2}
  ]
}
```

The frontend must show the quote and obtain an explicit customer confirmation before calling this.
No cart is created by quote or resolve. All items must be resolved; posted IDs/quantities must
exactly match the held quote (aggregated duplicate lines are equivalent).
Client prices/titles/availability/subtotal are ignored.

Immediately before cartCreate the service re-reads all variants, availability and quantity
rules. A price, currency, stock or rule change returns 409 QUOTE_CHANGED with an updated quote;
show it to the customer and confirm again using its new revision. Removed variants become not_found.
Concurrent mutations of a quote are rejected. Successful duplicate confirmations return the same
stored cart. A cart mutation failure/timeout marks the quote uncertain: do not retry it blindly;
start a new quote. There is no automatic upstream mutation retry.

Response: cartId, checkoutUrl, subtotal, total, warnings. checkoutUrl and costs are returned
directly by Shopify. Cart line changes/reductions are rejected rather than silently accepted.
There is an unavoidable time window after revalidation in which Shopify can change prices:
always display the returned cart cost; Shopify checkout remains the final authority.

## Shopify setup and API

Uses https://{domain}/api/{version}/graphql.json, full-text search restricted to PRODUCT,
nodes for current ProductVariant data, and cartCreate with merchandiseId/quantity.
Default mode sends no access token. Optional private mode sends
Shopify-Storefront-Private-Token; a validated request IP is forwarded as
Shopify-Storefront-Buyer-IP. No arbitrary browser-supplied buyer IP field is accepted.

Products must be published/available through the Storefront catalog used by this API,
with correct variants, market prices, availability and shipping/payment configuration.
Draft/unpublished products (including importer drafts) are not automatically published here.
Confirm tokenless access to the required fields on your store before public launch.
If Shopify requires authenticated access/scopes for your setup, configure a private Storefront
token with the relevant product-listing/checkout access; never substitute an Admin token.
This implementation has not called the real store or created a production cart during development.

Official references:
- https://shopify.dev/docs/api/storefront/latest
- https://shopify.dev/docs/api/storefront/latest/queries/search
- https://shopify.dev/docs/api/storefront/latest/queries/nodes
- https://shopify.dev/docs/api/storefront/latest/mutations/cartCreate

## Requests

```powershell
Invoke-RestMethod http://127.0.0.1:4320/health
$payload = @{message = "2 מרכך מקסימה בייבי`nאקונומיקה סנו`n3 נוזל רצפות לבנדר"} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4320/api/v1/shopping-list/quote -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload))
```

```bash
curl http://127.0.0.1:4320/health
curl -X POST http://127.0.0.1:4320/api/v1/shopping-list/quote \
  -H 'Content-Type: application/json' \
  --data '{"message":"2 מרכך מקסימה בייבי\nאקונומיקה סנו\n3 נוזל רצפות לבנדר"}'
```

## Errors and protection

JSON errors use stable code and Hebrew message; no stack, raw Shopify errors or token logging.
400 invalid input; 403 unapproved browser origin; 404 expired/unknown quote;
409 unresolved/stale/changed quote or rejected cart; 413 body too large; 415 JSON required;
429 rate/concurrency/Shopify limit; 502 Shopify failure; 500 unexpected server error.
A QUOTE_CHANGED error additionally carries the updated quote.

Public requests: 30/minute/IP; checkout also 10/minute/IP; 8 active API requests;
12kb body limit. In-memory limiter maps are bounded. Defaults ignore X-Forwarded-For;
only configure proxy trust for the actual managed ingress hop count.
Larger public deployments need shared limits and edge abuse protection. No cookies,
admin login, customer accounts or WhatsApp webhook authorization are added in this MVP.

### Natural Hebrew matching

No LLM is used. Extend `ALIAS_GROUPS` in `src/shopping/hebrew-query.ts` with a canonical concept and its aliases; `BRANDS`, `PHRASES`, and spelling mappings are maintained separately. Original input and Shopify titles are preserved. Normalization handles punctuation, quotes, hyphens, whitespace, Latin case and explicit spelling variants.

Each item searches the original parsed name, a distinct normalized form, and at most two alias-expanded forms (maximum four unique searches). Expansion preserves the rest of the name. Results merge by variant ID; a shared per-quote promise map reuses identical queries. Search stops on a decisive matched/unavailable result. Existing per-query product/variant limits remain unchanged.

Exact normalized titles and title-plus-variant matches retain priority and `EXACT_TITLE_MATCH`. Otherwise scoring uses weighted canonical token coverage: generic words 0.25, brands 2.5, other identifying words 2. A specified but absent brand multiplies the score by 0.4; missing complete requested phrases multiplies it by 0.8. Brands are recognized in titles as well as vendor fields.

Scores below 0.65 are not relevant; all candidates at or above 0.65 remain plausible. Automatic semantic matching requires exactly one plausible variant, score at least 0.85, complete search results and no unresolved meaningful variants. Success uses `SEMANTIC_UNIQUE_MATCH`; an unavailable decisive candidate uses `NOT_PURCHASABLE`, never an available substitute. Exact matches may override product pagination, as before.

Development-only `SHOPPING_ASSISTANT_DEBUG=true` logs redacted original/normalized queries, generated variants, candidate titles/scores and the final reason. Only allowlisted product vocabulary survives redaction; arbitrary customer text, numbers and identifiers are omitted. Credentials, headers and cookies are never logged.

### Product intent and unavailable results

Extend `PRODUCT_INTENTS` in `src/shopping/product-intent.ts` to configure type aliases. Supported intents are FABRIC_SOFTENER, LAUNDRY_DETERGENT, LAUNDRY_POWDER, BLEACH, FLOOR_CLEANER, FLOOR_WIPES, GLASS_CLEANER and UNKNOWN. Detection uses normalized word-boundary phrases; a more specific phrase overrides a broad family label (for example, Ritzpaz floor wipes). Equally specific conflicting signals yield UNKNOWN. Product titles take priority over optional productType metadata; the current Storefront adapter supplies titles.

Exact-title matching still runs first. For semantic scoring, a known conflicting type scores zero and is excluded. A same-intent candidate keeps its normal score; unknown candidate intent receives a small 0.95 multiplier. Unknown query intent retains the existing semantic fallback. Brand and fragrance agreement cannot override an explicit functional conflict.

If at least one strong (score >= 0.85) same-intent candidate is found and every returned plausible candidate is unpurchasable for the requested quantity, the result is unavailable with reason `ALL_RELEVANT_MATCHES_UNAVAILABLE`, including when product search is paginated. Candidates remain available for display; multiple products do not acquire an arbitrary bestMatch. This describes the observed matching candidates, not an inventory claim about unseen pages. Any purchasable plausible candidate prevents this aggregate unavailable shortcut. Purchasability includes sale availability, quantity rules, required selling plans and bundle restrictions. No automatic substitution is performed.

### Distinctive customer qualifiers

Semantic scoring requires all high-weight query tokens that remain after excluding configured product-type and brand vocabulary. Qualifier values are derived from each query, not a fragrance allowlist. Multi-word descriptors require every constituent token; existing configured meaningful phrases additionally require the complete phrase. Qualifiers must appear in the product or variant title, never merely in vendor metadata. Normalized aliases and spelling rules still apply.

A candidate missing any qualifier scores zero before relevance filtering. Such candidates cannot introduce ambiguity or block the all-unavailable state. Multiple qualifying products remain ambiguous; one qualifying strong available candidate may match under the existing pagination and variant safeguards. Exact-title matching retains priority.
