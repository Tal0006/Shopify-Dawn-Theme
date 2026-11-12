-- Withdrawal history. Additive: new nullable columns, plus a backfill of withdrawn_by for rows withdrawn before this.
-- withdrawn_by tells a customer's own withdrawal (receipt) from a store-owner removal in /admin; both are cleared
-- when the same membership row pledges again. Member rows are never deleted.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS withdrawn_by text CHECK(withdrawn_by IS NULL OR withdrawn_by IN ('MEMBER','ADMIN'));
-- Before this migration only the customer's own receipt could withdraw, so existing withdrawn rows are MEMBER.
-- Their withdrawal time was not recorded and stays NULL.
UPDATE group_members SET withdrawn_by='MEMBER' WHERE status='WITHDRAWN' AND withdrawn_by IS NULL;
-- Audit metadata for member-level admin actions: internal member id, status before the action, pledge before the
-- action (agorot). Never contact details, tokens or cart contents.
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS subject uuid;
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS previous_status text CHECK(previous_status IS NULL OR previous_status IN ('PLEDGED','WITHDRAWN'));
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS amount_agorot bigint CHECK(amount_agorot IS NULL OR amount_agorot>=0);
