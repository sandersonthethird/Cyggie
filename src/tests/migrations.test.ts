import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { runCustomFieldDefinitionsMigration } from '../main/database/migrations/039-custom-field-definitions'
import { runCustomFieldValuesMigration } from '../main/database/migrations/040-custom-field-values'
import { runContactKeyTakeawaysMigration } from '../main/database/migrations/069-contact-key-takeaways'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal settings table — required by all migrations as a sentinel store
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`)
  return db
}

describe('migration 039 — custom_field_definitions', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
  })

  it('creates the table on first run', () => {
    runCustomFieldDefinitionsMigration(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='custom_field_definitions'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('is idempotent — running twice does not throw', () => {
    expect(() => {
      runCustomFieldDefinitionsMigration(db)
      runCustomFieldDefinitionsMigration(db)
    }).not.toThrow()
  })

  it('records the sentinel key after running', () => {
    runCustomFieldDefinitionsMigration(db)
    const sentinel = db
      .prepare(`SELECT value FROM settings WHERE key = 'migration_039_custom_field_definitions_v1'`)
      .get()
    expect(sentinel).toBeTruthy()
  })

  it('creates the entity_type index', () => {
    runCustomFieldDefinitionsMigration(db)
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cfd_entity_type'`)
      .get()
    expect(idx).toBeTruthy()
  })
})

describe('migration 040 — custom_field_values', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
    // 040 depends on custom_field_definitions existing
    runCustomFieldDefinitionsMigration(db)
  })

  it('creates the table on first run', () => {
    runCustomFieldValuesMigration(db)
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='custom_field_values'`)
      .get()
    expect(row).toBeTruthy()
  })

  it('is idempotent — running twice does not throw', () => {
    expect(() => {
      runCustomFieldValuesMigration(db)
      runCustomFieldValuesMigration(db)
    }).not.toThrow()
  })

  it('records the sentinel key after running', () => {
    runCustomFieldValuesMigration(db)
    const sentinel = db
      .prepare(`SELECT value FROM settings WHERE key = 'migration_040_custom_field_values_v1'`)
      .get()
    expect(sentinel).toBeTruthy()
  })

  it('creates both indexes', () => {
    runCustomFieldValuesMigration(db)
    const entityIdx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cfv_entity'`)
      .get()
    const defIdx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_cfv_definition'`)
      .get()
    expect(entityIdx).toBeTruthy()
    expect(defIdx).toBeTruthy()
  })
})

describe('migration 069 — contact key_takeaways column', () => {
  let db: Database.Database

  beforeEach(() => {
    db = makeDb()
    // Migration requires contacts table to exist
    db.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  })

  it('adds key_takeaways column on first run', () => {
    runContactKeyTakeawaysMigration(db)
    const columns = db.pragma('table_info(contacts)') as Array<{ name: string }>
    const names = columns.map((c) => c.name)
    expect(names).toContain('key_takeaways')
  })

  it('is idempotent — running twice does not throw', () => {
    expect(() => {
      runContactKeyTakeawaysMigration(db)
      runContactKeyTakeawaysMigration(db)
    }).not.toThrow()
  })

  it('records the sentinel key after running', () => {
    runContactKeyTakeawaysMigration(db)
    const sentinel = db
      .prepare(`SELECT value FROM settings WHERE key = 'migration_069_contact_key_takeaways'`)
      .get()
    expect(sentinel).toBeTruthy()
  })
})
