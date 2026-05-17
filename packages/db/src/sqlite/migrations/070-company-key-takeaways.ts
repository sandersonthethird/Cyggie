import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_070_company_key_takeaways'

export function runCompanyKeyTakeawaysMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  if (!new Set(columns.map((c) => c.name)).has('key_takeaways')) {
    db.exec('ALTER TABLE org_companies ADD COLUMN key_takeaways TEXT')
  }

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(MIGRATION_KEY, new Date().toISOString())
}
