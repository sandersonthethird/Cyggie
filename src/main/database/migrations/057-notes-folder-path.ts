import type Database from 'better-sqlite3'

export function runNotesFolderPathMigration(db: Database.Database): void {
  // Each ALTER TABLE is wrapped individually for idempotency
  const alterColumns = [
    { name: 'folder_path',   sql: `ALTER TABLE notes ADD COLUMN folder_path TEXT` },
    { name: 'import_source', sql: `ALTER TABLE notes ADD COLUMN import_source TEXT` },
  ]

  for (const { name, sql } of alterColumns) {
    try {
      db.exec(sql)
      console.log(`[migration-057] Added column ${name} to notes`)
    } catch {
      // Column already exists — idempotent
    }
  }

  const indexes = [
    { name: 'idx_notes_folder_path',   sql: `CREATE INDEX IF NOT EXISTS idx_notes_folder_path   ON notes(folder_path)` },
    { name: 'idx_notes_import_source', sql: `CREATE INDEX IF NOT EXISTS idx_notes_import_source ON notes(import_source)` },
  ]

  for (const { name, sql } of indexes) {
    try {
      db.exec(sql)
      console.log(`[migration-057] Created index ${name}`)
    } catch {
      // Index already exists — idempotent
    }
  }
}
