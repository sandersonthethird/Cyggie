import type Database from 'better-sqlite3'

export function runCompanyFieldSourcesMigration(db: Database.Database): void {
  // Add field_sources JSON column to companies.
  // Stores a map of field -> meetingId for fields enriched from meeting summaries.
  // Example: { "description": "meeting-uuid", "round": "meeting-uuid" }
  // NULL = not enriched from any meeting.
  const cols = (db.pragma('table_info(companies)') as { name: string }[]).map((c) => c.name)
  if (!cols.includes('field_sources')) {
    db.exec(`ALTER TABLE companies ADD COLUMN field_sources TEXT`)
  }
}
