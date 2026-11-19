-- Transaction cancellation requests ("ביטול עסקה") from the storefront form (POST /api/v1/cancellations). Additive:
-- nothing existing changes.
-- The Israeli ID number is never stored in plaintext: id_number_sealed is AES-256-GCM (CANCELLATION_ENCRYPTION_KEY,
-- bound to this row's id) and id_fingerprint is an HMAC under a separate key derived from it (duplicate detection
-- only; an ID number cannot be recovered from it). Neither is ever logged, emailed, audited or sent to the storefront.
-- Retention (CANCELLATION_RETENTION_DAYS, counted from completed_at): every personal column is set to NULL and
-- purged_at is set. Only a non-personal record remains (reference, status, dates, the handling admin session label).
CREATE TABLE IF NOT EXISTS cancellation_requests (
 id uuid PRIMARY KEY,
 -- Public, non-sensitive reference the shopper keeps, e.g. CR-7K4M-Q2XZ (no I, L, O, U, 0 or 1).
 reference text NOT NULL UNIQUE CHECK(reference ~ '^CR-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$'),
 status text NOT NULL DEFAULT 'NEW' CHECK(status IN ('NEW','IN_REVIEW','COMPLETED')),
 created_at timestamptz NOT NULL DEFAULT NOW(),
 updated_at timestamptz NOT NULL DEFAULT NOW(),
 full_name text CHECK(full_name IS NULL OR char_length(full_name) BETWEEN 2 AND 120),
 order_number text CHECK(order_number IS NULL OR order_number ~ '^[A-Z0-9-]{1,30}$'),
 email text CHECK(email IS NULL OR char_length(email) BETWEEN 3 AND 254),
 phone text CHECK(phone IS NULL OR phone ~ '^\+?[0-9]{8,15}$'),
 reason text CHECK(reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000),
 id_number_sealed text CHECK(id_number_sealed IS NULL OR id_number_sealed LIKE 'v1.%'),
 id_fingerprint text CHECK(id_fingerprint IS NULL OR id_fingerprint ~ '^[a-f0-9]{64}$'),
 -- SHA-256 of the form's random submission key: a retry of the same submission returns the same reference.
 submission_key_hash text UNIQUE CHECK(submission_key_hash IS NULL OR submission_key_hash ~ '^[a-f0-9]{64}$'),
 admin_note text CHECK(admin_note IS NULL OR char_length(admin_note) BETWEEN 1 AND 1000),
 in_review_at timestamptz,
 -- handled_at: when the request was marked COMPLETED (the retention clock); handled_by: 'session:<12 hex>'.
 completed_at timestamptz,
 handled_by text CHECK(handled_by IS NULL OR char_length(handled_by) BETWEEN 3 AND 40),
 purged_at timestamptz,
 CONSTRAINT cancellation_requests_completion CHECK((status='COMPLETED')=(completed_at IS NOT NULL)),
 CONSTRAINT cancellation_requests_purged_empty CHECK(purged_at IS NULL OR (full_name IS NULL AND order_number IS NULL AND email IS NULL AND phone IS NULL AND reason IS NULL
  AND id_number_sealed IS NULL AND id_fingerprint IS NULL AND submission_key_hash IS NULL AND admin_note IS NULL)),
 CONSTRAINT cancellation_requests_active_complete CHECK(purged_at IS NOT NULL OR (full_name IS NOT NULL AND email IS NOT NULL AND id_number_sealed IS NOT NULL AND id_fingerprint IS NOT NULL)),
 CONSTRAINT cancellation_requests_purge_completed CHECK(purged_at IS NULL OR status='COMPLETED')
);
CREATE INDEX IF NOT EXISTS cancellation_requests_created ON cancellation_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS cancellation_requests_status ON cancellation_requests(status,created_at DESC);
CREATE INDEX IF NOT EXISTS cancellation_requests_duplicates ON cancellation_requests(id_fingerprint,created_at DESC) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS cancellation_requests_retention ON cancellation_requests(completed_at) WHERE status='COMPLETED' AND purged_at IS NULL;
