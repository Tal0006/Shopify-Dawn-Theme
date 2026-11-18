-- OPS_COSTS-managed recurring charges. Additive; 011 and 012 are unchanged.
-- managed_by='OPS_COSTS': the charge mirrors an OPS_COSTS entry (matched by import_key). The service creates it,
-- updates its amount/frequency prospectively and deactivates it when the entry disappears. Manual charges keep NULL
-- and are never touched by the synchronization.
-- deactivated_reason: ADMIN (stopped from the finance page) or OPS_SYNC (stopped because the entry left OPS_COSTS or
-- is no longer a positive ILS cost). Only OPS_SYNC charges are reactivated when their entry comes back.
ALTER TABLE business_recurring_transactions ADD COLUMN IF NOT EXISTS managed_by text CHECK(managed_by IS NULL OR managed_by='OPS_COSTS');
ALTER TABLE business_recurring_transactions ADD COLUMN IF NOT EXISTS deactivated_reason text CHECK(deactivated_reason IS NULL OR deactivated_reason IN ('ADMIN','OPS_SYNC'));
-- Charges imported by hand from OPS_COSTS (011/012 import flow) carry an ops-costs import key: they become managed.
UPDATE business_recurring_transactions SET managed_by='OPS_COSTS' WHERE import_key IS NOT NULL AND managed_by IS NULL;
-- Anything stopped before this migration was stopped by the admin.
UPDATE business_recurring_transactions SET deactivated_reason='ADMIN' WHERE NOT active AND deactivated_reason IS NULL;
ALTER TABLE business_recurring_transactions DROP CONSTRAINT IF EXISTS business_recurring_managed_key;
ALTER TABLE business_recurring_transactions ADD CONSTRAINT business_recurring_managed_key CHECK(managed_by IS NULL OR import_key IS NOT NULL);
ALTER TABLE business_recurring_transactions DROP CONSTRAINT IF EXISTS business_recurring_deactivated_reason;
ALTER TABLE business_recurring_transactions ADD CONSTRAINT business_recurring_deactivated_reason CHECK(active=(deactivated_reason IS NULL));
