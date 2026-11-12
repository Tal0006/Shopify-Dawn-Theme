-- Operational delivery workflow (admin only), separate from the business status (OPEN/THRESHOLD_REACHED/APPROVED/...).
-- Additive. Every existing group is backfilled as NEW by the column default: no existing row can be reliably known
-- to have been delivered, so none is marked COMPLETED. Completing a group never deletes or rewrites its members.
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS operational_status text NOT NULL DEFAULT 'NEW'
 CHECK(operational_status IN ('NEW','IN_PROGRESS','READY_FOR_DELIVERY','OUT_FOR_DELIVERY','COMPLETED'));
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS completed_at timestamptz;
-- Anonymous admin session reference ('session:' + 12 hex of the session hash), never a token.
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS completed_by text CHECK(completed_by IS NULL OR char_length(completed_by) BETWEEN 3 AND 40);
ALTER TABLE delivery_groups DROP CONSTRAINT IF EXISTS delivery_groups_completion_consistent;
ALTER TABLE delivery_groups ADD CONSTRAINT delivery_groups_completion_consistent CHECK((operational_status='COMPLETED')=(completed_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS delivery_groups_operational ON delivery_groups(operational_status);
-- Audit transitions: previous_status (added in 004 for member statuses) also holds operational statuses now, and
-- new_status records the target. Upper-case enum values only; never free text.
ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_previous_status_check;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_previous_status_check CHECK(previous_status IS NULL OR previous_status ~ '^[A-Z_]{3,30}$');
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS new_status text CHECK(new_status IS NULL OR new_status ~ '^[A-Z_]{3,30}$');
CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit(target,at);
