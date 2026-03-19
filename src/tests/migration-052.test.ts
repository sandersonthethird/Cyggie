import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '../main/database/migrations/052-unified-notes'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Stub referenced tables so FK constraints don't fail
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE themes (id TEXT PRIMARY KEY);
  `)
  return db
}

function makeDbWithOldTables(): Database.Database {
  const db = makeDb()
  db.exec(`
    CREATE TABLE company_notes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      source_meeting_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      theme_id TEXT,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      source_meeting_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

describe('migration 052 — unified notes', () => {
  it('creates the notes table', () => {
    const db = makeDb()
    runUnifiedNotesMigration(db)
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notes'`).get()
    expect(row).toBeTruthy()
  })

  it('creates expected indexes', () => {
    const db = makeDb()
    runUnifiedNotesMigration(db)
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notes'`)
      .all() as { name: string }[]
    const names = indexes.map((r) => r.name)
    expect(names).toContain('idx_notes_company')
    expect(names).toContain('idx_notes_contact')
    expect(names).toContain('idx_notes_updated')
  })

  it('is idempotent — running twice does not throw', () => {
    const db = makeDb()
    expect(() => {
      runUnifiedNotesMigration(db)
      runUnifiedNotesMigration(db)
    }).not.toThrow()
  })

  it('drops company_notes table after migration', () => {
    const db = makeDbWithOldTables()
    runUnifiedNotesMigration(db)
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='company_notes'`).get()
    expect(row).toBeUndefined()
  })

  it('drops contact_notes table after migration', () => {
    const db = makeDbWithOldTables()
    runUnifiedNotesMigration(db)
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='contact_notes'`).get()
    expect(row).toBeUndefined()
  })

  it('migrates company_notes rows into notes with correct company_id', () => {
    const db = makeDbWithOldTables()
    db.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
    db.prepare(`
      INSERT INTO company_notes (id, company_id, content, is_pinned, created_at, updated_at)
      VALUES ('note1', 'co1', 'Hello world', 0, datetime('now'), datetime('now'))
    `).run()
    db.prepare(`
      INSERT INTO company_notes (id, company_id, content, is_pinned, created_at, updated_at)
      VALUES ('note2', 'co1', 'Second note', 1, datetime('now'), datetime('now'))
    `).run()

    runUnifiedNotesMigration(db)

    const rows = db.prepare(`SELECT * FROM notes WHERE company_id = 'co1' ORDER BY is_pinned DESC`).all() as { id: string; company_id: string; is_pinned: number }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe('note2')
    expect(rows[0].company_id).toBe('co1')
    expect(rows[0].is_pinned).toBe(1)
    expect(rows[1].id).toBe('note1')
  })

  it('migrates contact_notes rows into notes with correct contact_id', () => {
    const db = makeDbWithOldTables()
    db.exec(`INSERT INTO contacts VALUES ('ct1', 'Alice Smith')`)
    db.prepare(`
      INSERT INTO contact_notes (id, contact_id, content, is_pinned, created_at, updated_at)
      VALUES ('cnote1', 'ct1', 'Contact note', 0, datetime('now'), datetime('now'))
    `).run()

    runUnifiedNotesMigration(db)

    const row = db.prepare(`SELECT * FROM notes WHERE contact_id = 'ct1'`).get() as { id: string; contact_id: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.id).toBe('cnote1')
    expect(row!.contact_id).toBe('ct1')
  })

  it('regression: listCompanyNotes returns migrated company notes after migration', () => {
    const db = makeDbWithOldTables()
    db.exec(`INSERT INTO org_companies VALUES ('co1', 'Acme')`)
    db.prepare(`
      INSERT INTO company_notes (id, company_id, title, content, is_pinned, created_at, updated_at)
      VALUES ('note1', 'co1', 'My Note', 'body text', 0, datetime('now'), datetime('now'))
    `).run()

    runUnifiedNotesMigration(db)

    // Simulate what listCompanyNotes does (query notes WHERE company_id = ?)
    const rows = db.prepare(`SELECT id, company_id, title, content FROM notes WHERE company_id = ?`).all('co1') as { id: string; company_id: string; title: string; content: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('My Note')
    expect(rows[0].content).toBe('body text')
    expect(rows[0].company_id).toBe('co1')
  })

  it('regression: listContactNotes returns migrated contact notes after migration', () => {
    const db = makeDbWithOldTables()
    db.exec(`INSERT INTO contacts VALUES ('ct1', 'Bob Jones')`)
    db.prepare(`
      INSERT INTO contact_notes (id, contact_id, title, content, is_pinned, created_at, updated_at)
      VALUES ('cnote1', 'ct1', 'Contact Title', 'contact body', 0, datetime('now'), datetime('now'))
    `).run()

    runUnifiedNotesMigration(db)

    const rows = db.prepare(`SELECT id, contact_id, title, content FROM notes WHERE contact_id = ?`).all('ct1') as { id: string; contact_id: string; title: string; content: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Contact Title')
    expect(rows[0].content).toBe('contact body')
    expect(rows[0].contact_id).toBe('ct1')
  })

  it('handles DB with no old tables gracefully (fresh install)', () => {
    const db = makeDb() // no company_notes or contact_notes
    expect(() => runUnifiedNotesMigration(db)).not.toThrow()
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notes'`).get()
    expect(row).toBeTruthy()
  })
})
