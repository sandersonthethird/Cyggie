-- Persist the scheduled end time alongside `date` (start).
--
-- Use case: when the mobile client POSTs to /meetings/from-calendar-event
-- we now also pass the calendar event's end time, so the meeting-detail
-- screen can render "60 min scheduled" pre-recording rather than the
-- placeholder em-dash. Same field becomes useful for future flows that
-- need to know the calendar slot length without re-fetching from Google.
--
-- Schema: nullable timestamptz. No default, no index — read only by the
-- detail screen, and never queried as a filter.
--
-- IF NOT EXISTS guards against re-runs on the single-Neon-branch reality
-- (manual prod application + drizzle migrator could race otherwise).
-- Plain ALTER ADD COLUMN with no default is non-blocking on Postgres 11+;
-- safe to run while the gateway is serving traffic.

ALTER TABLE "meetings"
  ADD COLUMN IF NOT EXISTS "scheduled_end_at" timestamp with time zone;
