import type Database from 'better-sqlite3'

export function runCompanyPortfolioFundMigration(db: Database.Database): void {
  const tableInfo = db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))

  if (!existingColumns.has('portfolio_fund')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN portfolio_fund TEXT;`)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_companies_portfolio_fund
      ON org_companies(portfolio_fund);
  `)
}
