-- Server-owned delivery areas become the grouping boundary for new groups.
-- Additive only: existing groups, members and their area_name/locality_key/coordinates are never rewritten.
CREATE TABLE IF NOT EXISTS delivery_areas (
 id uuid PRIMARY KEY, public_id uuid NOT NULL UNIQUE,
 name text NOT NULL CHECK(char_length(name) BETWEEN 2 AND 60),
 -- Normalized locality key of the original name (same normalization as domain.ts localityKey); immutable.
 slug text NOT NULL UNIQUE,
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 active boolean NOT NULL DEFAULT true,
 sort_order integer NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 100000),
 created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS delivery_areas_public ON delivery_areas(active,sort_order,name);
-- Exact normalized spellings that identify an area. Used only for exact legacy compatibility, never fuzzy matching.
CREATE TABLE IF NOT EXISTS delivery_area_aliases (
 alias_key text PRIMARY KEY,
 area_id uuid NOT NULL REFERENCES delivery_areas(id) ON DELETE CASCADE
);
ALTER TABLE delivery_groups ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES delivery_areas(id);
CREATE INDEX IF NOT EXISTS delivery_groups_area_matching ON delivery_groups(area_id,status,expires_at);

-- Initial areas with fixed public IDs so references stay stable across environments. Idempotent.
INSERT INTO delivery_areas(id,public_id,name,slug,latitude,longitude,sort_order) VALUES
 ('9b1d5f3e-0001-4a00-8000-000000000001','6f1a2c00-0001-4a00-8000-0000000000a1','באר שבע','באר שבע',31.2518,34.7913,10),
 ('9b1d5f3e-0002-4a00-8000-000000000002','6f1a2c00-0002-4a00-8000-0000000000a2','אשדוד','אשדוד',31.8014,34.6435,20),
 ('9b1d5f3e-0003-4a00-8000-000000000003','6f1a2c00-0003-4a00-8000-0000000000a3','אשקלון','אשקלון',31.6688,34.5743,30),
 ('9b1d5f3e-0004-4a00-8000-000000000004','6f1a2c00-0004-4a00-8000-0000000000a4','קריית גת','קריית גת',31.6100,34.7642,40),
 ('9b1d5f3e-0005-4a00-8000-000000000005','6f1a2c00-0005-4a00-8000-0000000000a5','נתיבות','נתיבות',31.4231,34.5886,50),
 ('9b1d5f3e-0006-4a00-8000-000000000006','6f1a2c00-0006-4a00-8000-0000000000a6','אופקים','אופקים',31.3142,34.6203,60),
 ('9b1d5f3e-0007-4a00-8000-000000000007','6f1a2c00-0007-4a00-8000-0000000000a7','שדרות','שדרות',31.5250,34.5969,70)
ON CONFLICT (slug) DO NOTHING;

-- Canonical names plus common exact spellings, already normalized (NFKC, lower case, separators -> single space).
INSERT INTO delivery_area_aliases(alias_key,area_id)
SELECT alias.key,area.id FROM (VALUES
 ('באר שבע','באר שבע'),('beer sheva','באר שבע'),('be er sheva','באר שבע'),('beersheba','באר שבע'),('beer sheba','באר שבע'),
 ('אשדוד','אשדוד'),('ashdod','אשדוד'),
 ('אשקלון','אשקלון'),('ashkelon','אשקלון'),('ashqelon','אשקלון'),
 ('קריית גת','קריית גת'),('קרית גת','קריית גת'),('kiryat gat','קריית גת'),('qiryat gat','קריית גת'),
 ('נתיבות','נתיבות'),('netivot','נתיבות'),
 ('אופקים','אופקים'),('ofakim','אופקים'),('ofaqim','אופקים'),
 ('שדרות','שדרות'),('sderot','שדרות')
) AS alias(key,slug) JOIN delivery_areas area ON area.slug=alias.slug
ON CONFLICT (alias_key) DO NOTHING;

-- Legacy mapping: only text-only groups (no coordinates) whose stored locality key exactly equals an alias.
-- Coordinate groups and any other spelling stay unmapped legacy groups. Names, keys and members are untouched.
UPDATE delivery_groups g SET area_id=x.area_id
FROM delivery_area_aliases x
WHERE g.area_id IS NULL AND g.anchor_lat IS NULL AND g.locality_key=x.alias_key;
