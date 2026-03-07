import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_032_user_profile_fields_v1'

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
  return columns.some((col) => col.name === columnName)
}

export function runUserProfileFieldsMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  if (!columnExists(db, 'users', 'title')) {
    db.exec(`ALTER TABLE users ADD COLUMN title TEXT`)
  }
  if (!columnExists(db, 'users', 'job_function')) {
    db.exec(`ALTER TABLE users ADD COLUMN job_function TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
