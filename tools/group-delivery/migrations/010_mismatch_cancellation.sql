-- ORDER_TOTAL_MISMATCH is a definitive failure before any charge: the unpaid Shopify order it left behind is canceled
-- and restocked with the same mechanism as a FAILED charge (009). Additive; 009 is unchanged.
-- Cancellation states are allowed on FAILED rows and on ORDER_FAILED rows that have an order (only a total mismatch
-- creates an order and then fails); never on UNKNOWN, SUCCEEDED or any in-progress row.
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_cancel_only_failed;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_cancel_only_failed CHECK(shopify_cancel_state IS NULL OR (status IN ('FAILED','ORDER_FAILED') AND shopify_order_id IS NOT NULL));
-- Mismatched orders left open before this migration are canceled by the next run/reconciliation.
UPDATE group_payment_charges SET shopify_cancel_state='ORDER_CANCEL_REQUIRED' WHERE status='ORDER_FAILED' AND failure_code='ORDER_TOTAL_MISMATCH' AND shopify_order_id IS NOT NULL AND shopify_cancel_state IS NULL;
