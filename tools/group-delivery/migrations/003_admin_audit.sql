-- Admin audit trail: one row per admin mutation, login/logout and customer-data export. Safe metadata only:
-- never passwords, tokens, request bodies or customer contact details. Additive; nothing existing changes.
CREATE TABLE IF NOT EXISTS admin_audit (
 id uuid PRIMARY KEY,
 at timestamptz NOT NULL DEFAULT NOW(),
 action text NOT NULL CHECK(char_length(action) BETWEEN 3 AND 40),
 -- 'session:<first 12 hex of the session token hash>' or 'anonymous' (failed logins). Never the token itself.
 actor text NOT NULL CHECK(char_length(actor) BETWEEN 3 AND 40),
 -- Group public id or area public id; NULL for login/logout.
 target text CHECK(target IS NULL OR char_length(target)<=64),
 result text NOT NULL CHECK(result IN ('OK','DENIED','FAILED')),
 -- An error code (e.g. APPROVAL_NOT_ALLOWED) or export kind; never free text from requests.
 detail text CHECK(detail IS NULL OR char_length(detail)<=60)
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at DESC);
