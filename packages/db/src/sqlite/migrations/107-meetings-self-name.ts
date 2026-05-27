import type Database from 'better-sqlite3'

/**
 * Adds `meetings.self_name` (TEXT, nullable) on SQLite. Mirrors Postgres
 * migration 0022_meetings_self_name.sql.
 *
 * Stores the meeting owner's calendar-side display name so the LLM
 * summarizer can render "Attendees: <selfName> (meeting owner), <others>"
 * without looking up the requesting user. See 0022 SQL for the longer
 * rationale (T24 firm-shared-meetings guard).
 *
 * Backfills existing rows from the local users table using the same
 * displayName → firstName+lastName → email fallback chain as Postgres.
 *
 * Idempotent — guarded by a PRAGMA table_info check.
 */
export function runMeetingsSelfNameMigration(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  if (cols.some((c) => c.name === 'self_name')) return

  db.exec(`ALTER TABLE meetings ADD COLUMN self_name TEXT`)

  // Backfill from users. NULLIF(..., '') treats empty strings as missing
  // so the COALESCE chain falls through to the next signal instead of
  // pinning an empty self_name on every row.
  db.exec(`
    UPDATE meetings
    SET self_name = COALESCE(
        NULLIF((SELECT u.display_name FROM users u WHERE u.id = meetings.user_id), ''),
        NULLIF(TRIM(
          COALESCE((SELECT u.first_name FROM users u WHERE u.id = meetings.user_id), '')
          || ' ' ||
          COALESCE((SELECT u.last_name FROM users u WHERE u.id = meetings.user_id), '')
        ), ''),
        NULLIF((SELECT u.email FROM users u WHERE u.id = meetings.user_id), '')
      )
    WHERE self_name IS NULL
  `)
}
