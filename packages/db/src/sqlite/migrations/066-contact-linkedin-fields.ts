import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_066_contact_linkedin_fields_v1'

export function runContactLinkedinFieldsMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('work_history')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN work_history TEXT`)
  }
  if (!columnNames.has('education_history')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN education_history TEXT`)
  }
  if (!columnNames.has('linkedin_headline')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN linkedin_headline TEXT`)
  }
  if (!columnNames.has('linkedin_skills')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN linkedin_skills TEXT`)
  }
  if (!columnNames.has('linkedin_enriched_at')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN linkedin_enriched_at TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
