import type Database from 'better-sqlite3'

/**
 * Adds `street`, `postal_code`, `country` to contacts (SQLite). Mirrors
 * Postgres migration 0023_contacts_address.sql. Nullable so existing rows
 * stay valid. Idempotent — guarded by a settings-row check.
 */
const MIGRATION_KEY = 'migration_108_contacts_address_v1'

export function runContactsAddressMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
  const columnNames = new Set(columns.map((c) => c.name))

  if (!columnNames.has('street')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN street TEXT`)
  }
  if (!columnNames.has('postal_code')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN postal_code TEXT`)
  }
  if (!columnNames.has('country')) {
    db.exec(`ALTER TABLE contacts ADD COLUMN country TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
