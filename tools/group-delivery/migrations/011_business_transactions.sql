-- Business finance (admin "כספים" page): manually recorded income and expenses, ILS only, integer agorot.
-- Additive; nothing existing changes. OPS_COSTS (environment) is NOT copied here automatically: the admin imports each
-- entry explicitly as a recurring expense (import_key makes that import happen at most once).
--
-- A recurring row is a DEFINITION, not a ledger line: it is never counted on its own transaction_date. Totals count it
-- once per billing date (every 1/3/12 months from recurrence_start_date, or transaction_date when no start is given,
-- on the same day of month or the month's last day) until recurrence_end_date. Nothing is materialized.
CREATE TABLE IF NOT EXISTS business_transactions (
 id uuid PRIMARY KEY,
 type text NOT NULL CHECK(type IN ('INCOME','EXPENSE')),
 -- Strictly positive; the type gives the direction. Upper bound ₪10,000,000 per entry.
 amount_agorot bigint NOT NULL CHECK(amount_agorot>0 AND amount_agorot<=1000000000),
 currency text NOT NULL DEFAULT 'ILS' CHECK(currency='ILS'),
 transaction_date date NOT NULL CHECK(transaction_date BETWEEN DATE '2000-01-01' AND DATE '2100-12-31'),
 category text NOT NULL CHECK(char_length(category) BETWEEN 1 AND 60),
 description text CHECK(description IS NULL OR char_length(description) BETWEEN 1 AND 200),
 payment_method text CHECK(payment_method IS NULL OR payment_method IN ('CARD','BANK_TRANSFER','CASH','STANDING_ORDER','OTHER')),
 source text NOT NULL DEFAULT 'MANUAL' CHECK(source IN ('MANUAL','SHOPIFY','CARDCOM','GROUP_DELIVERY','SYSTEM')),
 notes text CHECK(notes IS NULL OR char_length(notes) BETWEEN 1 AND 1000),
 recurring boolean NOT NULL DEFAULT false,
 recurrence_frequency text CHECK(recurrence_frequency IS NULL OR recurrence_frequency IN ('MONTHLY','QUARTERLY','YEARLY')),
 recurrence_start_date date,
 recurrence_end_date date,
 -- 'ops-costs:<16 hex>' for an entry imported from OPS_COSTS; NULL otherwise. Unique: one import per entry.
 import_key text UNIQUE CHECK(import_key IS NULL OR import_key ~ '^ops-costs:[a-f0-9]{16}$'),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 -- Same actor label as admin_audit ('session:<12 hex>'); the service has a single admin account.
 created_by text NOT NULL CHECK(char_length(created_by) BETWEEN 3 AND 40),
 updated_by text NOT NULL CHECK(char_length(updated_by) BETWEEN 3 AND 40),
 -- "חיוב קבוע" is an expense with recurrence metadata; one-off rows carry no recurrence fields.
 CONSTRAINT business_transactions_recurring_expense CHECK(NOT recurring OR type='EXPENSE'),
 CONSTRAINT business_transactions_recurrence_fields CHECK(
  (recurring AND recurrence_frequency IS NOT NULL) OR
  (NOT recurring AND recurrence_frequency IS NULL AND recurrence_start_date IS NULL AND recurrence_end_date IS NULL)),
 CONSTRAINT business_transactions_recurrence_range CHECK(recurrence_end_date IS NULL OR recurrence_end_date>=COALESCE(recurrence_start_date,transaction_date))
);
CREATE INDEX IF NOT EXISTS business_transactions_date ON business_transactions(transaction_date DESC,created_at DESC) WHERE NOT recurring;
CREATE INDEX IF NOT EXISTS business_transactions_recurring ON business_transactions(recurring) WHERE recurring;
