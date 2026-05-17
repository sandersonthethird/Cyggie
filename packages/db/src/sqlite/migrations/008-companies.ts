import type Database from 'better-sqlite3'
import { extractCompaniesFromAttendees } from '../../utils/company-extractor'

export function runCompaniesMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info('meetings')").all() as { name: string }[]

  if (!cols.some((c) => c.name === 'companies')) {
    db.exec('ALTER TABLE meetings ADD COLUMN companies TEXT')
  }

  if (!cols.some((c) => c.name === 'attendee_emails')) {
    db.exec('ALTER TABLE meetings ADD COLUMN attendee_emails TEXT')
  }

  // Backfill: extract companies from existing attendees that contain email addresses
  const rows = db
    .prepare('SELECT id, attendees FROM meetings WHERE attendees IS NOT NULL AND companies IS NULL')
    .all() as { id: string; attendees: string }[]

  for (const row of rows) {
    try {
      const attendees: string[] = JSON.parse(row.attendees)
      const companies = extractCompaniesFromAttendees(attendees)
      const emails = attendees.filter((a) => a.includes('@'))

      if (companies.length > 0 || emails.length > 0) {
        db.prepare('UPDATE meetings SET companies = ?, attendee_emails = ? WHERE id = ?').run(
          companies.length > 0 ? JSON.stringify(companies) : null,
          emails.length > 0 ? JSON.stringify(emails) : null,
          row.id
        )
      }
    } catch {
      // skip malformed JSON
    }
  }
}
