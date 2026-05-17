import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_030_performance_indexes_v1'

export function runPerformanceIndexesMigration(db: Database.Database): void {
  up(db)
}

function up(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_org_companies_canonical_name ON org_companies(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_org_companies_pipeline_stage ON org_companies(pipeline_stage);
    CREATE INDEX IF NOT EXISTS idx_meeting_company_links_company ON meeting_company_links(company_id);
    CREATE INDEX IF NOT EXISTS idx_email_company_links_company ON email_company_links(company_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_full_name ON contacts(full_name);
    CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at);
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
