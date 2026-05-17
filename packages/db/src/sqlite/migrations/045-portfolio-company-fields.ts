import type Database from 'better-sqlite3'

export function runPortfolioCompanyFieldsMigration(db: Database.Database): void {
  const tableInfo = db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))

  const columnsToAdd: Array<[string, string]> = [
    ['investment_size', 'TEXT'],
    ['ownership_pct', 'TEXT'],
    ['followon_investment_size', 'TEXT'],
    ['total_invested', 'TEXT'],
  ]

  for (const [col, type] of columnsToAdd) {
    if (!existingColumns.has(col)) {
      db.exec(`ALTER TABLE org_companies ADD COLUMN ${col} ${type};`)
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_companies_entity_type
      ON org_companies(entity_type);
  `)
}
