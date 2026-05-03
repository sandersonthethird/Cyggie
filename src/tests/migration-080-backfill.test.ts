/**
 * Tests for migration 080 — backfill of meetings.chat_messages into the new
 * chat_sessions / chat_session_messages tables.
 *
 * Critical invariants:
 *   1. Idempotent: re-running the migration is a no-op (deterministic IDs +
 *      INSERT OR IGNORE).
 *   2. Skips meetings with malformed JSON (logs but doesn't crash).
 *   3. Skips meetings with empty arrays (no session created).
 *   4. Pre-computes preview_text + message_count up-front (no mid-backfill
 *      UPDATEs that would trigger FTS5 storms).
 *   5. Title is the first user message truncated to 80 chars (no LLM call).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runChatSessionsMigration } from '../main/database/migrations/078-chat-sessions'
import { runBackfillMeetingChatsMigration } from '../main/database/migrations/080-backfill-meeting-chats'

let testDb: Database.Database

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      chat_messages TEXT,
      date TEXT,
      updated_at TEXT
    );
  `)
  runChatSessionsMigration(db)
  return db
}

function insertMeeting(
  db: Database.Database,
  id: string,
  title: string,
  messages: unknown,
  opts: { updatedAt?: string; date?: string } = {}
): void {
  db.prepare(
    `INSERT INTO meetings (id, title, chat_messages, date, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    messages === null ? null : JSON.stringify(messages),
    opts.date ?? '2026-01-15T10:00:00.000Z',
    opts.updatedAt ?? '2026-01-15T10:30:00.000Z'
  )
}

beforeEach(() => {
  testDb = buildDb()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('migration 080 — backfill', () => {
  it('creates one chat_sessions row per meeting with chat_messages', () => {
    insertMeeting(testDb, 'm1', 'First meeting', [
      { role: 'user', content: 'What do we know about Acme?' },
      { role: 'assistant', content: 'Acme is a synthetic explosives company.' },
    ])
    insertMeeting(testDb, 'm2', 'Second meeting', [
      { role: 'user', content: 'Q' },
      { role: 'assistant', content: 'A' },
    ])

    runBackfillMeetingChatsMigration(testDb)

    const sessions = testDb
      .prepare(`SELECT * FROM chat_sessions ORDER BY context_id`)
      .all() as Array<{
      id: string
      context_id: string
      context_kind: string
      context_label: string
      title: string
      preview_text: string
      message_count: number
      is_active: number
    }>

    expect(sessions.length).toBe(2)
    expect(sessions[0].id).toBe('mtg-chat-m1')
    expect(sessions[0].context_id).toBe('m1')
    expect(sessions[0].context_kind).toBe('meeting')
    expect(sessions[0].context_label).toBe('First meeting')
    expect(sessions[0].title).toBe('What do we know about Acme?')
    expect(sessions[0].message_count).toBe(2)
    expect(sessions[0].is_active).toBe(0)
    expect(sessions[0].preview_text).toBe('Acme is a synthetic explosives company.')

    const messages = testDb
      .prepare(`SELECT * FROM chat_session_messages WHERE session_id = ? ORDER BY id`)
      .all('mtg-chat-m1') as Array<{ id: string; role: string; content: string }>

    expect(messages.length).toBe(2)
    expect(messages.map((m) => m.id).sort()).toEqual(['mtg-msg-m1-0', 'mtg-msg-m1-1'])
  })

  it('is idempotent — re-running creates no duplicates', () => {
    insertMeeting(testDb, 'm1', 'M', [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])

    runBackfillMeetingChatsMigration(testDb)
    const sessionsAfterFirst = testDb
      .prepare(`SELECT COUNT(*) as n FROM chat_sessions`)
      .get() as { n: number }
    const messagesAfterFirst = testDb
      .prepare(`SELECT COUNT(*) as n FROM chat_session_messages`)
      .get() as { n: number }

    runBackfillMeetingChatsMigration(testDb)
    runBackfillMeetingChatsMigration(testDb)

    const sessionsAfterThird = testDb
      .prepare(`SELECT COUNT(*) as n FROM chat_sessions`)
      .get() as { n: number }
    const messagesAfterThird = testDb
      .prepare(`SELECT COUNT(*) as n FROM chat_session_messages`)
      .get() as { n: number }

    expect(sessionsAfterFirst.n).toBe(1)
    expect(messagesAfterFirst.n).toBe(2)
    expect(sessionsAfterThird.n).toBe(1)
    expect(messagesAfterThird.n).toBe(2)
  })

  it('skips meetings with malformed JSON without crashing', () => {
    testDb.prepare(`INSERT INTO meetings (id, title, chat_messages) VALUES (?, ?, ?)`).run(
      'm-bad',
      'Bad',
      'this is not json {{{'
    )
    insertMeeting(testDb, 'm-good', 'Good', [{ role: 'user', content: 'ok' }])

    expect(() => runBackfillMeetingChatsMigration(testDb)).not.toThrow()

    const sessions = testDb
      .prepare(`SELECT context_id FROM chat_sessions`)
      .all() as Array<{ context_id: string }>
    expect(sessions.map((s) => s.context_id)).toEqual(['m-good'])
  })

  it('skips meetings with empty chat_messages arrays', () => {
    insertMeeting(testDb, 'm-empty', 'Empty', [])
    insertMeeting(testDb, 'm-good', 'Good', [{ role: 'user', content: 'ok' }])

    runBackfillMeetingChatsMigration(testDb)

    const sessions = testDb
      .prepare(`SELECT context_id FROM chat_sessions`)
      .all() as Array<{ context_id: string }>
    expect(sessions.map((s) => s.context_id)).toEqual(['m-good'])
  })

  it('uses meeting title as fallback when no user message exists', () => {
    insertMeeting(testDb, 'm-no-user', 'Just-Assistant Meeting', [
      { role: 'system', content: 'You are an assistant.' },
      { role: 'assistant', content: 'Hi.' },
    ])

    runBackfillMeetingChatsMigration(testDb)

    const session = testDb
      .prepare(`SELECT title FROM chat_sessions WHERE id = ?`)
      .get('mtg-chat-m-no-user') as { title: string }
    expect(session.title).toBe('Just-Assistant Meeting')
  })

  it('truncates the title from first user message to 80 chars', () => {
    const longQuestion = 'x'.repeat(200)
    insertMeeting(testDb, 'm-long', 'Long', [{ role: 'user', content: longQuestion }])

    runBackfillMeetingChatsMigration(testDb)

    const session = testDb
      .prepare(`SELECT title FROM chat_sessions WHERE id = ?`)
      .get('mtg-chat-m-long') as { title: string }
    expect(session.title.length).toBe(80)
  })

  it('preserves message order via deterministic ordinal IDs', () => {
    insertMeeting(testDb, 'm1', 'M', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])

    runBackfillMeetingChatsMigration(testDb)

    const messages = testDb
      .prepare(
        `SELECT id, content FROM chat_session_messages WHERE session_id = ? ORDER BY id`
      )
      .all('mtg-chat-m1') as Array<{ id: string; content: string }>

    expect(messages).toEqual([
      { id: 'mtg-msg-m1-0', content: 'first' },
      { id: 'mtg-msg-m1-1', content: 'second' },
      { id: 'mtg-msg-m1-2', content: 'third' },
    ])
  })

  it('pre-computes preview_text from the last message', () => {
    insertMeeting(testDb, 'm1', 'M', [
      { role: 'user', content: 'what about Acme' },
      { role: 'assistant', content: 'Acme makes synthetic explosives for cartoon coyotes.' },
    ])

    runBackfillMeetingChatsMigration(testDb)

    const session = testDb
      .prepare(`SELECT preview_text FROM chat_sessions WHERE id = ?`)
      .get('mtg-chat-m1') as { preview_text: string }
    expect(session.preview_text).toContain('Acme makes synthetic explosives')
  })

  it('uses the meeting updated_at as last_message_at (not migration time)', () => {
    insertMeeting(
      testDb,
      'm-old',
      'Old meeting',
      [{ role: 'user', content: 'old chat' }],
      { updatedAt: '2024-06-15T08:00:00.000Z' }
    )
    insertMeeting(
      testDb,
      'm-new',
      'New meeting',
      [{ role: 'user', content: 'new chat' }],
      { updatedAt: '2026-01-15T10:30:00.000Z' }
    )

    runBackfillMeetingChatsMigration(testDb)

    const sessions = testDb
      .prepare(`SELECT id, last_message_at FROM chat_sessions ORDER BY last_message_at DESC`)
      .all() as Array<{ id: string; last_message_at: string }>

    expect(sessions[0].id).toBe('mtg-chat-m-new')
    expect(sessions[0].last_message_at).toBe('2026-01-15T10:30:00.000Z')
    expect(sessions[1].id).toBe('mtg-chat-m-old')
    expect(sessions[1].last_message_at).toBe('2024-06-15T08:00:00.000Z')
  })

  it('self-heals timestamps for already-backfilled rows that have migration-time stamps', () => {
    // Simulate a row backfilled by an earlier (buggy) version of the migration:
    // both created_at and updated_at are the same now-ish value, last_message_at too.
    const buggyTs = '2026-05-02T22:00:00.000Z'
    testDb
      .prepare(
        `INSERT INTO chat_sessions (id, context_id, context_kind, context_label, title,
                                    preview_text, message_count, is_active, is_pinned, is_archived,
                                    last_message_at, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, ?, ?, 1, 0, 0, 0, ?, ?, ?)`
      )
      .run(
        'mtg-chat-m1',
        'm1',
        'M',
        'first',
        'first',
        buggyTs,
        buggyTs,
        buggyTs
      )
    insertMeeting(
      testDb,
      'm1',
      'M',
      [{ role: 'user', content: 'first' }],
      { updatedAt: '2024-03-10T14:00:00.000Z' }
    )

    runBackfillMeetingChatsMigration(testDb)

    const session = testDb
      .prepare(`SELECT last_message_at FROM chat_sessions WHERE id = ?`)
      .get('mtg-chat-m1') as { last_message_at: string }
    expect(session.last_message_at).toBe('2024-03-10T14:00:00.000Z')
  })

  it('does NOT self-heal rows the user has already touched', () => {
    // A row with created_at != updated_at means a write happened post-backfill.
    const sessionId = 'mtg-chat-m1'
    testDb
      .prepare(
        `INSERT INTO chat_sessions (id, context_id, context_kind, context_label, title,
                                    preview_text, message_count, is_active, is_pinned, is_archived,
                                    last_message_at, created_at, updated_at)
         VALUES (?, ?, 'meeting', ?, ?, ?, 1, 0, 0, 0, ?, ?, ?)`
      )
      .run(
        sessionId,
        'm1',
        'M',
        'first',
        'first',
        '2026-05-02T22:00:00.000Z', // touched (last message)
        '2026-05-02T20:00:00.000Z', // created earlier
        '2026-05-02T22:00:00.000Z'  // updated later — DIFFERENT from created_at
      )
    insertMeeting(
      testDb,
      'm1',
      'M',
      [{ role: 'user', content: 'first' }],
      { updatedAt: '2024-03-10T14:00:00.000Z' }
    )

    runBackfillMeetingChatsMigration(testDb)

    const session = testDb
      .prepare(`SELECT last_message_at FROM chat_sessions WHERE id = ?`)
      .get(sessionId) as { last_message_at: string }
    // Should be unchanged because the user has touched it.
    expect(session.last_message_at).toBe('2026-05-02T22:00:00.000Z')
  })

  it('FTS5 index is populated by the message insert triggers during backfill', () => {
    insertMeeting(testDb, 'm1', 'M', [
      { role: 'user', content: 'something about pterodactyls' },
    ])

    runBackfillMeetingChatsMigration(testDb)

    const ftsResults = testDb
      .prepare(
        `SELECT message_id FROM chat_session_messages_fts WHERE chat_session_messages_fts MATCH ?`
      )
      .all('"pterodactyls"') as Array<{ message_id: string }>

    expect(ftsResults.length).toBe(1)
  })
})
