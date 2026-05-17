import type Database from 'better-sqlite3'

export function runMeetingNotesSourceMigration(db: Database.Database): void {
  // Add source_meeting_id to track which meeting a note was auto-generated from.
  // The unique constraints allow INSERT OR IGNORE for idempotent backfill.
  // ALTER TABLE ADD COLUMN has no IF NOT EXISTS — check first to stay idempotent.
  const contactCols = (db.pragma('table_info(contact_notes)') as { name: string }[]).map((c) => c.name)
  if (!contactCols.includes('source_meeting_id')) {
    db.exec(`ALTER TABLE contact_notes ADD COLUMN source_meeting_id TEXT;`)
  }

  const companyCols = (db.pragma('table_info(company_notes)') as { name: string }[]).map((c) => c.name)
  if (!companyCols.includes('source_meeting_id')) {
    db.exec(`ALTER TABLE company_notes ADD COLUMN source_meeting_id TEXT;`)
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_notes_source_meeting
      ON contact_notes(contact_id, source_meeting_id)
      WHERE source_meeting_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_company_notes_source_meeting
      ON company_notes(company_id, source_meeting_id)
      WHERE source_meeting_id IS NOT NULL;
  `)
}
