import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_029_pipeline_company_fields_v1'

export function runPipelineCompanyFieldsMigration(db: Database.Database): void {
  up(db)
}

function up(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  const columns = db.pragma('table_info(org_companies)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('priority')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN priority TEXT`)
  }

  if (!columnNames.has('post_money_valuation')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN post_money_valuation REAL`)
  }

  if (!columnNames.has('raise_size')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN raise_size REAL`)
  }

  if (!columnNames.has('round')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN round TEXT`)
  }

  if (!columnNames.has('pipeline_stage')) {
    db.exec(`ALTER TABLE org_companies ADD COLUMN pipeline_stage TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
