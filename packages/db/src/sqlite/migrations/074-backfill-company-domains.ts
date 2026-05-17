import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { extractDomainFromWebsiteUrl } from '../../utils/email-parser'

/**
 * One-time data repair: populate primary_domain for companies that have
 * website_url set but primary_domain empty.
 *
 * Root cause: until updateCompany() learned to auto-derive primary_domain
 * from website_url, manually editing the website on the company detail page
 * left primary_domain untouched. The Companies table's "Domain" column reads
 * primary_domain directly, so it appeared empty for these companies.
 *
 * Idempotent — only fills empty domains, so re-running is a no-op once
 * everything is backfilled.
 */

const COMMON_SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu'])

function getRegistrableDomain(domain: string): string {
  const labels = domain.split('.').filter(Boolean)
  if (labels.length <= 2) return labels.join('.')
  const tld = labels[labels.length - 1]
  const secondLevel = labels[labels.length - 2]
  if (tld.length === 2 && COMMON_SECOND_LEVEL_TLDS.has(secondLevel) && labels.length >= 3) {
    return labels.slice(-3).join('.')
  }
  return labels.slice(-2).join('.')
}

export function runBackfillCompanyDomainsMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, website_url
       FROM org_companies
       WHERE website_url IS NOT NULL
         AND TRIM(website_url) <> ''
         AND (primary_domain IS NULL OR TRIM(primary_domain) = '')`,
    )
    .all() as Array<{ id: string; website_url: string }>

  if (rows.length === 0) return

  const updateDomain = db.prepare(
    `UPDATE org_companies
       SET primary_domain = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO org_company_aliases (
       id, company_id, alias_value, alias_type, created_at
     )
     VALUES (?, ?, ?, 'domain', datetime('now'))`,
  )

  const apply = db.transaction(() => {
    let backfilled = 0
    for (const row of rows) {
      const derived = extractDomainFromWebsiteUrl(row.website_url)
      if (!derived) continue
      updateDomain.run(derived, row.id)
      const registrable = getRegistrableDomain(derived)
      const candidates = [...new Set([derived, registrable, `www.${registrable}`])]
      for (const candidate of candidates) {
        insertAlias.run(randomUUID(), row.id, candidate)
      }
      backfilled++
    }
    return backfilled
  })

  const backfilled = apply()
  if (backfilled > 0) {
    console.log(`[migration-074] Backfilled primary_domain for ${backfilled} companies`)
  }
}
