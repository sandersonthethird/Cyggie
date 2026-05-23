import type Database from 'better-sqlite3'

/**
 * Adds `meetings.summary` (TEXT, nullable) on SQLite. Mirrors Postgres
 * migration 0017_meetings_summary_text.sql.
 *
 * Item 2 (mobile summary tab): the existing summary lives in a markdown
 * file at `summary_path` (local disk) and optionally in Drive
 * (`summary_drive_id`). Neither is reachable from mobile. Storing the
 * markdown body in the `summary` column lets the desktop summarizer
 * dual-write to file + column; the column then propagates via the
 * Phase 1.5a outbox to Neon, and mobile reads it via GET /meetings/:id.
 *
 * Idempotent — guarded by a PRAGMA table_info check.
 */
export function runMeetingsSummaryTextMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'summary')) return
  db.exec(`ALTER TABLE meetings ADD COLUMN summary TEXT`)
}
