import type Database from 'better-sqlite3'
import { extractDomainFromWebsiteUrl } from '../../utils/email-parser'

/**
 * One-time data repair: fix `primary_domain` rows that contain malformed values
 * (no dot — e.g. "www", "abc", "localhost") which leaked in via partially-typed
 * URLs being saved on blur before the input validation tightened.
 *
 * Strategy per offending row:
 *   - If `website_url` parses to a real domain via `extractDomainFromWebsiteUrl`,
 *     overwrite `primary_domain` with the derived value.
 *   - Otherwise, NULL out `primary_domain` so a later user edit (or migration
 *     074's empty-domain backfill) can fill it correctly.
 *
 * Idempotent — after running, every `primary_domain` value either contains a
 * dot or is NULL, so re-running selects zero rows.
 */
export function runRepairBadPrimaryDomainsMigration(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT id, website_url
       FROM org_companies
       WHERE primary_domain IS NOT NULL
         AND TRIM(primary_domain) <> ''
         AND primary_domain NOT LIKE '%.%'`,
    )
    .all() as Array<{ id: string; website_url: string | null }>

  if (rows.length === 0) return

  const updateDomain = db.prepare(
    `UPDATE org_companies
       SET primary_domain = ?, updated_at = datetime('now')
     WHERE id = ?`,
  )

  let repaired = 0
  let nulled = 0
  const apply = db.transaction(() => {
    for (const row of rows) {
      const derived = extractDomainFromWebsiteUrl(row.website_url)
      if (derived) {
        updateDomain.run(derived, row.id)
        repaired++
      } else {
        updateDomain.run(null, row.id)
        nulled++
      }
    }
  })
  apply()

  console.log(
    `[migration-084] Repaired ${repaired} primary_domain values (NULLed ${nulled} unrecoverable)`,
  )
}
