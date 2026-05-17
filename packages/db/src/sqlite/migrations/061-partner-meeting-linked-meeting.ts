import type Database from 'better-sqlite3'

export function runPartnerMeetingLinkedMeetingMigration(db: Database.Database): void {
  // Add meeting_id to partner_meeting_digests so the digest can reference
  // the recorded partner call for transcript-based reconciliation.
  try {
    db.exec(`
      ALTER TABLE partner_meeting_digests
        ADD COLUMN meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL
    `)
    console.log('[migration-061] Added meeting_id to partner_meeting_digests')
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('duplicate column')) {
      // Already applied
    } else {
      throw err
    }
  }

  // Add source_digest_id to notes for idempotent reconciliation note creation.
  // A note with source_digest_id set was created by the reconciliation pipeline;
  // re-running reconciliation for the same digest skips companies that already
  // have a note with this digest's ID.
  try {
    db.exec(`
      ALTER TABLE notes
        ADD COLUMN source_digest_id TEXT
    `)
    console.log('[migration-061] Added source_digest_id to notes')
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('duplicate column')) {
      // Already applied
    } else {
      throw err
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS notes_company_source_digest
      ON notes (company_id, source_digest_id)
      WHERE source_digest_id IS NOT NULL
  `)
  console.log('[migration-061] Created notes_company_source_digest index')
}
