import type Database from 'better-sqlite3'

/**
 * Drops the denormalized `contacts.last_meeting_at` / `last_email_at` columns and
 * their indexes. Their server-side maintenance was never wired, so they sat empty
 * and silently broke the contact list's recency sort. Last-touch is now computed
 * live (gateway list joins speaker-contact-link + attendee-email meetings; desktop
 * recomputes from meeting/email CTEs), so the drop is non-destructive.
 *
 * Drop the indexes BEFORE the columns — SQLite refuses to DROP COLUMN while an
 * index references it. SQLite ≥ 3.35 (bundled by better-sqlite3) supports DROP
 * COLUMN. Idempotent via PRAGMA + IF EXISTS so re-runs are cheap no-ops.
 *
 * Matching Neon drop: packages/db/migrations/0041_abnormal_thena.sql.
 */
export function runDropContactTouchpointColumnsMigration(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS contacts_last_meeting_idx`)
  db.exec(`DROP INDEX IF EXISTS contacts_last_email_idx`)
  const cols = db.pragma('table_info(contacts)') as Array<{ name: string }>
  if (cols.some((c) => c.name === 'last_meeting_at')) {
    db.exec(`ALTER TABLE contacts DROP COLUMN last_meeting_at`)
  }
  if (cols.some((c) => c.name === 'last_email_at')) {
    db.exec(`ALTER TABLE contacts DROP COLUMN last_email_at`)
  }
}
