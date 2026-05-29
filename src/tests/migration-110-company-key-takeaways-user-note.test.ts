import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runCompanyKeyTakeawaysUserNoteMigration } from '@cyggie/db/sqlite/migrations/110-company-key-takeaways-user-note'

// Migration 110 adds `org_companies.key_takeaways_user_note`. Mirrors the
// Postgres 0025 migration. Additive + nullable so no backfill.

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL
    );
  `)
  return db
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]
  return cols.some((c) => c.name === col)
}

describe('migration 110 — org_companies.key_takeaways_user_note', () => {
  it('adds the column when missing', () => {
    const db = makeDb()
    expect(hasColumn(db, 'org_companies', 'key_takeaways_user_note')).toBe(false)
    runCompanyKeyTakeawaysUserNoteMigration(db)
    expect(hasColumn(db, 'org_companies', 'key_takeaways_user_note')).toBe(true)
  })

  it('writes the migration_key row to settings', () => {
    const db = makeDb()
    runCompanyKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get('migration_110_company_key_takeaways_user_note') as { value: string } | undefined
    expect(row?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is idempotent — re-running does not clobber populated values', () => {
    const db = makeDb()
    runCompanyKeyTakeawaysUserNoteMigration(db)
    db.prepare(`INSERT INTO org_companies (id, canonical_name, key_takeaways_user_note) VALUES (?, ?, ?)`)
      .run('co1', 'Acme', 'partner notes')
    runCompanyKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT key_takeaways_user_note FROM org_companies WHERE id = ?`)
      .get('co1') as { key_takeaways_user_note: string | null } | undefined
    expect(row?.key_takeaways_user_note).toBe('partner notes')
  })

  it('column is nullable — existing rows are left untouched', () => {
    const db = makeDb()
    db.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES (?, ?)`).run('co2', 'Beta Co')
    runCompanyKeyTakeawaysUserNoteMigration(db)
    const row = db
      .prepare(`SELECT key_takeaways_user_note FROM org_companies WHERE id = ?`)
      .get('co2') as { key_takeaways_user_note: string | null } | undefined
    expect(row?.key_takeaways_user_note).toBeNull()
  })
})
