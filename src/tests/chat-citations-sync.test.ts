/**
 * M5 — chat citations sync round-trip (desktop side).
 *
 * The gateway stores citations as jsonb; chat_session_messages is a synced owned
 * table and desktop reads messages from local SQLite (not the live API). So a
 * pulled message's citations must: stringify on apply → store as TEXT → JSON.parse
 * back on read. This guards the PG-jsonb ↔ SQLite-TEXT seam the reviews flagged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import type { PulledChatSessionMessageRow } from '@main/services/sync-remote-apply'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const repo = await import('@cyggie/db/sqlite/repositories/chat-session.repo')
const { applyRemoteChatSessionMessages } = await import('@main/services/sync-remote-apply')

function insertSession(id: string): void {
  testDb
    .prepare(
      `INSERT INTO chat_sessions (id, context_id, context_kind, is_active, is_pinned,
         is_archived, cache_enabled, message_count, last_message_at, created_at, updated_at, lamport)
       VALUES (?, ?, 'crm', 1, 0, 0, 1, 0, datetime('now'), datetime('now'), datetime('now'), '1')`,
    )
    .run(id, id)
}

function pulledMessage(
  over: Partial<PulledChatSessionMessageRow> & { id: string; sessionId: string; citations: unknown },
): PulledChatSessionMessageRow {
  return {
    role: 'assistant',
    content: 'answer',
    attachmentsJson: null,
    createdAt: new Date().toISOString(),
    lamport: '100',
    ...over,
  } as PulledChatSessionMessageRow
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
})

describe('chat citations sync round-trip', () => {
  it('migration 132 added the citations column to chat_session_messages', () => {
    const cols = testDb.prepare(`PRAGMA table_info('chat_session_messages')`).all() as { name: string }[]
    expect(cols.some((c) => c.name === 'citations')).toBe(true)
  })

  it('a pulled message with citations stores as JSON TEXT and reads back parsed', () => {
    insertSession('sess-1')
    const citations = [
      { type: 'company', id: 'co1', label: 'Acme Corp' },
      { type: 'meeting', id: 'm1', label: 'Q3 Sync', timestamp: 1719100800000 },
    ]
    applyRemoteChatSessionMessages(testDb, 'device-2', 'user-1', [
      pulledMessage({ id: 'msg-1', sessionId: 'sess-1', citations }),
    ])

    // Stored as a JSON string in SQLite.
    const raw = testDb.prepare(`SELECT citations FROM chat_session_messages WHERE id = ?`).get('msg-1') as {
      citations: string | null
    }
    expect(typeof raw.citations).toBe('string')

    // Read back through the repo → parsed Citation[].
    const messages = repo.loadMessages('sess-1')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.citations).toEqual(citations)
  })

  it('a pulled message with null citations reads back as null', () => {
    insertSession('sess-2')
    applyRemoteChatSessionMessages(testDb, 'device-2', 'user-1', [
      pulledMessage({ id: 'msg-2', sessionId: 'sess-2', citations: null }),
    ])
    const messages = repo.loadMessages('sess-2')
    expect(messages[0]!.citations).toBeNull()
  })
})
