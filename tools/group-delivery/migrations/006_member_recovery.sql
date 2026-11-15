-- Email OTP recovery of an existing membership on another browser/device. Additive: no existing row is changed or
-- removed, and every receipt issued before this migration keeps working.
--
-- Device receipts. One membership can be authenticated from several devices: each successful recovery adds a row
-- here, and no existing receipt is rotated or revoked. Only SHA-256 hashes of the 256-bit random bearer tokens are
-- stored. group_members.token_hash stays the receipt issued at join (backfilled here and still written at join), so
-- a join served by an instance still running the previous release during a rolling deploy keeps working; see
-- Groups.member() for the lookup.
CREATE TABLE IF NOT EXISTS member_tokens (
 id uuid PRIMARY KEY,
 member_id uuid NOT NULL REFERENCES group_members(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(char_length(token_hash) BETWEEN 1 AND 128),
 source text NOT NULL CHECK(source IN ('JOIN','RECOVERY')),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 -- Reserved for a future "sign out other devices"; nothing revokes a receipt yet.
 revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_tokens_member ON member_tokens(member_id);
INSERT INTO member_tokens(id,member_id,token_hash,source,created_at)
 SELECT gen_random_uuid(),m.id,m.token_hash,'JOIN',m.created_at FROM group_members m
 WHERE NOT EXISTS(SELECT 1 FROM member_tokens t WHERE t.token_hash=m.token_hash);
--
-- One-time recovery codes. Never the code itself: code_hash is an HMAC (server secret) of the challenge id and the
-- 6-digit code, so a database copy alone cannot be brute-forced offline. member_id is NULL when the submitted details
-- matched no membership: the row exists so that the public answer, limits and attempt counting look the same either
-- way, and it can never verify. identity_hash / requester_hash are HMACs of the submitted contact pair (per group) and
-- of the client IP, used only for rate limits. Rows are short-lived security records, deleted after a day.
CREATE TABLE IF NOT EXISTS member_recovery_challenges (
 id uuid PRIMARY KEY,
 group_id uuid NOT NULL REFERENCES delivery_groups(id) ON DELETE CASCADE,
 member_id uuid REFERENCES group_members(id) ON DELETE CASCADE,
 identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
 requester_hash text NOT NULL CHECK(requester_hash ~ '^[a-f0-9]{64}$'),
 code_hash text NOT NULL CHECK(code_hash ~ '^[a-f0-9]{64}$'),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 closed_reason text CHECK(closed_reason IS NULL OR closed_reason IN ('VERIFIED','SUPERSEDED','LOCKED','DELIVERY_FAILED')),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK((consumed_at IS NULL)=(closed_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS member_recovery_identity ON member_recovery_challenges(identity_hash,created_at);
CREATE INDEX IF NOT EXISTS member_recovery_group ON member_recovery_challenges(group_id,created_at);
CREATE INDEX IF NOT EXISTS member_recovery_member ON member_recovery_challenges(member_id,created_at);
CREATE INDEX IF NOT EXISTS member_recovery_created ON member_recovery_challenges(created_at);
--
-- Customer security events (separate from the admin action log). Safe metadata only: an event name, the group public
-- id and the internal member id when a membership matched. Never an email, phone, code, token or IP address.
CREATE TABLE IF NOT EXISTS security_events (
 id uuid PRIMARY KEY,
 at timestamptz NOT NULL DEFAULT NOW(),
 event text NOT NULL CHECK(event IN ('RECOVERY_REQUESTED','RECOVERY_SENT','RECOVERY_DELIVERY_FAILED','RECOVERY_SUCCEEDED','RECOVERY_FAILED','RECOVERY_LOCKED')),
 group_public_id uuid,
 member_id uuid
);
CREATE INDEX IF NOT EXISTS security_events_member ON security_events(member_id,at);
CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at DESC);
