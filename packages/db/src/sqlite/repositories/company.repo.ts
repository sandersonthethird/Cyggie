import { getDatabase } from '../connection'

export interface CompanyRecord {
  domain: string
  displayName: string
}

export function getByDomain(domain: string): CompanyRecord | null {
  const db = getDatabase()
  const row = db
    .prepare('SELECT domain, display_name FROM companies WHERE domain = ?')
    .get(domain) as { domain: string; display_name: string } | undefined

  if (!row) return null
  return { domain: row.domain, displayName: row.display_name }
}

export function upsert(domain: string, displayName: string): void {
  const db = getDatabase()
  db.prepare(
    `INSERT INTO companies (domain, display_name, enriched_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(domain) DO UPDATE SET display_name = excluded.display_name, enriched_at = excluded.enriched_at`
  ).run(domain, displayName)
}

export function getByDomains(domains: string[]): Map<string, string> {
  if (domains.length === 0) return new Map()
  const db = getDatabase()
  const placeholders = domains.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT domain, display_name FROM companies WHERE domain IN (${placeholders})`)
    .all(...domains) as { domain: string; display_name: string }[]

  const map = new Map<string, string>()
  for (const row of rows) {
    map.set(row.domain, row.display_name)
  }
  return map
}
