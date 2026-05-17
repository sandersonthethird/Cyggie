/**
 * Tests for deleteContact — verifies cleanup of FK CASCADE children plus
 * the no-FK chat_sessions orphan that's not covered by any FK declaration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { deleteContact } = await import('@cyggie/db/sqlite/repositories/contact.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      context_kind TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

describe('deleteContact', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.prepare(`INSERT INTO contacts (id) VALUES ('c1')`).run()
    testDb.prepare(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce1', 'c1', 'a@example.com', 1)`).run()
    testDb.prepare(`INSERT INTO notes (id, contact_id) VALUES ('n1', 'c1')`).run()
    testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES ('chat-c1', 'c1', 'contact')`).run()
    // A meeting-context chat session that should NOT be touched.
    testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES ('chat-m1', 'c1', 'meeting')`).run()
    // Another contact + chat session — must survive.
    testDb.prepare(`INSERT INTO contacts (id) VALUES ('c2')`).run()
    testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES ('chat-c2', 'c2', 'contact')`).run()
  })

  it('removes the contact row and FK CASCADE children', () => {
    deleteContact('c1')
    expect(testDb.prepare(`SELECT id FROM contacts WHERE id = 'c1'`).get()).toBeUndefined()
    expect(testDb.prepare(`SELECT id FROM contact_emails WHERE contact_id = 'c1'`).all()).toHaveLength(0)
  })

  it('clears notes.contact_id via FK SET NULL', () => {
    deleteContact('c1')
    expect((testDb.prepare(`SELECT contact_id FROM notes WHERE id = 'n1'`).get() as { contact_id: string | null }).contact_id).toBeNull()
  })

  it('removes only the matching contact-context chat_sessions row', () => {
    deleteContact('c1')
    const sessions = testDb.prepare(`SELECT id FROM chat_sessions ORDER BY id`).all()
    expect(sessions).toEqual([{ id: 'chat-c2' }, { id: 'chat-m1' }])
  })

  it('is a no-op for an unknown contact', () => {
    deleteContact('does-not-exist')
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM contacts`).get()).toEqual({ n: 2 })
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM chat_sessions`).get()).toEqual({ n: 3 })
  })
})
