-- Order lifecycle (src/orders.ts). Additive: no existing row changes meaning; every existing order stays editable.
--
-- 1. An order (a group_members row) can be LOCKED: paid outside the online payment flow (owner-attested) or delivered.
--    A locked order is never edited, withdrawn or reconfirmed by anyone; a new cart becomes a separate order.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS order_state text NOT NULL DEFAULT 'OPEN' CHECK(order_state IN ('OPEN','LOCKED'));
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS locked_reason text CHECK(locked_reason IS NULL OR locked_reason IN ('PAID_EXTERNAL','DELIVERED'));
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_lock_consistent;
ALTER TABLE group_members ADD CONSTRAINT group_members_lock_consistent CHECK((order_state='OPEN' AND locked_at IS NULL AND locked_reason IS NULL) OR (order_state='LOCKED' AND locked_at IS NOT NULL AND locked_reason IS NOT NULL));

-- 2. Every cart an order ever had, in order. Rows are never updated or deleted. BASELINE is the cart at migration time
--    (earlier versions were never recorded).
CREATE TABLE IF NOT EXISTS member_cart_versions (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 cart_snapshot jsonb NOT NULL,
 amount_agorot bigint NOT NULL CHECK(amount_agorot>=0),
 source text NOT NULL CHECK(source IN ('BASELINE','JOIN','CUSTOMER_UPDATE','REOPEN','ADMIN_RESTORE','ADMIN_SPLIT','ADMIN_TRANSFER','ANOTHER_ORDER')),
 actor text CHECK(actor IS NULL OR char_length(actor) BETWEEN 3 AND 40),
 recorded_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS member_cart_versions_member ON member_cart_versions(member_id,recorded_at);
INSERT INTO member_cart_versions(id,member_id,cart_snapshot,amount_agorot,source)
 SELECT gen_random_uuid(),m.id,m.cart_snapshot,m.pledged_total_agorot,'BASELINE' FROM group_members m
 WHERE NOT EXISTS(SELECT 1 FROM member_cart_versions v WHERE v.member_id=m.id);

-- 3. Payments received outside the online payment flow, attested by the store owner. Never a Shopify or Cardcom
--    transaction and never a charge. One active record per order; a record is voided, never deleted.
--    cart_fingerprint = md5 of the order's cart at attestation, so a record always names the exact cart it paid for.
CREATE TABLE IF NOT EXISTS member_payment_records (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 group_id uuid NOT NULL REFERENCES delivery_groups(id) ON DELETE CASCADE,
 amount_agorot bigint NOT NULL CHECK(amount_agorot>0),
 method text NOT NULL CHECK(method IN ('CASH','BANK_TRANSFER','BIT','PAYBOX','CARD_EXTERNAL','OTHER')),
 received_on date NOT NULL CHECK(received_on BETWEEN DATE '2020-01-01' AND DATE '2100-12-31'),
 -- A short note (receipt number, date); never contact or card details.
 reference text CHECK(reference IS NULL OR char_length(reference)<=60),
 cart_fingerprint text NOT NULL CHECK(char_length(cart_fingerprint)=32),
 attested_by text NOT NULL CHECK(char_length(attested_by) BETWEEN 3 AND 40),
 recorded_at timestamptz NOT NULL DEFAULT NOW(),
 -- A mistaken record is voided, never deleted or edited: when, by whom (admin session reference) and why. A
 -- correction is a new record that names the one it replaces.
 voided_at timestamptz,
 voided_by text CHECK(voided_by IS NULL OR char_length(voided_by) BETWEEN 3 AND 40),
 void_reason text CHECK(void_reason IS NULL OR char_length(void_reason) BETWEEN 3 AND 60),
 replaces_id uuid REFERENCES member_payment_records(id),
 CHECK((voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL) OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS member_payment_records_active ON member_payment_records(member_id) WHERE voided_at IS NULL;

-- 4. Links between orders of the same customer: an order split off a restored one (ORDER_SPLIT), placed from an
--    existing receipt (ANOTHER_ORDER) or carried to the next cycle (CYCLE_TRANSFER). The receipt of the first order can open the linked one.
--    request_id makes "place another order" idempotent (one order per client request).
CREATE TABLE IF NOT EXISTS member_links (
 id uuid PRIMARY KEY,
 from_member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 to_member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK(reason IN ('ORDER_SPLIT','ANOTHER_ORDER','CYCLE_TRANSFER')),
 request_id uuid UNIQUE,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK(from_member_id<>to_member_id),
 UNIQUE(from_member_id,to_member_id)
);
CREATE INDEX IF NOT EXISTS member_links_from ON member_links(from_member_id);

-- 5. Rows never move between groups (ids never change). An order carried to the next cycle is a new row there,
--    linked from the original (CYCLE_TRANSFER); the original stays in its cycle as history with reason TRANSFERRED.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%withdrawn_by%' LOOP
  EXECUTE format('ALTER TABLE group_members DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE group_members ADD CONSTRAINT group_members_withdrawn_by_check CHECK(withdrawn_by IS NULL OR withdrawn_by IN ('MEMBER','ADMIN','EXPIRED','TRANSFERRED'));

-- 5b. At most one OPEN order per customer (e-mail, and phone) per cycle; LOCKED orders (paid or delivered) no longer
--     block a separate new order in the same cycle. Replaces the UNIQUE(group_id,email) / (group_id,phone) table
--     constraints of migration 001 (whatever names PostgreSQL gave them) with partial unique indexes. Ordinary joins
--     still refuse any existing row with the same details (Groups.admissible); only "place another order" uses this.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='group_members'::regclass AND contype='u'
   AND (pg_get_constraintdef(oid) IN ('UNIQUE (group_id, email)','UNIQUE (group_id, phone)')) LOOP
  EXECUTE format('ALTER TABLE group_members DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS group_members_open_email ON group_members(group_id,email) WHERE order_state='OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS group_members_open_phone ON group_members(group_id,phone) WHERE order_state='OPEN';

-- 6. Owner cycle splits ("סיום מחזור ופתיחת מחזור חדש"), one row per executed split; the key makes a retry a no-op.
CREATE TABLE IF NOT EXISTS group_cycle_splits (
 id uuid PRIMARY KEY,
 idempotency_key uuid NOT NULL UNIQUE,
 source_group_id uuid NOT NULL REFERENCES delivery_groups(id),
 target_group_id uuid NOT NULL REFERENCES delivery_groups(id),
 reason text NOT NULL CHECK(reason IN ('PAID_ORDERS_DELIVERED','ORDER_OVERWRITE_RECONCILIATION')),
 summary jsonb NOT NULL,
 actor text NOT NULL CHECK(char_length(actor) BETWEEN 3 AND 40),
 created_at timestamptz NOT NULL DEFAULT NOW()
);

-- 7. Device receipts issued for a linked order.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='member_tokens'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%source%' LOOP
  EXECUTE format('ALTER TABLE member_tokens DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE member_tokens ADD CONSTRAINT member_tokens_source_check CHECK(source IN ('JOIN','RECOVERY','LINK'));
