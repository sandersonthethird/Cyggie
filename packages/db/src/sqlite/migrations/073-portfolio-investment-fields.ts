import type Database from 'better-sqlite3'

export function runPortfolioInvestmentFieldsMigration(db: Database.Database): void {
  const tableInfo = db.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))

  const columnsToAdd: Array<[string, string]> = [
    ['investment_mark', 'REAL'],
    ['investment_round', 'TEXT'],
    ['initial_investment_security', 'TEXT'],
    ['date_of_initial_investment', 'TEXT'],
    ['initial_round_size', 'REAL'],
    ['last_company_valuation', 'REAL'],
    ['followon_check', 'REAL'],
    ['followon_date', 'TEXT'],
    ['followon_check_2', 'REAL'],
    ['followon_date_2', 'TEXT'],
  ]

  for (const [col, type] of columnsToAdd) {
    if (!existingColumns.has(col)) {
      db.exec(`ALTER TABLE org_companies ADD COLUMN ${col} ${type};`)
    }
  }
}
