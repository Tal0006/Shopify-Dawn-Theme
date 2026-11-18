-- Where the ILS amount of an OPS-managed charge comes from. Additive; 011–013 are unchanged.
--  OPS_CONFIG: from OPS_COSTS (the ILS price, or financeAmountIls for a foreign-currency cost). The synchronization
--              keeps it in line with OPS_COSTS and stops the charge when OPS_COSTS no longer gives an ILS amount.
--  MANUAL:     typed by the admin in the old "import" flow (011/012), typically for a USD cost. The synchronization
--              keeps that amount while OPS_COSTS gives none, and takes over (OPS_CONFIG) only once OPS_COSTS defines one.
-- 013 cannot tell these apart afterwards (created_by does not record a later takeover), hence this column.
ALTER TABLE business_recurring_transactions ADD COLUMN IF NOT EXISTS amount_source text CHECK(amount_source IS NULL OR amount_source IN ('OPS_CONFIG','MANUAL'));
-- Charges created by the synchronization (013) carry the system actor; anything else that is OPS-managed was imported
-- by hand. A hand import of an ILS cost is taken over on the next synchronization (its entry gives an ILS amount),
-- so only foreign-currency hand imports keep MANUAL in practice.
UPDATE business_recurring_transactions SET amount_source=CASE WHEN created_by LIKE 'system:%' THEN 'OPS_CONFIG' ELSE 'MANUAL' END
 WHERE managed_by='OPS_COSTS' AND amount_source IS NULL;
ALTER TABLE business_recurring_transactions DROP CONSTRAINT IF EXISTS business_recurring_amount_source;
ALTER TABLE business_recurring_transactions ADD CONSTRAINT business_recurring_amount_source CHECK((managed_by IS NULL)=(amount_source IS NULL));
