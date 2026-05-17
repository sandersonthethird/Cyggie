import type Database from 'better-sqlite3'

export function runTranscriptSegmentsMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const hasColumn = cols.some((c) => c.name === 'transcript_segments')

  if (!hasColumn) {
    db.exec('ALTER TABLE meetings ADD COLUMN transcript_segments TEXT')
  }
}
