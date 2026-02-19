import type Database from 'better-sqlite3'

export function runRecordingPathMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const hasRecordingPath = cols.some((c) => c.name === 'recording_path')

  if (!hasRecordingPath) {
    db.exec('ALTER TABLE meetings ADD COLUMN recording_path TEXT')
  }
}
