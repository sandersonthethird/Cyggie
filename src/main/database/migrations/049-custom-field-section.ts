import type Database from 'better-sqlite3'

export function runCustomFieldSectionMigration(db: Database.Database): void {
  const tableInfo = db.prepare(`PRAGMA table_info(custom_field_definitions)`).all() as Array<{ name: string }>
  const existingColumns = new Set(tableInfo.map((col) => col.name))
  if (!existingColumns.has('section')) {
    db.exec(`ALTER TABLE custom_field_definitions ADD COLUMN section TEXT DEFAULT NULL;`)
  }
}
