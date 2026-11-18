-- Card reservation (Cardcom Low Profile CreateTokenOnly, J2: card check + token, no charge) and charging after admin
-- approval. Additive: every existing group is backfilled as payment_mode NONE and keeps working exactly as before
-- (no card, no charge); only groups created while Cardcom is required are CARDCOM. Never stored here: card numbers,
-- CVV, track data, the Cardcom password or any API credential. The Cardcom token is stored only AES-256-GCM sealed
-- with a key that lives in the environment (GROUP_DELIVERY_PAYMENT_ENCRYPTION_KEY), never in the database.
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'NONE' CHECK(payment_mode IN ('NONE','CARDCOM'));
-- Derived from group_payment_charges after approval of a CARDCOM group; NULL before approval and for NONE groups.
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS payment_state text CHECK(payment_state IS NULL OR payment_state IN ('CHARGING','PAID','PAYMENT_REVIEW_REQUIRED'));
-- Phase 1 pinned paid_total_agorot to 0. Paid totals are now reachable, but only for CARDCOM groups and only from
-- confirmed Cardcom charges (never from pledges).
ALTER TABLE delivery_groups DROP CONSTRAINT IF EXISTS delivery_groups_paid_total_agorot_check;
ALTER TABLE delivery_groups ADD CONSTRAINT delivery_groups_paid_total_agorot_check CHECK(paid_total_agorot>=0 AND (payment_mode='CARDCOM' OR paid_total_agorot=0));

-- Payment state of a membership, separate from the membership status (PLEDGED/WITHDRAWN). NULL: a member of a NONE
-- group (no card). approved_amount_agorot/consent_at: the last amount the member explicitly approved to be charged.
-- pending_*: a cart change above the approved amount, waiting for explicit consent; it is never counted or charged.
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS payment_status text CHECK(payment_status IS NULL OR payment_status IN ('CARD_RESERVED','CONSENT_REQUIRED','CHARGE_PENDING','CHARGED','PAYMENT_FAILED','CANCELED'));
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS approved_amount_agorot bigint CHECK(approved_amount_agorot IS NULL OR approved_amount_agorot>=0);
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS consent_at timestamptz;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS pending_cart_snapshot jsonb;
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS pending_amount_agorot bigint CHECK(pending_amount_agorot IS NULL OR pending_amount_agorot>0);
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_pending_consistent;
ALTER TABLE group_members ADD CONSTRAINT group_members_pending_consistent CHECK((pending_cart_snapshot IS NULL)=(pending_amount_agorot IS NULL));
-- The counted (and chargeable) pledge of an active card member never exceeds what that member explicitly approved.
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_pledge_within_consent;
ALTER TABLE group_members ADD CONSTRAINT group_members_pledge_within_consent CHECK(payment_status IS NULL OR status<>'PLEDGED' OR
 (approved_amount_agorot IS NOT NULL AND consent_at IS NOT NULL AND pledged_total_agorot<=approved_amount_agorot));

-- One row per card-reservation attempt. id is our random correlation id, sent to Cardcom as ReturnValue (no PII).
-- While PENDING_RESERVATION the row holds the join it will create (contact, validated cart, approved amount); a pending
-- reservation is not a member, holds no group slot and never counts toward any total. Contact and cart are erased as
-- soon as the row leaves PENDING_RESERVATION. CARD_RESERVED: verified server-to-server with GetLpResult; the sealed
-- token is kept until the charge succeeds (CONSUMED) or the membership is canceled (CANCELED), then deleted.
CREATE TABLE IF NOT EXISTS group_payment_reservations (
 id uuid PRIMARY KEY,
 provider text NOT NULL DEFAULT 'CARDCOM' CHECK(provider='CARDCOM'),
 status text NOT NULL CHECK(status IN ('PENDING_RESERVATION','CARD_RESERVED','CONSUMED','RESERVATION_FAILED','EXPIRED','CANCELED')),
 -- Target: the area (its group is matched or created only on activation) or a specific group; member_id is set for a
 -- withdrawn member re-reserving, and on activation.
 area_id uuid REFERENCES delivery_areas(id),
 group_id uuid REFERENCES delivery_groups(id) ON DELETE CASCADE,
 member_id uuid REFERENCES group_members(id) ON DELETE CASCADE,
 email text,
 phone text,
 cart_snapshot jsonb,
 -- SHA-256 of the receipt the browser holds; it authorizes status reads now and becomes the member receipt on activation.
 member_token_hash text NOT NULL CHECK(member_token_hash ~ '^[a-f0-9]{64}$'),
 amount_agorot bigint NOT NULL CHECK(amount_agorot>0),
 consent_at timestamptz NOT NULL,
 consent_version text NOT NULL CHECK(consent_version ~ '^[a-z0-9.-]{3,40}$'),
 low_profile_id uuid UNIQUE,
 token_ciphertext text CHECK(token_ciphertext IS NULL OR char_length(token_ciphertext) BETWEEN 40 AND 400),
 token_expires_on date,
 card_last4 text CHECK(card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
 card_brand text CHECK(card_brand IS NULL OR card_brand ~ '^[A-Za-z]{2,20}$'),
 -- Our own safe enum codes (e.g. DECLINED, GROUP_CLOSED, ABANDONED) and Cardcom's numeric ResponseCode; never provider text.
 failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{2,40}$'),
 provider_response_code integer,
 last_checked_at timestamptz,
 verified_at timestamptz,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK(area_id IS NOT NULL OR group_id IS NOT NULL OR member_id IS NOT NULL),
 CHECK((status='CARD_RESERVED')=(token_ciphertext IS NOT NULL)),
 CHECK(status='PENDING_RESERVATION' OR (email IS NULL AND phone IS NULL AND cart_snapshot IS NULL)),
 CHECK(status NOT IN ('CARD_RESERVED','CONSUMED') OR (member_id IS NOT NULL AND group_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS group_payment_reservations_pending ON group_payment_reservations(status,expires_at);
CREATE INDEX IF NOT EXISTS group_payment_reservations_member ON group_payment_reservations(member_id,status);

-- One charge per member per approved group (UNIQUE): a double click, retry or restart can never create a second one.
-- id is sent to Cardcom as ExternalUniqTranId. A charge is claimed (PENDING -> IN_FLIGHT) before Cardcom is called and
-- sent at most once automatically; a lost/ambiguous answer becomes UNKNOWN and is only resolved by reconciliation.
CREATE TABLE IF NOT EXISTS group_payment_charges (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES delivery_groups(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 reservation_id uuid NOT NULL REFERENCES group_payment_reservations(id),
 amount_agorot bigint NOT NULL CHECK(amount_agorot>0),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 cardcom_transaction_id bigint,
 provider_response_code integer,
 failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[A-Z0-9_]{2,40}$'),
 started_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 UNIQUE(group_id,member_id),
 CHECK((status='SUCCEEDED')=(cardcom_transaction_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS group_payment_charges_group ON group_payment_charges(group_id,status);
