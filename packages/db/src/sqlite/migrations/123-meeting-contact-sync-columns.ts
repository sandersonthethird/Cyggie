import type Database from 'better-sqlite3'

/**
 * Adds four columns the sync pull-apply has always written but the local SQLite
 * schema never had — closing a schema/code drift that silently broke meeting
 * and contact DOWN-sync entirely.
 *
 *   meetings.was_impromptu     INTEGER NOT NULL DEFAULT 0  (boolean; PG default false)
 *   meetings.scheduled_end_at  TEXT  (nullable ISO timestamp)
 *   contacts.last_meeting_at   TEXT  (nullable ISO timestamp)
 *   contacts.last_email_at     TEXT  (nullable ISO timestamp)
 *
 * WHY THIS MATTERS
 * upsertMeetingRow / the contacts upsert in sync-remote-apply.ts list these
 * columns in their INSERT statements (they exist on the Postgres side + the
 * sync wire), but no SQLite migration ever added them. So on every /sync/pull,
 * the meetings and contacts sub-batches threw
 *
 *     table meetings has no column named was_impromptu
 *     table contacts has no column named last_meeting_at
 *
 * and the whole chunk rolled back — meaning NO gateway meeting or contact has
 * ever applied to this device (the watermark still advances past the rolled-back
 * rows, so they're permanently skipped until a from-0 re-pull). This is why
 * mobile-recorded transcripts never reached desktop ("No transcript available
 * yet"): the meeting row carrying the transcript could not be inserted at all.
 *
 * The sync-remote-apply unit tests passed only because their hand-rolled test
 * `meetings` table happens to declare was_impromptu/scheduled_end_at — masking
 * the gap against the real migration-produced schema.
 *
 * No backfill needed: existing local rows take the defaults (was_impromptu=0,
 * the three timestamps null); the next from-0 re-pull overwrites them with the
 * gateway's authoritative values via the upserts' ON CONFLICT clauses.
 *
 * Idempotent — each ALTER is guarded by a PRAGMA table_info check, so a partial
 * prior run (or a device that already has a column) is safe.
 */
export function runMeetingContactSyncColumnsMigration(db: Database.Database): void {
  const meetingCols = db.prepare(`PRAGMA table_info('meetings')`).all() as { name: string }[]
  if (!meetingCols.some((c) => c.name === 'was_impromptu')) {
    db.exec(`ALTER TABLE meetings ADD COLUMN was_impromptu INTEGER NOT NULL DEFAULT 0`)
  }
  if (!meetingCols.some((c) => c.name === 'scheduled_end_at')) {
    db.exec(`ALTER TABLE meetings ADD COLUMN scheduled_end_at TEXT`)
  }

  const contactCols = db.prepare(`PRAGMA table_info('contacts')`).all() as { name: string }[]
  if (!contactCols.some((c) => c.name === 'last_meeting_at')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN last_meeting_at TEXT`)
  }
  if (!contactCols.some((c) => c.name === 'last_email_at')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN last_email_at TEXT`)
  }
}
