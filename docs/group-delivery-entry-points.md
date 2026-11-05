# Group Delivery storefront entry points

Use the existing Shopify Page assigned to page.group-delivery. Under Theme settings > Group Delivery select that page if its handle differs from group-delivery. Without a selection, the theme resolves pages['group-delivery']; it never constructs a guessed URL. If no published page resolves, links and the promotion are omitted (the Theme Editor shows setup guidance).

The homepage promotion follows Trust Benefits and can be moved, disabled, or removed in the Theme Editor. Heading, title, copy, and CTA label are editable; the shared page picker keeps all destinations consistent.

For the preferred merchant-managed navigation, add “משלוח קבוצתי” to the header's selected Shopify menu and choose the existing page using Shopify's page selector. Keep the link at the top level for direct visibility on desktop and mobile. The optional theme navigation shortcut is enabled by default and omitted when the menu already contains the destination at any of Shopify's three nesting levels. Disable this shortcut in Theme settings to manage placement exclusively through Navigation. Existing menu order and entries are never overwritten.

A compact contextual link is available beneath the footer's store information. Its separate Theme setting can disable it. It is omitted if the rendered customer-service menu already contains the page. Existing links and policies are preserved.

No backend URL, preview parameters, private group identifiers, or membership receipts are used. The promotion sends no requests and is usable without JavaScript. Publishing the page and any merchant Navigation changes remain Shopify Admin configuration steps.
