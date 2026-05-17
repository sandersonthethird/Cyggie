import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { logAudit, logAppEvent } from '@cyggie/db/sqlite/repositories/audit.repo'

const mockGetDb = vi.mocked(getDatabase)

/**
 * Locks the audit FK safety net (Phase 2).
 *
 * audit_log has FK: user_id REFERENCES users(id) ON DELETE SET NULL.
 * Pre-safety-net, calling logAudit with a non-existent user_id threw and
 * could kill the caller's operation (e.g. stress-test report persisted but
 * audit-log write fails → entire success branch unwound).
 * Post-safety-net, FK violations are demoted to console.warn.
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT 'X',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users (id, display_name) VALUES ('u-real', 'Real User');

    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      changes_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE app_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      event_name TEXT NOT NULL,
      properties_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `)
  return db
}

describe('audit.repo — FK safety net', () => {
  let db: Database.Database
  beforeEach(() => {
    db = makeDb()
    mockGetDb.mockReturnValue(db)
  })

  it('logAudit writes a row when user_id exists', () => {
    expect(() => logAudit('u-real', 'memo', 'm-1', 'create', { foo: 1 })).not.toThrow()
    const rows = db.prepare(`SELECT user_id, entity_type, entity_id FROM audit_log`).all() as Array<{user_id:string; entity_type:string; entity_id:string}>
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_type).toBe('memo')
  })

  it('logAudit does NOT throw when user_id is missing from users (FK demoted to warn)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => logAudit('u-ghost', 'memo', 'm-2', 'create')).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    const rows = db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }
    expect(rows.c).toBe(0)   // row dropped, not persisted
  })

  it('logAudit DOES throw on non-FK errors (e.g. missing required column)', () => {
    // Force a non-FK error by dropping the audit_log table.
    db.exec(`DROP TABLE audit_log`)
    expect(() => logAudit('u-real', 'memo', 'm-1', 'create')).toThrow()
  })

  it('logAudit accepts null user_id (and does not fire FK)', () => {
    expect(() => logAudit(null, 'memo', 'm-3', 'create')).not.toThrow()
    const rows = db.prepare(`SELECT user_id FROM audit_log`).all() as Array<{user_id: string | null}>
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBeNull()
  })

  it('logAppEvent does NOT throw on missing user_id (parallel safety net)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => logAppEvent('u-ghost', 'test_event', { k: 'v' })).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
