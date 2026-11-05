
CREATE TABLE IF NOT EXISTS delivery_groups (
 id uuid PRIMARY KEY, public_id uuid NOT NULL UNIQUE, area_name text NOT NULL, locality_key text NOT NULL,
 anchor_lat double precision, anchor_lng double precision, center_lat double precision, center_lng double precision,
 threshold_agorot bigint NOT NULL CHECK(threshold_agorot>0),
 pledged_total_agorot bigint NOT NULL DEFAULT 0 CHECK(pledged_total_agorot>=0),
 paid_total_agorot bigint NOT NULL DEFAULT 0 CHECK(paid_total_agorot=0),
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','THRESHOLD_REACHED','APPROVED','PAYMENT_OPEN','CONFIRMED','SCHEDULED','COMPLETED','EXPIRED','CANCELLED')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK ((anchor_lat IS NULL)=(anchor_lng IS NULL)), CHECK ((center_lat IS NULL)=(center_lng IS NULL)),
 CHECK(anchor_lat BETWEEN -90 AND 90), CHECK(anchor_lng BETWEEN -180 AND 180), CHECK(center_lat BETWEEN -90 AND 90), CHECK(center_lng BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS delivery_groups_matching ON delivery_groups(status,locality_key,expires_at);
CREATE TABLE IF NOT EXISTS group_members (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES delivery_groups(id) ON DELETE CASCADE,
 email text NOT NULL, phone text NOT NULL, locality_key text NOT NULL, approx_lat double precision, approx_lng double precision,
 cart_snapshot jsonb NOT NULL, pledged_total_agorot bigint NOT NULL CHECK(pledged_total_agorot>=0),
 token_hash text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'PLEDGED' CHECK(status IN ('PLEDGED','WITHDRAWN')),
 created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW(),
 CHECK((status='PLEDGED' AND pledged_total_agorot>0) OR (status='WITHDRAWN' AND pledged_total_agorot=0)),
 UNIQUE(group_id,email), UNIQUE(group_id,phone), CHECK((approx_lat IS NULL)=(approx_lng IS NULL)), CHECK(approx_lat BETWEEN -90 AND 90), CHECK(approx_lng BETWEEN -180 AND 180)
);
CREATE INDEX IF NOT EXISTS group_members_group ON group_members(group_id);
CREATE TABLE IF NOT EXISTS group_coordination (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO group_coordination(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS admin_sessions (
 token_hash text PRIMARY KEY, csrf text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS request_limits (
 key text NOT NULL, bucket bigint NOT NULL, hits integer NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(key,bucket)
);

CREATE INDEX IF NOT EXISTS request_limits_expiry ON request_limits(expires_at);
