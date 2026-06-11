import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runChatSessionAttachedEntitiesMigration } from '@cyggie/db/sqlite/migrations/118-chat-session-attached-entities'

// Migration 118 adds `chat_sessions.attached_context_entities` (JSON TEXT,
// DEFAULT '[]'). Generalizes migration 102's company-only selected_company_ids
// to mixed company+contact refs. Additive, PRAGMA-idempotent, no backfill.

function makeDb(withTable = true): Database.Database {
  const db = new Database(':memory:')
  if (withTable) {
    db.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        context_kind TEXT NOT NULL
      );
    `)
  }
  return db
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as { name: string }[]
  return cols.some((c) => c.name === col)
}

describe('migration 118 — chat_sessions.attached_context_entities', () => {
  it('adds the column when missing', () => {
    const db = makeDb()
    expect(hasColumn(db, 'chat_sessions', 'attached_context_entities')).toBe(false)
    runChatSessionAttachedEntitiesMigration(db)
    expect(hasColumn(db, 'chat_sessions', 'attached_context_entities')).toBe(true)
  })

  it('defaults existing rows to an empty JSON array', () => {
    const db = makeDb()
    db.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind) VALUES (?, ?, ?)`)
      .run('s1', 'company:c1', 'company')
    runChatSessionAttachedEntitiesMigration(db)
    const row = db
      .prepare(`SELECT attached_context_entities FROM chat_sessions WHERE id = ?`)
      .get('s1') as { attached_context_entities: string }
    expect(row.attached_context_entities).toBe('[]')
  })

  it('is idempotent — re-running does not clobber populated values', () => {
    const db = makeDb()
    runChatSessionAttachedEntitiesMigration(db)
    db.prepare(`UPDATE chat_sessions SET attached_context_entities = ? WHERE id = ?`) // no-op (no rows)
    db.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind, attached_context_entities) VALUES (?, ?, ?, ?)`)
      .run('s2', 'global-all', 'global', '[{"type":"company","id":"c1","label":"Acme"}]')
    runChatSessionAttachedEntitiesMigration(db) // second run must not reset
    const row = db
      .prepare(`SELECT attached_context_entities FROM chat_sessions WHERE id = ?`)
      .get('s2') as { attached_context_entities: string }
    expect(JSON.parse(row.attached_context_entities)).toEqual([{ type: 'company', id: 'c1', label: 'Acme' }])
  })

  it('no-ops when chat_sessions table is absent (earlier migration skipped)', () => {
    const db = makeDb(false)
    expect(() => runChatSessionAttachedEntitiesMigration(db)).not.toThrow()
  })
})
