import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_028_company_location_v1'

export function runCompanyLocationMigration(db: Database.Database): void {
  up(db)
}

function up(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('city')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN city TEXT`)
  }

  if (!columnNames.has('state')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN state TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
