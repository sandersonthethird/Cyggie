import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_036_contact_extra_fields_v1'

export function runContactExtraFieldsMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('investor_stage')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN investor_stage TEXT`)
  }
  if (!columnNames.has('city')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN city TEXT`)
  }
  if (!columnNames.has('state')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN state TEXT`)
  }
  if (!columnNames.has('notes')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN notes TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
