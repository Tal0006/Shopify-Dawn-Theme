-- Releasing stock after a definitive Cardcom failure. Additive (008 is unchanged).
-- A FAILED charge leaves an unpaid Shopify order that holds inventory (orderCreate DECREMENT_OBEYING_POLICY). The
-- order is canceled with orderCancel(reason: DECLINED, restock: true, notifyCustomer: false, no refund):
--   ORDER_CANCEL_REQUIRED  -> set together with FAILED; cancellation not done yet (or the last attempt failed)
--   ORDER_CANCEL_REQUESTED -> orderCancel accepted; Shopify cancels asynchronously
--   ORDER_CANCELED         -> Shopify reports cancelledAt; only now is the inventory recorded as released
-- Only FAILED charges are ever canceled: never UNKNOWN (the charge may have happened) and never SUCCEEDED (paid).
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_cancel_state text CHECK(shopify_cancel_state IS NULL OR shopify_cancel_state IN ('ORDER_CANCEL_REQUIRED','ORDER_CANCEL_REQUESTED','ORDER_CANCELED'));
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_cancel_requested_at timestamptz;
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_canceled_at timestamptz;
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS inventory_released_at timestamptz;
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_cancel_only_failed;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_cancel_only_failed CHECK(shopify_cancel_state IS NULL OR (status='FAILED' AND shopify_order_id IS NOT NULL));
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_inventory_after_cancel;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_inventory_after_cancel CHECK((inventory_released_at IS NOT NULL)=(shopify_cancel_state IS NOT DISTINCT FROM 'ORDER_CANCELED'));
-- Rows that already failed before this migration also release their stock (processed by the next run/reconciliation).
UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCEL_REQUIRED' WHERE status='FAILED' AND shopify_order_id IS NOT NULL AND shopify_cancel_state IS NULL;
