-- Shopify order before every Cardcom charge, Cardcom-safe external ids and explicit card expiry.
-- Additive on top of 007 (007 is left unchanged because it may already have been applied to a local/staging database).
--
-- Card expiry as Cardcom returned it in GetLpResult TokenInfo (CardMonth/CardYear), normalized: month 1-12 and a
-- 4-digit year. CardExpirationMMYY for a token charge is built from these two columns. Not a secret; never CVV.
ALTER TABLE group_payment_reservations ADD COLUMN IF NOT EXISTS card_exp_month smallint CHECK(card_exp_month IS NULL OR card_exp_month BETWEEN 1 AND 12);
ALTER TABLE group_payment_reservations ADD COLUMN IF NOT EXISTS card_exp_year smallint CHECK(card_exp_year IS NULL OR card_exp_year BETWEEN 2000 AND 2099);
ALTER TABLE group_payment_reservations DROP CONSTRAINT IF EXISTS group_payment_reservations_card_exp_pair;
ALTER TABLE group_payment_reservations ADD CONSTRAINT group_payment_reservations_card_exp_pair CHECK((card_exp_month IS NULL)=(card_exp_year IS NULL));

-- ExternalUniqTranId sent to Cardcom: at most 25 characters (Cardcom KB "Preventing Duplicate Transactions When Charging
-- Tokens"). Derived deterministically from the charge id ('G' + first 24 hex digits, 25 characters), so it is stable
-- across retries, restarts and reconciliation and is never regenerated; UNIQUE so two charges can never share it.
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS external_uniq_tran_id text;
UPDATE group_payment_charges SET external_uniq_tran_id='G'||substr(replace(id::text,'-',''),1,24) WHERE external_uniq_tran_id IS NULL;
ALTER TABLE group_payment_charges ALTER COLUMN external_uniq_tran_id SET NOT NULL;
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_external_uniq_tran_id_key;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_external_uniq_tran_id_key UNIQUE(external_uniq_tran_id);
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_external_id_derived;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_external_id_derived CHECK(char_length(external_uniq_tran_id)<=25 AND external_uniq_tran_id='G'||substr(replace(id::text,'-',''),1,24));

-- The exact approved cart the order and the charge are built from (copied at approval; immutable afterwards).
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS order_lines jsonb;
UPDATE group_payment_charges c SET order_lines=m.cart_snapshot FROM group_members m WHERE c.member_id=m.id AND c.order_lines IS NULL;
-- Shopify order (GraphQL Admin orderCreate). One order per charge row, and the charge row is UNIQUE per member and
-- group (007), so a member of a group can never get a second order; UNIQUE order id so no order serves two charges.
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_order_id text CHECK(shopify_order_id IS NULL OR shopify_order_id ~ '^gid://shopify/Order/[1-9][0-9]{0,19}$');
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_shopify_order_id_key;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_shopify_order_id_key UNIQUE(shopify_order_id);
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_order_name text CHECK(shopify_order_name IS NULL OR char_length(shopify_order_name)<=40);
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_order_created_at timestamptz;
-- Recording the Cardcom payment on the Shopify order (orderCreateManualPayment + reference tag), after Cardcom succeeded.
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_payment_state text NOT NULL DEFAULT 'NOT_STARTED' CHECK(shopify_payment_state IN ('NOT_STARTED','SYNCED','SYNC_REQUIRED'));
ALTER TABLE group_payment_charges ADD COLUMN IF NOT EXISTS shopify_synced_at timestamptz;

-- Charge lifecycle. Order stage: PENDING -> ORDER_CREATING -> ORDER_CREATED (or ORDER_FAILED / ORDER_UNKNOWN).
-- Cardcom stage (only from ORDER_CREATED): IN_FLIGHT -> SUCCEEDED / FAILED / UNKNOWN.
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_status_check;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_status_check CHECK(status IN ('PENDING','ORDER_CREATING','ORDER_CREATED','ORDER_FAILED','ORDER_UNKNOWN','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN'));
-- No Cardcom charge without a Shopify order: every Cardcom-stage row must carry its order. (NOT VALID only so that
-- charge rows written before this migration, which had no order step, do not block it; every new write is checked.)
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_order_before_charge;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_order_before_charge CHECK(status NOT IN ('ORDER_CREATED','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN') OR shopify_order_id IS NOT NULL) NOT VALID;
ALTER TABLE group_payment_charges DROP CONSTRAINT IF EXISTS group_payment_charges_sync_after_success;
ALTER TABLE group_payment_charges ADD CONSTRAINT group_payment_charges_sync_after_success CHECK(shopify_payment_state='NOT_STARTED' OR status='SUCCEEDED');
