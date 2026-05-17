import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_021_company_domain_normalization_v1'

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '')
}

export function runCompanyDomainNormalizationMigration(db: Database.Database): void {
  const alreadyRan = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(MIGRATION_KEY) as { value: string } | undefined
  if (alreadyRan?.value === '1') return

  const columns = db.prepare("PRAGMA table_info('org_companies')").all() as { name: string }[]
  if (!columns.some((column) => column.name === 'primary_domain')) {
    return
  }

  const rows = db
    .prepare(`
      SELECT id, primary_domain
      FROM org_companies
      WHERE primary_domain IS NOT NULL
    `)
    .all() as Array<{ id: string; primary_domain: string }>

  const updateDomain = db.prepare(`
    UPDATE org_companies
    SET primary_domain = ?, updated_at = datetime('now')
    WHERE id = ?
  `)

  const tx = db.transaction((items: Array<{ id: string; primary_domain: string }>) => {
    for (const item of items) {
      const normalized = normalizeDomain(item.primary_domain)
      if (normalized !== item.primary_domain) {
        updateDomain.run(normalized, item.id)
      }
    }
  })

  tx(rows)

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')
  `).run(MIGRATION_KEY)
}
