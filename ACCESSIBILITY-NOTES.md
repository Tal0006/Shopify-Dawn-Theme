# Storefront accessibility — 12 October 2026

The layer runs only in layout/theme.liquid. Checkout is unchanged. Existing Hebrew translations, URL pickers, product/collection selection, native cart forms and Theme Editor settings are preserved. New interface strings are added to both storefront locales.

## Improvements

- Fixed logical bottom corner launcher with a 52px touch area. A labeled non-modal native dialog supports keyboard entry, Escape, explicit close and focus return. Tab can leave the panel; it closes when focus moves to another page control. There is no custom Tab trap.
- Text scaling from 80% to 150% includes existing pixel-based text and form controls, without changing the base design. Responsive font baselines are remeasured on resize and new content.
- High contrast, grayscale, link highlighting and animation pause. Grayscale uses a pointer-transparent viewport overlay so it does not create a new positioning ancestor for the RTL header/drawers.
- Preferences use the localStorage key punky-accessibility-v1. Invalid data is normalized, storage exceptions do not disable controls, and reset removes only this key. System reduced-motion preferences always remain respected after reset.
- Native skip link to a focusable main landmark. Strong focus rings and persistent underlines on links in descriptive content.
- Informative image alternatives use saved alt text first, with product/title fallbacks. Image-only product/cart links have explicit names. Decorative assets keep intentionally empty alternatives. Social image blocks now have an optional accessible description setting.
- Native product thumbnail buttons and submenu disclosure buttons preserve the original destination links. Hidden mobile/cart drawers are inert, opening moves focus into them after their visibility transition, and Escape returns focus to their launcher.
- Corrected page/About and collection/search card heading levels, and the optional newsletter heading. Existing CSS preserves card styling for h2 and h3.

## Accessibility statement setup

1. In Shopify Admin, create a page titled הצהרת נגישות.
2. Assign the page.accessibility template (shown as accessibility in the template selector).
3. Enter the store's reviewed statement in the page content. Include actual contact details, known limitations, tested assistive technologies and the latest review date. The prepared fallback is a feature description, not a compliance certification.
4. In Customize → Footer, select that page in עמוד הצהרת נגישות. The footer link uses the selected page URL; no handle is hardcoded.
5. If using fallback content, select a contact page in the accessibility statement section.

## Verification and limits

Theme Check: no issues under the project configuration. JavaScript syntax checks pass. The existing four locale/template tests pass. Seven browser scenarios pass for skip focus, non-modal panel keyboard behavior, persistence/reset/text bounds, system reduced motion, accessible names and image alternatives on six core routes, native product thumbnails, and mobile menu/cart controls plus 150% text at 320px. Desktop and mobile screenshots were inspected; the statement section renders with HTTP 200.

Browser tests require Shopify theme dev on port 9292 and an isolated Chrome remote-debugging session on port 9333. Run node --test tests/accessibility.browser.cjs. Alternate URLs use ACCESSIBILITY_PREVIEW_URL and ACCESSIBILITY_DEBUG_URL. The tests do not submit contact/newsletter forms or navigate to checkout.

Remaining manual checks: NVDA/VoiceOver announcements and reading order; keyboard-only use on actual devices; iOS/Android and browser zoom at 200%/400%; authenticated customer account and order screens; multiple variants/images and optional section combinations; image-specific descriptions and heading structure in merchant-authored content; contrast of uploaded images, color choices and third-party widgets; the finished statement and contact route. Third-party embeds and future Admin content require their own review. This is not a full WCAG audit or certification.

## Files for this change

### created

- assets/accessibility.css
- assets/accessibility.js
- snippets/accessibility-menu.liquid
- sections/accessibility-statement.liquid
- templates/page.accessibility.json
- tests/accessibility.browser.cjs
- ACCESSIBILITY-NOTES.md

### modified

- layout/theme.liquid
- assets/storefront.css
- assets/storefront.js
- assets/script.js
- locales/en.json
- locales/he.default.json
- sections/header.liquid
- sections/footer.liquid
- sections/hero-section.liquid
- sections/single-product.liquid
- sections/main-cart.liquid
- sections/feature-section.liquid
- sections/shop-now.liquid
- sections/social-media.liquid
- sections/content.liquid
- sections/about-us.liquid
- snippets/navigation-links.liquid
- snippets/product-card.liquid

