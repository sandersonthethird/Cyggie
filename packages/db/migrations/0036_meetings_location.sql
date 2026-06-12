-- Postgres mirror of SQLite migration 122-meetings-location.ts.
--
-- Adds meetings.location: the free-text `location` from the originating Google
-- Calendar event. Google auto-attaches a Meet link to most events, so
-- meeting_url alone can't distinguish an in-person meeting from a video one —
-- location is the signal. classifyLocation() in @cyggie/shared interprets the
-- overloaded field (address / room / phone-call note / pasted conference URL)
-- at display time. NULL on impromptu rows and pre-migration rows.
--
-- ALTER TABLE ADD COLUMN with no default is non-blocking on Postgres 11+
-- (constant-time metadata update). Safe on Neon.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location TEXT;
