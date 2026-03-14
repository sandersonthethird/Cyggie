import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_040_custom_field_values_v1'

export function runCustomFieldValuesMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  console.log('[migration-040] running...')

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_field_values (
      id TEXT PRIMARY KEY,
      field_definition_id TEXT NOT NULL
        REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('company','contact')),
      entity_id TEXT NOT NULL,
      value_text TEXT,
      value_number REAL,
      value_boolean INTEGER,
      value_date TEXT,
      value_ref_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(field_definition_id, entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cfv_entity ON custom_field_values(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_cfv_definition ON custom_field_values(field_definition_id);
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())

  console.log('[migration-040] done')
}
