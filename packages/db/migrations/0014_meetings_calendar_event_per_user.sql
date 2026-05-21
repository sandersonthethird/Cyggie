-- Per-user uniqueness on meetings.calendar_event_id.
--
-- The previous global-unique partial index (meetings_calendar_event_idx,
-- migration 0011) made multi-tenant operation impossible — two users
-- invited to the same Google calendar event share the event id and
-- couldn't both have a meeting row. Mobile's new tap-to-view flow
-- would hit this collision immediately as soon as a second user opens
-- a shared calendar event.
--
-- Migration order:
--   1. CREATE the new composite partial-unique CONCURRENTLY (no write
--      lock; takes longer than naive CREATE INDEX but is safe under
--      concurrent traffic).
--   2. DROP the old global-unique CONCURRENTLY (also lock-free).
--
-- CONCURRENTLY caveats:
--   • Must run OUTSIDE a transaction. Drizzle migrate wraps each .sql
--     file in a tx by default. Set `drizzle.config.ts` migrator to
--     `wrapInTransaction: false` for this migration OR run the two
--     statements via raw psql before redeploying the gateway.
--   • If a build fails mid-CREATE, the index ends up in INVALID state.
--     Recovery: DROP INDEX CONCURRENTLY <name>, then re-run CREATE
--     INDEX CONCURRENTLY.
--
-- This migration is ONE-WAY once the gateway starts writing cross-user
-- duplicates (i.e., as soon as a second user taps a shared event). The
-- old global-unique constraint would reject those duplicate rows on
-- rollback. See runbooks/migration-0014-one-way.md for the operational
-- contract.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "meetings_user_calendar_event_idx"
  ON "meetings" ("user_id", "calendar_event_id")
  WHERE "calendar_event_id" IS NOT NULL;
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "meetings_calendar_event_idx";
