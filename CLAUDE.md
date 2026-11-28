# Fankee — repository guide for Claude

Hebrew (RTL) Shopify storefront plus small Node services. One Git repo, no root `package.json`.

## Layout

| Path | What it is | Production runtime |
| --- | --- | --- |
| repo root (`assets/ config/ layout/ locales/ sections/ snippets/ templates/`) | Shopify theme based on Dawn v15, Liquid + vanilla JS, `he` default locale | Shopify (the theme is released by hand, see below) |
| `tests/` | Theme tests (`node:test`, `*.test.cjs` and `*.browser.cjs`) | local only |
| `tools/group-delivery` | Group Delivery service: Express 5, TypeScript, `pg`, admin pages, Cardcom, Shopify orders, finance, renewals, cancellations, feedback | Render web service + Neon PostgreSQL |
| `tools/shopping-assistant` | Hebrew shopping-list → Shopify cart API, optional WhatsApp channel; in-memory state, no DB | Render web service |
| `tools/product-importer` | Barcode product importer (Cheapersal/SerpAPI, Shopify Admin API, creates DRAFT products) | Render web service |
| `tools/shopify-app` | Checkout UI extension (Thank-you page feedback survey) of the existing Fankee app | Shopify app (deployed by hand) |
| `docs/` | Entry-point notes, privacy-policy draft | — |

Each `tools/*` service is independent (own `package.json`, `node_modules`, `.env`); none imports another. `.shopifyignore` keeps `tools/**` and `.env` out of theme uploads. Every service has a long README; read the relevant section before changing behavior.

## Commands (verified from package.json / READMEs)

Theme (repo root, Node 22+, Chrome installed):
- `node --test --test-concurrency=1 tests/*.cjs` — all theme tests. Always concurrency 1.
- `node --test tests/<name>.cjs` — one file. Most browser suites start their own headless Chrome against fixtures (`CHROME_PATH` overrides).
- `accessibility`, `navigation`, `card-cart` need `shopify theme dev` on `127.0.0.1:9292` and Chrome CDP on `127.0.0.1:9333`; without them they fail with `fetch failed`.
- Liquid-render tests skip unless `NODE_PATH` points at a `liquidjs@10` install (not a repo dependency).
- `node tests/helpers/theme-revision.cjs` prints the revision stamp; `--write` updates `snippets/theme-revision.liquid` (release step only).

Services (`cd tools/<service>` first):
- `npm test` — group-delivery uses on-disk PGlite with the real migrations and mocked Shopify; shopping-assistant and product-importer block external HTTP. Safe offline.
- `npm run build` (tsc → `dist/`), `npm run typecheck` (shopping-assistant, product-importer, shopify-app).
- `npm run dev` / `npm run migrate` / `npm run inspect:catalog` load the local `.env` and may reach real services — see risks.
- shopify-app: `npm test` (needs Chrome), `npm run typecheck`.

Ports: group-delivery 4330, shopping-assistant 4320, product-importer 4310, theme dev 9292.

## Production vs local

- **Production**: Shopify live store + live theme; Render services (build `npm ci --include=dev && npm run build`, start `npm start`, health `/health`); Neon PostgreSQL for group-delivery; Cardcom payments; Resend email; Meta WhatsApp Business. All secrets live in Render's environment panel, never in the repo or theme settings.
- **Local/test**: PGlite in `npm test`, mocked Shopify/Cardcom/Meta, fixture HTML servers, development store for `shopify theme dev` / `shopify app dev`, Cardcom sandbox terminal only on a staging service with its own database.
- A local `.env` can contain production credentials. Treat any command that loads it as touching production.

## Architectural boundaries

- Theme code never holds tokens, database URLs or admin credentials. Storefront JS calls only the public service APIs.
- group-delivery: migrations in `migrations/NNN_*.sql` run transactionally on **every server start**. Never edit a deployed migration; add the next number. Rollbacks are hand-run scripts in `ops/`.
- group-delivery money is integer agorot; orders/payments are designed to be idempotent (one Shopify order and one Cardcom transaction per member). Preserve that.
- Admin routes: server session in PostgreSQL, SameSite=Strict `__Host-` cookie, exact-origin + per-session CSRF nonce, strict CSP (no inline script/style). Public API CORS never applies to admin routes.
- shopping-assistant uses the Storefront API only (no Admin token); single instance, quotes/sessions are in memory and lost on restart.
- shopify-app: the backend origin is hard-coded in `extensions/post-purchase-feedback/src/feedback.ts`. `shopify app deploy` also pushes `shopify.app.toml` (scopes) to the live app.

## Operational risks — stop and ask before any of these

- Releasing the theme (`shopify theme push/publish`), `shopify app deploy/release`, any Render deploy, Neon branch/DB change.
- Starting a service with a `.env` (it runs migrations against whatever `DATABASE_URL` points to).
- Anything that charges cards (approving a Cardcom group), creates/changes Shopify orders or products, sends email or WhatsApp messages.
- `npm run cancellations:retention` (permanently clears personal data).
- `git push`, merges, rebases, branch deletion, hard resets.

## Working rules

- Never read or print `.env` files, tokens or customer data; use `.env.example` for variable names.
- Do not paste real customer names, phones, emails, addresses or order data into code, tests, docs or commits.
- Keep the UI RTL-correct and accessible (keyboard, focus, reduced motion, narrow widths); Hebrew strings go through `locales/`.
- Run the relevant `npm test` / `node --test` before calling work done, and report failures as they are.
- Known repo quirks: local `main` may lag `origin/main` (branch from `origin/main`); `tools/shopify-app` has `node_modules` tracked in Git; native Windows has no Claude sandbox, so permission rules are a guard, not a boundary.

## Project agents (`.claude/agents/`)

`frontend`, `backend`, `database` (read-only, no shell), `qa` (also runs the offline PGlite database tests), `security-review` (read-only, no shell). Delegate only when the task is large or needs an independent review; do small changes directly.
