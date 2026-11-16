# Fankee Shopping Assistant MVP

Independent public Node.js 22 / TypeScript / Express service. No imports from or changes to
Product Importer or the Shopify theme. No backend UI, LLM, Admin API, or payment page. Optional WhatsApp adapter shares the website shopping engine.

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
| SHOPPING_ASSISTANT_DEBUG | true enables sanitized error codes and redacted `Shopping match` diagnostics outside production; ignored when NODE_ENV=production |
| SHOPPING_ASSISTANT_DEBUG_RAW_PRODUCT_TITLES | Local diagnostics only: with SHOPPING_ASSISTANT_DEBUG=true and NODE_ENV≠production, `Shopping match` shows full catalog product titles, variant titles and productType. Customer text stays redacted; no IDs, URLs or tokens; API responses unchanged. Ignored in production |
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
- shopping/vocabulary.ts: product types, aliases, brands, spellings, preferences and negation words;
  hebrew-query.ts (scoring, retrieval forms) and product-intent.ts (type detection) build on it.
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

Compound lines split conservatively. "כוסות וצלחות" becomes two items only because both sides are independently
recognized product types; "שמפו לשיער יבש ופגום" and "שמפו ומרכך" (a bare "מרכך" needs context) stay one item.
A leading modifier before a dash or colon ("חד פעמי – כוסות וצלחות") is added to each item, but only when it is
product vocabulary and the rest lists several independent products. List labels ("ניקיון: …") and
product-scent lines ("ריצפז - לבנדר") parse as before. Each split item carries its own originalText
("2 כוסות חד פעמי"), so edit/remove in the website and WhatsApp rebuild a valid list. Split items count toward the 20-item limit.

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

No LLM is used. All matching vocabulary lives in `src/shopping/vocabulary.ts`: `PRODUCT_INTENTS`, `ALIAS_GROUPS` (canonical concepts), `BRANDS`, `PHRASES`, generic words, soft and size wishes, spelling mappings and negation words. Original input and Shopify titles are preserved. Normalization handles punctuation, quotes, hyphens, whitespace, Latin case and explicit spelling variants (plural/gender forms such as ספוגים→ספוג, סקוצ→סקוץ, חד פעמיות→חד פעמי). Attached Hebrew prefixes (ו/ה/ב/ל/מ/ש/כ: "לשיער", "וצלחות", "למטבח") are removed only when the remainder is configured vocabulary, so ordinary words such as "לבנדר" are untouched.

Each item searches the original parsed name, a distinct normalized form, then retrieval forms of the core request, then alias rewrites of the full text (maximum four unique searches). A retrieval form is the type's catalog wording from `PRODUCT_INTENTS[].search` plus the requested brands and qualifiers, without soft wishes and filler: "מרכך כביסה עם ריח חזק" searches "מרכך כביסה" and "מרכך"; "מרכך שיער כיף" searches "מרכך כיף". An alias rewrite that would change the detected product type is skipped. Results merge by variant ID; a shared per-quote promise map reuses identical queries. Search stops on a matched result, or on an unavailable result for an exactly named product; a non-exact unavailable result keeps searching so an equally relevant purchasable product can still be retrieved. Searches keep Shopify's relevance order (`unavailableProducts: SHOW`): ordering unavailable products last let eight available products of other types (for example other Kif products) push an unavailable exact match off the first page. Availability is applied after relevance, by the matcher. Only when every relevant candidate found is unavailable and results were cut off does one extra availability probe search the core retrieval form with `unavailableProducts: LAST`; its results are scored like any other, so it can add relevant purchasable products but never displace or replace relevant ones (at most five searches per item). Existing per-query product/variant limits remain unchanged.

Exact normalized titles and title-plus-variant matches retain priority and `EXACT_TITLE_MATCH`. Otherwise scoring uses weighted canonical token coverage: generic words 0.25, brands 2.5, other identifying words 2. When the request and the product have the same known type (or the product is a more specific kind of it), the type's own vocabulary and generic words count as present: "ספוגים לכלים" is covered by "כרית ניקוי לכלים". A specified but absent brand multiplies the score by 0.4; missing complete requested phrases multiplies it by 0.8. Brands are recognized in titles as well as vendor fields.

Soft wishes (subjective words such as חזק, נעים, טוב, איכותי, or the room "מטבח") are never required and never lower relevance; they only order otherwise comparable candidates. Size wishes (גדול, קטן, ענק) narrow the relevant candidates only when at least one of them states the size.

Explicit negation is generic: "ללא X", "בלי X", "אינו/אינה מכיל(ה) X", "לא מכיל X", "נטול X" (also with ו). A product whose title says it does not contain a core word of the request (or an alias of it) scores zero: "אוקסיג'ן מסיר כתמים ללא אקונומיקה" never matches "אקונומיקה". Negated words do not determine a product's type. A customer exclusion ("מסיר כתמים ללא אקונומיקה") removes products that contain it and ranks products stating it first.

Scores below 0.65 are not relevant; all candidates at or above 0.65 remain plausible. Automatic semantic matching requires exactly one plausible variant, score at least 0.85, complete search results and no unresolved meaningful variants. Success uses `SEMANTIC_UNIQUE_MATCH`; an unavailable decisive candidate uses `NOT_PURCHASABLE`, never an available substitute. Exact matches may override product pagination, as before.

Candidates are ordered by relevance. A purchasable candidate ranks ahead of an unavailable one whose score is equal or higher by at most 0.1 (`AVAILABILITY_RANK_MARGIN`); larger relevance gaps are never overridden by stock, and availability never makes an irrelevant product a candidate. Several plausible candidates remain ambiguous (no automatic substitution); this ordering decides what the customer sees first and which candidates fit in the ten shown.

Development-only `SHOPPING_ASSISTANT_DEBUG=true` logs redacted original/normalized queries, generated variants, each search with its result count, candidate titles/scores/availability with the index of the search that first retrieved them, and the final reason. A product missing from the candidates was never retrieved; one present with a score below 0.65 was retrieved and scored out. Only configured product vocabulary survives redaction; arbitrary customer text, numbers and identifiers are omitted. Credentials, headers and cookies are never logged.

### Product intent and unavailable results

Extend `PRODUCT_INTENTS` in `src/shopping/vocabulary.ts` to configure types (`product-intent.ts` holds the detection). Supported intents: FABRIC_SOFTENER, HAIR_CONDITIONER, SHAMPOO, BODY_WASH, HAND_SOAP, DISH_SOAP, LAUNDRY_DETERGENT, LAUNDRY_POWDER, BLEACH, FLOOR_CLEANER, FLOOR_WIPES, CLEANING_CLOTHS, GLASS_CLEANER, TOILET_CLEANER, DEGREASER, DISH_SPONGE, PAPER_TOWELS, TOILET_PAPER, TRASH_BAGS, CUPS, PLATES and UNKNOWN. Each definition has `aliases` (contiguous phrases; `a+b` means both words anywhere, for context such as "מרכך+שיער" or "מרכך+בגדים"), optional `contextual` aliases that need context (a bare "מרכך" defaults to fabric softener but is not enough to split a list item), `search` retrieval wording and an optional `parent` (FLOOR_WIPES is a kind of CLEANING_CLOTHS). Detection uses normalized word-boundary phrases; a more specific phrase overrides a broad family label (for example, Ritzpaz floor wipes, or "מרכך שיער" over "מרכך"). Equally specific conflicting signals yield UNKNOWN, except a parent/child pair, which yields the child. A context-dependent word shared with another type (a bare "מרכך") never classifies a product by itself: the product type comes from context words in the title ("מרכך ... מכונת כביסה", "מרכך לשיער"), then Shopify `productType` (fetched with each search), then `BRAND_CONTEXT` (a brand's product family), otherwise UNKNOWN. In requests a bare "מרכך" still means fabric softener. Hair conditioner and fabric softener remain hard conflicts. Tags and collections are not fetched: tags need an extra Storefront scope, and a missing scope would fail the whole search. Product titles take priority over optional productType metadata; the current Storefront adapter supplies titles.

Exact-title matching still runs first. For semantic scoring, a known conflicting type scores zero and is excluded: a hair-conditioner request never matches laundry softener and vice versa. A same-intent candidate keeps its normal score; unknown candidate intent or the broader parent type receives a small 0.95 multiplier. A specialization is relevant but ranked after generic products (multiplier 0.8, `SPECIALIZATION_FACTOR`): a child type (floor wipes for "מטליות לניקוי"), or a type declared `variantOf` the request whose title also names the requested type on its own ("אקונומיקה ג'ל לאסלה" for "אקונומיקה"; TOILET_CLEANER is `variantOf` BLEACH). 0.8 keeps a lone specialization as an offered choice rather than an automatic match, and is more than the availability margin below a generic match, so stock never lifts it above a clearly better generic product. Context-dependent words never create a specialization (a hair conditioner is never a fabric softener), and "ללא אקונומיקה" remains a hard exclusion. Unknown query intent retains the existing semantic fallback. Brand and fragrance agreement cannot override an explicit functional conflict.

If at least one strong (score >= 0.85) same-intent candidate is found and every returned plausible candidate is unpurchasable for the requested quantity, the result is unavailable with reason `ALL_RELEVANT_MATCHES_UNAVAILABLE`, including when product search is paginated. Candidates remain available for display; multiple products do not acquire an arbitrary bestMatch. This describes the observed matching candidates, not an inventory claim about unseen pages. Any purchasable plausible candidate prevents this aggregate unavailable shortcut. Purchasability includes sale availability, quantity rules, required selling plans and bundle restrictions. No automatic substitution is performed.

### Distinctive customer qualifiers

Semantic scoring requires all high-weight query tokens that remain after excluding configured product-type, brand, soft-wish and size vocabulary. Qualifier values are derived from each query, not a fragrance allowlist. Multi-word descriptors require every constituent token; existing configured meaningful phrases additionally require the complete phrase. Qualifiers must appear in the product or variant title, never merely in vendor metadata. Normalized aliases and spelling rules still apply.

A candidate missing any qualifier scores zero before relevance filtering. Such candidates cannot introduce ambiguity or block the all-unavailable state. Multiple qualifying products remain ambiguous; one qualifying strong available candidate may match under the existing pagination and variant safeguards. Exact-title matching retains priority.

## WhatsApp Business Platform channel

WhatsApp is an optional delivery adapter over the same in-process QuoteService, resolve logic,
CheckoutService and Storefront client used by the website. No internal HTTP calls or second
shopping engine. Website routes and request/response contracts are unchanged.

### Configuration and Meta setup

Keep WHATSAPP_ENABLED=false to run the website without any Meta credentials. To enable:
- WHATSAPP_ENABLED=true
- WHATSAPP_PHONE_NUMBER_ID: the Meta business phone-number ID (not its display phone number)
- WHATSAPP_ACCESS_TOKEN: server-only token authorized for that number
- WHATSAPP_VERIFY_TOKEN: your chosen unguessable webhook verification token
- META_APP_SECRET: the Meta app secret used to verify inbound HMAC signatures
- META_GRAPH_API_VERSION: an explicitly configured currently supported Graph version, including
  the v prefix. There is deliberately no default version.

Configure Render's environment, not browser/theme settings. Do not commit .env.
In Meta, subscribe your app to the WhatsApp business account messages webhook and configure:
https://<your-backend-host>/webhooks/whatsapp with your verify token. Complete Meta's business
number/token setup separately. This implementation does not register numbers or subscribe apps
on your behalf.

GET /webhooks/whatsapp verifies hub.mode=subscribe and hub.verify_token and returns the numeric
hub.challenge as plain text. Invalid verification returns 403.
POST /webhooks/whatsapp authenticates x-hub-signature-256 against the exact raw body with
HMAC-SHA256 and timing-safe comparison, then parses JSON. Invalid/missing signatures return 401;
invalid JSON returns 400. The route is registered before general JSON parsing and website CORS.
Only events for the configured phone-number ID are accepted. Status-only/unsupported events are
acknowledged and ignored. Supported inbound types: text, interactive button_reply and list_reply.
No receipt/status event initiates Shopify work. Bodies are capped at 256KB. Messages outside the
last 24 hours or implausibly in the future are ignored.

### Conversation flow

Initial state is IDLE conceptually; a greeting/restart creates WAITING_FOR_LIST without Shopify
access. A likely list sent as the first message also works directly. Commands:
- היי / שלום / תפריט / הזמנה / התחלה: introduction and restart
- שינוי / שינוי הרשימה: discard the active interaction and request a full updated list
- ביטול: delete the active session
- הסר מהרשימה: remove the currently prompted unresolved item and create a fresh quote
- אישור: explicit confirmation, allowed only in WAITING_FOR_CONFIRMATION

WAITING_FOR_RESOLUTION sends a Hebrew summary followed by options for the first unresolved
item. The list has up to nine purchasable candidates plus a removal action. Longer product
titles appear in descriptions and the summary; Meta field lengths are bounded. No unavailable
variant is selectable. A customer may edit the complete list instead. Not-found and unavailable
items can be removed but are never substituted. The shared parser still limits lists to
4000 characters, 20 items, quantity 20 per variant and 100 total units.

Selection IDs are opaque UUIDs stored in that customer's session with quote ID, revision,
item index and trusted Shopify variant ID. Incoming option titles/prices are ignored. Old,
foreign or expired choices cannot authorize another quote. Each new rendered revision replaces
old choices. The summary and controls must be delivered before confirmation is enabled.

WAITING_FOR_CONFIRMATION offers אישור, שינוי הרשימה, ביטול. Only explicit confirmation invokes
the shared checkout service with server-held IDs/quantities. No cart is created during quote
or resolution. QUOTE_CHANGED sends the new quote and requires another explicit confirmation.
CHECKOUT_READY stores the returned Shopify checkout URL before sending it; repeating אישור
resends that same URL without creating another cart. No URL shortener or custom payment page.
CHECKOUT_UNCERTAIN blocks repeated cart mutation after uncertain failure; customer must request
a new list. Backend prices, line totals and subtotal are used directly; no channel price math.

### Queue, privacy and operational limits

Validated messages are acknowledged promptly; processing runs asynchronously with four workers,
a 100-message queue and per-customer serialization. A full queue returns 503 so Meta can redeliver.
Dedup claims occur before processing; duplicate IDs are ignored. A per-customer limit of ten
messages per minute bounds abuse. No automatic Meta-send retries are performed, including 429,
network errors and ambiguous timeouts. Customer actions must be recent inbound messages; this
MVP sends no proactive/template campaigns or messages outside the service conversation.

The abstract WhatsAppSessionStore can be replaced with Redis/database. The current memory
implementation holds at most 500 sessions (15-minute quote/session expiry), 10,000 dedup IDs
(24-hour expiry) and 1,000 short-lived rate buckets. It stores only the current quote reference,
revision, state, unresolved indices, opaque action mappings, latest message ID and optional
checkout URL; no complete conversation history. Customer keys are hashed at rest in the map.
The existing bounded quote service retains the current shopping data until its own expiry.
Phone numbers and inbound messages exist transiently in the queue and outbound requests but
are never written to normal logs. Errors log only a static failure label, never exception data.

Render restarts lose sessions, deduplication, pending jobs and quotes. This queue is not durable:
an acknowledged message may be lost during restart/deploy. Run one process/instance for MVP.
Before scaling or requiring reliable delivery, replace sessions, dedup/rate limits, quote storage,
queue and cart locks with shared durable implementations. Do not treat hashing as anonymization.
No production Meta or Shopify calls are made by automated tests.

### Validation and protocol references

Run npm run build and npm test. tests/whatsapp.test.ts mocks both providers and covers raw
verification, ACK timing, duplicate messages, greetings, quote rendering, opaque selections,
unavailable/removal, confirmation, checkout URL, price reconfirmation, cancellation, privacy,
per-customer serialization, send/cart failures, session expiry and website compatibility.

Meta protocol references:
- https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
- https://www.postman.com/meta/whatsapp-business-platform/request/r3ufenw/send-list-message
- https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
The archived SDK reference documents the wire protocol; no archived SDK dependency is installed.
