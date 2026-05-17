import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_027_contact_type_v1'

export function runContactTypeMigration(db: Database.Database): void {
  up(db)
}

function up(db: Database.Database): void {
  const applied = db
    .prepare(`SELECT 1 FROM settings WHERE key = ?`)
    .get(MIGRATION_KEY)

  if (applied) return

  const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('contact_type')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN contact_type TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
