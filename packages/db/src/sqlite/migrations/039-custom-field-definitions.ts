import type Database from 'better-sqlite3'

const MIGRATION_KEY = 'migration_039_custom_field_definitions_v1'

export function runCustomFieldDefinitionsMigration(db: Database.Database): void {
  const applied = db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(MIGRATION_KEY)
  if (applied) return

  console.log('[migration-039] running...')

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_field_definitions (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('company','contact')),
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      field_type TEXT NOT NULL CHECK(field_type IN (
        'text','textarea','number','currency','date','url',
        'select','multiselect','boolean','contact_ref','company_ref'
      )),
      options_json TEXT,
      is_required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      show_in_list INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(entity_type, field_key)
    );
    CREATE INDEX IF NOT EXISTS idx_cfd_entity_type ON custom_field_definitions(entity_type, sort_order);
  `)

  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`)
    .run(MIGRATION_KEY, new Date().toISOString())

  console.log('[migration-039] done')
}
