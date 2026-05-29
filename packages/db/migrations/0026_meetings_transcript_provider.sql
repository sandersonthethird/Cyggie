-- Postgres mirror of SQLite migration 111-meetings-transcript-provider.ts.
--
-- Adds meetings.transcript_provider so the gateway-side sync push
-- preserves the live provider attribution from desktop. The column is
-- nullable; rows from before this column landed will be NULL.
--
-- ALTER TABLE ADD COLUMN with no default is non-blocking on Postgres
-- 11+ (constant-time metadata update). Safe on Neon.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS transcript_provider TEXT;
