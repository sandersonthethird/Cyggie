import type Database from 'better-sqlite3'
import { extractDomainFromEmail } from '../../utils/company-extractor'

export function runCompaniesCacheMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      domain TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      enriched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Backfill: extract domains from existing meetings' attendee_emails
  const rows = db
    .prepare('SELECT attendee_emails FROM meetings WHERE attendee_emails IS NOT NULL')
    .all() as { attendee_emails: string }[]

  const insertStmt = db.prepare(
    'INSERT OR IGNORE INTO companies (domain, display_name) VALUES (?, ?)'
  )

  const seenDomains = new Set<string>()

  for (const row of rows) {
    try {
      const emails: string[] = JSON.parse(row.attendee_emails)
      for (const email of emails) {
        const domain = extractDomainFromEmail(email)
        if (domain && !seenDomains.has(domain)) {
          seenDomains.add(domain)
          // Use domain as placeholder display name — enrichment will overwrite later
          const placeholder = domain
            .split('.')[0]
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
          insertStmt.run(domain, placeholder)
        }
      }
    } catch {
      // skip malformed JSON
    }
  }
}
