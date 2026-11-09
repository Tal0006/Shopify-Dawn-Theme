# Fankee Group Delivery - Phase 1

Independent Node.js/TypeScript service in `tools/group-delivery`. Production state lives in PostgreSQL through `pg`; Shopping Assistant and Product Importer are not dependencies.

This phase records nonbinding, unpaid cart intentions. Reaching the target changes OPEN to THRESHOLD_REACHED. Merchant review can change THRESHOLD_REACHED to APPROVED. Approval never creates a payment, checkout, Draft Order, shipping rate or delivery. APPROVED groups are frozen to member changes in this phase.

## Local development and Render

Use Node 22 (Node 24 is also supported) and PostgreSQL 15+.

1. In this directory, run `npm ci`.
2. Copy `.env.example` to an untracked `.env` and configure the variables below.
3. Run `npm run dev`. The server binds `0.0.0.0` and defaults to port 4330; open `http://127.0.0.1:4330/admin`.
4. Check `GET /health`.
5. Run `npm run build` and `npm test`.

For Render:
- Create a separate web service; root directory: `tools/group-delivery`.
- Attach a durable PostgreSQL database, using its private/internal connection URL as DATABASE_URL. Use verified TLS when using an external database connection; do not disable certificate verification.
- Build command: `npm ci --include=dev && npm run build`.
- Start command: `npm start` (`node dist/server.js`).
- Health path: `/health`.
- Set NODE_ENV=production, APP_ORIGIN to the exact HTTPS service origin without a trailing slash, and TRUST_PROXY_HOPS=1 for Render's managed ingress.
- Configure database backups/access controls using the hosting provider.
- Every start runs numbered migrations transactionally before listening. No manual SQL edits are required. Local manual migration command: `npm run migrate` (loads .env). Production manual command, if needed: `node dist/migrate.js`.
- Keep historical migration files immutable after deployment; add a new numbered migration for schema changes.

### Environment

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | PostgreSQL connection string; server only |
| APP_ORIGIN | Exact service origin; HTTPS required in production |
| STOREFRONT_ORIGINS | Comma-separated exact storefront/preview origins, including scheme; no wildcard |
| PORT | Hosting port, default 4330 |
| NODE_ENV | production on Render |
| TRUST_PROXY_HOPS | 0 locally; 1 only behind Render's trusted ingress |
| ADMIN_USERNAME | Single merchant account |
| ADMIN_PASSWORD | At least 16 characters; server only |
| SESSION_SECRET | At least 32 random characters; HMAC key for anonymous rate-limit identifiers |
| SHOPIFY_STORE_DOMAIN | Shop's myshopify.com domain; no protocol/path |
| SHOPIFY_STOREFRONT_API_VERSION | Default 2026-10; configure a supported Shopify stable version |
| SHOPIFY_STOREFRONT_PRIVATE_TOKEN | Private Storefront token; server only |
| STANDARD_DELIVERY_RADIUS_KM | Default 20 |
| GROUP_CLUSTER_RADIUS_KM | Default 7 |
| GROUP_THRESHOLD_ILS | Decimal ILS setting, default 500; parsed directly to integer agorot |
| GROUP_EXPIRY_DAYS | Default 7 |
| STORE_LATITUDE / STORE_LONGITUDE | Optional store origin pair for the advisory standard-radius result |

Shopify token scopes must include `unauthenticated_read_product_listings` and `unauthenticated_read_product_inventory` for quantityAvailable. Products must be published to the Storefront channel used by this token. See [Shopify scopes](https://shopify.dev/docs/api/usage/access-scopes).

No Shopify Admin token is needed in Phase 1. Never put private tokens, admin credentials, database URLs or SESSION_SECRET in Theme Editor.

## Storefront installation

1. Deploy the service and add the exact store domain(s) and any HTTPS preview origin to STOREFRONT_ORIGINS. Use a local development service for HTTP localhost previews.
2. In Shopify, create a Page and assign the `group-delivery` page template.
3. The Group Delivery section uses its explicitly configured Service URL, otherwise the public https://fankee-group-delivery.onrender.com origin. Keep the Theme Editor setting to override this for another deployment. The fallback also applies to fresh draft and visitor-preview themes without saved section settings. This URL is public configuration, not a credential. The service still requires each exact storefront/preview origin in STOREFRONT_ORIGINS; a working fallback does not bypass CORS. Page selection continues to use the configured Shopify page, otherwise the published group-delivery page.
4. Add a navigation link to that Page through Shopify's existing navigation editor if desired.
5. Test with actual Storefront-published variants in a development theme before launch.

The section can also be added through Theme Editor as a reusable section. No homepage, navigation links or existing commerce behavior are automatically changed.

Geolocation runs only after an explicit button click. The customer still supplies a locality; no external geocoder or exact delivery address is used. Coordinates are rounded to two decimals in the browser and again on the server. A location/permission failure leaves manual locality entry available.

The browser reads the current Shopify Ajax cart without changing it. Non-ILS carts, selling-plan allocations and custom line properties are unsupported in this MVP. The validator additionally rejects component bundles and required purchase plans. Empty carts cannot join. A member with a receipt can submit an empty cart to withdraw an existing pledge before approval.

The visible cart total comes from Shopify Ajax. The **verified pledge** uses current Storefront IL/ILS variant prices times quantities, before shipping and cart-dependent discounts. The UI explicitly distinguishes these values and shows the verified amount. No formatted-price parsing or client-provided total is trusted. Intent snapshots are not inventory reservations; prices and stock can change.

Only opaque member receipts (group public ID + random bearer token + save time) are stored, one localStorage key per group under `fankee-group-delivery:<service origin>:receipt:<publicId>`, so closing the tab keeps membership and different groups never overwrite each other. A receipt from the earlier single sessionStorage key is migrated automatically, and the old copy is removed once the localStorage copy is confirmed. If localStorage is unavailable, sessionStorage is used for the tab. No contacts, coordinates, cart snapshots or payment data are stored. A receipt is deleted only when the service definitively rejects it (MEMBER_AUTH_REQUIRED or GROUP_NOT_FOUND); network/timeout/5xx, RATE_LIMITED, SHOPIFY_UNAVAILABLE and GROUP_CLOSED keep it. Receipt loss (for example, cleared site data) still has no unauthenticated recovery in Phase 1: the UI does not allow taking over membership using a known email address.

## PostgreSQL data model

- delivery_groups: internal/public UUIDs, public area label, normalized locality key, private fixed anchor and moving center, integer threshold/pledged/paid totals, status, expiry and timestamps.
- group_members: internal UUID, group FK, normalized email/phone, locality and rounded private coordinates, validated JSON cart snapshot, integer pledge, hashed bearer token, PLEDGED/WITHDRAWN state and timestamps. Per-group contact uniqueness prevents duplicate pledges.
- admin_sessions: hashed cookie token, CSRF nonce and expiry.
- request_limits: HMAC IP bucket identifiers and expiring counters.
- schema_migrations / schema_migration_lock and group_coordination: migration tracking and database coordination.

All money arithmetic is bigint/integer agorot. Public monetary fields are integer agorot and are capped below JavaScript's safe-integer limit. Paid totals are constrained to zero in Phase 1. Zero-pledge withdrawn members do not count as participants.

Every group mutation locks a shared coordination row inside a PostgreSQL transaction. This intentionally serializes the modest MVP write workload, including joins that create a group, joins, updates and approval, across service instances. Search is read-only and takes no lock. Group state is never kept in an application Map or process-local cache.

## Matching and lifecycle

Coordinate mode:
- Search OPEN, unexpired groups in a latitude prefilter; at most 500 candidates.
- Use Haversine distance to the immutable anchor and current center.
- Calculate a spherical mean of active member locations.
- Require all active members and the new location to remain within the cluster radius of the proposed center.
- Never move the anchor: a chain of nearby customers cannot walk a group indefinitely outward.
- Groups are created only by `POST /groups/join`, never by `/groups/find` (the deprecated legacy `find-or-create` route is the temporary exception for the previous theme). The match is repeated inside the lock, so two first joins for the same area produce one group with two members.

Text mode:
- Without coordinates, match only the same NFKC-normalized locality text.
- Text-only and coordinate groups do not silently merge. The 7 km guarantee applies only when coordinates exist.
- Different spellings/languages are not guessed to be the same city.

Thresholds and expiry are captured when a group is created. Nonzero pledge updates can move OPEN <-> THRESHOLD_REACHED. A zero update withdraws a member and may reopen the group. A matching group has capacity for at most 100 membership records. Merchant approval requires the stored threshold and freezes further member updates. There is no threshold override endpoint.

Expiry is evaluated from PostgreSQL NOW() during reads, matching, joining, updates, listing and approval; it does not depend on a browser timer. OPEN, THRESHOLD_REACHED and APPROVED groups expire. No background payment/shipping jobs run.

STANDARD_DELIVERY_RADIUS_KM is advisory only when store and customer coordinates exist. Without a configured store origin or coordinates, the API returns null, never fabricated delivery eligibility. Existing Shopify shipping rules are not changed.

## APIs

### Staged deployment (read-only search rollout)

The service now ships both the new routes and a **deprecated** legacy route, so it is safe to deploy before the theme.

1. **Deploy the backend first.** The currently live theme keeps working through `POST /groups/find-or-create`.
2. **Verify `/groups/find` exists:** `POST https://<service>/api/v1/groups/find` with `Origin: <store origin>`, `Content-Type: application/json` and `{"location":{"areaName":"<town>"}}` must return 200 with a `group` field (often `null`) and `canCreateOnJoin`, not 404.
3. **Test the new theme on a Development Theme.** It calls `/groups/find` and `/groups/join`; searches there create nothing.
4. **Publish the new theme.**
5. **Verify production traffic uses `/groups/find`.** Legacy responses carry a `Deprecation: true` header; confirm in the Render request logs (or browser DevTools on the live store) that storefront searches hit `/groups/find` and `find-or-create` traffic has stopped, allowing for cached old pages.
6. **Later cleanup:** remove the legacy route (`legacyFindOrCreate` in `src/groups.ts` and its route in `src/server.ts`), its test, and the theme's `search()` fallback in `assets/group-delivery.js`.

Until step 6, `find-or-create` deliberately keeps the old create-on-search behavior for the old theme only, so old-theme searches can still create empty groups. Groups created by searches (before this change, or through the legacy route) remain in the database as historical data; they are not migrated or deleted.

All JSON bodies are limited to 24 KiB. State-changing public API requests require a configured Origin and application/json. Locality is `{areaName,lat?,lng?}`. Cart lines are `[{variantId:"123456789",quantity:2}]`; Shopify GIDs are also accepted.

| Method | Path | Behavior |
| --- | --- | --- |
| POST | /api/v1/groups/find | Body: location, optional lines. Read-only: never creates a group or writes. Returns `group` (or `null` when no compatible group exists), `canCreateOnJoin` (true when `group` is null), nullable withinStandardRadius and optional validatedPledgeAgorot. |
| POST | /api/v1/groups/join | Body: location, email, phone, lines. Joins the area: under the coordination lock it expires stale groups, re-matches, joins a compatible group or creates one with this shopper as its first member, all in one transaction. Returns 201 with group, `created`, private memberToken and validatedPledgeAgorot. |
| POST | /api/v1/groups/find-or-create | **DEPRECATED, scheduled for removal** once the new theme is live (see Staged deployment). Legacy contract for the previous theme only: body as `/find`; always returns a non-null `group` (creating an empty group on a miss), withinStandardRadius and optional validatedPledgeAgorot; no `canCreateOnJoin`. Responds with `Deprecation: true`. |
| POST | /api/v1/groups/:publicId/join | Body: location, email, phone, lines. Joins a specific group the shopper was shown. Validates fresh Shopify data, then adds one membership; returns group, private memberToken and validatedPledgeAgorot. |
| GET | /api/v1/groups/:publicId | Aggregate only, no member authorization required. |
| POST | /api/v1/groups/:publicId/update-pledge | Body: lines, including [] for withdrawal. Requires Authorization: Bearer memberToken. Revalidates prices; returns group and own validatedPledgeAgorot. |
| GET | /health | Public status only |

Safe public group fields: publicId, areaName, status, participantCount, currency, thresholdAgorot, pledgedTotalAgorot, remainingAmountAgorot, progressPercent, expiresAt. Contacts, anchors, centers, member locations, cart snapshots, internal member IDs and membership receipts are absent from public GET responses. Receipt tokens are never accepted in a query string.

## Merchant review and security

Open /admin. Login uses ADMIN_USERNAME/ADMIN_PASSWORD checked on the server, following the repository's single-admin session pattern with PostgreSQL storage instead of an in-memory session Map.

- HttpOnly, SameSite=Strict, eight-hour sessions; Secure + __Host- cookie in production.
- Session and receipt tokens stored only as SHA-256 hashes.
- Exact-origin CSRF protection; per-session CSRF nonce required for approval/logout.
- CORS applies only to public API paths, never credentialed admin routes.
- Admin list prioritizes threshold-reached groups and shows up to 200 records with totals, counts and dates; no customer contacts.
- GET /admin/api/groups and POST /admin/api/groups/:publicId/approve require the admin cookie. Approval also requires X-CSRF-Token (available in the authenticated page's hidden form).
- Merchant HTML approval/logout forms submit CSRF directly.
- Rate limits in PostgreSQL: 20 public writes / 10 minutes / IP, 120 public reads / 10 minutes / IP, 10 admin login attempts / 15 minutes / IP.
- Parameterized SQL, validated inputs, fixed safe error messages, canonical host/TLS checks, narrow proxy trust and bounded request/variant counts.
- No customer bodies, contacts, exact coordinates, tokens, signatures or secrets are logged.
- Group/member records are durable; no business-data deletion policy is guessed. Choose a retention policy before wider rollout.

## Tests and limits

`npm test` uses an on-disk PGlite PostgreSQL engine with the real migrations and SQL, plus mocked Shopify responses. It tests DB restart persistence, duplicate/concurrent joins, anti-chain matching, money, empty-cart withdrawal, threshold changes, expiry, privacy, invalid carts, rate/body/origin limits, admin login, CSRF, approval, freeze and secure cookies.

Root `tests/group-delivery.browser.cjs` exercises the actual client script and section styling with mocked cart/service responses, explicit geolocation consent, durable per-group receipts and their migration and stale-receipt rules, the no-group-yet join flow, updates, failures, RTL, reduced motion and narrow widths.

No real Shopify API is consumed by automated tests. A live Render PostgreSQL instance, multi-process network concurrency, deployment credentials and real store variants are not part of the local fixtures. Run a staging smoke test against the deployed PostgreSQL/Shopify configuration before customer launch.

## Phase 2 integration points - intentionally not implemented

Add a new migration to support paid totals/payment member states and an explicit state machine beyond APPROVED. Before opening payment, revalidate stock, prices, currency, customer consent and the exact intended cart (including customizations/discount rules supported then). Bind each approved pledge revision to an idempotent Draft Order/payment record. Use verified Shopify webhooks and deduplicated payment events to update paid_total_agorot; do not treat pledge totals as paid totals. Scheduling/delivery confirmation and checkout links require separate, merchant-approved transitions.

No Shopify Admin calls, Draft Orders, payment links, checkout changes, shipping-rate changes, automatic charges or delivery creation exist in this phase.
