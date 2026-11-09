-- Payment-verification foundation. Additive: existing groups and members keep their rows; members that joined
-- before verification existed get NOT_STARTED / NOT_REQUIRED and are never charged automatically.
-- CHECKs spell out IS NOT NULL because a NULL comparison would otherwise pass silently.
-- No card data is stored anywhere: only opaque provider references, statuses, integer agorot and timestamps.

-- One row per verification attempt. The browser holds the public id plus a one-time secret (stored hashed here).
-- The attempt is bound to the shopper's contact digest (HMAC of normalized email + phone) and is consumed by
-- exactly one join.
CREATE TABLE IF NOT EXISTS payment_verifications (
 id uuid PRIMARY KEY, public_id uuid NOT NULL UNIQUE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 contact_digest text NOT NULL CHECK(contact_digest ~ '^[a-f0-9]{64}$'),
 provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
 provider_session_ref text NOT NULL CHECK(char_length(provider_session_ref) BETWEEN 1 AND 255),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VERIFIED','FAILED','CANCELLED')),
 payment_method_ref text CHECK(payment_method_ref IS NULL OR char_length(payment_method_ref) BETWEEN 1 AND 255),
 failure_code text CHECK(failure_code IN ('DECLINED','PROVIDER_ERROR')),
 verified_at timestamptz, consumed_at timestamptz,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW(),
 UNIQUE(provider,provider_session_ref),
 CHECK((status='VERIFIED')=(payment_method_ref IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(status<>'FAILED' OR failure_code IS NOT NULL),
 CHECK(consumed_at IS NULL OR status='VERIFIED')
);
CREATE INDEX IF NOT EXISTS payment_verifications_expiry ON payment_verifications(expires_at) WHERE consumed_at IS NULL;

ALTER TABLE group_members
 ADD COLUMN IF NOT EXISTS payment_verification_id uuid UNIQUE REFERENCES payment_verifications(id),
 ADD COLUMN IF NOT EXISTS payment_method_status text NOT NULL DEFAULT 'NOT_STARTED',
 ADD COLUMN IF NOT EXISTS payment_verified_at timestamptz,
 ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'NOT_REQUIRED',
 -- Amount the member is asked to approve: a copy of the validated pledge at the moment approval became required.
 ADD COLUMN IF NOT EXISTS approval_amount_agorot bigint,
 -- Rotates whenever the requested amount changes, so an approval can only confirm the amount the member saw.
 ADD COLUMN IF NOT EXISTS approval_nonce text,
 ADD COLUMN IF NOT EXISTS approval_required_at timestamptz,
 ADD COLUMN IF NOT EXISTS approved_at timestamptz,
 ADD COLUMN IF NOT EXISTS charge_status text NOT NULL DEFAULT 'NOT_STARTED',
 ADD COLUMN IF NOT EXISTS charge_ref text,
 ADD COLUMN IF NOT EXISTS charged_amount_agorot bigint,
 ADD COLUMN IF NOT EXISTS charged_at timestamptz,
 ADD COLUMN IF NOT EXISTS charge_failure_code text,
 ADD COLUMN IF NOT EXISTS charge_attempts integer NOT NULL DEFAULT 0,
 -- Sent to the provider with every submission of one attempt; a new key is minted only after a definitive failure.
 ADD COLUMN IF NOT EXISTS charge_idempotency_key text UNIQUE,
 ADD COLUMN IF NOT EXISTS charge_requested_at timestamptz;

ALTER TABLE group_members
 ADD CONSTRAINT group_members_payment_method_status CHECK(payment_method_status IN ('NOT_STARTED','PENDING','VERIFIED','FAILED')),
 ADD CONSTRAINT group_members_verified_reference CHECK(payment_method_status<>'VERIFIED' OR (payment_verification_id IS NOT NULL AND payment_verified_at IS NOT NULL)),
 ADD CONSTRAINT group_members_approval_status CHECK(approval_status IN ('NOT_REQUIRED','REQUIRED','APPROVED','DECLINED','EXPIRED')),
 ADD CONSTRAINT group_members_approval_amount CHECK(approval_status='NOT_REQUIRED' OR (approval_amount_agorot IS NOT NULL AND approval_amount_agorot>0)),
 ADD CONSTRAINT group_members_approval_nonce CHECK(approval_status NOT IN ('REQUIRED','DECLINED') OR (approval_nonce IS NOT NULL AND approval_nonce ~ '^[a-f0-9]{32}$')),
 ADD CONSTRAINT group_members_charge_status CHECK(charge_status IN ('NOT_STARTED','PENDING','SUCCEEDED','FAILED')),
 ADD CONSTRAINT group_members_charge_needs_approval CHECK(charge_status NOT IN ('PENDING','SUCCEEDED') OR (approval_status='APPROVED' AND approved_at IS NOT NULL AND charge_idempotency_key IS NOT NULL)),
 ADD CONSTRAINT group_members_charge_success CHECK((charge_status='SUCCEEDED')=(charged_amount_agorot IS NOT NULL AND charged_at IS NOT NULL AND charge_ref IS NOT NULL)),
 ADD CONSTRAINT group_members_charge_amount CHECK(charged_amount_agorot IS NULL OR (approval_amount_agorot IS NOT NULL AND charged_amount_agorot>0 AND charged_amount_agorot<=approval_amount_agorot)),
 ADD CONSTRAINT group_members_charge_failure CHECK(charge_failure_code IS NULL OR (charge_status='FAILED' AND charge_failure_code IN ('DECLINED','PROVIDER_ERROR'))),
 ADD CONSTRAINT group_members_charge_attempts CHECK(charge_attempts BETWEEN 0 AND 20);

-- paid_total_agorot was pinned to 0 in phase one; it now mirrors the sum of successful member charges.
ALTER TABLE delivery_groups DROP CONSTRAINT IF EXISTS delivery_groups_paid_total_agorot_check;
ALTER TABLE delivery_groups ADD CONSTRAINT delivery_groups_paid_total_nonnegative CHECK(paid_total_agorot>=0);
ALTER TABLE delivery_groups
 ADD COLUMN IF NOT EXISTS payment_opened_at timestamptz,
 ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
