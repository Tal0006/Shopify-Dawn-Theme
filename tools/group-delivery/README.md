# Fankee Group Delivery - Phase 1

Independent Node.js/TypeScript service in `tools/group-delivery`. Production state lives in PostgreSQL through `pg`; Shopping Assistant and Product Importer are not dependencies.

The service records cart pledges behind a verified payment method. The flow:

1. Joining requires a payment-method verification that charges nothing.
2. Reaching the target waits for the merchant's approval.
3. Merchant approval freezes the group and opens a fixed approval window.
4. Member approval records consent for an exact amount.
5. Money moves only once approved value covers the target and every cart has been revalidated with Shopify. The payment layer is provider-neutral and currently ships only a development simulator (`PAYMENT_PROVIDER=mock`), so **no real payment can be verified or charged yet**. Shopify checkout, Draft Orders, shipping rates and deliveries are untouched. See [Payment verification and approval](#payment-verification-and-approval).

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
| PAYMENT_PROVIDER | `none` (default) or `mock`. With `none`, verification and every new Join fail closed with 503 PAYMENTS_UNAVAILABLE; existing members can still update pledges. Unknown values stop startup. |
| PAYMENT_APPROVAL_HOURS | Member payment-approval window after merchant approval, default 24 (1–168). Stored per group as a fixed deadline; never extended. |
| PAYMENT_EXECUTION_POLICY | `require_authorization` (default): money moves only through authorize/capture, and a provider without it fails closed. `allow_direct_charge` permits the direct-charge fallback for development/testing; refused in production. |
| MAINTENANCE_TOKEN | Optional, 32+ characters. Enables `POST /internal/payment-maintenance` for a scheduler; without it the route does not exist. Server-only secret. |
| ALLOW_MOCK_PAYMENTS | Must be exactly `true` for `PAYMENT_PROVIDER=mock`, in every environment; otherwise startup fails. The simulator never moves money. Do not set it on the production service. |

Future real-provider variables are generic and adapter-specific, for example `PAYMENT_PROVIDER=<adapter>`, a server-only API credential, a webhook signing secret and the provider's hosted-page hostnames. They are not read today. See [Connecting a real payment provider](#connecting-a-real-payment-provider).

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
- payment_verifications (migration 003): one row per verification attempt. Public id, SHA-256 of the one-time browser secret, HMAC contact digest (SESSION_SECRET key over normalized email + phone), provider name, opaque provider session reference, status PENDING/VERIFIED/FAILED/CANCELLED, opaque payment-method reference once verified, failure category, verified/consumed/expiry timestamps. Unconsumed attempts expire after 30 minutes and are deleted a day later; consumed attempts stay because members reference them.
- group_members payment columns (migration 003): payment_verification_id (unique: one verification per member), payment_method_status NOT_STARTED/PENDING/VERIFIED/FAILED, approval_status NOT_REQUIRED/REQUIRED/APPROVED/DECLINED/EXPIRED with approval amount, nonce and timestamps, charge_status NOT_STARTED/PENDING/SUCCEEDED/FAILED with opaque charge reference, charged amount, failure category (DECLINED/PROVIDER_ERROR), attempt counter, unique idempotency key and request time. CHECK constraints tie them together: a charge needs an approval, a success needs an amount no greater than the approved amount. Members from before migration 003 default to NOT_STARTED/NOT_REQUIRED/NOT_STARTED and are never charged.
- No card number, expiry, CVV, cardholder name or billing address is stored anywhere, and the service never receives them.
- admin_sessions: hashed cookie token, CSRF nonce and expiry.
- request_limits: HMAC IP bucket identifiers and expiring counters.
- schema_migrations / schema_migration_lock and group_coordination: migration tracking and database coordination.

All money arithmetic is bigint/integer agorot. Public monetary fields are integer agorot and are capped below JavaScript's safe-integer limit. `paid_total_agorot` equals the sum of successful member charges (the phase-one zero pin was replaced by a non-negative check in migration 003). Zero-pledge withdrawn members do not count as participants.

Every group mutation locks a shared coordination row inside a PostgreSQL transaction. This intentionally serializes the modest MVP write workload, including joins that create a group, joins, updates and approval, across service instances. Search is read-only and takes no lock. Group state is never kept in an application Map or process-local cache.

## Matching and lifecycle

The only flow is: choose an area → `POST /groups/find` (read-only; an existing group or the no-group state) → `POST /groups/join`, which creates the area's group only when none exists. Search never creates a group.

- A search or join for an area matches only that area's OPEN, unexpired group with fewer than 100 membership records; area A never matches area B.
- Groups are created only by `POST /groups/join`. The match is repeated inside the coordination lock, so two first joins for the same area produce one group with two members.
- Direct joins (`POST /groups/:publicId/join`) require the group's own area.

Thresholds and expiry are captured when a group is created. Nonzero pledge updates can move OPEN <-> THRESHOLD_REACHED. A zero update withdraws a member and may reopen the group. A matching group has capacity for at most 100 membership records. Merchant approval requires the stored threshold and freezes further member updates. There is no threshold override endpoint.

Expiry is evaluated from PostgreSQL NOW() during reads, matching, joining, updates, listing and approval; it does not depend on a browser timer. OPEN, THRESHOLD_REACHED and APPROVED groups expire, and their open approval requests become EXPIRED. PAYMENT_OPEN groups never expire by time, because members may already have paid. No background payment/shipping jobs run.

## Payment verification and approval

### Join flow

Contact details → `POST /payment-verifications` → provider verification (development: the simulator control) → `GET /payment-verifications/:id` or the simulator result, which reads the outcome **from the provider**, never from the browser → Join with `verificationId` + `verificationToken`.

Inside the Join transaction, after the area, capacity and duplicate-contact rules, the service locks the verification row and requires all of the following. Otherwise it returns 403 PAYMENT_VERIFICATION_REQUIRED.
- The secret matches its stored hash.
- The verification came from the configured provider and its status is VERIFIED.
- It has not expired and has not been used.
- Its contact digest equals the joining contact.

It then marks the verification consumed and stores the member as payment VERIFIED. A join rejected for any reason, including a rollback, never consumes the verification. Client-sent fields such as `verified:true` are ignored. Both `/groups/join` and `/groups/:publicId/join` share this path.

### Payment phase policy

1. **The merchant approves first.** Reaching the target asks nobody to pay. The admin action "אישור הקבוצה ופתיחת אישורי תשלום" means the store has confirmed the group delivery is operationally feasible.
2. **The group freezes on merchant approval.** From that moment there are no new members and no pledge or cart changes for this payment cycle.
3. **Approval is consent, not payment.** A member's approval records explicit consent for the exact frozen amount; it never calls the provider.
4. **Only approved value counts.** `approvedPledgeTotalAgorot` sums APPROVED members whose payment has not failed or been voided. Declined, expired, invalidated, failed and unanswered members are excluded. The group is *payment-ready* when that total reaches the stored threshold.
5. **Fixed approval window.** The deadline is set to `PAYMENT_APPROVAL_HOURS` (default 24) after merchant approval and is never extended.
6. **Shopify revalidation is mandatory.** Immediately before any authorization or charge, each member's stored lines are revalidated with Shopify: variants exist, products are available, quantity rules and inventory hold, the currency is ILS, unit prices are unchanged, and the total exactly equals the approved amount.
7. **Money moves only when** the merchant approved, the group is payment-ready, and Shopify revalidation passed. See [Execution timing](#execution-timing).

### Group state transitions

| From | Event / condition | To | Money |
| --- | --- | --- | --- |
| — | First verified Join for the area | OPEN | none |
| OPEN | Pledged total ≥ threshold (join or pledge update) | THRESHOLD_REACHED | none |
| THRESHOLD_REACHED | Pledged total drops below threshold (update or withdrawal) | OPEN | none |
| OPEN / THRESHOLD_REACHED | `expires_at` passes | EXPIRED | none |
| THRESHOLD_REACHED | Merchant approves, a provider is configured, and payment-capable pledges ≥ threshold. Sets `approval_deadline`, freezes the group, asks every verified member to approve their exact pledge. | PAYMENT_OPEN | none |
| THRESHOLD_REACHED | Merchant approves without a provider, or payment-capable pledges < threshold | (refused: 503 / 409) | none |
| PAYMENT_OPEN | Deadline passes before execution with approved value < threshold. Open requests become EXPIRED; approvals are kept for audit. `closed_reason=APPROVAL_DEADLINE`. | EXPIRED | none |
| PAYMENT_OPEN | Approved value ≥ threshold and (no one still waiting, or deadline passed, or merchant "execute now") | PAYMENT_OPEN, execution started | revalidate, then authorize |
| PAYMENT_OPEN (executing) | Authorized + captured value ≥ threshold | PAYMENT_OPEN | capture every hold |
| PAYMENT_OPEN (executing) | Captured value ≥ threshold, nothing queued/pending/held, nobody waiting (or deadline passed) | CONFIRMED | done |
| PAYMENT_OPEN (executing) | No unknown outcomes, no one can still answer or retry (deadline passed, or nobody left), approved value < threshold. `closed_reason=INSUFFICIENT_PAYMENTS`. | CANCELLED | holds voided; `refund_required` if anything was charged |
| APPROVED | Phase-one history only. Frozen, never charged. Time expiry still applies. | EXPIRED | none |

SCHEDULED and COMPLETED remain reserved and unused.

### Member payment transitions

| Approval / charge | Event | Next |
| --- | --- | --- |
| NOT_REQUIRED | Merchant opens payment (member verified, pledged) | REQUIRED (amount = frozen pledge, fresh nonce) |
| NOT_REQUIRED (legacy, no verified method) | anything | stays NOT_REQUIRED; approve → 409 PAYMENT_METHOD_REQUIRED; never charged; no verification is fabricated |
| REQUIRED / DECLINED | Approve (echoing the shown nonce and amount) before the deadline | APPROVED, charge NOT_STARTED (consent only) |
| REQUIRED / APPROVED (charge not started) | Decline before the deadline | DECLINED (approve again before the deadline if desired) |
| APPROVED | Approve again | no change (idempotent) |
| REQUIRED | Deadline passes | EXPIRED |
| APPROVED / NOT_STARTED | Revalidation: price or line changed, before the deadline | REQUIRED with the new validated amount, new nonce, `review=CART_CHANGED`; old nonce void |
| APPROVED / NOT_STARTED | Revalidation: price changed after the deadline | INVALIDATED, `review=CART_CHANGED` |
| APPROVED / NOT_STARTED | Revalidation: variant missing/unavailable, quantity rule, inventory, currency | INVALIDATED, `review=CART_UNAVAILABLE` (store review) |
| APPROVED / NOT_STARTED | Shopify unreachable | unchanged; retried on the next run |
| APPROVED / NOT_STARTED | Submitted (only if still-collectible value ≥ threshold) | PENDING with key `gdc_<member>_<attempt>` |
| PENDING | Provider authorizes / declines / outcome unknown | AUTHORIZED / FAILED / stays PENDING and is re-submitted with **the same key** |
| AUTHORIZED | Capture submitted / succeeds / fails / unknown | CAPTURING / SUCCEEDED / FAILED / stays CAPTURING (re-submitted with the same capture key) |
| AUTHORIZED | Group cancelled | VOIDED |
| APPROVED / FAILED | Member retries before the deadline | NOT_STARTED, a new attempt is minted later |
| SUCCEEDED in a CANCELLED group | direct-charge fallback only | group `refund_required=true` (manual refund) |

### Failure rules

| Situation | Behaviour |
| --- | --- |
| Member declines | Excluded from approved value. May approve again until the deadline. Never charged. |
| Approval expires | REQUIRED → EXPIRED at the deadline; never charged. |
| Price changed | Old approval voided; new approval for the new amount (or invalidated after the deadline). Never charged a different amount. |
| Unavailable product / inventory / quantity rule | Approval INVALIDATED (`CART_UNAVAILABLE`); never charged; the member is told the store will be in touch. |
| Authorization fails | FAILED; excluded from approved value. The member may retry until the deadline. Others' holds wait; nothing is captured below the target. |
| Capture fails | FAILED. If the captured total cannot reach the target, the group is cancelled and any captured payments are flagged for refund. |
| Unknown provider result | Stays PENDING/CAPTURING and blocks final decisions. Each later run re-submits the same idempotency key, which the provider must deduplicate. |
| Some members authorize, others fail | Capture only when authorized + captured value ≥ threshold; otherwise wait for retries until the deadline, then void all holds and cancel. |
| Nobody touches the group after the deadline | Scheduled maintenance applies the transition on its next run (see below). |

### Execution guarantees

- **One runner at a time.** A short per-group lease (`payment_execution_lease_until`, 120 s) lets only one request run execution. A crashed run's lease lapses.
- **Single submission.** Every provider submission is claimed under the coordination lock first. Results are recorded by compare-and-set on the matching attempt, so repeats, double clicks and concurrent requests never move money twice.
- **Exact amounts.** Amounts are always the stored integer-agorot approval. A provider result reporting a different amount is not accepted; the attempt stays PENDING for manual reconciliation.

### Authorization/capture vs. direct charge

The preferred production flow is approval → authorization (hold) → all required authorizations succeed (authorized ≥ target) → capture. If the target cannot be reached, the holds are voided and nobody pays. `PaymentProvider.supportsAuthorization` selects this flow.

Under `PAYMENT_EXECUTION_POLICY=require_authorization` (the default), this fallback is never used. If a provider cannot authorize separately and the policy allows it, the fallback charges each revalidated member directly. It does so only when the still-collectible total covers the target, so the common shortfall cases (declines, invalid carts) charge nobody.

The remaining risk is a charge failing *after* others succeeded, which leaves the group short. The group is then cancelled with `refund_required=true`, and the merchant must refund manually.

### Scheduled payment maintenance

The lifecycle does not depend on anyone opening a page. `Groups.maintain()` is a vendor-neutral domain operation. Each run:

1. Applies time-based transitions: approval deadlines, open requests expiring, and groups expiring below the target.
2. Runs execution for every due PAYMENT_OPEN group: Shopify revalidation, authorization, capture, and re-submission of unknown outcomes with the same idempotency keys, then confirm or cancel.
3. Retries releasing holds left on CANCELLED or EXPIRED groups.
4. Reports counts only: `{checked, executionRuns, confirmed, cancelled, expired, holdsReleased, blocked, attention}`.

It is idempotent and safe to run concurrently with shopper and admin requests. Each group's execution is lease-guarded, results are compare-and-set, and repeat runs find nothing due and make no provider calls. Member status reads and admin page loads still advance groups as before, but nothing relies on them.

There are two ways to invoke it:

- **Job (recommended for production):** `npm run build && npm run maintain:dist` with the web service's environment. It runs once and exits non-zero on failure. On Render, create a Cron Job from the same repository and environment group, with the command `npm ci && npm run build && npm run maintain:dist` and a schedule such as every 5 minutes (`*/5 * * * *`). Any other scheduler works the same way. The job refuses `PAYMENT_PROVIDER=mock`, because the simulator's state lives inside the web-service process.
- **Internal HTTP:** `POST /internal/payment-maintenance` with `Authorization: Bearer $MAINTENANCE_TOKEN`. The route exists only when `MAINTENANCE_TOKEN` (32+ characters) is configured; otherwise it returns 404. A missing or wrong token returns 401. It accepts no cookies, no CORS and no query-string tokens, and is limited to 30 requests per 10 minutes per IP. A scheduler can call it with `curl -fsS -X POST -H "Authorization: Bearer $MAINTENANCE_TOKEN" https://<service>/internal/payment-maintenance`.

The interval bounds how late a deadline takes effect. Every 5 minutes is suggested.

### Execution timing

- When approved value first reaches the target, nothing starts while payment-capable members can still answer.
- **Automatic start:** when every payment-capable member has answered (approved, declined, or no longer REQUIRED) and approved value ≥ target, or when the deadline has arrived and approved value ≥ target.
- **"Execute now"** (protected admin action) may start earlier once approved value covers the target, and is remembered as `payment_execution_forced`.
- The rule is re-checked on every run. If a later re-pricing puts a member back into REQUIRED, no new payment starts until that member answers or the deadline passes. In-flight attempts are still reconciled and holds are still captured.
- Never below the target: no run starts execution, and no run submits new payments unless the still-collectible value covers the target.

### Price-change reapproval

Revalidation that finds a changed price or line never treats the earlier approval as consent for the new amount:
- The approval goes back to REQUIRED with the newly validated amount, a new nonce and `review=CART_CHANGED`.
- Audit columns record the amount approved before (`previous_approval_amount_agorot`), when it was voided (`approval_invalidated_at`) and how many times it was re-issued (`approval_revision`).
- The shopper sees both the previous and the new amount.
- The old nonce or old amount is refused (409 PAYMENT_AMOUNT_CHANGED), and nothing is authorized until the new amount is explicitly approved.
- If no new approval arrives by the deadline, the request expires and the member's value is excluded from collectible value.
- If the change is detected after the deadline, the approval is INVALIDATED.

### Unavailable items (whole-cart policy)

If any line is missing, unavailable, short on inventory, violates quantity rules or cannot be validated, the member's approval is INVALIDATED for this cycle (`review=CART_UNAVAILABLE`). It is shown to the shopper ("נדרשת בדיקה של הסל") and to admin (the "נדרשת בדיקה" count). No partial cart is created and no provider call is made.

Partial-cart recovery is intentionally deferred.

### Authorization/capture production policy

`PAYMENT_EXECUTION_POLICY`, server configuration only:

- `require_authorization` (default, everywhere). Money moves only through authorize → capture. With a provider that lacks authorization, the merchant cannot open a payment phase (503 PAYMENTS_UNAVAILABLE). Groups already in PAYMENT_OPEN are blocked from execution (maintenance reports `blocked`, admin shows "ביצוע התשלומים חסום"). There is no silent fallback to direct charges.
- `allow_direct_charge`. Permits the direct-charge fallback for development and testing. Startup refuses it when `NODE_ENV=production`.

Recommended production flow: verify the payment method → collect explicit member approvals → authorize the approved amounts → ensure successful authorizations cover the target → capture → confirm the group. If the group fails before capture, every authorization is voided. A void that fails is retried by each maintenance run, and the open hold is shown to admin.

### Refund safety

There are no fake refunds: the service has no refund operation and never pretends to have refunded anyone.

Whenever money moved in a group that cannot complete, the group is CANCELLED with `refund_required=true`. That happens with direct charges, or when captures partially fail. Such a group is:
- shown first in admin under a banner (red alert "נדרש החזר כספי ידני");
- counted in maintenance's `attention`;
- reported with `resolved:false` in the admin API.

Nothing ever clears that flag automatically. A group is "resolved" only when it is terminal, holds no authorization or in-flight attempt, and owes no refund.

**Direct-charge production use is not approved** until a real adapter includes a verified refund operation and refund reconciliation.

### Legacy groups

Historical and pre-payment groups are not migrated into the payment flow and stay payment-ineligible:
- Phase-one APPROVED groups can never be opened for payment.
- Groups without payment-capable pledges covering the target cannot be opened either.
- Maintenance ignores both kinds.

No verification or consent is ever generated on their behalf. Receipts keep working: pledge updates where the group status allowed them before (OPEN/THRESHOLD_REACHED), and membership reads.

### Privacy

- **Public responses** (`GET /groups/:publicId`, `/groups/find`) add only `approvals:{approved,waiting}` counts.
- **Member responses** (Join, update, membership, approval) return the member's own `paymentMethod`, approval status/amount/nonce and charge status/amount/time/failure category.
- **Never exposed:** provider session, payment-method and charge references, idempotency keys and verification secrets never appear in any response, the admin, HTML or logs.
- **Browser storage:** the browser keeps the verification secret in memory only, and stores nothing but the existing receipt.

### Production safety and deployment order

- **Do not deploy this payment foundation to the live Group Delivery service until a real provider adapter is configured.** With `PAYMENT_PROVIDER` unset (the default), verification, every new Join and the merchant's payment opening fail closed (503 PAYMENTS_UNAVAILABLE). Existing members keep updating and viewing their membership.
- **Never deploy the mock provider to production.** `PAYMENT_PROVIDER=mock` with `ALLOW_MOCK_PAYMENTS=true` belongs only on a separate staging service.
- **Deploy order:** when it is time, deploy the backend first. The updated theme needs the verification, membership and approval routes; older backends answer them with 404.

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

The existing `/admin` page (same session, Origin and CSRF protection) lists all areas with edit forms and an add form: display name, center latitude/longitude, sort order and active flag. JSON equivalents: `GET /admin/api/areas`, `POST /admin/api/areas` and `POST /admin/api/areas/:publicId` (X-CSRF-Token). Duplicate names return 409 AREA_EXISTS; unknown areas 404 AREA_NOT_FOUND.

## APIs

Group creation happens only during Join. The previous create-on-search route (`POST /groups/find-or-create`) has been removed and now returns 404 NOT_FOUND like any unknown path; the storefront has no fallback to it.

All JSON bodies are limited to 24 KiB. State-changing public API requests require a configured Origin and application/json. Areas are referenced only by `areaPublicId`; free-text locations are rejected. Cart lines are `[{variantId:"123456789",quantity:2}]`; Shopify GIDs are also accepted.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | /api/v1/areas | Active delivery areas ordered by sort order, then name: `{areas:[{publicId,name}]}`. No coordinates or slugs. |
| POST | /api/v1/areas/nearest | Body: `{latitude,longitude}` (finite JSON numbers in range, otherwise 400 INVALID_COORDINATES). Returns `{area:{publicId,name}}` for the closest active area within AREA_SUGGESTION_RADIUS_KM, else `{area:null}`. Coordinates are used only for the computation: never stored, logged or echoed. Separate limit: 10 / 10 minutes / IP. |
| POST | /api/v1/groups/find | Body: `areaPublicId`, optional lines. Read-only: never creates a group or writes. The service resolves the active area; free-text names are not accepted (400 INVALID_AREA). Returns `group` (or `null` when the area has no open group), `canCreateOnJoin` (true when `group` is null), nullable withinStandardRadius (area center vs. store) and optional validatedPledgeAgorot. |
| POST | /api/v1/payment-verifications | Body: email, phone. Starts a verification without charging. Returns 201 `{verification:{id,status:"PENDING",expiresAt},verificationToken,next}`. `next` is `{type:"mock"}` for the simulator, or a provider redirect only to an https host the adapter allow-lists. 503 PAYMENTS_UNAVAILABLE without a provider. Separate limit: 15 / 10 minutes / IP. |
| GET | /api/v1/payment-verifications/:id | Bearer verificationToken. Refreshes the status from the provider: PENDING, VERIFIED, FAILED, CANCELLED, EXPIRED or USED. |
| POST | /api/v1/payment-verifications/:id/mock-result | Simulator only (404 otherwise). Bearer verificationToken; body `{outcome:"verified"\|"failed"\|"cancelled"}`. Stands in for the hosted page. The status is then read back from the provider. |
| GET | /api/v1/groups/:publicId/membership | Bearer memberToken. Group aggregate plus the member's own payment state and allowed `actions`. In PAYMENT_OPEN it first lets execution progress (lease-guarded). |
| POST | /api/v1/groups/:publicId/payment-approval | Bearer memberToken, PAYMENT_OPEN before the deadline. Approve (echoing the shown nonce and amount) records consent only; decline withdraws it until execution picks the member up. Idempotent. Returns `{group,member}`. |
| POST | /api/v1/groups/join | Body: `areaPublicId`, email, phone, lines, `verificationId`, `verificationToken`. Joins the area: under the coordination lock it expires stale groups, re-resolves the area (it must still be active), re-matches, joins the area's open group or creates one with this shopper as its first member, all in one transaction. Returns 201 with group, `created`, private memberToken and validatedPledgeAgorot. |
| POST | /api/v1/groups/:publicId/join | Body: `areaPublicId`, email, phone, lines, `verificationId`, `verificationToken`. Joins a specific group the shopper was shown; the group must belong to that active area (409 LOCATION_OUTSIDE_GROUP otherwise). Validates fresh Shopify data, then adds one membership; returns group, private memberToken and validatedPledgeAgorot. |
| GET | /api/v1/groups/:publicId | Aggregate only, no member authorization required. |
| POST | /api/v1/groups/:publicId/update-pledge | Body: lines, including [] for withdrawal. Requires Authorization: Bearer memberToken. Revalidates prices; returns group and own validatedPledgeAgorot. |
| GET | /health | Public status only |

Safe public group fields: publicId, areaName, status, participantCount, currency, thresholdAgorot, pledgedTotalAgorot, remainingAmountAgorot, progressPercent, expiresAt, approvals (`{approved,waiting,approvedPledgeTotalAgorot,ready,deadline}`). Contacts, anchors, centers, member locations, cart snapshots, internal member IDs and membership receipts are absent from public GET responses. Receipt tokens are never accepted in a query string.

## Merchant review and security

Open /admin. Login uses ADMIN_USERNAME/ADMIN_PASSWORD checked on the server, following the repository's single-admin session pattern with PostgreSQL storage instead of an in-memory session Map.

- HttpOnly, SameSite=Strict, eight-hour sessions; Secure + __Host- cookie in production.
- Session and receipt tokens stored only as SHA-256 hashes.
- Exact-origin CSRF protection; per-session CSRF nonce required for approval/logout.
- CORS applies only to public API paths, never credentialed admin routes.
- Admin list prioritizes threshold-reached groups and shows up to 200 records with totals, counts and dates; no customer contacts.
- GET /admin/api/groups and POST /admin/api/groups/:publicId/approve require the admin cookie. Approval also requires X-CSRF-Token (available in the authenticated page's hidden form).
- Merchant HTML approval/logout forms submit CSRF directly.
- Admin group cards show payment aggregates only. No provider references.
  - Totals: pledged total, approval target, approved pledge total.
  - Approval state: payment-ready state, approval deadline, waiting / approved / declined / expired / invalidated counts.
  - Payments: authorizations, processing, successful and failed payments, voided holds.
  - Other: legacy (non-payment-capable) members, closing reason, and a refund-required flag.
- Admin actions are merchant approval (THRESHOLD_REACHED → PAYMENT_OPEN) and "execute now" (`POST /admin/groups/:publicId/execute`, also `/admin/api/...`). Both use the same session, Origin and CSRF checks.
- Rate limits in PostgreSQL: 20 public writes / 10 minutes / IP, 15 payment-verification writes / 10 minutes / IP, 120 public reads / 10 minutes / IP, 10 admin login attempts / 15 minutes / IP.
- Bearer credentials (member receipts, verification secrets) are accepted only in the Authorization header, never in cookies or URLs, so cross-site pages cannot replay them. Every write still needs an allowed Origin and application/json.
- Parameterized SQL, validated inputs, fixed safe error messages, canonical host/TLS checks, narrow proxy trust and bounded request/variant counts.
- No customer bodies, contacts, exact coordinates, tokens, signatures or secrets are logged.
- Group/member records are durable; no business-data deletion policy is guessed. Choose a retention policy before wider rollout.

## Tests and limits

`npm test` uses an on-disk PGlite PostgreSQL engine with the real migrations and SQL, plus mocked Shopify responses. It tests DB restart persistence, duplicate/concurrent joins, anti-chain matching, money, empty-cart withdrawal, threshold changes, expiry, privacy, invalid carts, rate/body/origin limits, admin login, CSRF, approval, freeze and secure cookies.

Root `tests/group-delivery.browser.cjs` exercises the actual client script and section styling with mocked cart/service responses, explicit geolocation consent, durable per-group receipts and their migration and stale-receipt rules, the no-group-yet join flow, updates, failures, RTL, reduced motion and narrow widths.

No real Shopify API is consumed by automated tests. A live Render PostgreSQL instance, multi-process network concurrency, deployment credentials and real store variants are not part of the local fixtures. Run a staging smoke test against the deployed PostgreSQL/Shopify configuration before customer launch.

`tests/payments.test.ts` covers:
- the verification gate: missing, forged, foreign, failed, cancelled, expired and reused verifications;
- merchant approval opening and freezing the payment phase, and consent-only member approval;
- approved-value readiness, the 24 h deadline, and early execution;
- Shopify revalidation (changed price, unavailable inventory, outage);
- authorize/capture with retries, voids, unknown outcomes and the direct-charge fallback;
- server-held agorot amounts, nonce rotation, legacy members, and duplicate approvals;
- privacy of references in responses, admin and logs;
- admin aggregates, rate limits, the fail-closed configuration and the additive migration.

## Connecting a real payment provider

Not implemented. A future adapter implements `PaymentProvider` in `src/payments.ts` and is selected in `paymentProvider()` and `config()`. The adapter must provide:

1. **Tokenization/verification session.** `createVerificationSession({reference,idempotencyKey})` creates a zero-amount verification (or tokenization) on the provider's hosted page or hosted fields. It returns an opaque `sessionRef` and `next:{type:"redirect",url}`. Declare the exact hostnames in `redirectHosts`; any other URL is refused. Card data must never touch this service or the theme.
2. **Return and callback.** Add a provider callback/webhook route that verifies the provider's signature (HMAC or public key, over the raw body, with timestamp/replay protection) before trusting anything. It then updates the verification through the same `PENDING → VERIFIED/FAILED/CANCELLED` compare-and-set used by `sync()`. The browser return page only triggers `GET /payment-verifications/:id`, which re-reads `getVerificationStatus` from the provider.
3. **Storefront redirect.** Add the redirect branch in `assets/group-delivery.js`. Keep the verification secret in `sessionStorage` only for the round trip, then clear it.
4. **Payment-method reference.** Store only the provider's token or customer reference in `payment_verifications.payment_method_ref`. Encrypt it at rest if the provider recommends it. Never log, return or render it.
5. **Authorization and capture (preferred).** Set `supportsAuthorization=true` and implement `authorize`, `capture` and `voidAuthorization`, each passing our idempotency key (`…`, `…_capture`, `…_void`) to the provider. Holds must last at least `PAYMENT_APPROVAL_HOURS` plus processing time. Check the provider's hold expiry.
   **Direct charge (fallback).** `createCharge` must pass `idempotencyKey` to the provider's idempotency mechanism. A repeat with the same key must return the original result, never a second charge. Return SUCCEEDED with the provider's charged amount, a definitive FAILED (DECLINED/PROVIDER_ERROR), PENDING, or throw on an unknown outcome.
6. **Status reconciliation.** `getChargeStatus(idempotencyKey)` looks up the attempt. Also add a merchant-run or scheduled reconciliation for charges left PENDING, and for any success whose amount differs from the request.
7. **Webhooks for charges.** Accept verified, deduplicated charge events (store event ids), updating only the matching PENDING attempt.
8. **Refunds and cancellation.** These are not modelled yet. Decide a policy for CONFIRMED vs. under-funded PAYMENT_OPEN groups before launch.
9. **Before going live.** Revalidate stock and prices before charging if the business requires it. Add the provider's legal/consent copy, then run a staging test with the provider's sandbox.

No Shopify Admin calls, Draft Orders, payment links, checkout changes, shipping-rate changes, automatic charges or delivery creation exist.
