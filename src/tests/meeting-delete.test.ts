/**
 * Tests for deleteMeeting — verifies meetings + meetings_fts + chat_sessions
 * cleanup is atomic and that FK CASCADE children (meeting_company_links) are
 * also removed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { deleteMeeting } = await import('@cyggie/db/sqlite/repositories/meeting.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT
    );

    CREATE VIRTUAL TABLE meetings_fts USING fts5(
      title,
      meeting_id UNINDEXED
    );

    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL
    );

    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      PRIMARY KEY (meeting_id, company_id)
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

describe('deleteMeeting', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.prepare(`INSERT INTO meetings (id, title) VALUES ('m1', 'Standup')`).run()
    testDb.prepare(`INSERT INTO meetings (id, title) VALUES ('m2', 'Other')`).run()
    testDb.prepare(`INSERT INTO meetings_fts (title, meeting_id) VALUES ('Standup', 'm1')`).run()
    testDb.prepare(`INSERT INTO meetings_fts (title, meeting_id) VALUES ('Other', 'm2')`).run()
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co1', 'Acme')`).run()
    testDb.prepare(`INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('m1', 'co1')`).run()
    testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES ('chat-m1', 'm1', 'meeting')`).run()
    // Different-kind chat session keyed to the same id — must NOT be touched.
    testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES ('chat-co1', 'm1', 'company')`).run()
  })

  it('removes the meeting row and returns true', () => {
    expect(deleteMeeting('m1')).toBe(true)
    expect(testDb.prepare(`SELECT id FROM meetings WHERE id = 'm1'`).get()).toBeUndefined()
  })

  it('removes the matching meetings_fts row', () => {
    deleteMeeting('m1')
    const ftsRows = testDb.prepare(`SELECT meeting_id FROM meetings_fts ORDER BY meeting_id`).all()
    expect(ftsRows).toEqual([{ meeting_id: 'm2' }])
  })

  it('FK CASCADE removes meeting_company_links rows', () => {
    deleteMeeting('m1')
    expect(testDb.prepare(`SELECT meeting_id FROM meeting_company_links`).all()).toHaveLength(0)
  })

  it('removes only the matching meeting-context chat_sessions row', () => {
    deleteMeeting('m1')
    const sessions = testDb.prepare(`SELECT id FROM chat_sessions ORDER BY id`).all()
    expect(sessions).toEqual([{ id: 'chat-co1' }])
  })

  it('returns false when the meeting does not exist', () => {
    expect(deleteMeeting('nonexistent')).toBe(false)
  })
})
