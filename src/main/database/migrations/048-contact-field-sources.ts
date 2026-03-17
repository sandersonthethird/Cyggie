import type Database from 'better-sqlite3'

export function runContactFieldSourcesMigration(db: Database.Database): void {
  // Add field_sources JSON column to contacts.
  // Stores a map of field -> meetingId for fields enriched from meeting summaries.
  // Example: { "title": "meeting-uuid", "phone": "meeting-uuid", "linkedinUrl": "meeting-uuid" }
  // NULL = not enriched from any meeting.
  const cols = (db.pragma('table_info(contacts)') as { name: string }[]).map((c) => c.name)
  if (!cols.includes('field_sources')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN field_sources TEXT`)
  }
}
