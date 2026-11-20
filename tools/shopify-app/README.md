# Fankee Shopify app: checkout UI extensions

This folder holds the extensions of the **existing Fankee app**: the Dev Dashboard app whose `SHOPIFY_CLIENT_ID` and
`SHOPIFY_CLIENT_SECRET` the Group Delivery service on Render already uses. It is not a new app, and no third-party app
is involved.

| Extension | Target | What it does |
|---|---|---|
| `extensions/post-purchase-feedback` | `purchase.thank-you.block.render` (API 2026-10) | A short, optional Hebrew survey on the Thank you page about the ordering and site experience |

## How the survey works

- The extension (Preact with Polaris web components) reads the order from `shopify.orderConfirmation`. It asks for a
  session token with `shopify.sessionToken.get()`, then sends a `POST` to
  `https://fankee-group-delivery.onrender.com/api/post-purchase-feedback` with `Authorization: Bearer <token>`.
- The backend checks the token's signature with the app secret, and checks that it was issued for this app and this
  shop. It stores at most one response per order. See the "Post-purchase feedback" section of
  `tools/group-delivery/README.md`.
- **No credentials in the extension.** It holds no Admin API token or secret, and it calls no Shopify API.
- **Nothing in URLs, cookies or `localStorage`.** Answers travel only in the request body. The extension's own storage
  keeps just the id of the order that already answered, so the form isn't shown again on the same device.
- **Failures never affect the page.** If the backend is asleep or down, or anything else goes wrong, the shopper sees
  "לא הצלחנו לשלוח את המשוב כרגע. ההזמנה שלכם הושלמה כרגיל." The order confirmation is unaffected.
- **The Thank you page holds the survey only.** There is no Google review request, no review link and no extension
  setting: the customer hasn't received the products yet. See "Next feature" below.
- **The order status page is not targeted**, so a shopper is never asked twice.
- **The backend address is hard-coded.** It's in `src/feedback.ts` (`BACKEND_ORIGIN`). If the Render service moves,
  change it there and deploy a new app version.

## Development

```sh
cd tools/shopify-app
npm install                      # installs the extension dependencies (node_modules is git-ignored)
npm run typecheck                # tsc for the extension and its tests
npm test                         # unit, render and headless-Chrome tests (needs Chrome; CHROME_PATH to override)
```

The tests run the real component, but against stand-in Polaris elements. How it looks inside Shopify's real checkout
can only be checked with `shopify app dev` (below).

## Deploying (manual, by the merchant or developer)

`shopify app deploy` always sends the app configuration (`shopify.app.toml`, including scopes and URLs) along with the
extensions. Recent CLI versions removed `include_config_on_deploy`. A hand-written or guessed `shopify.app.toml` could
therefore change the live app, which is why none is committed here.

1. **Deploy the backend first.** Render applies migration `016_post_purchase_feedback.sql` on startup. Then check
   these Render variables:
   - `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` must belong to the app linked in step 2. The session tokens are
     signed with that app's secret.
2. **Link to the existing app** (no new app):
   ```sh
   cd tools/shopify-app
   shopify app config link      # choose the existing Fankee app; this writes shopify.app.toml from its live configuration
   ```
   Review the generated `shopify.app.toml` and don't change its scopes or URLs. The client ID isn't a secret, so the
   file can be committed if you want.
3. **Network access.** The extension declares `network_access = true`.
   - If the dashboard asks for it, allow network access for checkout UI extensions in the app's API access settings.
     `shopify app deploy` reports when this is missing.
   - No protected customer data access is needed: the extension reads no customer details.
4. **Preview on a development store:** `shopify app dev`, then open the checkout editor → Thank you page, and place a
   test order.
5. **Release:** `shopify app deploy`. This creates and releases a new app version; `--no-release` only stages it.
6. **Place the block in the store's checkout editor:**
   - Shopify admin → Settings → Checkout → Customize → page selector: **Thank you**.
   - Add app block → **Post-purchase feedback**. Put it below the order confirmation details. It has no settings.
   - Save.

   App blocks on the Thank you page are available on the Basic plan. Checkout-step extensions are not used.
7. **Check end to end:**
   - Place a test order and answer the survey. A second submission from the same order must change nothing.
   - The response then appears on `/admin/feedback`.

## Next feature: Google review request after confirmed delivery

Not implemented yet. The Thank you page deliberately holds the survey only: right after checkout the customer hasn't
received the products, so it's too early to ask for a Google review. The planned design:

- **Trigger: an actual `delivered` state** on the Shopify order's fulfillment. For Shopify Local Delivery, the merchant
  marks the order as delivered in Shopify after handing it to the customer.
- **Not proof of delivery:** checkout completion, the Thank you page, or `Order fulfilled` alone. Fulfilled means it
  left the store, not that the customer has it.
- **Once per order.** A repeated or replayed delivery event must not send a second request.
- **Independent of the survey.** It is sent whatever the survey score, and whether or not the survey was answered.
- **No incentive** of any kind (discount, coupon, gift, points or any other reward) for leaving a review.
- **Kept separate from `post_purchase_feedback`.** That table never records whether a review link was sent or clicked.
