/**
 * Sync outbox-emission test for the attached-context-entities write path.
 *
 * `attached_context_entities` lives on `chat_sessions`, a sync-owned table, so
 * the barrel's `setChatSessionAttachedEntities` (withSync) MUST emit one
 * `chat_sessions` update row whose payload carries `attachedContextEntities` as
 * a JS ARRAY (not the raw JSON string) — the Postgres column is jsonb. A
 * string-vs-array slip here would round-trip wrong to Neon.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runChatSessionsMigration } from '@cyggie/db/sqlite/migrations/078-chat-sessions'
import { runChatSessionSelectedCompaniesMigration } from '@cyggie/db/sqlite/migrations/102-chat-session-selected-companies'
import { runChatSessionCacheEnabledMigration } from '@cyggie/db/sqlite/migrations/103-chat-session-cache-enabled'
import { runChatSessionAttachedEntitiesMigration } from '@cyggie/db/sqlite/migrations/118-chat-session-attached-entities'
import { runLamportOnOwnedTablesMigration } from '@cyggie/db/sqlite/migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({
  logAudit: vi.fn(),
}))

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createChatSession, setChatSessionAttachedEntities } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
}

function chatSessionOutbox(): OutboxRow[] {
  return (testDb.prepare(`SELECT table_name, row_id, op, payload FROM outbox ORDER BY id ASC`).all() as OutboxRow[])
    .filter((r) => r.table_name === 'chat_sessions')
}

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL);
  `)
  runChatSessionsMigration(db)
  runChatSessionSelectedCompaniesMigration(db)
  runChatSessionCacheEnabledMigration(db)
  runChatSessionAttachedEntitiesMigration(db)
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  return db
}

describe('chat_sessions attached entities — sync outbox emission', () => {
  beforeEach(() => {
    testDb = buildDb()
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => 'user-1',
      getDeviceId: () => 'device-1',
    })
  })

  it('emits one chat_sessions update with attachedContextEntities as a JS array', () => {
    const session = createChatSession('company:c1', 'company', 'Acme', 'user-1')
    testDb.exec(`DELETE FROM outbox`) // clear the create row

    const entities = [
      { type: 'company' as const, id: 'c1', label: 'Acme' },
      { type: 'contact' as const, id: 'p1', label: 'Jane Doe' },
    ]
    setChatSessionAttachedEntities(session.id, entities, 'user-1')

    const rows = chatSessionOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('update')
    expect(rows[0].row_id).toBe(session.id)

    const payload = JSON.parse(rows[0].payload)
    // Must be an ARRAY in the payload (jsonb), never the raw JSON string.
    expect(Array.isArray(payload.attachedContextEntities)).toBe(true)
    expect(payload.attachedContextEntities).toEqual(entities)
  })
})
