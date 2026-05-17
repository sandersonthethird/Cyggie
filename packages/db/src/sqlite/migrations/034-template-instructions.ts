import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_034_template_instructions_v1'

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${tableName}')`).all() as Array<{ name: string }>
  return columns.some((col) => col.name === columnName)
}

export function runTemplateInstructionsMigration(db: Database.Database): void {
  const applied = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(MIGRATION_KEY)
  if (applied) return

  if (!columnExists(db, 'templates', 'instructions')) {
    db.exec(`ALTER TABLE templates ADD COLUMN instructions TEXT`)
  }

  db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`)
    .run(MIGRATION_KEY, new Date().toISOString())
}
