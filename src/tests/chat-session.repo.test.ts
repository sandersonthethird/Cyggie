/**
 * Tests for chat-session.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - audit.repo logAudit → no-op (avoids needing to set up audit_log table)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runChatSessionsMigration } from '../main/database/migrations/078-chat-sessions'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb,
}))

vi.mock('../main/database/repositories/audit.repo', () => ({
  logAudit: vi.fn(),
}))

const {
  getOrCreateActive,
  appendMessage,
  endActive,
  createNew,
  listRecent,
  loadMessages,
  search,
  rename,
  pin,
  unpin,
  archive,
  deleteSession,
  getSession,
  getActiveForContext,
  setTitleIfMissing,
} = await import('../main/database/repositories/chat-session.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Stub the entity tables that refreshContextLabel reads from.
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  `)
  runChatSessionsMigration(db)
  return db
}

describe('chat-session.repo', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  describe('getOrCreateActive', () => {
    it('creates a new active session when none exists', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      expect(session.contextId).toBe('global-all')
      expect(session.contextKind).toBe('global')
      expect(session.isActive).toBe(true)
      expect(session.messageCount).toBe(0)
    })

    it('reuses the existing active session for the same context', () => {
      const a = getOrCreateActive('global-all', 'global', 'Global')
      const b = getOrCreateActive('global-all', 'global', 'Global')
      expect(b.id).toBe(a.id)
    })

    it('throws on empty contextId', () => {
      expect(() => getOrCreateActive('', 'global', null)).toThrow()
    })

    it('refreshes contextLabel from the entity table when no label provided', () => {
      testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES (?, ?)`).run('c1', 'Acme')
      const session = getOrCreateActive('company:c1', 'company', null)
      expect(session.contextLabel).toBe('Acme')
    })
  })

  describe('appendMessage', () => {
    it('inserts a message and updates session counters', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      const msg = appendMessage({ sessionId: session.id, role: 'user', content: 'hello world' })
      expect(msg.role).toBe('user')
      expect(msg.content).toBe('hello world')

      const updated = getSession(session.id)
      expect(updated?.messageCount).toBe(1)
      expect(updated?.previewText).toBe('hello world')
    })

    it('truncates oversized attachments_json to null', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      const huge = 'x'.repeat(100_000)
      const json = JSON.stringify({ blob: huge })
      const msg = appendMessage({
        sessionId: session.id,
        role: 'user',
        content: 'q',
        attachmentsJson: json,
      })
      expect(msg.attachmentsJson).toBeNull()
    })

    it('writes to FTS5 index so search() finds the content', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: session.id, role: 'user', content: 'tell me about pterodactyls' })
      const results = search('pterodactyls')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].sessionId).toBe(session.id)
    })

    it('throws on missing sessionId or content', () => {
      expect(() => appendMessage({ sessionId: '', role: 'user', content: 'q' })).toThrow()
      expect(() => appendMessage({ sessionId: 'x', role: 'user', content: '' })).toThrow()
    })
  })

  describe('endActive', () => {
    it('flips is_active to 0 when the session has messages', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: session.id, role: 'user', content: 'q' })
      endActive('global-all')
      const updated = getSession(session.id)
      expect(updated?.isActive).toBe(false)
    })

    it('prunes empty active sessions instead of marking them inactive', () => {
      const session = getOrCreateActive('global-all', 'global', 'Global')
      endActive('global-all')
      expect(getSession(session.id)).toBeNull()
    })

    it('is idempotent when no active session exists', () => {
      expect(() => endActive('nonexistent-context')).not.toThrow()
    })

    it('next message after end starts a new session', () => {
      const a = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: a.id, role: 'user', content: 'first' })
      endActive('global-all')
      const b = getOrCreateActive('global-all', 'global', 'Global')
      expect(b.id).not.toBe(a.id)
    })
  })

  describe('createNew', () => {
    it('ends the existing active session and creates a fresh one', () => {
      const a = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: a.id, role: 'user', content: 'q' })
      const b = createNew('global-all', 'global', 'Global')
      expect(b.id).not.toBe(a.id)
      expect(getSession(a.id)?.isActive).toBe(false)
      expect(b.isActive).toBe(true)
    })
  })

  describe('listRecent', () => {
    it('returns non-archived sessions ordered by recency', () => {
      const s1 = getOrCreateActive('company:c1', 'company', 'A')
      appendMessage({ sessionId: s1.id, role: 'user', content: 'q1' })
      endActive('company:c1')

      // Tick — better-sqlite3 datetime('now') has 1-sec resolution, so wait
      const start = Date.now()
      while (Date.now() - start < 1100) { /* spin */ }

      const s2 = getOrCreateActive('company:c2', 'company', 'B')
      appendMessage({ sessionId: s2.id, role: 'user', content: 'q2' })

      const recent = listRecent({ limit: 10 })
      expect(recent[0].id).toBe(s2.id)
      expect(recent[1].id).toBe(s1.id)
    })

    it('filters by contextId', () => {
      const s1 = getOrCreateActive('company:c1', 'company', 'A')
      appendMessage({ sessionId: s1.id, role: 'user', content: 'q' })
      const s2 = getOrCreateActive('company:c2', 'company', 'B')
      appendMessage({ sessionId: s2.id, role: 'user', content: 'q' })
      const filtered = listRecent({ contextId: 'company:c1' })
      expect(filtered.length).toBe(1)
      expect(filtered[0].id).toBe(s1.id)
    })

    it('sorts pinned sessions ahead of unpinned ones', () => {
      const s1 = getOrCreateActive('company:c1', 'company', 'A')
      appendMessage({ sessionId: s1.id, role: 'user', content: 'q1' })
      endActive('company:c1')
      const s2 = getOrCreateActive('company:c2', 'company', 'B')
      appendMessage({ sessionId: s2.id, role: 'user', content: 'q2' })
      pin(s1.id)
      const recent = listRecent({ limit: 10 })
      expect(recent[0].id).toBe(s1.id)
    })

    it('excludes archived sessions', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'q' })
      archive(s.id)
      expect(listRecent().length).toBe(0)
    })
  })

  describe('search', () => {
    it('returns ranked results for FTS5 phrase match', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'find some unique pterodactyls today' })
      appendMessage({ sessionId: s.id, role: 'assistant', content: 'unrelated reply about cats' })
      const results = search('pterodactyls')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].snippet).toContain('pterodactyls')
    })

    it('returns [] for queries shorter than 2 chars', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'foo' })
      expect(search('a')).toEqual([])
      expect(search('')).toEqual([])
    })

    it('handles FTS5 metacharacters without crashing', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'discuss c++ pointers' })
      // Wrapped-in-quotes phrase match should not crash on these.
      expect(() => search('c++')).not.toThrow()
      expect(() => search('foo:bar')).not.toThrow()
      expect(() => search('OR')).not.toThrow()
    })

    it('excludes archived sessions from search results', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'unique-keyword-xyz' })
      archive(s.id)
      const results = search('unique-keyword-xyz')
      expect(results.length).toBe(0)
    })
  })

  describe('pin / unpin / archive / delete', () => {
    it('pin and unpin toggle is_pinned', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      pin(s.id)
      expect(getSession(s.id)?.isPinned).toBe(true)
      unpin(s.id)
      expect(getSession(s.id)?.isPinned).toBe(false)
    })

    it('archive sets is_archived and clears is_active', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      archive(s.id)
      const updated = getSession(s.id)
      expect(updated?.isArchived).toBe(true)
      expect(updated?.isActive).toBe(false)
    })

    it('deleteSession removes the row and CASCADE removes messages', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'q' })
      deleteSession(s.id)
      expect(getSession(s.id)).toBeNull()
      const msgs = loadMessages(s.id)
      expect(msgs.length).toBe(0)
    })
  })

  describe('rename / setTitleIfMissing', () => {
    it('rename updates the title', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      rename(s.id, 'My renamed thread')
      expect(getSession(s.id)?.title).toBe('My renamed thread')
    })

    it('rename truncates titles longer than 80 chars', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      rename(s.id, 'x'.repeat(200))
      expect(getSession(s.id)?.title?.length).toBeLessThanOrEqual(80)
    })

    it('rename rejects empty titles', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      expect(() => rename(s.id, '   ')).toThrow()
    })

    it('setTitleIfMissing only sets title when null', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      setTitleIfMissing(s.id, 'first')
      expect(getSession(s.id)?.title).toBe('first')
      setTitleIfMissing(s.id, 'second')
      expect(getSession(s.id)?.title).toBe('first')
    })
  })

  describe('loadMessages / getActiveForContext', () => {
    it('returns messages in chronological order', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: s.id, role: 'user', content: 'one' })
      appendMessage({ sessionId: s.id, role: 'assistant', content: 'two' })
      appendMessage({ sessionId: s.id, role: 'user', content: 'three' })
      const msgs = loadMessages(s.id)
      expect(msgs.map((m) => m.content)).toEqual(['one', 'two', 'three'])
    })

    it('returns [] for nonexistent session', () => {
      expect(loadMessages('does-not-exist')).toEqual([])
    })

    it('getActiveForContext returns null when no active session exists', () => {
      expect(getActiveForContext('nope')).toBeNull()
    })

    it('getActiveForContext returns the active session', () => {
      const s = getOrCreateActive('global-all', 'global', 'Global')
      const found = getActiveForContext('global-all')
      expect(found?.id).toBe(s.id)
    })
  })

  describe('UNIQUE INDEX (context_id) WHERE is_active = 1', () => {
    it('prevents two simultaneous active sessions for the same contextId', () => {
      getOrCreateActive('global-all', 'global', 'Global')
      // Trying to manually insert a second active row with the same context_id
      // should fail — the index enforces it.
      expect(() =>
        testDb
          .prepare(
            `INSERT INTO chat_sessions (id, context_id, context_kind, is_active, last_message_at)
             VALUES ('rogue', 'global-all', 'global', 1, datetime('now'))`
          )
          .run()
      ).toThrow()
    })

    it('allows multiple inactive sessions for the same contextId', () => {
      const a = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: a.id, role: 'user', content: 'q' })
      endActive('global-all')
      const b = getOrCreateActive('global-all', 'global', 'Global')
      appendMessage({ sessionId: b.id, role: 'user', content: 'q' })
      endActive('global-all')
      // Two inactive sessions coexist with the same context_id
      const all = listRecent({ contextId: 'global-all', limit: 100 })
      expect(all.length).toBe(2)
    })
  })
})
