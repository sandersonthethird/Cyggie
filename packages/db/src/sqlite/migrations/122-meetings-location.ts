import type Database from 'better-sqlite3'

/**
 * Adds `meetings.location` (TEXT, nullable) on SQLite. Mirrors the Postgres
 * `location` column on the meetings table.
 *
 * Stores the free-text `location` from the originating Google Calendar event.
 * Google auto-attaches a Meet link to most events, so `meeting_url` alone
 * cannot distinguish an in-person meeting from a video one — `location` is the
 * signal. classifyLocation() in @cyggie/shared interprets the overloaded field
 * (address / room / phone-call note / pasted conference URL) at display time.
 *
 * No backfill: existing rows surface as null (no chip / fall back to
 * meeting_url) until their calendar event is re-synced via
 * POST /meetings/from-calendar-event, which refreshes calendar-sourced fields.
 *
 * Idempotent — guarded by a PRAGMA table_info check.
 */
export function runMeetingsLocationMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'location')) return

  db.exec(`ALTER TABLE meetings ADD COLUMN location TEXT`)
}
