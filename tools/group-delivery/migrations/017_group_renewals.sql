-- Store-owner renewal of an expired group (src/renewals.ts). Additive: nothing existing changes.
-- A pledge in an expired group counts again only after the customer reconfirmed it explicitly (by phone, WhatsApp,
-- e-mail or in person) and the store owner recorded that here. One row per recorded confirmation; rows are never
-- deleted. The reference is a short note such as a date or ticket number, never contact details.
CREATE TABLE IF NOT EXISTS member_reconfirmations (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES delivery_groups(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 method text NOT NULL CHECK(method IN ('PHONE','WHATSAPP','EMAIL','IN_PERSON')),
 reference text CHECK(reference IS NULL OR char_length(reference)<=60),
 -- The pledge before the confirmation, and the amount the customer confirmed (today's Shopify prices).
 previous_amount_agorot bigint NOT NULL CHECK(previous_amount_agorot>=0),
 confirmed_amount_agorot bigint NOT NULL CHECK(confirmed_amount_agorot>0),
 confirmed_snapshot jsonb NOT NULL,
 -- Anonymous admin session reference ('session:' + 12 hex), as in admin_audit.
 recorded_by text NOT NULL CHECK(char_length(recorded_by) BETWEEN 3 AND 40),
 recorded_at timestamptz NOT NULL DEFAULT NOW(),
 -- Set when a reopen counted this confirmation; a used or revoked confirmation is never counted again.
 used_at timestamptz,
 revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_reconfirmations_member ON member_reconfirmations(group_id,member_id,recorded_at DESC);
-- Why a membership stopped counting: MEMBER (the customer withdrew), ADMIN (the store owner removed it) and now EXPIRED
-- (its group expired and the customer did not reconfirm before the group was reopened). The original amount and cart
-- stay in cart_snapshot and the audit log. Replaces the check from migration 004, whatever name PostgreSQL gave it.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%withdrawn_by%' LOOP
  EXECUTE format('ALTER TABLE group_members DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE group_members ADD CONSTRAINT group_members_withdrawn_by_check CHECK(withdrawn_by IS NULL OR withdrawn_by IN ('MEMBER','ADMIN','EXPIRED'));
-- How often a group was reopened, and when last (shown to the store owner).
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS reopened_count integer NOT NULL DEFAULT 0 CHECK(reopened_count>=0);
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS last_reopened_at timestamptz;
