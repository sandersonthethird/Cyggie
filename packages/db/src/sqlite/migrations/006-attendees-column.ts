import type Database from 'better-sqlite3'

export function runAttendeesMigration(db: Database.Database): void {
  // Check if column already exists
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]
  const hasAttendees = cols.some((c) => c.name === 'attendees')

  if (!hasAttendees) {
    // Store attendees as JSON array of strings (names/emails)
    db.exec('ALTER TABLE meetings ADD COLUMN attendees TEXT')
  }
}
