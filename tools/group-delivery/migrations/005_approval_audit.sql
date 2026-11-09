-- Approval audit (additive). When Shopify revalidation voids an approval (price change or unavailable cart), keep the
-- amount the member had approved, when it was voided and how many times the request was re-issued.
ALTER TABLE group_members
 ADD COLUMN IF NOT EXISTS previous_approval_amount_agorot bigint,
 ADD COLUMN IF NOT EXISTS approval_invalidated_at timestamptz,
 ADD COLUMN IF NOT EXISTS approval_revision integer NOT NULL DEFAULT 0;
ALTER TABLE group_members ADD CONSTRAINT group_members_previous_approval CHECK(previous_approval_amount_agorot IS NULL OR (previous_approval_amount_agorot>0 AND approval_invalidated_at IS NOT NULL));
ALTER TABLE group_members ADD CONSTRAINT group_members_approval_revision CHECK(approval_revision BETWEEN 0 AND 1000);
-- Set by the merchant's "execute now": later runs may start new payments without waiting for remaining answers.
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS payment_execution_forced boolean NOT NULL DEFAULT false;
