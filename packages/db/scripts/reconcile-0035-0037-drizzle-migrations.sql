-- Reconcile drizzle.__drizzle_migrations on prod Neon (Issue #27).
--
-- WHY: migrations 0035/0036/0037 were applied to Neon out-of-band (0035 via an
-- early push; 0036 meetings.location + 0037 notes.is_private via direct DDL in
-- PR #26) but never recorded in the tracking table. It sat at 35 rows with
-- max(created_at)=1780781000000 (== 0034's journal `when`), so `drizzle-kit
-- migrate` would re-attempt 0035's non-idempotent ADD COLUMN and fail with
-- "column already exists".
--
-- WHAT: insert the three missing rows so max(created_at) == 0037's `when`. The
-- migrator decides what to apply purely by `created_at DESC LIMIT 1` (see
-- drizzle-orm/pg-core/dialect.js), so this makes `migrate` a clean no-op.
--   created_at = the `when` from packages/db/migrations/meta/_journal.json
--   hash       = sha256(<full .sql file contents>) — recompute with
--                `shasum -a 256 packages/db/migrations/<tag>.sql` and confirm
--                these match before running.
--
-- Idempotent (WHERE NOT EXISTS on hash) and reversible:
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash IN (
--     '3753a8975295f3a227e2b4cfd7987e93e6946a06111d7c1fcdc0755aac26851f',
--     '6bc3d39b040aa50668c18866e8110bf17e71d513ca5ba332d944417a879b9709',
--     '70d964e7e2bfc5c5b7919e8a3d85f1ab2b2d0bf9951c314bfea022cd7cf149f1');

BEGIN;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT v.hash, v.created_at
FROM (VALUES
  ('3753a8975295f3a227e2b4cfd7987e93e6946a06111d7c1fcdc0755aac26851f'::text, 1781178876347::bigint), -- 0035_chat_sessions_attached_entities
  ('6bc3d39b040aa50668c18866e8110bf17e71d513ca5ba332d944417a879b9709',       1781178900000),        -- 0036_meetings_location
  ('70d964e7e2bfc5c5b7919e8a3d85f1ab2b2d0bf9951c314bfea022cd7cf149f1',       1781527318900)         -- 0037_perpetual_zombie
) AS v(hash, created_at)
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations m WHERE m.hash = v.hash
);

COMMIT;
