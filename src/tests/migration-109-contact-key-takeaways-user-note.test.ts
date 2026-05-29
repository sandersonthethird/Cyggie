import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runContactKeyTakeawaysUserNoteMigration } from '@cyggie/db/sqlite/migrations/109-contact-key-takeaways-user-note'

// Migration 109 adds `contacts.key_takeaways_user_note`. Mirrors the
// Postgres 0024 migration. Additive + nullable so no backfill.

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL
    );
  `)
  return db
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]
  return cols.some((c) => c.name === col)
}

describe('migration 109 — contacts.key_takeaways_user_note', () => {
  it('adds the column when missing', () => {
    const db = makeDb()
    expect(hasColumn(db, 'contacts', 'key_takeaways_user_note')).toBe(false)
    runContactKeyTakeawaysUserNoteMigration(db)
    expect(hasColumn(db, 'contacts', 'key_takeaways_user_note')).toBe(true)
  })

  it('writes the migration_key row to settings', () => {
    const db = makeDb()
    runContactKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get('migration_109_contact_key_takeaways_user_note') as { value: string } | undefined
    expect(row?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is idempotent — re-running does not throw or duplicate the column', () => {
    const db = makeDb()
    runContactKeyTakeawaysUserNoteMigration(db)
    // Insert a row with the new column populated so we can confirm the
    // second run doesn't clobber it via a redundant ALTER.
    db.prepare(`INSERT INTO contacts (id, full_name, key_takeaways_user_note) VALUES (?, ?, ?)`)
      .run('c1', 'Sandy', 'pre-existing note')
    runContactKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT key_takeaways_user_note FROM contacts WHERE id = ?`)
      .get('c1') as { key_takeaways_user_note: string | null } | undefined
    expect(row?.key_takeaways_user_note).toBe('pre-existing note')
  })

  it('column is nullable — existing rows are left untouched', () => {
    const db = makeDb()
    db.prepare(`INSERT INTO contacts (id, full_name) VALUES (?, ?)`).run('c2', 'Andy')
    runContactKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT key_takeaways_user_note FROM contacts WHERE id = ?`)
      .get('c2') as { key_takeaways_user_note: string | null } | undefined
    expect(row?.key_takeaways_user_note).toBeNull()
  })
})
