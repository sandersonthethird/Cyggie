-- Postgres mirror of SQLite migration 112-meetings-me-speaker-index.ts.
--
-- Adds meetings.me_speaker_index so the gateway-side sync push preserves
-- which Deepgram speaker index is "me" for each recording. Drives the
-- me/them bubble view; NULL on pre-migration rows.
--
-- ALTER TABLE ADD COLUMN with no default is non-blocking on Postgres
-- 11+ (constant-time metadata update). Safe on Neon.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS me_speaker_index INTEGER;
