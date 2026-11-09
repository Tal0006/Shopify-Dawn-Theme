-- Payment phase refinement (additive). Merchant approval opens a time-boxed member-approval window; member approval
-- only records consent; execution (Shopify revalidation, then authorize/capture or the direct-charge fallback) is a
-- separate step. Existing rows keep their values; no member is charged by this migration.

-- Member approvals: INVALIDATED = the stored cart can no longer be honoured as approved (needs store review).
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_approval_status;
ALTER TABLE group_members ADD CONSTRAINT group_members_approval_status CHECK(approval_status IN ('NOT_REQUIRED','REQUIRED','APPROVED','DECLINED','EXPIRED','INVALIDATED'));
ALTER TABLE group_members
 -- Why a fresh approval (CART_CHANGED) or store review (CART_UNAVAILABLE) is needed after Shopify revalidation.
 ADD COLUMN IF NOT EXISTS approval_review_reason text,
 ADD COLUMN IF NOT EXISTS authorization_ref text,
 ADD COLUMN IF NOT EXISTS authorized_at timestamptz,
 ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE group_members ADD CONSTRAINT group_members_review_reason CHECK(approval_review_reason IS NULL OR approval_review_reason IN ('CART_CHANGED','CART_UNAVAILABLE'));

-- Execution states: PENDING (authorization or direct charge submitted, outcome not yet known), AUTHORIZED (funds
-- reserved, nothing moved), CAPTURING (capture submitted), SUCCEEDED (money moved), FAILED, VOIDED (released).
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_charge_status;
ALTER TABLE group_members ADD CONSTRAINT group_members_charge_status CHECK(charge_status IN ('NOT_STARTED','PENDING','AUTHORIZED','CAPTURING','SUCCEEDED','FAILED','VOIDED'));
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_charge_needs_approval;
ALTER TABLE group_members ADD CONSTRAINT group_members_charge_needs_approval CHECK(charge_status IN ('NOT_STARTED','FAILED','VOIDED') OR (approval_status='APPROVED' AND approved_at IS NOT NULL AND charge_idempotency_key IS NOT NULL));
ALTER TABLE group_members ADD CONSTRAINT group_members_authorization_ref CHECK(charge_status NOT IN ('AUTHORIZED','CAPTURING') OR (authorization_ref IS NOT NULL AND authorized_at IS NOT NULL));

ALTER TABLE delivery_groups
 -- Set once when the merchant opens the payment phase; never extended.
 ADD COLUMN IF NOT EXISTS approval_deadline timestamptz,
 ADD COLUMN IF NOT EXISTS payment_execution_started_at timestamptz,
 -- Short lease so only one request at a time runs a group's execution step (crash-safe: it simply lapses).
 ADD COLUMN IF NOT EXISTS payment_execution_lease_until timestamptz,
 ADD COLUMN IF NOT EXISTS closed_reason text,
 ADD COLUMN IF NOT EXISTS closed_at timestamptz,
 -- Direct-charge fallback only: a cancelled group in which some money was already moved.
 ADD COLUMN IF NOT EXISTS refund_required boolean NOT NULL DEFAULT false;
-- Development databases that ran the earlier simulator flow get a fixed window from when payment opened.
UPDATE delivery_groups SET approval_deadline=COALESCE(payment_opened_at,NOW())+INTERVAL '24 hours' WHERE status='PAYMENT_OPEN' AND approval_deadline IS NULL;
ALTER TABLE delivery_groups ADD CONSTRAINT delivery_groups_payment_deadline CHECK(status<>'PAYMENT_OPEN' OR approval_deadline IS NOT NULL);
ALTER TABLE delivery_groups ADD CONSTRAINT delivery_groups_closed_reason CHECK(closed_reason IS NULL OR closed_reason IN ('APPROVAL_DEADLINE','INSUFFICIENT_PAYMENTS'));
