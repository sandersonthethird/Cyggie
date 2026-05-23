// Tests for the one-shot memo sync backfill (memo-sync-backfill.service.ts).
//
// Builds a minimal in-memory SQLite with just enough schema to exercise
// the row-iteration + outbox-emission path. Same posture as
// sync-remote-apply.test.ts — no need to run the full migration stack.
//
// The service module is imported via vi.mock to swap getDatabase() — the
// service reaches for the connection singleton, but tests run with their
// own :memory: db.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = 'user-test-1'
const DEVICE_ID = 'device-test-1'

let db: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => db,
}))

const { backfillMemosForSync } = await import('@main/services/memo-sync-backfill.service')

function freshDb(): Database.Database {
  const next = new Database(':memory:')
  next.pragma('foreign_keys = ON')
  next.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      lamport TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT
    );
    -- Minimal investment_memos shape (matches what backfill SELECTs).
    CREATE TABLE investment_memos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      latest_version_number INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0'
    );
    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      UNIQUE(memo_id, version_number)
    );
  `)
  next.prepare('INSERT INTO users (id) VALUES (?)').run(USER_ID)
  next.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('syncDeviceId', DEVICE_ID)
  return next
}

describe('backfillMemosForSync', () => {
  beforeEach(() => {
    db = freshDb()
  })
  afterEach(() => {
    db.close()
  })

  it('no-ops when userId is null', () => {
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'T')",
    ).run()
    const r = backfillMemosForSync(null)
    expect(r).toEqual({ memosEnqueued: 0, versionsEnqueued: 0, skipped: 0 })
    const outboxCount = db.prepare('SELECT COUNT(*) as c FROM outbox').get() as { c: number }
    expect(outboxCount.c).toBe(0)
  })

  it('no-ops when device_id setting is missing', () => {
    db.prepare("DELETE FROM settings WHERE key = 'syncDeviceId'").run()
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'T')",
    ).run()
    const r = backfillMemosForSync(USER_ID)
    expect(r.memosEnqueued).toBe(0)
  })

  it('enqueues one outbox row per memo at lamport=0', () => {
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'A'), ('m2', 'co1', 'B')",
    ).run()
    const r = backfillMemosForSync(USER_ID)
    expect(r.memosEnqueued).toBe(2)
    const rows = db
      .prepare('SELECT table_name, row_id, op, user_id, device_id FROM outbox ORDER BY id')
      .all() as Array<{ table_name: string; row_id: string; op: string; user_id: string; device_id: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      table_name: 'investment_memos',
      row_id: 'm1',
      op: 'insert',
      user_id: USER_ID,
      device_id: DEVICE_ID,
    })
    expect(rows[1]?.row_id).toBe('m2')
  })

  it('bumps memo.lamport so re-runs skip already-enqueued rows', () => {
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'A')",
    ).run()
    backfillMemosForSync(USER_ID)
    const lamportAfter = (db
      .prepare("SELECT lamport FROM investment_memos WHERE id = 'm1'")
      .get() as { lamport: string }).lamport
    expect(lamportAfter).not.toBe('0')

    // Second run — should be a no-op.
    const r2 = backfillMemosForSync(USER_ID)
    expect(r2.memosEnqueued).toBe(0)
    const outboxCount = db.prepare('SELECT COUNT(*) as c FROM outbox').get() as { c: number }
    expect(outboxCount.c).toBe(1)
  })

  it('enqueues versions alongside memos', () => {
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'A')",
    ).run()
    db.prepare(
      "INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown) VALUES ('v1', 'm1', 1, '# Hi')",
    ).run()
    const r = backfillMemosForSync(USER_ID)
    expect(r.memosEnqueued).toBe(1)
    expect(r.versionsEnqueued).toBe(1)
    const tables = (db
      .prepare('SELECT table_name FROM outbox ORDER BY id')
      .all() as Array<{ table_name: string }>).map((r) => r.table_name)
    expect(tables).toEqual(['investment_memos', 'investment_memo_versions'])
  })

  it('outbox payload contains the bumped lamport', () => {
    db.prepare(
      "INSERT INTO investment_memos (id, company_id, title) VALUES ('m1', 'co1', 'A')",
    ).run()
    backfillMemosForSync(USER_ID)
    const row = db.prepare('SELECT payload, lamport FROM outbox').get() as {
      payload: string
      lamport: string
    }
    const parsed = JSON.parse(row.payload)
    expect(parsed.lamport).toBe(row.lamport)
    expect(parsed.id).toBe('m1')
  })
})
