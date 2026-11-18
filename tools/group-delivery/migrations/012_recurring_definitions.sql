-- Recurring charges become definitions that RECORD immutable expense rows (one per billing date) in
-- business_transactions, instead of being expanded at query time. A recorded row keeps the amount and descriptive
-- fields that applied when it was recorded; editing or stopping a definition never touches recorded rows.
-- Additive: migration 011 is unchanged; its business_transactions.recurring* columns stay but are no longer used.

CREATE TABLE IF NOT EXISTS business_recurring_transactions (
 id uuid PRIMARY KEY,
 type text NOT NULL DEFAULT 'EXPENSE' CHECK(type='EXPENSE'),
 amount_agorot bigint NOT NULL CHECK(amount_agorot>0 AND amount_agorot<=1000000000),
 currency text NOT NULL DEFAULT 'ILS' CHECK(currency='ILS'),
 category text NOT NULL CHECK(char_length(category) BETWEEN 1 AND 60),
 description text CHECK(description IS NULL OR char_length(description) BETWEEN 1 AND 200),
 payment_method text CHECK(payment_method IS NULL OR payment_method IN ('CARD','BANK_TRANSFER','CASH','STANDING_ORDER','OTHER')),
 source text NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','SHOPIFY','CARDCOM','GROUP_DELIVERY','SYSTEM')),
 notes text CHECK(notes IS NULL OR char_length(notes) BETWEEN 1 AND 1000),
 -- Billing dates: start_date + k*frequency_months (same day of month, or the month's last day), until end_date.
 frequency_months smallint NOT NULL CHECK(frequency_months IN (1,3,12)),
 start_date date NOT NULL CHECK(start_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
 end_date date,
 -- The first billing date the CURRENT terms may record. A change of amount, frequency or dates moves it to the day of
 -- the change, so new terms never reach back into dates that were already due.
 effective_from date NOT NULL,
 active boolean NOT NULL DEFAULT true,
 deactivated_at timestamptz,
 import_key text UNIQUE CHECK(import_key IS NULL OR import_key ~ '^ops-costs:[a-f0-9]{16}$'),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 created_by text NOT NULL CHECK(char_length(created_by) BETWEEN 3 AND 40),
 updated_by text NOT NULL CHECK(char_length(updated_by) BETWEEN 3 AND 40),
 CONSTRAINT business_recurring_range CHECK(end_date IS NULL OR end_date>=start_date),
 CONSTRAINT business_recurring_active CHECK(active=(deactivated_at IS NULL))
);
CREATE INDEX IF NOT EXISTS business_recurring_active_idx ON business_recurring_transactions(active) WHERE active;

-- Recorded billing dates. The UNIQUE pair makes recording idempotent (INSERT … ON CONFLICT DO NOTHING): the same
-- billing date of the same charge can never exist twice, whatever the concurrency. One-off rows keep both NULL.
ALTER TABLE business_transactions ADD COLUMN IF NOT EXISTS recurring_definition_id uuid REFERENCES business_recurring_transactions(id) ON DELETE RESTRICT;
ALTER TABLE business_transactions ADD COLUMN IF NOT EXISTS recurring_occurrence_date date;
ALTER TABLE business_transactions DROP CONSTRAINT IF EXISTS business_transactions_recurring_occurrence;
ALTER TABLE business_transactions ADD CONSTRAINT business_transactions_recurring_occurrence UNIQUE(recurring_definition_id,recurring_occurrence_date);
ALTER TABLE business_transactions DROP CONSTRAINT IF EXISTS business_transactions_occurrence_shape;
ALTER TABLE business_transactions ADD CONSTRAINT business_transactions_occurrence_shape CHECK(
 (recurring_definition_id IS NULL AND recurring_occurrence_date IS NULL) OR
 (recurring_definition_id IS NOT NULL AND recurring_occurrence_date=transaction_date AND type='EXPENSE' AND NOT recurring));
CREATE INDEX IF NOT EXISTS business_transactions_definition ON business_transactions(recurring_definition_id,recurring_occurrence_date) WHERE recurring_definition_id IS NOT NULL;

-- Rows created under 011 as recurring were definitions, never money movements (011 counted them only virtually).
-- Move each to a definition with the SAME id, anchor, terms and import_key, then remove the 011 row. History is not
-- lost or doubled: the service records the same billing dates (from the original anchor) on its next finance request.
INSERT INTO business_recurring_transactions(id,type,amount_agorot,currency,category,description,payment_method,source,notes,frequency_months,start_date,end_date,effective_from,
 active,import_key,created_at,updated_at,created_by,updated_by)
SELECT id,'EXPENSE',amount_agorot,currency,category,description,payment_method,source,notes,
 CASE recurrence_frequency WHEN 'MONTHLY' THEN 1 WHEN 'QUARTERLY' THEN 3 ELSE 12 END,
 COALESCE(recurrence_start_date,transaction_date),recurrence_end_date,COALESCE(recurrence_start_date,transaction_date),
 true,import_key,created_at,updated_at,created_by,updated_by
FROM business_transactions WHERE recurring
ON CONFLICT (id) DO NOTHING;
DELETE FROM business_transactions WHERE recurring;
-- From now on business_transactions holds actual movements only.
ALTER TABLE business_transactions DROP CONSTRAINT IF EXISTS business_transactions_actual_only;
ALTER TABLE business_transactions ADD CONSTRAINT business_transactions_actual_only CHECK(NOT recurring);
