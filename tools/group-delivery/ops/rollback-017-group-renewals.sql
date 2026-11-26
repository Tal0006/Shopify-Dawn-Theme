-- Manual rollback of migration 017 (group renewals). NOT a migration: it lives outside migrations/ and never runs on
-- start-up. Run it by hand only after the service was rolled back to a release before 017, and only on approval.
--
-- Usually unnecessary: 017 is additive, and a release before it ignores the new table and columns. Prefer leaving the
-- schema in place. This script refuses (and changes nothing) once the feature was used, because that would lose the
-- recorded customer reconfirmations or break the restored 004 check on rows with reason EXPIRED.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM group_members WHERE withdrawn_by='EXPIRED') THEN
  RAISE EXCEPTION 'rollback refused: memberships with reason EXPIRED exist (kept expired, unconfirmed commitments)';
 END IF;
 IF EXISTS(SELECT 1 FROM member_reconfirmations) THEN
  RAISE EXCEPTION 'rollback refused: recorded customer reconfirmations exist';
 END IF;
 IF EXISTS(SELECT 1 FROM delivery_groups WHERE reopened_count>0) THEN
  RAISE EXCEPTION 'rollback refused: a group was reopened';
 END IF;
END $$;
ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_withdrawn_by_check;
ALTER TABLE group_members ADD CONSTRAINT group_members_withdrawn_by_check CHECK(withdrawn_by IS NULL OR withdrawn_by IN ('MEMBER','ADMIN'));
DROP TABLE IF EXISTS member_reconfirmations;
ALTER TABLE delivery_groups DROP COLUMN IF EXISTS last_reopened_at;
ALTER TABLE delivery_groups DROP COLUMN IF EXISTS reopened_count;
DELETE FROM schema_migrations WHERE name='017_group_renewals.sql';
COMMIT;
