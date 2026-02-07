import type Database from 'better-sqlite3'

export function runNotesMigration(db: Database.Database): void {
  // Check if column already exists
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const hasNotes = cols.some((c) => c.name === 'notes')

  if (!hasNotes) {
    db.exec('ALTER TABLE meetings ADD COLUMN notes TEXT')
  }
}
