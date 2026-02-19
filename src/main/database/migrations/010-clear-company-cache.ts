import type Database from 'better-sqlite3'

export function runClearCompanyCacheMigration(db: Database.Database): void {
  // Clear cached company names so they get re-enriched with improved word segmentation
  const migrationKey = 'migration_010_clear_company_cache'
  const row = db.prepare("SELECT 1 FROM companies WHERE domain = ?").get(migrationKey)
  if (row) return // Already ran

  db.exec('DELETE FROM companies')
  db.prepare("INSERT INTO companies (domain, display_name) VALUES (?, '')").run(migrationKey)
}
