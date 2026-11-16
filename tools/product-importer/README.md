# Fankee barcode product importer

Private Node.js 22+ / TypeScript tool with a Hebrew RTL UI. Cheapersal supplies metadata only.
Image discovery is separate. Only confirmation of product creation writes a Shopify DRAFT.
Existing products, selling prices, inventory quantities and publication are never synchronized automatically.

## Local setup

From the repository root (PowerShell):

```powershell
cd tools/product-importer
npm ci
# First setup only. Do not replace an existing .env containing your credentials:
Copy-Item .env.example .env
```

Edit the existing .env privately; never put credentials into Liquid, theme settings or browser code.

- CHEAPERSAL_API_KEY: obtain through [Cheapersal developers](https://cheapersal.co.il/developers).
- SHOPIFY_STORE_DOMAIN: canonical your-store.myshopify.com domain without a protocol/path.
- SHOPIFY_ADMIN_ACCESS_TOKEN: an Admin token for an installed app with
  read_products,write_products,read_files,write_files scopes.
- Alternatively, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET: the server obtains and refreshes
  tokens for an installed app belonging to the same Shopify organization as the store.
  See [Shopify client credentials](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant).
  Other merchants require OAuth installation and its resulting Admin token.
- SHOPIFY_TRACK_INVENTORY=false initially; enable only after checking your inventory workflow.
  Location activation and inventory quantities remain manual in Shopify.
- PORT=4310 by default.
- IMPORTER_USERNAME and IMPORTER_PASSWORD are required, including locally. Use a unique password of at least 12 characters.

```powershell
npm run dev
```

Open **http://127.0.0.1:4310** and sign in. The existing dev command reads your local
.env; production does not need that file. The server listens on 0.0.0.0 and validates the
configured application origin. For a local compiled run, use npm run build followed by
node --env-file=.env dist/server.js.

## Render deployment

Create a Node Web Service with **Root Directory: tools/product-importer**.
Use Node 22 (package.json pins 22.x).

- Build Command: npm ci --include=dev && npm run build
- Start Command: npm start (runs node dist/server.js)
- Health Check Path: /health

TypeScript compiles src/server.ts to dist/server.js (rootDir=src, outDir=dist).
The public UI stays in public/ and is resolved correctly from the compiled server.
Do not configure a static-site service. Do not upload .env.

Set these variables privately in Render's Environment panel:

| Variable | Requirement |
| --- | --- |
| NODE_ENV | production |
| IMPORTER_USERNAME | Required single-admin username |
| IMPORTER_PASSWORD | Required unique strong password, at least 12 characters |
| CHEAPERSAL_API_KEY | Required metadata provider credential |
| SHOPIFY_STORE_DOMAIN | Required canonical store.myshopify.com hostname |
| SHOPIFY_ADMIN_ACCESS_TOKEN | Shopify Admin token; or use both client credential variables below |
| SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET | Alternative supported Shopify authentication |
| APP_ORIGIN | Optional with Render's automatic RENDER_EXTERNAL_URL; required for a custom domain, e.g. https://shopify-dawn-theme.onrender.com |

Render provides PORT and RENDER_EXTERNAL_URL. Binding is 0.0.0.0; local development
still uses http://127.0.0.1:4310. An explicit APP_ORIGIN must exactly match the browser's
origin and must use HTTPS in production. No trailing paths or credentials are allowed.
Production trusts one ingress proxy for HTTPS detection; keep the service behind Render's
managed ingress.

Optional provider and feature variables are documented below and listed in .env.example:
PRODUCT_IMAGE_PROVIDER, PRODUCT_IMAGE_PROVIDER_ORDER, GOOGLE_IMAGE_PROVIDER,
SERPAPI_API_KEY, BARCODE_LOOKUP_API_KEY, GO_UPC_API_KEY, PRODUCT_IMAGE_API_KEY,
PRODUCT_IMAGE_API_URL, PRODUCT_IMAGE_PREFERRED_DOMAINS, PRODUCT_IMAGE_APPROVED_DOMAINS,
PRODUCT_IMAGE_APPROVED_PROVIDERS, SERPAPI_GL, SERPAPI_HL, SERPAPI_LOCATION, SHOPIFY_TRACK_INVENTORY.
Blank API keys skip those optional paid providers. See **Product image source policy**.

Local login accepts the exact http://127.0.0.1:4310 origin by default; localhost is a
different origin. Blank/whitespace APP_ORIGIN falls back to RENDER_EXTERNAL_URL or the
local default. The login page uses Referrer-Policy: same-origin so native form posts
send their real Origin instead of null. All other pages retain no-referrer.
Origin:null, missing POST Origin, foreign hosts and cross-site requests remain rejected.
Development 403 diagnostics log only fixed rejection reasons, never request values.
After a server update, reload /login before submitting an already-open form.

Login credentials are checked only on the server. A random opaque session is stored
server-side for eight hours; the browser receives a host-only HttpOnly, SameSite=Strict
cookie, Secure in production. API writes, including logout, also require a session-bound
CSRF token and the configured Origin. Anonymous API calls receive 401 JSON. GET / renders login HTML for anonymous visitors
and importer HTML for authenticated sessions. GET /login, login styles and minimal /health
are public. External-link navigation to these public pages is allowed; login POST and
protected endpoints still enforce the configured origin. POST /logout revokes the session
with CSRF protection; /api/logout remains a compatible alias. Other private UI requests
redirect to /login.
Failed login attempts are rate limited. Use the UI's logout button to revoke the session.

Run **one instance/worker per store**. Sessions, previews, caches, and the existing import
lock are in memory. Restarts/deploys log the admin out and discard pending previews.
Horizontal scaling requires shared session/preview storage and a distributed import lock;
it is intentionally outside this single-admin deployment.

Only public/ is served, behind login. Server source, .env and dist/ are never served.
Browser code calls same-origin importer endpoints, not provider or Shopify Admin APIs.
Provider error bodies/stacks are not returned, and credential-like fields/known secret
values are removed from JSON responses as defense in depth. No environment dump is logged.

Before deployment run npm install, npm run build, and npm test. All external APIs are
blocked in automated tests; security tests use fake credentials and local HTTP only.

## Provider configuration

Add or update these variables in your existing .env, keeping Cheapersal/Shopify credentials:

```dotenv
PRODUCT_IMAGE_PROVIDER=auto
PRODUCT_IMAGE_PROVIDER_ORDER=barcodelookup,go-upc,open-products-facts,upcitemdb,serpapi,authorized-api
BARCODE_LOOKUP_API_KEY=
GO_UPC_API_KEY=
GOOGLE_IMAGE_PROVIDER=
SERPAPI_API_KEY=
PRODUCT_IMAGE_API_KEY=
PRODUCT_IMAGE_API_URL=
PRODUCT_IMAGE_PREFERRED_DOMAINS=
PRODUCT_IMAGE_APPROVED_DOMAINS=
PRODUCT_IMAGE_APPROVED_PROVIDERS=
```

Blank order uses the default shown above. Keys left blank skip paid providers.
Use PRODUCT_IMAGE_PROVIDER=none to disable automatic lookup. The legacy upcitemdb setting now uses
the configurable chain too. PRODUCT_IMAGE_PROVIDER=authorized-api retains its standalone behavior
unless an explicit provider order is supplied.

| Provider | Key/configuration | Lookup | Selection / heuristic confidence |
| --- | --- | --- | --- |
| Barcode Lookup | BARCODE_LOOKUP_API_KEY | Exact barcode, products[].images | Discovery-only by default; automatic only if approved, 0.95 |
| Go-UPC | GO_UPC_API_KEY | Exact barcode, Bearer authentication, product.imageUrl | Discovery-only by default; automatic only if approved, 0.95 |
| Open Products/Beauty/Food Facts | No key | Universal API v3 with product_type=all | Discovery-only by default; automatic only if approved, 0.90 |
| UPCitemdb | No key for trial endpoint | Exact barcode, items[0].images | Discovery-only by default; automatic only if approved, 0.90 |
| Google Images through SerpAPI | GOOGLE_IMAGE_PROVIDER=serpapi and SERPAPI_API_KEY | Localized exact barcode, then barcode/manufacturer, then manufacturer/title only while empty | Discovery-only; automatic only for an approved image domain, 0.50 |
| Your authorized API | PRODUCT_IMAGE_API_URL and PRODUCT_IMAGE_API_KEY | GET template with {barcode}, X-API-Key | Approved, automatic, 0.90 |

Confidence is a rough provider heuristic, not a measured probability. Low-confidence/search results
never become automatic selections, even if only one result is returned. Usage approval is a separate
check: see **Product image source policy**. An exact-barcode response
with an explicit conflicting identifier is rejected.

Official documentation used for the adapters:

- [Barcode Lookup](https://www.barcodelookup.com/api-documentation)
- [Go-UPC](https://go-upc.com/docs)
- [Open Facts universal product lookup](https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/scanning-cosmetics-pet-food-and-other-products/)
- [UPCitemdb trial](https://www.upcitemdb.com/wp/docs/main/development/getting-started/)
- [SerpAPI Google Images](https://serpapi.com/images-results)

Open Facts follows only HTTPS API redirects between the four official world.* Facts hosts,
so household and beauty records can be found on their own database instances. It sends a custom
User-Agent. Its image fields are tried as image_front_url, image_url, then selected_images.front.
No retailer pages or Google HTML are fetched for scraping.

For your own authorized API, set an HTTPS template such as
https://your-authorized-api.example/products/{barcode}/image (a placeholder, not a real vendor).
The expected JSON contract is {"imageUrl":"https://..."}; null/404/204 means no image.
Vendor-specific formats can be added by implementing ProductImageProvider.
Never include secret API keys in the returned image URL.

Optionally set PRODUCT_IMAGE_PREFERRED_DOMAINS to comma-separated verified manufacturer/brand
domains. SerpAPI candidates from those domains rank first, then product results and larger
reported dimensions. Domain ranking never proves ownership or grants reuse rights.
Check the source page and the provider/image licensing terms before publishing. Source page
links, image origin and confidence are shown in the preview when available.

## Product image source policy

This is an application safeguard against accidentally attaching images whose usage permission is
unknown. It is not legal advice, and an approved classification is not a statement about rights.

- Product images are attached automatically only from approved sources.
- Google/SerpAPI is discovery-only. A search result can be attached automatically only when the
  image's own HTTPS hostname is on an approved domain; the page that shows it does not count.
- Barcode Lookup, Go-UPC, Open Facts and UPCitemdb are discovery-only by default. Their responses
  verify the barcode, not permission to reuse the images. Approve one only if your agreement with
  that provider covers using its images in your store.
- Your own authorized API (PRODUCT_IMAGE_API_URL) remains approved.
- Unapproved results are kept as candidates and the provider chain continues, so a later approved
  provider can still supply the image. A found image is not the same as a safe-to-attach image.
- Using a candidate from an unapproved source, or a manual image URL, requires the admin to check
  **אני מאשר/ת שיש לנו הרשאה להשתמש בתמונה הזו**. The confirmation is held server-side for that
  one image in that one preview. It is never saved for a domain and never reused in a later preview.
- Products may be created without an image. Metadata found with no approved image creates a valid
  draft without media.
- Before the Shopify mutation, the server checks the final validated URL again. A redirect off an
  approved domain, or any change to a confirmed image's URL, stops the import with a message.
  Browser-supplied approval flags are ignored.
- Existing Shopify products and their images are never changed.

Configuration (all optional; blank values never stop the importer from starting):

```dotenv
# Bare hostnames, comma-separated. Subdomains are included: officialbrand.co.il also covers
# images.officialbrand.co.il, but never officialbrand.co.il.evil.example.
PRODUCT_IMAGE_APPROVED_DOMAINS=officialbrand.co.il,examplemanufacturer.com
# Providers approved as a whole. Blank means authorized-api only.
PRODUCT_IMAGE_APPROVED_PROVIDERS=
```

Entries are trimmed and lowercased. Empty values, URLs, paths, ports, IP addresses, single labels
and shared hosting suffixes (for example co.il, cdn.shopify.com, cloudfront.net) are ignored.
Approving a shared CDN would approve every site on it. PRODUCT_IMAGE_PREFERRED_DOMAINS still only
ranks search suggestions and grants no approval. serpapi and manual cannot be approved as providers.

Each image decision logs one line with the action, provider, source domain (hostname only),
policy, autoAttach and whether it was attached, for example
`[image] action=discover provider=serpapi domain=example.com policy=DISCOVERY_ONLY autoAttach=false attached=false`.
Full image URLs, query strings and API keys are never logged.

## Uploading your own product image

1. Enter the barcode and price as usual.
2. Attach a photo under **תמונת מוצר** (JPEG, PNG or WebP, up to 10MB and 8000 pixels per side).
3. Check **אני מאשר/ת שיש לנו הרשאה להשתמש בתמונה הזו**. Nothing is sent without it.
4. Click **חיפוש מוצר**. Metadata is looked up as before; the image provider chain is skipped
   because an approved upload takes priority. The photo is processed and shown side by side:
   **תמונה מקורית** and **תמונה מותאמת לאתר** (on a checkerboard; the file itself is transparent),
   with dimensions, format, size and background status, for example `1200×1200 · PNG · רקע שקוף`.
5. Choose **השתמש בתמונה המותאמת** (default when background removal succeeds),
   **השתמש בתמונה המקורית**, **בחר תמונה אחרת** (new file, new confirmation), **המשך ללא תמונה**,
   or **הסר תמונה וחפש במקורות** to discard the upload and run the normal provider chain.
6. Click **צור מוצר ב-Shopify** to create the draft with the chosen image.

Images are processed **without generative AI**. Nothing is redrawn, regenerated, recoloured or
completed. The pipeline only: applies EXIF orientation, removes all metadata (GPS, device, serial,
timestamps), converts to sRGB, removes the background, trims transparent margins, scales
proportionally (`fit: inside`; never stretched, never cropped) and centres the product on a
transparent 1200×1200 PNG. Square items fill 80% of the canvas, tall or wide items up to 88%.
The original choice is only re-oriented, metadata-stripped and re-encoded (JPEG quality 92, 4:4:4;
PNG lossless; WebP quality 92), limited to 4096px on the long side.

Background removal (`EdgeBackgroundRemover`, replaceable through `BackgroundRemovalService`) is
deterministic and local: it estimates the backdrop colour from the image border, then removes only
backdrop-coloured pixels connected to the border, stopped by product outlines. Pixel colours are
never changed; only transparency is set, with a narrow anti-aliased edge and no erosion. Enclosed
gaps (inside a handle) are kept rather than risking product loss. Photos on a busy or non-uniform
background are reported as **לא הצלחנו להסיר את הרקע אוטומטית.**; the original, another photo or no
image remain available, and product creation is never blocked. Uncertain results show a comparison
warning. Already-transparent PNG/WebP files keep their own alpha. Best results: one product on a
plain light background, filling most of the frame.

Security and storage: the file type is detected from its content (never the filename or browser
MIME type); SVG, GIF, PDF, HEIC, animated and corrupt files are rejected; sizes are checked from the
header before decoding (decompression bombs are refused). Bytes are sent as a raw request body to
`POST /api/image-upload` with the session's CSRF token, the preview id and the
`X-Usage-Confirmed: true` confirmation. They are kept in memory only (never on Render's disk), at
most 10 open uploads, one processed at a time with a short queue, and released after import,
removal, replacement or the 30-minute preview expiry. The confirmation is bound to that preview,
that upload id and the SHA-256 of each produced variant; import re-verifies all three. A new upload
discards the previous upload and its confirmation. Previews are served only to the logged-in admin.

Shopify receives uploaded bytes through the official staged upload flow (Admin GraphQL 2026-10):
`stagedUploadsCreate` (resource `IMAGE`, `POST`) returns a signed Shopify staging target; the server
POSTs the verified bytes there as multipart form data (the Admin token is not sent to the target);
the returned `resourceUrl` is passed to the existing `productSet` `files.originalSource`. No local
or Render URL is ever exposed to Shopify. The existing `write_files`/`write_products` scopes are used.
A staging failure stops before the product mutation, so the import can be retried.

No new environment variables are required.

## Preview and candidate selection

1. Restart the importer after editing .env.
2. Enter **7290108356472** and price **15.90**, then click **חיפוש מוצר**.
3. Check Cheapersal's title, manufacturer, category, unit quantity, barcode and your price in
   the Shopify store currency. No price or description is taken from image providers.
4. The first high-confidence image from an approved source may be selected automatically
   (**מקור תמונה מאושר**). **בחר תמונת מוצר** shows up to five thumbnails with
   **תמונה נמצאה דרך** (source-page domain), provider, source-page links and radio controls.
   A selection is checked server-side and becomes the preview image.
5. Candidates from sources that are not approved are labelled **תמונה לבדיקה** and start unselected.
   Choosing one opens a review panel with the source and the checkbox
   **אני מאשר/ת שיש לנו הרשאה להשתמש בתמונה הזו**; **השתמש בתמונה** is enabled only after it is checked.
   **חפש תמונה אחרת** returns to the list. Clicking a candidate does not upload it or create a Shopify product.
6. If no approved image is found, paste an HTTP/HTTPS image URL into **תמונה חלופית**, check the same
   permission checkbox and search again. The request is rejected without it. A manual URL is used
   after automatic providers fail. **המשך ללא תמונה** explicitly clears a selection.
7. Click **צור מוצר ב-Shopify** only when ready to create a draft. No selection is also a valid
   no-image import. The result shows the product ID, barcode, title and Shopify Admin link.

The actual provider used appears under **מקור תמונה**; it depends on API coverage, your configured
keys/order and your selection. Availability for a particular barcode is not guaranteed.
Other manual test examples: 7290012823626 and 7290005427107. Examples are never production constants.

Selections use a server-held preview ID and candidate index, so the browser cannot substitute
an arbitrary candidate URL on confirmation. Selections are cached by barcode with their timestamp
for the current local workflow; only approved-source selections and "no image" are restored in a
later preview, never an earlier permission confirmation. Expired, completed and busy previews reject edits.
Changing the lookup form invalidates its preview. The browser restores the previous server
selection when a selection request fails.

## Image validation and Shopify media

HTTP/HTTPS URLs reject credentials, nonstandard ports, IP literals and local names.
DNS results must be public and are pinned for each image connection; redirects are checked again.
A bounded GET range probe reads at most 64 KiB and requests image content. It validates raster
Content-Type when available, rejects HTML disguised as images, obvious tracking URLs, and
reported file sizes below 128 bytes or above 20 MiB. PNG/GIF/JPEG/WebP dimensions are read from
available headers; known dimensions below 64 pixels on either side, excessive dimensions and
excessive pixel counts are rejected. Unknown/truncated dimensions are reported as unverified.
Hosts that block probing or time out yield a visible verification warning.
These checks cannot guarantee the final response from a remote host; the selected image is
checked again before import, and Shopify validates/processes the actual media.

Shopify's existing productSet files.originalSource (IMAGE) handling copies the selected file into
Shopify Files/product media. The storefront uses Shopify-hosted media. Processing is asynchronous;
inspect the draft's media before publication. Missing images do not block product creation.
A rejected or inaccessible supplied image may still require manual correction in Shopify.
Mutations are never blindly retried.

## Cache, quota and error behavior

The replaceable MemoryCatalogCache is shared as an abstraction across metadata and image lookups.
Each provider has isolated keys/caches. API payloads, normalized discoveries and candidate lists
have a one-hour TTL; confirmed user image preferences include a timestamp and the selected source.
Empty whole-chain results and transient request failures cache for one minute.
Concurrent requests for the same barcode share a lookup. Image validation may repeat while
cached paid API calls do not. Restart clears caches and cooldowns.

HTTP 429 pauses that provider for at least one minute and honors longer Retry-After values.
Auth failures also pause briefly. Go-UPC and Barcode Lookup requests are conservatively spaced;
Open Facts starts at most one new logical lookup per four seconds. A lookup inside a spacing
window falls through to the next provider instead of issuing extra calls. Each provider's failures
or malformed JSON advance the chain. There are no aggressive retries or background calls.
Only after automatic options fail does the preview show **לא נמצאה תמונה אוטומטית למוצר**.

## Shopify behavior

- Duplicate detection scans all variant pages for exact barcode values, avoiding search-index
  delays. Existing products are returned without changes. Only one local import runs at a time.
  External writers/multiple processes still require a distributed store-wide lock.
- Server previews retain metadata, manually entered price and currency for 30 minutes.
  Repeated confirmation returns its prior result. An uncertain mutation cannot be retried
  with the same preview; inspect Shopify first.
- GraphQL Admin API 2026-10 creates a DRAFT with title, vendor, escaped plain-text external
  description when present, one variant, your entered price and barcode. No inventory quantities
  or publication commands are sent.
- No collection is assigned automatically. Choose collections manually in Shopify.
- Existing custom metafield definitions are inspected and never changed. Compatible typed values:
  catalog_source, external_barcode, catalog_category (if supplied), catalog_last_sync.
  Conflicting definitions require manual review.

## Checks and diagnostics

```powershell
npm run typecheck
npm test
npm run build
```

The test runner blocks external fetch/http/https requests and permits only local test servers.
Provider, quota, fallback, confidence, selection, validation and Shopify tests use mocks.
No real image provider or store credentials are needed for automated tests.

Optional metadata diagnostic (one real Cheapersal request, field names/types only):

```powershell
npm run inspect:catalog -- 7290108356472
```

## Files changed for multi-provider discovery

Added:
- src/image-types.ts: provider/result/candidate/discovery contracts.
- src/image-api.ts: per-provider API cache, throttling and error handling.
- src/image-validation.ts: public URL, bounded content and dimension checks, moved from images.ts.
- src/image-providers.ts: Barcode Lookup, Go-UPC, Open Facts and SerpAPI adapters.
- tests/providers.test.ts: mocked chain, candidate and validation coverage.
- tests/block-external-http.cjs: external HTTP guard.

Modified:
- src/images.ts: composite provider, configured factory and compatibility exports.
- src/upcitemdb.ts: confidence and shared image validation imports.
- src/importer.ts: discovery, server-held candidates, selection and preview state.
- src/server.ts: CSRF-protected image selection endpoint.
- public/index.html / public/app.js / public/style.css: Hebrew image selection UI.
- .env.example: placeholder keys and configurable order.
- package.json: guarded test runner.
- tests/images.test.ts / tests/upcitemdb.test.ts: updated API/default/confidence expectations.
- README.md: setup and behavior.

Existing .env credentials and storefront/theme files are left untouched. No automatic commit,
push, publication or product import is performed.

## Israeli SerpAPI image search

The previous adapter already read images_results (not shopping_results), but did not specify a
locale or check product-name/manufacturer overlap. Domain, size and is_product ranking could
therefore accept unrelated US products, and a second search ran even after one valid result.

Project defaults are explicit, configurable and independent of the proxy/server location:

```dotenv
SERPAPI_GL=il
SERPAPI_HL=he
SERPAPI_LOCATION=Israel
```

Every search sends engine=google_images, q=<query>, gl=il, hl=he, location=Israel, safe=active,
and the API key server-side. Only images_results is read; shopping_results is never used.

For barcode 7290108356472 the exact first q is 7290108356472. If no relevant usable originals
remain after filtering/validation, the next q is the barcode plus manufacturer. Only if still
empty is manufacturer plus the original Cheapersal title tried. No category, price, generic
English product query or translation is appended. Even one accepted candidate stops the search.
A successful exact-barcode search normally costs one SerpAPI request; a cached repeat costs zero.
There are at most three distinct fallback queries, fewer when metadata is missing.

Relevance uses normalized Hebrew/Unicode product-title tokens and manufacturer, barcode context,
Israeli .il source domains, preferred domains, is_product and useful dimensions. Generic category
words alone do not establish a match. Candidates with no meaningful product overlap are rejected,
regardless of domain or dimensions, and a minimum score applies before image validation.
This is a heuristic filter, not a guarantee that an image is the exact product variant.
The picker remains manual for Google results and displays result titles beside source domains.

The validated original is the final image URL. The API thumbnail is used only in the picker
when it is a valid public-format HTTP/HTTPS URL; otherwise the original is used for preview.
Candidate normalization preserves that distinction. Shopify never receives a thumbnail in place
of an available original. Candidates/results cache by provider, barcode and locale (including
location and the metadata used for scoring); concurrent previews share a lookup.

Set NODE_ENV=development before starting locally to enable sanitized query, locale,
images_results count, accepted count and rejected count diagnostics. These logs omit the
request URL, raw API response and API key. Production emits no such diagnostics.

Restart npm run dev after updating code/configuration. Test 7290108356472, 7290012823626 and
7290005427107 through the Hebrew preview. Look for the intended product title and source domain;
results should exclude unrelated paint, bathroom accessories and drink bottles. A localized
API search cannot exactly reproduce personalized Google browser results, and coverage may vary.
The automated tests mock SerpAPI and block external HTTP; live checks require your configured key.
