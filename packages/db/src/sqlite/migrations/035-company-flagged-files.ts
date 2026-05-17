import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_035_company_flagged_files_v1'

export function runCompanyFlaggedFilesMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  db.exec(`
    CREATE TABLE IF NOT EXISTS company_flagged_files (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      flagged_at TEXT NOT NULL,
      UNIQUE(company_id, file_id)
    )
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
