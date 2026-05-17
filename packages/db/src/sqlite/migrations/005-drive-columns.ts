import type Database from 'better-sqlite3'

export function runDriveColumnsMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]

  if (!cols.some((c) => c.name === 'transcript_drive_id')) {
    db.exec('ALTER TABLE meetings ADD COLUMN transcript_drive_id TEXT')
  }
  if (!cols.some((c) => c.name === 'summary_drive_id')) {
    db.exec('ALTER TABLE meetings ADD COLUMN summary_drive_id TEXT')
  }
}
