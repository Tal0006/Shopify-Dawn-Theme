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
| GROUP_THRESHOLD_ILS | Decimal ILS setting, default 500; parsed directly to integer agorot |
| GROUP_EXPIRY_DAYS | Default 7 |
| AREA_SUGGESTION_RADIUS_KM | Default 25 (1-100). Nearest-area suggestions beyond this distance return no area |
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

The shopper chooses a server-owned delivery area from an accessible, filterable combobox (`GET /api/v1/areas`). "שימוש במיקום שלי" is optional: only after that explicit click does the browser ask for permission, round the position to two decimals (about 1 km) and send it once to `POST /api/v1/areas/nearest`, which suggests and selects the closest active area or returns none. The coordinates are never stored, logged or sent to the group APIs; denied or unsupported location leaves manual selection fully usable. No external geocoder or delivery address is used.

The browser reads the current Shopify Ajax cart without changing it. Non-ILS carts, selling-plan allocations and custom line properties are unsupported in this MVP. The validator additionally rejects component bundles and required purchase plans. Empty carts cannot join. A member with a receipt can submit an empty cart to withdraw an existing pledge before approval.

The visible cart total comes from Shopify Ajax. The **verified pledge** uses current Storefront IL/ILS variant prices times quantities, before shipping and cart-dependent discounts. The UI explicitly distinguishes these values and shows the verified amount. No formatted-price parsing or client-provided total is trusted. Intent snapshots are not inventory reservations; prices and stock can change.

Only opaque member receipts (group public ID + random bearer token + save time) are stored, one localStorage key per group under `fankee-group-delivery:<service origin>:receipt:<publicId>`, so closing the tab keeps membership and different groups never overwrite each other. A receipt from the earlier single sessionStorage key is migrated automatically, and the old copy is removed once the localStorage copy is confirmed. If localStorage is unavailable, sessionStorage is used for the tab. No contacts, coordinates, cart snapshots or payment data are stored. A receipt is deleted only when the service definitively rejects it (MEMBER_AUTH_REQUIRED or GROUP_NOT_FOUND); network/timeout/5xx, RATE_LIMITED, SHOPIFY_UNAVAILABLE and GROUP_CLOSED keep it. Receipt loss (for example, cleared site data) still has no unauthenticated recovery in Phase 1: the UI does not allow taking over membership using a known email address.

## PostgreSQL data model

- delivery_groups: internal/public UUIDs, public area label, normalized locality key, private fixed anchor and moving center, integer threshold/pledged/paid totals, status, expiry and timestamps.
- group_members: internal UUID, group FK, normalized email/phone, locality and rounded private coordinates, validated JSON cart snapshot, integer pledge, hashed bearer token, PLEDGED/WITHDRAWN state and timestamps. Per-group contact uniqueness prevents duplicate pledges.
- admin_sessions: hashed cookie token, CSRF nonce and expiry.
- admin_audit (migration 003): admin actions and exports with safe metadata only; migration 004 adds subject (member id), previous_status and amount_agorot for member removals.
- group_members.withdrawn_at / withdrawn_by (migration 004): when and by whom (MEMBER or ADMIN) the pledge was withdrawn; cleared when the same row pledges again. Migration 004 marks earlier withdrawals as MEMBER (only receipts could withdraw then); their time stays NULL.
- request_limits: HMAC IP bucket identifiers and expiring counters.
- schema_migrations / schema_migration_lock and group_coordination: migration tracking and database coordination.

All money arithmetic is bigint/integer agorot. Public monetary fields are integer agorot and are capped below JavaScript's safe-integer limit. Paid totals are constrained to zero in Phase 1. Zero-pledge withdrawn members do not count as participants.

Every group mutation locks a shared coordination row inside a PostgreSQL transaction. This intentionally serializes the modest MVP write workload, including joins that create a group, joins, updates and approval, across service instances. Search is read-only and takes no lock. Group state is never kept in an application Map or process-local cache.

## Matching and lifecycle

The only flow is: choose an area → `POST /groups/find` (read-only; an existing group or the no-group state) → `POST /groups/join`, which creates the area's group only when none exists. Search never creates a group.

- A search or join for an area matches only that area's OPEN, unexpired group with fewer than 100 active (PLEDGED) members; area A never matches area B.
- Groups are created only by `POST /groups/join`. The match is repeated inside the coordination lock, so two first joins for the same area produce one group with two members.
- Direct joins (`POST /groups/:publicId/join`) require the group's own area.

Thresholds and expiry are captured when a group is created. Nonzero pledge updates can move OPEN <-> THRESHOLD_REACHED. An empty cart never changes a pledge: update-pledge rejects it with 422 EMPTY_CART_CANNOT_UPDATE_PLEDGE (an expired or cleared Shopify cart reads as empty). Withdrawal is a separate, explicitly confirmed request and may reopen the group; a withdrawn member keeps the receipt and can pledge again with a non-empty cart (same row, same receipt). Without the receipt there is no way back into that group yet: any join with an email or phone already in the group (withdrawn or not) is 409 ALREADY_JOINED, no row is reactivated and no token is issued (cross-device recovery will need OTP). Withdrawal keeps the last cart_snapshot as history only: it never counts toward the total, is never returned to the receipt (member read returns cart: []) and is replaced by the next explicit pledge. Member rows are never deleted. Capacity is 100 ACTIVE (PLEDGED) members per group; withdrawn rows hold no slot, and a group with 100 active members is skipped by the area join (a new group opens) and refuses direct joins (GROUP_FULL). Merchant approval requires the stored threshold and freezes further member updates. There is no threshold override endpoint.

Expiry is evaluated from PostgreSQL NOW() during reads, matching, joining, updates, listing and approval; it does not depend on a browser timer. OPEN, THRESHOLD_REACHED and APPROVED groups expire. No background payment/shipping jobs run.

STANDARD_DELIVERY_RADIUS_KM is advisory only: it compares the selected area's center with STORE_LATITUDE/STORE_LONGITUDE. Without a configured store origin, the API returns null, never fabricated delivery eligibility. Existing Shopify shipping rules are not changed.

## Delivery areas

`migrations/002_delivery_areas.sql` adds `delivery_areas` (internal id, public UUID, Hebrew name, immutable normalized slug, center latitude/longitude, active flag, sort order, timestamps), `delivery_area_aliases` (exact normalized spellings) and a nullable `delivery_groups.area_id` reference. It seeds באר שבע, אשדוד, אשקלון, קריית גת, נתיבות, אופקים and שדרות with fixed public IDs (idempotent, `ON CONFLICT DO NOTHING`), plus aliases such as `קרית גת`, `ashdod` and `kiryat gat`.

- **New groups** are always created inside a server-resolved active area: `area_id` is set, `area_name`/`locality_key` keep the area name and slug for display and admin, and no anchor or member coordinates are stored. The area is the whole grouping boundary; one open group per area at a time is the normal case.
- **Matching**: an area search or join matches only OPEN, unexpired, non-full groups with the same `area_id`. Area A never matches area B, and geolocation can only suggest an area: it never moves a shopper silently.
- **Inactive areas** disappear from `/areas` and nearest-area suggestions and reject new searches and joins (INVALID_AREA). Their existing groups stay readable, members can still update or withdraw, and admin approval still works.
- **Renaming** an area changes its display name for new groups and the list; the slug and existing groups (and their stored `area_name`) are not rewritten.

### Pre-areas groups

Groups created before delivery areas (free text and/or coordinates) are historical data: they are never deleted or rewritten.

- The `002` migration linked such a group to an area only when it was **text-only** and its stored `locality_key` **exactly** equalled an alias (no fuzzy, partial or distance-based matching). Linked groups take part in area matching like any other area group.
- Unlinked groups (`area_id` NULL: coordinate groups, unknown spellings, other towns) stay readable by public ID, existing members keep updating or withdrawing with their receipts (coordinate groups keep their fixed anchor/center bookkeeping), and admin approval still applies. Searches never return them and they accept no new members, so they wind down at expiry. The admin list labels them as legacy.

### Area admin

The `/admin/areas` page (same session, Origin and CSRF protection) lists all areas with edit forms and an add form: display name, center latitude/longitude, sort order and active flag. JSON equivalents: `GET /admin/api/areas`, `POST /admin/api/areas` and `POST /admin/api/areas/:publicId` (X-CSRF-Token). Duplicate names return 409 AREA_EXISTS; unknown areas 404 AREA_NOT_FOUND.

## APIs

Group creation happens only during Join. The previous create-on-search route (`POST /groups/find-or-create`) has been removed and now returns 404 NOT_FOUND like any unknown path; the storefront has no fallback to it.

All JSON bodies are limited to 24 KiB. State-changing public API requests require a configured Origin and application/json. Areas are referenced only by `areaPublicId`; free-text locations are rejected. Cart lines are `[{variantId:"123456789",quantity:2}]`; Shopify GIDs are also accepted.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | /api/v1/areas | Active delivery areas ordered by sort order, then name: `{areas:[{publicId,name}]}`. No coordinates or slugs. |
| POST | /api/v1/areas/nearest | Body: `{latitude,longitude}` (finite JSON numbers in range, otherwise 400 INVALID_COORDINATES). Returns `{area:{publicId,name}}` for the closest active area within AREA_SUGGESTION_RADIUS_KM, else `{area:null}`. Coordinates are used only for the computation: never stored, logged or echoed. Separate limit: 10 / 10 minutes / IP. |
| POST | /api/v1/groups/find | Body: `areaPublicId`, optional lines. Read-only: never creates a group or writes. The service resolves the active area; free-text names are not accepted (400 INVALID_AREA). Returns `group` (or `null` when the area has no open group), `canCreateOnJoin` (true when `group` is null), nullable withinStandardRadius (area center vs. store) and optional validatedPledgeAgorot. |
| POST | /api/v1/groups/join | Body: `areaPublicId`, email, phone, lines. Joins the area: under the coordination lock it expires stale groups, re-resolves the area (it must still be active), re-matches, joins the area's open group or creates one with this shopper as its first member, all in one transaction. Returns 201 with group, `created`, private memberToken and validatedPledgeAgorot. |
| POST | /api/v1/groups/:publicId/join | Body: `areaPublicId`, email, phone, lines. Joins a specific group the shopper was shown; the group must belong to that active area (409 LOCATION_OUTSIDE_GROUP otherwise). Validates fresh Shopify data, then adds one membership; returns group, private memberToken and validatedPledgeAgorot. |
| GET | /api/v1/groups/:publicId | Aggregate only, no member authorization required. |
| POST | /api/v1/groups/:publicId/update-pledge | Body: non-empty lines. Requires Authorization: Bearer memberToken. Revalidates prices; returns group and own validatedPledgeAgorot. An empty lines array is rejected (422 EMPTY_CART_CANNOT_UPDATE_PLEDGE) and never withdraws. |
| POST | /api/v1/groups/:publicId/member | Body: {}. Requires Authorization: Bearer memberToken. Returns only member.status (PLEDGED/WITHDRAWN), member.pledgedTotalAgorot, member.cartCheck (OK/UNAVAILABLE) and member.cart: the stored snapshot re-checked against Shopify now (variantId, title, quantity, storedUnitAgorot for comparison, currentUnitAgorot, available, restorableQuantity, maxAvailableQuantity, priceChanged, reason AVAILABLE/QUANTITY_REDUCED/UNAVAILABLE). Never returns contact details, the token, its hash or database ids. Counts toward the read rate limit; writes nothing. |
| POST | /api/v1/groups/:publicId/withdraw | Body: {"confirm":true} (400 WITHDRAW_CONFIRMATION_REQUIRED otherwise). Requires Authorization: Bearer memberToken; open groups only. Sets the pledge to 0 (WITHDRAWN) and returns group and member. |
| GET | /health | Public status only |

Safe public group fields: publicId, areaName, status, participantCount, currency, thresholdAgorot, pledgedTotalAgorot, remainingAmountAgorot, progressPercent, expiresAt. Contacts, anchors, centers, member locations, cart snapshots, internal member IDs and membership receipts are absent from public GET responses. Receipt tokens are never accepted in a query string.

## Merchant review and security

Open /admin. Login uses ADMIN_USERNAME/ADMIN_PASSWORD checked on the server, following the repository's single-admin session pattern with PostgreSQL storage instead of an in-memory session Map.

- HttpOnly, SameSite=Strict, eight-hour sessions; Secure + __Host- cookie in production.
- Session and receipt tokens stored only as SHA-256 hashes.
- Exact-origin CSRF protection; per-session CSRF nonce required for approval/logout.
- CORS applies only to public API paths, never credentialed admin routes.
- Every /admin response sends `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store` and a same-origin-only CSP (`script-src 'self'`, no inline script or style). Logout deletes the server session and sends `Clear-Site-Data: "cache"`; /admin/app.js reloads back/forward-cached pages so an old page is never shown from memory.
- Unauthenticated page requests redirect to the login form (`/admin?expired=1&next=…`, same-site admin paths only); /admin/api requests get 401. A wrong username or password gets the same message, so account existence is never revealed.
- Merchant HTML approval/logout forms submit CSRF directly; approval additionally requires an explicit confirmation tick.

### Admin dashboard (store owner only)

Server-rendered Hebrew RTL pages behind the admin session; customer email and phone appear only here, never on /api/v1.

| Page | Purpose |
|---|---|
| /admin | Summary cards (active groups = OPEN/THRESHOLD_REACHED, reached, active customers = distinct emails of PLEDGED members in active groups, active pledged total, groups opened today / this week in Israel time) and the groups table with server-side search (group id prefix, customer email, phone in local or international form), area, status, active/closed and date filters, sortable columns and pagination (25 per page, max 100). |
| /admin/groups/:publicId | Group header with progress toward the stored threshold, lifecycle dates, approval (THRESHOLD_REACHED only, explicit confirmation), CSV exports and the paginated members table (status filter, mailto/tel/WhatsApp links and copy buttons; nothing is sent automatically). |
| /admin/groups/:publicId/members/:memberId | Contact details and the stored cart snapshot (quantity, stored unit price, stored line total, stored pledge). Product titles and today's Shopify price come from one batched Storefront request and are shown for comparison only. For a PLEDGED member of an OPEN/THRESHOLD_REACHED group: "הסר מהמשלוח הקבוצתי" with a confirmation dialog (see below). |
| /admin/groups/:publicId/export.csv, export-lines.csv | Members, or one row per stored cart line. UTF-8 with BOM; cells starting with = + - @ tab or CR are prefixed with an apostrophe (formula injection). Each export is audited. |
| /admin/areas | Delivery-area management (unchanged behaviour). |
| /admin/audit | Admin audit log: login/logout, approvals, area changes, member removals (with member id, previous status and previous pledge) and exports with actor (`session:` + 12 hex of the session hash), target, result and error code. Never passwords, tokens, bodies or contact details. |

JSON equivalents (same session): `GET /admin/api/dashboard`, `GET /admin/api/groups`, `GET /admin/api/groups/:publicId`, `GET /admin/api/groups/:publicId/members`, `GET /admin/api/groups/:publicId/members/:memberId`, `GET /admin/api/audit`.

**Removing a customer** (`POST /admin/groups/:publicId/members/:memberId/withdraw` form with `confirm=yes`, or `POST /admin/api/groups/:publicId/members/:memberId/withdraw` with `{"confirm":true}`; admin session, Origin and CSRF required). It runs the same domain withdrawal as the customer's own request under the coordination lock: the row stays (status WITHDRAWN, pledge 0, last cart kept as history, `withdrawn_by=ADMIN`, `withdrawn_at`), and the group total, member count and OPEN/THRESHOLD_REACHED status are recalculated from the remaining pledges. Only active groups (409 GROUP_CLOSED otherwise; an approved group is never reopened). Repeating it is a no-op (`changed:false`). The customer's receipt is not rotated: it reads WITHDRAWN with no cart and restores nothing until the customer pledges again explicitly. The member page labels withdrawn members "הוסר על ידי מנהל" (ADMIN) or "פרש מהקבוצה" (MEMBER), shows the withdrawal time when recorded, and shows the kept cart as "הסל האחרון לפני ההסרה" with historical prices. The cart-lines CSV contains active pledges only. Audited as `member.withdraw` (OK, OK + ALREADY_WITHDRAWN, or DENIED/FAILED with the error code).

Intentionally not available: deleting or editing groups or members (removal above is a withdrawal, never a delete), changing pledges, cancelling, marking delivered, payments, refunds or messaging. The domain has no safe transitions for these yet.
- Rate limits in PostgreSQL: 20 public writes / 10 minutes / IP, 120 public reads / 10 minutes / IP, 10 admin login attempts / 15 minutes / IP.
- Parameterized SQL, validated inputs, fixed safe error messages, canonical host/TLS checks, narrow proxy trust and bounded request/variant counts.
- No customer bodies, contacts, exact coordinates, tokens, signatures or secrets are logged.
- Group/member records are durable; no business-data deletion policy is guessed. Choose a retention policy before wider rollout.

## Tests and limits

`npm test` uses an on-disk PGlite PostgreSQL engine with the real migrations and SQL, plus mocked Shopify responses. It tests DB restart persistence, duplicate/concurrent joins, anti-chain matching, money, empty-cart rejection, explicit confirmed withdrawal, the member read (safe fields, Shopify re-check of price/stock/quantity rules), threshold changes, expiry, privacy, invalid carts, rate/body/origin limits, admin login, CSRF, approval, freeze and secure cookies.

Root `tests/group-delivery.browser.cjs` exercises the actual client script and section styling with mocked cart/service responses, explicit geolocation consent, durable per-group receipts and their migration and stale-receipt rules, the no-group-yet join flow, updates, failures, RTL, reduced motion and narrow widths.

No real Shopify API is consumed by automated tests. A live Render PostgreSQL instance, multi-process network concurrency, deployment credentials and real store variants are not part of the local fixtures. Run a staging smoke test against the deployed PostgreSQL/Shopify configuration before customer launch.

## Phase 2 integration points - intentionally not implemented

Add a new migration to support paid totals/payment member states and an explicit state machine beyond APPROVED. Before opening payment, revalidate stock, prices, currency, customer consent and the exact intended cart (including customizations/discount rules supported then). Bind each approved pledge revision to an idempotent Draft Order/payment record. Use verified Shopify webhooks and deduplicated payment events to update paid_total_agorot; do not treat pledge totals as paid totals. Scheduling/delivery confirmation and checkout links require separate, merchant-approved transitions.

No Shopify Admin calls, Draft Orders, payment links, checkout changes, shipping-rate changes, automatic charges or delivery creation exist in this phase.
