# Fankee Group Delivery - Phase 1

Independent Node.js/TypeScript service in `tools/group-delivery`. Production state lives in PostgreSQL through `pg`; Shopping Assistant and Product Importer are not dependencies.

This phase records nonbinding, unpaid cart intentions. Reaching the target changes OPEN to THRESHOLD_REACHED. Merchant review can change THRESHOLD_REACHED to APPROVED. Approval never creates a payment, checkout, Draft Order, shipping rate or delivery. APPROVED groups are frozen to member changes in this phase. With `CARDCOM_ENABLED=true`, new memberships require a verified Cardcom card reservation (no charge), and approving such a group charges its active members; see **Card reservation and charging (Cardcom)** below.

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
| RECOVERY_EMAIL_PROVIDER | `resend` to enable membership recovery by emailed code; unset or `off` disables it (the endpoints answer 503 RECOVERY_UNAVAILABLE). `memory` is for development/tests only and is refused in production |
| RESEND_API_KEY | Resend API key (sending access, restricted to the sending domain); server only, never in the theme, browser or database |
| RECOVERY_EMAIL_FROM | Sender on a Resend-verified domain, e.g. `פאנקי <no-reply@mail.fanakee.com>` |
| RECOVERY_EMAIL_REPLY_TO | Optional reply-to address |

With RECOVERY_EMAIL_PROVIDER=resend and a missing or invalid RESEND_API_KEY / RECOVERY_EMAIL_FROM, recovery fails closed (no code is generated or sent) and the startup log names the variable, never its value; the rest of the service starts normally. The operations page (/admin/system) shows the state and the sender domain only.

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

Only opaque member receipts (group public ID + random bearer token + save time) are stored, one localStorage key per group under `fankee-group-delivery:<service origin>:receipt:<publicId>`, so closing the tab keeps membership and different groups never overwrite each other. A receipt from the earlier single sessionStorage key is migrated automatically, and the old copy is removed once the localStorage copy is confirmed. If localStorage is unavailable, sessionStorage is used for the tab. No contacts, coordinates, cart snapshots or payment data are stored. A receipt is deleted only when the service definitively rejects it (MEMBER_AUTH_REQUIRED or GROUP_NOT_FOUND); network/timeout/5xx, RATE_LIMITED, SHOPIFY_UNAVAILABLE and GROUP_CLOSED keep it. Receipt loss (another browser or device, cleared site data) is recovered only by an emailed one-time code; see **Membership recovery** below. Email and phone alone never grant access.

## PostgreSQL data model

- delivery_groups: internal/public UUIDs, public area label, normalized locality key, private fixed anchor and moving center, integer threshold/pledged/paid totals, status, expiry and timestamps.
- group_members: internal UUID, group FK, normalized email/phone, locality and rounded private coordinates, validated JSON cart snapshot, integer pledge, hashed bearer token, PLEDGED/WITHDRAWN state and timestamps. Per-group contact uniqueness prevents duplicate pledges.
- admin_sessions: hashed cookie token, CSRF nonce and expiry.
- delivery_groups.operational_status / completed_at / completed_by (migration 005): admin delivery workflow; COMPLETED iff completed_at is set.
- business_transactions (migrations 011, 012): actual income and expense rows in integer agorot, including the rows recorded by recurring charges (`recurring_definition_id`, `recurring_occurrence_date`, UNIQUE per charge and date).
- business_recurring_transactions (migrations 012–014): recurring-charge definitions; `managed_by='OPS_COSTS'` marks charges synchronized from OPS_COSTS, `deactivated_reason` (ADMIN, OPS_SYNC) records why a charge stopped, `amount_source` (OPS_CONFIG, MANUAL) where an OPS-managed charge's ILS amount comes from (see "Business finance").
- admin_audit (migration 003): admin actions and exports with safe metadata only; migration 005 adds new_status and lets previous_status hold operational statuses; migration 004 adds subject (member id), previous_status and amount_agorot for member removals.
- group_members.withdrawn_at / withdrawn_by (migration 004): when and by whom (MEMBER or ADMIN) the pledge was withdrawn; cleared when the same row pledges again. Migration 004 marks earlier withdrawals as MEMBER (only receipts could withdraw then); their time stays NULL.
- request_limits: HMAC IP bucket identifiers and expiring counters.
- member_tokens (migration 006): device receipts, SHA-256 hashes only. One row per join receipt (backfilled for every existing member) plus one per successful recovery, so several devices stay signed in to the same membership. group_members.token_hash keeps the join receipt and is still accepted, so joins written during a rolling deploy keep working; a revoked member_tokens row always wins (nothing revokes yet).
- member_recovery_challenges (migration 006): one-time codes as HMAC(SESSION_SECRET) hashes, attempts, expiry, single-use state, and HMAC identifiers of the submitted details and the client IP for limits. member_id is NULL when nothing matched (such a challenge can never verify). Deleted after 24 hours.
- security_events (migration 006): recovery requested/sent/delivery failed/succeeded/failed/locked, with the group public id and (when matched) the internal member id only. Shown on the admin member page; never an email, phone, code, token or IP.
- schema_migrations / schema_migration_lock and group_coordination: migration tracking and database coordination.

All money arithmetic is bigint/integer agorot. Public monetary fields are integer agorot and are capped below JavaScript's safe-integer limit. Paid totals stay zero for groups without cards; for Cardcom card groups they come only from confirmed charges (migration 007). Zero-pledge withdrawn members do not count as participants.

Every group mutation locks a shared coordination row inside a PostgreSQL transaction. This intentionally serializes the modest MVP write workload, including joins that create a group, joins, updates and approval, across service instances. Search is read-only and takes no lock. Group state is never kept in an application Map or process-local cache.

## Matching and lifecycle

The only flow is: choose an area → `POST /groups/find` (read-only; an existing group or the no-group state) → `POST /groups/join`, which creates the area's group only when none exists. Search never creates a group.

- A search or join for an area matches only that area's OPEN, unexpired group with fewer than 100 active (PLEDGED) members; area A never matches area B.
- Groups are created only by `POST /groups/join`. The match is repeated inside the coordination lock, so two first joins for the same area produce one group with two members.
- Direct joins (`POST /groups/:publicId/join`) require the group's own area.

Thresholds and expiry are captured when a group is created. Nonzero pledge updates can move OPEN <-> THRESHOLD_REACHED. An empty cart never changes a pledge: update-pledge rejects it with 422 EMPTY_CART_CANNOT_UPDATE_PLEDGE (an expired or cleared Shopify cart reads as empty). Withdrawal is a separate, explicitly confirmed request and may reopen the group; a withdrawn member keeps the receipt and can pledge again with a non-empty cart (same row, same receipt). Without the receipt, any join with an email or phone already in the group (withdrawn or not) is 409 ALREADY_JOINED, no row is reactivated and no token is issued; the storefront then offers recovery by emailed code (below). Withdrawal keeps the last cart_snapshot as history only: it never counts toward the total, is never returned to the receipt (member read returns cart: []) and is replaced by the next explicit pledge. Member rows are never deleted. Capacity is 100 ACTIVE (PLEDGED) members per group; withdrawn rows hold no slot, and a group with 100 active members is skipped by the area join (a new group opens) and refuses direct joins (GROUP_FULL). Merchant approval requires the stored threshold and freezes further member updates. Automatic expiry applies only to OPEN and THRESHOLD_REACHED groups (EXPIRED after the configured window); APPROVED groups never expire automatically, so delivery can continue for as long as needed, and completed or already-expired groups are never rewritten. There is no threshold override endpoint.

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
| POST | /api/v1/groups/:publicId/recovery/start | Body: {email, phone}. Always 200 {ok, message, challengeId, expiresInSeconds:600, resendAfterSeconds:60} for valid input, whether or not the details match a membership of this group; the code is emailed (after the response) only to the stored address of a membership whose email AND phone both match. 429 RATE_LIMITED, 404 GROUP_NOT_FOUND, 400 INVALID_CONTACT, 503 RECOVERY_UNAVAILABLE. |
| POST | /api/v1/groups/:publicId/recovery/verify | Body: {challengeId, code}. 200 {memberToken, group, member:{status}}: a new device receipt; existing receipts stay valid and nothing about the membership changes. 400 INVALID_OR_EXPIRED_CODE (wrong, expired, used, superseded, unknown or other group's challenge), 429 TOO_MANY_ATTEMPTS (5th wrong attempt and after), 503 RECOVERY_UNAVAILABLE. |
| POST | /api/v1/groups/:publicId/withdraw | Body: {"confirm":true} (400 WITHDRAW_CONFIRMATION_REQUIRED otherwise). Requires Authorization: Bearer memberToken; open groups only. Sets the pledge to 0 (WITHDRAWN) and returns group and member. |
| GET | /health | Public status only |

Safe public group fields: publicId, areaName, status, participantCount, currency, thresholdAgorot, pledgedTotalAgorot, remainingAmountAgorot, progressPercent, expiresAt. Contacts, anchors, centers, member locations, cart snapshots, internal member IDs and membership receipts are absent from public GET responses. Receipt tokens are never accepted in a query string.

## Membership recovery (email code)

A shopper whose browser has no receipt for a group and whose join is refused with ALREADY_JOINED sees "כבר קיימת הצטרפות עם הפרטים האלה" with **שחזור הצטרפות** / **חזרה**. Recovery restores access only; the only proof is the emailed code.

- **Start**: the submitted email + phone must both match one membership of the group (after the same normalization as joining). A 6-digit code from `crypto.randomInt` is stored as an HMAC and emailed to the membership's stored address, which equals the submitted one. Unknown or mismatched details get the identical answer and a challenge that can never verify, so a request reveals nothing. Email is sent after the response (provider latency and failures are not observable); a failure closes that challenge, writes a generic log line and changes nothing else.
- **Code**: valid 10 minutes, single use, 5 attempts (the 5th wrong attempt locks it), constant-time comparison. A new request supersedes the previous code for the same details.
- **Limits**: per submitted details 1 code per 60 s and 5 per hour (identical for unknown details); 30 starts per group per hour; per IP 10 starts and 30 verifications per hour, on top of the shared public-write budget (20 / 10 minutes).
- **Success**: a new receipt (member_tokens, source RECOVERY) saved in the browser in the normal receipt format; the original device keeps its receipt. PLEDGED shows the shopper's delivery; WITHDRAWN shows the inactive membership and pledging again stays an explicit cart update; APPROVED keeps pledge changes closed; COMPLETED/EXPIRED are history only. Nobody is moved to another group.
- **Admin**: the member page shows the number of active device receipts and recent recovery events. Codes, tokens and IPs are never stored or shown.

### Resend and DNS (manual)

1. In Resend, add the domain `mail.fanakee.com` (a sending subdomain keeps the root domain's existing mail and SPF untouched).
2. Resend then lists DNS records for it, typically: an **MX** and a **TXT (SPF)** record on `send.mail`, and a **TXT (DKIM)** record on `resend._domainkey.mail`; optionally a **TXT (DMARC)** record on `_dmarc`. Add exactly the values Resend shows in GoDaddy (DNS → Manage zones → fanakee.com → Add record). GoDaddy appends `.fanakee.com` to the host itself.
3. Wait for Resend to show the domain as **Verified**.
4. Create an API key with **Sending access** restricted to `mail.fanakee.com` and set it as RESEND_API_KEY in Render, with RECOVERY_EMAIL_PROVIDER=resend and RECOVERY_EMAIL_FROM=`פאנקי <no-reply@mail.fanakee.com>`.

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
| /admin/system | Business finance dashboard ("כספים"): income, expenses, recurring charges, chart and OPS_COSTS import. See "Business finance" below. |
| /admin/audit | Admin audit log: login/logout, approvals, area changes, member removals (with member id, previous status and previous pledge) and exports with actor (`session:` + 12 hex of the session hash), target, result and error code. Never passwords, tokens, bodies or contact details. |

JSON equivalents (same session): `GET /admin/api/dashboard`, `GET /admin/api/groups`, `GET /admin/api/groups/:publicId`, `GET /admin/api/groups/:publicId/members`, `GET /admin/api/groups/:publicId/members/:memberId`, `GET /admin/api/audit`.

**Removing a customer** (`POST /admin/groups/:publicId/members/:memberId/withdraw` form with `confirm=yes`, or `POST /admin/api/groups/:publicId/members/:memberId/withdraw` with `{"confirm":true}`; admin session, Origin and CSRF required). It runs the same domain withdrawal as the customer's own request under the coordination lock: the row stays (status WITHDRAWN, pledge 0, last cart kept as history, `withdrawn_by=ADMIN`, `withdrawn_at`), and the group total, member count and OPEN/THRESHOLD_REACHED status are recalculated from the remaining pledges. Only active groups (409 GROUP_CLOSED otherwise; an approved group is never reopened). Repeating it is a no-op (`changed:false`). The customer's receipt is not rotated: it reads WITHDRAWN with no cart and restores nothing until the customer pledges again explicitly. The member page labels withdrawn members "הוסר על ידי מנהל" (ADMIN) or "פרש מהקבוצה" (MEMBER), shows the withdrawal time when recorded, and shows the kept cart as "הסל האחרון לפני ההסרה" with historical prices. The cart-lines CSV contains active pledges only. Audited as `member.withdraw` (OK, OK + ALREADY_WITHDRAWN, or DENIED/FAILED with the error code).

**Operational delivery workflow** (admin only; migration 005). Each group also has `operational_status` NEW → IN_PROGRESS → READY_FOR_DELIVERY → OUT_FOR_DELIVERY → COMPLETED ("חדש", "בטיפול", "מוכן למשלוח", "יצא למשלוח", "הושלם"), separate from the business status (OPEN/THRESHOLD_REACHED/APPROVED/EXPIRED), which it never changes. Rules: forward one step at a time, backward any number of steps before completion, COMPLETED only from OUT_FOR_DELIVERY and terminal (no reopen). Same status again is a no-op. `POST /admin/groups/:publicId/operational-status` (form: `status`, plus `confirm=yes` for COMPLETED) or `POST /admin/api/groups/:publicId/operational-status` (`{"status":"…","confirm":true}`); `GET /admin/api/groups/:publicId/timeline`. Admin session, Origin and CSRF required. Each change runs under the coordination lock and writes its audit row (`group.operational_status_change`, or `group.complete` with the final pledged total) in the same transaction, so the group page timeline is read from the audit log; refused attempts are audited as DENIED.

Completing a delivery never deletes, copies, moves or zeroes anything: the row keeps its id, public id, members, withdrawn members, carts, pledges, totals and timestamps, and gains `completed_at` / `completed_by` (anonymous session reference). From then on the group is history: it is not matched by find/join, refuses joins, pledge updates, withdrawals and approval (GROUP_CLOSED / APPROVAL_NOT_ALLOWED), is skipped by expiry, and the public aggregate reports `status: "COMPLETED"` (the storefront shows "המשלוח הקבוצתי הזה כבר הושלם."). Receipts stay tied to their own group and never authorize another one. The area's next first join creates a brand-new group (new public id, threshold from config, 0 pledged, NEW) through the normal join under the same lock, so concurrent first joins still produce one group. Inactive areas stay inactive; legacy groups without an area complete without any replacement. Existing groups are backfilled as NEW (none is assumed delivered).

**Website systems page** (`/admin/system/services`, "מערכות האתר"; JSON `GET /admin/api/system`, `?refresh=1` re-checks; it moved from `/admin/system`, which is now the finance dashboard below). Admin session only, no-store. Lists Shopify, the theme editor, the theme (CLI) release, GitHub, Render services, Neon, the Group Delivery admin, Google Business Profile, Google Merchant Center and the domain, plus the postponed systems (dynamic Google reviews, Group Delivery payments) and manually configured monthly costs. Statuses: OPERATIONAL/DEGRADED/OFFLINE only from a real check, MANUAL for systems that are not checked, POSTPONED for postponed ones. Checks run only when the page is opened (60 s in-memory cache, re-check at most every 10 s, 3 s timeout, no retries): the service's own `/health` (APP_ORIGIN, or OPS_RENDER_GROUP_DELIVERY_URL), `SELECT 1` on the database, a `HEAD` on the storefront, and `/health` of extra services listed in OPS_RENDER_SERVICES. No Google, GitHub, Render or Neon API is called; nothing is stored.

Optional, non-secret settings (Render environment; invalid values are ignored with a warning naming only the variable; URLs must be https without credentials):

| Variable | Meaning |
|---|---|
| OPS_SHOPIFY_ADMIN_URL | Store admin, e.g. https://admin.shopify.com/store/<store> (the theme editor link defaults to <admin>/themes) |
| OPS_SHOPIFY_THEME_EDITOR_URL | Direct theme editor link (optional) |
| OPS_THEME_NAME, OPS_THEME_ID, OPS_THEME_REVISION | Live theme name, numeric id, revision label from snippets/theme-revision.liquid (e.g. 2026-11-12+ab875ef) |
| OPS_GITHUB_REPO_URL, OPS_GITHUB_BRANCH | Default https://github.com/Tal0006/Shopify-Dawn-Theme and main. The deployed backend commit comes from Render's RENDER_GIT_COMMIT |
| OPS_RENDER_DASHBOARD_URL, OPS_RENDER_GROUP_DELIVERY_URL, OPS_RENDER_GROUP_DELIVERY_DASHBOARD_URL | Render links; the service URL defaults to APP_ORIGIN |
| OPS_RENDER_SERVICES | JSON array of extra services: [{"name","url","healthPath","dashboardUrl","purpose","note"}] |
| OPS_NEON_CONSOLE_URL, OPS_GOOGLE_BUSINESS_URL, OPS_MERCHANT_CENTER_URL | Management links |
| OPS_STOREFRONT_URL, OPS_STOREFRONT_CHECK | Default https://fanakee.com/ and on; set the check to off to skip the HEAD request |
| OPS_COSTS | JSON array: [{"service","amount","currency":"USD"|"ILS","frequency":"MONTHLY"|"YEARLY","note","system","financeAmountIls"}]. `amount` is the provider price (systems page; totals per currency, never converted, yearly ÷ 12). Optional `financeAmountIls`: the ILS amount the finance page records for this cost (positive number, at most 2 decimals; invalid values are ignored with a warning). Finance uses `financeAmountIls` when set, otherwise the price of an ILS cost; a foreign-currency cost without it is listed but never counted. No exchange rate is ever used |
| OPS_NOTES | JSON object of system id to a short note (never secrets) |

Intentionally not available: deleting or editing groups or members (removal above is a withdrawal, never a delete), changing pledges, cancelling, marking delivered, payments, refunds or messaging. The domain has no safe transitions for these yet.
- Rate limits in PostgreSQL: 20 public writes / 10 minutes / IP, 120 public reads / 10 minutes / IP, 10 admin login attempts / 15 minutes / IP.
- Parameterized SQL, validated inputs, fixed safe error messages, canonical host/TLS checks, narrow proxy trust and bounded request/variant counts.
- No customer bodies, contacts, exact coordinates, tokens, signatures or secrets are logged.
- Group/member records are durable; no business-data deletion policy is guessed. Choose a retention policy before wider rollout.

### Business finance (`/admin/system`, "כספים")

A Hebrew RTL finance dashboard for manually recorded income and expenses. ILS only; every amount is stored as integer agorot (`bigint`) and handled as BigInt in the service (no floating point). Admin session only; mutations need the same Origin plus the CSRF token, have their own rate limit (120 writes / 10 minutes / IP) and are audited (`finance.transaction_create|update|delete`, with the transaction id, type and amount only) in the same transaction as the change.

- **Data** (migrations 011 and 012, additive): `business_transactions` holds actual movements only — `type` INCOME/EXPENSE, `amount_agorot` (> 0, ≤ ₪10,000,000), `currency` ILS, `transaction_date`, free-text `category` (suggestions in the UI, not enforced), `description`, `payment_method` (CARD, BANK_TRANSFER, CASH, STANDING_ORDER, OTHER), `source` (MANUAL, SHOPIFY, CARDCOM, GROUP_DELIVERY, SYSTEM), `notes`, `created_at/updated_at`, `created_by/updated_by` (`session:` actor label, or `system:recurring` for recorded billing rows), and for recorded billing rows `recurring_definition_id` + `recurring_occurrence_date` (UNIQUE together). 011's `recurring`/`recurrence_*` columns remain but must be false/empty (CHECK). `business_recurring_transactions` holds the charges: amount, category, description, payment method, source, notes, `frequency_months` (1, 3, 12), `start_date` (first billing date), `end_date`, `effective_from`, `active`/`deactivated_at`, `import_key` (unique), timestamps and actors.
- **Recurring charges ("חיוב קבוע")** record immutable expense rows. Billing dates are `start_date` + k × `frequency_months` (same day of month, or the month's last day) up to `end_date`. At the start of every finance read (page or JSON), every active charge records each billing date that is due (on or before today, Israel time) and not recorded yet, copying the charge's current amount and fields into a new `business_transactions` row. This is deterministic, idempotent (`INSERT … ON CONFLICT (recurring_definition_id, recurring_occurrence_date) DO NOTHING`) and serialized with charge changes by a transaction-scoped advisory lock; no scheduler is needed, and no future row is ever created. A charge whose start is in the past records the billing dates since then when it is created.
- **Editing a charge** (same dialog, one charge for the admin): dates already due are first recorded with the old terms; then a change of amount, frequency, first billing date or end date moves `effective_from` to today, so the new terms apply from today's billing date (if it was not already recorded earlier today) or the next one. Category, description, payment method, source and notes apply to rows recorded from then on. Recorded rows are never updated by the service; editing or deleting a recorded billing row is refused (409 RECURRING_OCCURRENCE) and "עריכה" on it opens its charge.
- **Stopping a charge** ("הפסקה"): `active=false` and `deactivated_at`; recorded rows stay in every total and nothing more is recorded (today's billing date only if it was already recorded). A charge that never recorded anything is deleted instead. A stopped charge cannot be edited (409 RECURRING_INACTIVE); add a new one.
- **Migration 012** moves every 011 recurring row into a definition with the same id, anchor (`recurrence_start_date` or `transaction_date`), terms, end date and `import_key`, then deletes the 011 row (it was a definition, never a counted movement). The first finance read after deploy records the same billing dates and amounts 011 showed up to today, once. With no such rows the migration only adds the table and columns.
- **One source of truth**: the KPI cards (this month's income, expenses, profit/loss = income − expenses, and the monthly equivalent of active charges: quarterly ÷ 3, yearly ÷ 12), the chart (6 months, 12 months or the current year) and "תנועות אחרונות" all read the actual rows in `business_transactions` only, so they always agree. Recorded billing rows are marked "חיוב קבוע" in the list. The recurring-charges card reads the definitions (status, next billing date not yet recorded).
- **OPS_COSTS synchronization** (migrations 013, 014). On every finance read, before billing dates are recorded and under the same advisory lock, each OPS_COSTS entry is matched to a charge by its stable key (`ops-costs:` + 16 hex of service name and currency):
  - **The ILS amount of an entry** is `financeAmountIls` when set, otherwise its price if it is an ILS cost; free costs and foreign-currency costs without `financeAmountIls` have none. A change of a foreign provider price alone changes nothing in finance.
  - **Entry with an ILS amount, no charge yet** → one charge (`managed_by='OPS_COSTS'`, `amount_source=OPS_CONFIG`, source SYSTEM, the configured frequency) starting on the 1st of the current month (Israel time). Earlier months are never created; from then on billing dates are recorded like any other charge.
  - **ILS amount or frequency changed** → dates already due are recorded with the old terms, then the new terms apply from today (recorded rows never change).
  - **Entry removed, now free, or without an ILS amount** (e.g. `financeAmountIls` removed) → the charge is stopped (`deactivated_reason=OPS_SYNC`); recorded rows stay in every total, and the cost is listed as not counted again.
  - **Entry back after an OPS_SYNC stop** → the same charge resumes from today; the months in between are not backfilled.
  - Nothing is written when OPS_COSTS and the charges already agree; each change is audited as `system:ops-costs` (`OPS_COSTS_SYNC`). Manual charges (no import key) are never read or changed by the synchronization, and clients cannot set an import key.
  - **Free entries** create nothing. **Foreign-currency entries without `financeAmountIls`** create nothing and no exchange rate is used; the finance page lists them as "לא נכלל בסיכומים · אין סכום בשקלים" and the systems page explains that `financeAmountIls` is needed. The systems page shows both "עלות ספק" (provider price) and "עלות לחישוב כספי" (the ILS amount; "כמו עלות הספק" for a plain ILS cost).
  - **On the page**: synchronized charges appear once, in "חיובים קבועים", tagged "הוצאת מערכת · OPS_COSTS". Their amount, frequency and dates are read-only there and they cannot be stopped from the page (409 OPS_MANAGED; remove them from OPS_COSTS instead); category, description, payment method and notes stay editable. The "עלויות מערכת (OPS_COSTS)" section lists only entries that are not counted (free, non-ILS, stopped by the admin). The manual "ייבוא כחיוב קבוע" flow is removed.
  - **Earlier manual imports** (011/012) carry an import key: migration 013 marks them OPS-managed and migration 014 marks the ones created by an admin `amount_source=MANUAL`. A MANUAL charge of a still-configured foreign cost keeps the ILS amount the admin typed, stays editable and is shown as "סכום ידני (ייבוא קודם)". Once OPS_COSTS gives that entry an ILS amount (`financeAmountIls`), the synchronization takes the same charge over (OPS_CONFIG, new amount from today) — never a second charge. A hand import of an ILS cost is taken over on the first synchronization. A charge the admin had stopped (`deactivated_reason=ADMIN`) is never restarted automatically.
  - Example (placeholder ILS amounts): `[{"service":"Shopify","amount":39.90,"currency":"USD","frequency":"MONTHLY","financeAmountIls":150},{"service":"Render","amount":7,"currency":"USD","frequency":"MONTHLY","financeAmountIls":26}]`.
- **Pages** (work without JavaScript; `/admin/app.js` opens the dialogs as modals): `GET /admin/system` (`range=6m|12m|year`, filters `q`, `month=YYYY-MM`, `type`, `category`, `page`; `?add=INCOME|EXPENSE|RECURRING`, `?edit=<id>`, `?delete=<id>`, `?import=<key>` render the dialogs), `POST /admin/system/transactions`, `POST /admin/system/transactions/:id`, `POST /admin/system/transactions/:id/delete` (`confirm=yes`). A refused form comes back (422/409) with the typed values and per-field errors. `/admin/system?refresh=1` redirects to the systems page.
- **JSON** (same session; `X-CSRF-Token` for writes): `GET /admin/api/finance/summary?range=`, `GET /admin/api/finance/transactions` (same filters), `GET /admin/api/finance/transactions/:id`, `POST /admin/api/finance/transactions` (201), `POST /admin/api/finance/transactions/:id`, `POST /admin/api/finance/transactions/:id/delete` with `{"confirm":true}` (a charge answers `{deactivated}` or, with nothing recorded, `{deleted}`), `GET /admin/api/finance/recurring`. Creating with `recurring:true` answers `{recurring}`; other ids answer `{transaction}`. Amounts: `amountAgorot` (positive integer) or `amount` (shekel text such as `"1,234.56"`). 422 INVALID_TRANSACTION includes `fields` (field → Hebrew message); 404 TRANSACTION_NOT_FOUND; 400 DELETE_CONFIRMATION_REQUIRED.
- **Chart**: server-rendered inline SVG grouped bars (no charting dependency; the admin CSP forbids inline styles, so only SVG attributes and classes are used). Months run right to left; expense bars are hatched so the two series differ without color; each bar has a `<title>`, and the same numbers are in an expandable table. On narrow screens the chart scrolls inside its card.
- **Navigation**: `ADMIN_SECTIONS` in `src/admin.ts` lists כספים, משלוחים קבוצתיים, אזורי משלוח, יומן פעולות and מערכות האתר; "סקירה" and "הזמנות" are declared but disabled until their pages exist.

## Tests and limits

`npm test` uses an on-disk PGlite PostgreSQL engine with the real migrations and SQL, plus mocked Shopify responses. It tests DB restart persistence, duplicate/concurrent joins, anti-chain matching, money, empty-cart rejection, explicit confirmed withdrawal, the member read (safe fields, Shopify re-check of price/stock/quantity rules), threshold changes, expiry, privacy, invalid carts, rate/body/origin limits, admin login, CSRF, approval, freeze and secure cookies.

Root `tests/group-delivery.browser.cjs` exercises the actual client script and section styling with mocked cart/service responses, explicit geolocation consent, durable per-group receipts and their migration and stale-receipt rules, the no-group-yet join flow, updates, failures, RTL, reduced motion and narrow widths.

No real Shopify API is consumed by automated tests. A live Render PostgreSQL instance, multi-process network concurrency, deployment credentials and real store variants are not part of the local fixtures. Run a staging smoke test against the deployed PostgreSQL/Shopify configuration before customer launch.

## Card reservation and charging (Cardcom)

Off by default (`CARDCOM_ENABLED` unset or `false`): nothing above changes. With it on, a membership exists only after a verified Cardcom card reservation, and approving a group charges its active members. This is independent of the Shopify checkout's Cardcom integration, Shipfn and shipping rates, which are not touched.

**Flow**
1. After the cart is validated, the section shows "שריינו מקום במשלוח הקבוצתי", the pledge amount and a required consent checkbox; "המשך לשריון באשראי" stays disabled until it is ticked.
2. `POST /api/v1/groups/reserve` (or `/groups/:publicId/reserve`) requires `consent:{accepted:true, amountAgorot}` equal to the server-validated pledge (otherwise 409 PLEDGE_AMOUNT_CHANGED with `details.newAmountAgorot`). It stores a `PENDING_RESERVATION` (not a member, never counted, holds no slot), calls Cardcom `LowProfile/Create` with `Operation:"CreateTokenOnly"` and `AdvancedDefinition.JValidateType:2` (J2: card check, no charge, no J5 hold), and returns the Cardcom page URL plus the browser receipt. `ReturnValue` is our random reservation id; no email, phone or token is ever sent there or put in a URL.
3. The shopper enters the card on Cardcom's page only. Cardcom calls `POST /webhooks/cardcom/low-profile`. Only the `LowProfileId` is read from it; the service then calls `LowProfile/GetLpResult` and activates only if ResponseCode is 0, the LowProfileId and TerminalNumber are ours, Operation is CreateTokenOnly, ReturnValue is the reservation id and a token is present. Activation runs under the coordination lock in one transaction: admission rules again (group open, area, capacity, duplicate contacts), member created as `PLEDGED` / `CARD_RESERVED` with the approved amount and consent time, token sealed, group recalculated. Replays and Cardcom retries are no-ops; 503 asks Cardcom to retry when it cannot be reached.
4. Back on the storefront (`?gd_result=success|failed`, removed from the URL), the section shows "מאמתים את שריון המקום..." and asks `POST /api/v1/reservations/:id` (bearer receipt) a few times; that read also checks Cardcom itself (at most every 2 s), so a delayed webhook never strands the shopper. Success: "המקום שלך במשלוח הקבוצתי נשמר בהצלחה…". Failure: "לא הצלחנו לשריין את המקום. כרטיס האשראי לא חויב. אפשר לנסות שוב.".
5. Unfinished reservations expire after `CARDCOM_RESERVATION_TTL_MINUTES` (default 30); their contact and cart are erased and the same details can reserve again. A newer reservation for the same details supersedes an older pending one.

**Cart changes.** A cart at or below the last approved amount replaces the pledge directly. A higher cart is stored as a pending change (`CONSENT_REQUIRED`); the member keeps counting with the approved cart and amount, and the section shows "ההתחייבות שלך השתנתה מ־X ל־Y" with its own checkbox and "אישור ההתחייבות החדשה" (`POST /api/v1/groups/:publicId/confirm-pledge` with `{confirm:true, amountAgorot}`; the pending cart is re-priced first). A database constraint guarantees that a card member's counted pledge never exceeds the approved amount.

**Cancellation.** "ביטול ההצטרפות" is the existing confirmed withdrawal: WITHDRAWN, pledge 0, group recalculated, reservation `CANCELED` and sealed token deleted; repeating it changes nothing. After charging has started or happened it is refused (CHARGE_IN_PROGRESS); refunds follow the business's own process. A withdrawn card member renews through a new reservation with the same receipt.

**Shopify Admin authentication.**
- The service is a Dev Dashboard app acting on our own store, so it uses the client credentials grant: `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `grant_type=client_credentials`, `client_id` and `client_secret`. There is no static Admin token; `SHOPIFY_ADMIN_ACCESS_TOKEN` is refused if set.
- **Caching:** the access token is cached in memory only (not in PostgreSQL). It is refreshed before it expires: `expires_in` from the response, minus a tenth, at most 5 minutes early.
- **Single flight:** concurrent requests share one token request.
- **401:** the token is dropped, one new token is fetched and the request is retried once. A second 401 fails.
- **Scopes:** the granted `scope` must include `write_orders`, which also grants read access to orders; no other scope is requested or needed. Otherwise authentication fails closed.
- **Failure:** any authentication failure (rejected credentials, missing scope, token endpoint unreachable) leaves the charge rows PENDING with `SHOPIFY_AUTH_FAILED`. No order is created and nothing is charged; the next "process" continues once fixed. The startup log and failure codes name variables and kinds only, never the secret or a token.

**Approval, Shopify order and charging.** Approving a card group requires Cardcom *and* the Shopify client credentials (otherwise 409 PAYMENT_UNAVAILABLE, nothing changes). In the approval transaction it creates one `group_payment_charges` row per active card member (UNIQUE per member and group) for the amount the member counts with, plus a copy of the exact approved cart; an unapproved pending change is discarded. Rows then advance in the background, and every stage is claimed in the database before its external call:

1. **Shopify order** (`PENDING → ORDER_CREATING → ORDER_CREATED`):
   - The approved cart is revalidated with Shopify first (availability, quantity rules, currency).
   - `orderCreate` then creates an unpaid order: `financialStatus: PENDING`, the approved unit prices in `priceSet`, `taxesIncluded: true`.
   - **No customer data:** no email, phone, name, shipping or billing address. The store is on Shopify Basic, which has no Level 2 protected customer data access, and the app needs only `write_orders`. Member contacts stay in the Group Delivery database (admin pages and exports) and are never put into the order's note, tags or attributes.
   - It carries tags `group-delivery`, `group:<publicId>` and `gd-charge-<ref>`, a note and custom attributes with the group and area, and `sourceIdentifier` = our reference.
   - Options: `inventoryBehaviour: DECREMENT_OBEYING_POLICY` (an item that can no longer be sold fails the order) and no Shopify customer emails.
   - No shipping line: Group Delivery defines no shipping price and collects no address.
   - The order total must equal the approved amount, otherwise `ORDER_FAILED/ORDER_TOTAL_MISMATCH`: the order is kept unpaid and not charged.
2. **Cardcom charge** (`ORDER_CREATED → IN_FLIGHT → SUCCEEDED | FAILED | UNKNOWN`). It runs only for a row that has its Shopify order (database constraint) and is sent once, with:
   - `Token`;
   - `CardExpirationMMYY` built from the stored CardMonth/CardYear;
   - `ExternalUniqTranId` = the charge reference (`G` + 24 hex digits = 25 characters, derived from the charge id, UNIQUE, never regenerated);
   - `ExternalUniqUniqTranIdResponse: true`;
   - no CVV.

   Expired cards or tokens are not sent.
3. **Payment record in Shopify** (after SUCCEEDED; `shopify_payment_state NOT_STARTED → SYNCED | SYNC_REQUIRED`):
   - `orderCreateManualPayment` (payment method "Cardcom (Group Delivery)", processedAt = charge time) records the full outstanding amount, so the order shows Paid. It is not routed through the storefront's Cardcom checkout provider.
   - Then `tagsAdd` adds `cardcom-tx-<transaction id>`.
   - It first reads the order and skips the payment record when it is already PAID with nothing outstanding, so repeating it never pays twice.
   - It is SYNCED only after re-reading `displayFinancialStatus = PAID` and `totalOutstandingSet = 0`; otherwise SYNC_REQUIRED.

Failure handling:
- **Shopify order rejected** (userErrors, unavailable cart): `ORDER_FAILED`, member `PAYMENT_FAILED`, never charged.
- **Shopify not executed** (HTTP 429 / top-level GraphQL error): back to `PENDING`, retried by the next "process".
- **Shopify answer lost / timeout / 5xx:** `ORDER_UNKNOWN`, never re-created blindly.
- **Cardcom declined** (or an expired card/token, not sent):
  - `FAILED`, member `PAYMENT_FAILED`, no automatic resend.
  - The unpaid order is canceled with `orderCancel(reason: DECLINED, restock: true, notifyCustomer: false)`, with no refund because nothing was paid (migration 009).
  - States: `ORDER_CANCEL_REQUIRED` (set together with FAILED), then `ORDER_CANCEL_REQUESTED` (Shopify cancels asynchronously), then `ORDER_CANCELED`.
  - `inventory_released_at` is set only once Shopify reports `cancelledAt`.
  - A failed cancellation keeps `ORDER_CANCEL_REQUIRED`, and the Cardcom state is unchanged.
  - "process" and reconciliation retry only the cancellation: they read the order first and never send `orderCancel` again while an accepted request is running (up to 10 minutes).
  - Never for UNKNOWN or SUCCEEDED rows (database constraint).
- **Cardcom answer lost:** `UNKNOWN`, never inferred as failed and never re-sent.
- **Cardcom succeeded but the Shopify payment record failed:** member `CHARGED` (money moved), row keeps the Cardcom transaction id, Shopify order id and reference, `SYNC_REQUIRED`.
- **Restart:** rows left `ORDER_CREATING` or `IN_FLIGHT` for 2+ minutes become `ORDER_UNKNOWN` or `UNKNOWN`.

The group's `payment_state` is CHARGING while rows are open, PAID when every row is SUCCEEDED and SYNCED, and PAYMENT_REVIEW_REQUIRED otherwise. Admin actions:
- **"המשך חיובים שטרם נשלחו":** continues only PENDING, ORDER_CREATED and unsynced SUCCEEDED rows.
- **"בדיקה מול קארדקום ושופיפיי (ללא חיוב)":** never creates an order and never charges.
  - ORDER_UNKNOWN: finds the order by its `gd-charge-<ref>` tag. Found becomes ORDER_CREATED; not found 10+ minutes after the attempt becomes PENDING.
  - UNKNOWN: `GetTransactionByExternalUniqTran`. Only a confirmed success counts.
  - SYNC_REQUIRED: retries only the Shopify payment record.

The members table shows each member's stage (כרטיס שמור, הזמנה נוצרה בשופיפיי, בחיוב, שולם, החיוב נכשל – ההזמנה לא שולמה, חויב בקארדקום – נדרש עדכון בשופיפיי, …) with the Shopify order name. Retrying failed members and refunds are not implemented.

**Data (migrations 007 and 008).**
- `delivery_groups.payment_mode`: NONE (all existing groups, backfilled) or CARDCOM (created while Cardcom is required).
- `delivery_groups.payment_state`.
- `paid_total_agorot`: may now be positive, for CARDCOM groups only.
- `group_members`: `payment_status`, `approved_amount_agorot`, `consent_at`, and `pending_cart_snapshot` / `pending_amount_agorot`.
- `group_payment_reservations`: our id (= ReturnValue), status, target area/group/member, pending contact and cart (erased once final), receipt hash, approved amount, consent time and version, LowProfileId, sealed token (only the token is sealed), token expiry (TokenExDate), `card_exp_month` / `card_exp_year` (008, normalized), last 4 digits and brand (usually absent), a safe failure code, Cardcom's numeric response code, and timestamps.
- `group_payment_charges`:
  - our id;
  - `external_uniq_tran_id` (008): ≤ 25 characters, UNIQUE, CHECKed as derived from the id;
  - amount and `order_lines` (the approved cart);
  - status (see above), attempts;
  - `shopify_order_id` (UNIQUE), `shopify_order_name`, `shopify_order_created_at`;
  - `shopify_payment_state`, `shopify_synced_at`;
  - Cardcom transaction id, response code, failure code, and timestamps.

  A CHECK forbids every Cardcom stage without a Shopify order id.
- Migration 007 was left unchanged (it may already be applied to a local or staging database); 008 is additive.

**Compatibility.** While Cardcom is required, groups created without cards accept no new members (their members still update, withdraw and get approved as before) and `POST /groups/join` / `/groups/:id/join` answer 409 CARD_RESERVATION_REQUIRED. Public responses of groups without cards are unchanged; card groups add `cardReservation:true`, `find` adds `cardReservationRequired:true`, and the member read adds `payment`. Roll out in this order: deploy the service (flag off), then the theme, then configure the variables and enable the flag.

**Security.**
- Card numbers, CVV and expiry are entered only on Cardcom's page. Public APIs refuse card-like fields or Luhn-valid card numbers (400 CARD_DATA_NOT_ACCEPTED).
- The token is never returned, logged, put in a URL or shown. It is stored only AES-256-GCM sealed, bound to its reservation row, with `GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY`; there is no fallback key.
- Cardcom credentials stay in the environment only (never in the database or theme). Log lines are fixed sentences with an error kind.

| Variable | Purpose |
| --- | --- |
| CARDCOM_ENABLED | `true` to require card reservations; default off |
| CARDCOM_TERMINAL_NUMBER | Cardcom terminal number (use a sandbox/test terminal until a live test is approved) |
| CARDCOM_API_NAME | Cardcom API name; server only |
| GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY | 32 bytes (64 hex or base64); seals tokens; required, no fallback |
| CARDCOM_SUCCESS_URL | Storefront page with the Group Delivery section; origin must be in STOREFRONT_ORIGINS |
| CARDCOM_ERROR_URL | Optional; defaults to CARDCOM_SUCCESS_URL |
| CARDCOM_WEBHOOK_URL | Optional; must equal APP_ORIGIN + `/webhooks/cardcom/low-profile` |
| CARDCOM_RESERVATION_TTL_MINUTES | 10-120, default 30 |
| SHOPIFY_CLIENT_ID | Client ID of the Dev Dashboard app (same organization as the store), installed with `write_orders`; required to approve and charge card groups |
| SHOPIFY_CLIENT_SECRET | That app's client secret; server only (never in the browser, logs, errors or git) |
| SHOPIFY_ADMIN_API_VERSION | Default 2026-10 |
| SHOPIFY_ORDERS_TEST | `true` creates Shopify test orders (staging); default false |

With CARDCOM_ENABLED=true and anything missing or invalid, the startup log names the variables and card reservations fail closed: new joins still require a card, the reservation endpoints answer 503 PAYMENT_UNAVAILABLE and card groups cannot be approved. The rest of the service runs normally. Cardcom's JSON API v11 needs only the terminal number and API name for these operations; the API password is needed only for refunds, which are not implemented.

### Cardcom facts checked, and points still to verify

These were checked against the v11 OpenAPI (`https://secure.cardcom.solutions/swagger/v11/swagger.json`) and the Cardcom developer KB (`https://kb.cardcom.solutions/apijosn/en`).

**Settled:**
- **J2 / J5 result codes** (KB "Preventing Duplicate Transactions When Charging Tokens"): charge = 0, J2 verification = 701, J5 authorization = 700. The OpenAPI's own wording ("700 and 701 success for J2 and J5") is ambiguous, so we follow the KB.
  - A reservation activates only for Operation CreateTokenOnly with ResponseCode 0 or 701. If TranzactionInfo is present, its ResponseCode must be 0 or 701 and JParameter 2.
  - 700 or JParameter 5 gives `J5_NOT_ALLOWED`; another JParameter (e.g. 0 = a regular charge) gives `NOT_J2`. Neither ever activates.
- **ExternalUniqTranId:** "a string of up to 25 characters" (same KB article). Ours are exactly 25.
- **ExternalUniqUniqTranIdResponse: true** (KB "Do Transaction"): a repeat is not charged and the original response is returned.
- **CVV** (KB "Do Transaction"): CVV2 "works only with a card number, not with a token". CVV is never asked for, sent with a token or stored.

**Still to verify** (isolated in `src/cardcom.ts`, marked VERIFY):
1. **Production blocker — Tokens module and terminal setup:** the terminal must be configured with the card companies to operate without CVV for token charges, and the Tokens model must be active on our terminal.
2. The webhook body format. Only `LowProfileId` is read, so it does not matter.
3. `Operation` as the string `CreateTokenOnly` or its index 2. Both are accepted.
4. Which top-level GetLpResult codes Cardcom uses for a completed J2 page (0 and 701 are accepted).
5. What the cardholder sees for the required `Amount` on a CreateTokenOnly page.
6. The exact "not found" answer of GetTransactionByExternalUniqTran. Only ResponseCode 0 with a transaction id counts as found.
7. TokenInfo.CardYear is documented as an integer "card expiration year"; both 4-digit and 2-digit values are normalized explicitly, and anything else is refused.
8. The hosted page host `secure.cardcom.solutions`.

### Shopify points to verify
1. Prices are VAT-inclusive (`taxesIncluded: true`). If Shopify computes a different total on the live store, the row stops at `ORDER_TOTAL_MISMATCH` (unpaid, not charged).
2. Reconciliation of a lost `orderCreate` answer relies on the order search index (tag query). A row is only sent back to PENDING 10+ minutes after the attempt.
3. Inventory is claimed at order creation (`DECREMENT_OBEYING_POLICY`), before the charge, and released by `orderCancel(restock: true)` after a definitive failure. A row stuck in ORDER_CANCEL_REQUIRED keeps the stock held until reconciliation succeeds.
4. Shopify sends no order emails for these orders (`sendReceipt: false`); the store decides how customers are notified.

### Manual sandbox test (no live terminal without explicit approval)

1. Ask Cardcom support for a sandbox/test terminal and API name. Set them, a fresh encryption key, CARDCOM_SUCCESS_URL (a development theme's group-delivery page) and CARDCOM_ENABLED=true on a staging service with its own database.
2. Reserve with a Cardcom test card. Check that the webhook arrives, the member is `CARD_RESERVED`, and the Cardcom report shows a J2 validation with no charge.
3. Decline with a test card that Cardcom documents as declined, close the page, and wait 30 minutes. In each case: no member, no charge.
4. Raise the cart, check the consent prompt, then cancel and check that the token row is CANCELED.
5. With a Dev Dashboard app installed on the development store (scope `write_orders`; SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET) and SHOPIFY_ORDERS_TEST=true, reach the threshold and approve. Check:
   - one unpaid Shopify test order per member first, then one Cardcom transaction per member with our 25-character reference as ExternalUniqTranId;
   - each order then shows Paid with the `cardcom-tx-` tag;
   - double-clicking approve creates no second order or transaction.
6. Make a test card decline the charge and check that the order stays unpaid and the group shows PAYMENT_REVIEW_REQUIRED.
7. Temporarily break the client secret after a charge to force SYNC_REQUIRED, restore it, and check that reconciliation marks the order Paid without a second transaction.

## Phase 2 integration points - intentionally not implemented

Not implemented yet: retrying failed charges, refunds and order cancellation from this service, and Shopify customer notifications.

No Draft Orders, payment links, checkout changes, shipping-rate changes or delivery creation exist. Shopify Admin calls are limited to the order mutations above, and happen only for Cardcom card groups after admin approval.
