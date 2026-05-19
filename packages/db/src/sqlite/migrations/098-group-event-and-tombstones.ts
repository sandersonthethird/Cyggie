import type Database from 'better-sqlite3'

/**
 * Adds two `meetings` columns supporting the group-event ingestion gate, plus
 * a `contact_tombstones` table that prevents user-deleted contacts from being
 * resurrected by `syncContactsFromAttendees` on subsequent calendar / startup
 * syncs.
 *
 * The two pieces ship in one migration because the IPC handler that writes
 * tombstones (CONTACT_DELETE) and the bulk sync that reads `is_group_event`
 * (`syncContactsFromMeetings`) both depend on the same release boundary —
 * splitting them would let one DB state exist without the other.
 *
 * Idempotent: each ALTER and CREATE is guarded by an existence check.
 */
export function runGroupEventAndTombstonesMigration(db: Database.Database): void {
  // --- meetings columns ---
  const meetingsCols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  const hasGroupEvent = meetingsCols.some((c) => c.name === 'is_group_event')
  const hasGroupEventUserSet = meetingsCols.some((c) => c.name === 'is_group_event_user_set')

  if (!hasGroupEvent) {
    db.exec(`ALTER TABLE meetings ADD COLUMN is_group_event INTEGER NOT NULL DEFAULT 0`)
  }
  if (!hasGroupEventUserSet) {
    db.exec(`ALTER TABLE meetings ADD COLUMN is_group_event_user_set INTEGER NOT NULL DEFAULT 0`)
  }

  // --- contact_tombstones table ---
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='contact_tombstones'`)
    .get()
  if (!tableExists) {
    db.exec(`
      CREATE TABLE contact_tombstones (
        id          TEXT PRIMARY KEY,
        email       TEXT NOT NULL,
        deleted_at  TEXT NOT NULL DEFAULT (datetime('now')),
        user_id     TEXT REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX idx_contact_tombstones_email ON contact_tombstones(email);
    `)
  }
}
