// Migration 097: sync outbox + sync_state.
//
// Behavioral parity with the gateway-side migration tests (0014/0015):
// run the migration on an empty in-memory SQLite and assert the
// post-migration shape via pragma_table_info. Catches a regression
// where a future migration accidentally drops or retypes a column the
// pull service depends on.

import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'

interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: 0 | 1
  dflt_value: string | null
  pk: 0 | 1
}

function tableColumns(db: Database.Database, table: string): Map<string, ColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
  return new Map(rows.map((r) => [r.name, r]))
}

describe('migration 097 — sync outbox + sync_state', () => {
  test('creates outbox table with the expected columns', () => {
    const db = new Database(':memory:')
    runSyncOutboxStateMigration(db)
    const cols = tableColumns(db, 'outbox')
    expect(cols.size).toBeGreaterThan(0)
    expect(cols.get('id')?.pk).toBe(1)
    expect(cols.get('table_name')?.notnull).toBe(1)
    expect(cols.get('row_id')?.notnull).toBe(1)
    expect(cols.get('lamport')?.notnull).toBe(1)
    expect(cols.get('status')?.dflt_value).toContain("pending")
    expect(cols.get('attempts')?.dflt_value).toBe('0')
    db.close()
  })

  test('creates sync_state with last_pushed_lamport AND last_pulled_lamport (Phase 1.5c)', () => {
    const db = new Database(':memory:')
    runSyncOutboxStateMigration(db)
    const cols = tableColumns(db, 'sync_state')
    expect(cols.get('device_id')?.pk).toBe(1)
    expect(cols.get('last_pushed_lamport')).toBeDefined()
    expect(cols.get('last_pushed_lamport')?.notnull).toBe(1)
    expect(cols.get('last_pushed_lamport')?.dflt_value).toContain("0")
    expect(cols.get('last_pulled_lamport')).toBeDefined()
    expect(cols.get('last_pulled_lamport')?.notnull).toBe(1)
    expect(cols.get('last_pulled_lamport')?.dflt_value).toContain("0")
    db.close()
  })

  test('is idempotent — running twice is a no-op (IF NOT EXISTS)', () => {
    const db = new Database(':memory:')
    runSyncOutboxStateMigration(db)
    expect(() => runSyncOutboxStateMigration(db)).not.toThrow()
    // Confirm one of the existing rows didn't get blown away
    db.prepare("INSERT INTO sync_state (device_id, user_id) VALUES ('d1', 'u1')").run()
    runSyncOutboxStateMigration(db)
    const row = db.prepare("SELECT user_id FROM sync_state WHERE device_id = 'd1'").get() as
      | { user_id: string }
      | undefined
    expect(row?.user_id).toBe('u1')
    db.close()
  })
})
