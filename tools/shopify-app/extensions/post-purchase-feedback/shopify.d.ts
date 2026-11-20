// Types the `shopify` global for the Thank you page target (the Shopify CLI also generates this file on `app dev`).
import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/ThankYou.tsx' {
  const shopify: import('@shopify/ui-extensions/purchase.thank-you.block.render').Api;
  const globalThis: {shopify: typeof shopify};
}
