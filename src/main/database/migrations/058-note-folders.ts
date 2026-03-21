import type Database from 'better-sqlite3'

export function runNoteFoldersMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_folders (
      path       TEXT PRIMARY KEY,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  console.log('[migration-058] Created note_folders table')

  // Add index for the dedup correlated subquery in listNotes/searchNotes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_source_meeting ON notes(source_meeting_id)
  `)
  console.log('[migration-058] Created idx_notes_source_meeting index')
}
