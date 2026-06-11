// Tests for custom-field-sync-backfill.service.ts — mirrors memo-sync-backfill
// test harness: a minimal in-memory SQLite with just the tables the backfill
// reads/writes, getDatabase() swapped via vi.mock.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const USER_ID = 'user-test-1'
const DEVICE_ID = 'device-test-1'

let db: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => db,
}))

const { backfillCustomFieldsForSync } = await import(
  '@main/services/custom-field-sync-backfill.service'
)

function freshDb(): Database.Database {
  const next = new Database(':memory:')
  next.pragma('foreign_keys = ON')
  next.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL, device_id TEXT NOT NULL, table_name TEXT NOT NULL,
      row_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL,
      lamport TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), acked_at TEXT
    );
    CREATE TABLE custom_field_definitions (
      id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, field_key TEXT NOT NULL,
      label TEXT NOT NULL, field_type TEXT NOT NULL, options_json TEXT,
      is_required INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      show_in_list INTEGER NOT NULL DEFAULT 0, is_builtin INTEGER NOT NULL DEFAULT 0,
      section TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), lamport TEXT NOT NULL DEFAULT '0'
    );
    CREATE TABLE custom_field_values (
      id TEXT PRIMARY KEY, field_definition_id TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, value_text TEXT,
      value_number REAL, value_boolean INTEGER, value_date TEXT, value_ref_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), lamport TEXT NOT NULL DEFAULT '0',
      UNIQUE(field_definition_id, entity_id)
    );
  `)
  next.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('syncDeviceId', DEVICE_ID)
  return next
}

function insertDef(id: string, key: string) {
  db.prepare(
    `INSERT INTO custom_field_definitions (id, entity_type, field_key, label, field_type)
     VALUES (?, 'company', ?, ?, 'multiselect')`,
  ).run(id, key, key)
}
function insertValue(id: string, defId: string, entityId: string, text: string) {
  db.prepare(
    `INSERT INTO custom_field_values (id, field_definition_id, entity_type, entity_id, value_text)
     VALUES (?, ?, 'company', ?, ?)`,
  ).run(id, defId, entityId, text)
}

describe('backfillCustomFieldsForSync', () => {
  beforeEach(() => { db = freshDb() })
  afterEach(() => { db.close() })

  it('no-ops when userId is null', () => {
    insertDef('d1', 'focus')
    const r = backfillCustomFieldsForSync(null)
    expect(r).toEqual({ definitionsEnqueued: 0, valuesEnqueued: 0, skipped: 0 })
    expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as { c: number }).c).toBe(0)
  })

  it('no-ops when device_id is missing', () => {
    db.prepare("DELETE FROM settings WHERE key = 'syncDeviceId'").run()
    insertDef('d1', 'focus')
    expect(backfillCustomFieldsForSync(USER_ID).definitionsEnqueued).toBe(0)
  })

  it('enqueues definitions BEFORE values (FK order)', () => {
    insertDef('d1', 'focus')
    insertValue('v1', 'd1', 'co1', 'Seed')
    const r = backfillCustomFieldsForSync(USER_ID)
    expect(r).toEqual({ definitionsEnqueued: 1, valuesEnqueued: 1, skipped: 0 })
    const tables = (db.prepare('SELECT table_name FROM outbox ORDER BY id').all() as Array<{ table_name: string }>)
      .map((x) => x.table_name)
    expect(tables).toEqual(['custom_field_definitions', 'custom_field_values'])
  })

  it('emits correct row_id / op / user / device for each table', () => {
    insertDef('d1', 'focus')
    insertValue('v1', 'd1', 'co1', 'Seed')
    backfillCustomFieldsForSync(USER_ID)
    const rows = db.prepare('SELECT table_name, row_id, op, user_id, device_id FROM outbox ORDER BY id').all() as Array<Record<string, string>>
    expect(rows[0]).toMatchObject({ table_name: 'custom_field_definitions', row_id: 'd1', op: 'insert', user_id: USER_ID, device_id: DEVICE_ID })
    expect(rows[1]).toMatchObject({ table_name: 'custom_field_values', row_id: 'v1', op: 'insert' })
  })

  it('bumps lamport so re-runs are a no-op', () => {
    insertDef('d1', 'focus')
    insertValue('v1', 'd1', 'co1', 'Seed')
    backfillCustomFieldsForSync(USER_ID)
    expect((db.prepare("SELECT lamport FROM custom_field_definitions WHERE id='d1'").get() as { lamport: string }).lamport).not.toBe('0')
    const r2 = backfillCustomFieldsForSync(USER_ID)
    expect(r2).toEqual({ definitionsEnqueued: 0, valuesEnqueued: 0, skipped: 0 })
    expect((db.prepare('SELECT COUNT(*) c FROM outbox').get() as { c: number }).c).toBe(2)
  })

  it('outbox payload carries the bumped lamport and id', () => {
    insertDef('d1', 'focus')
    backfillCustomFieldsForSync(USER_ID)
    const row = db.prepare('SELECT payload, lamport FROM outbox').get() as { payload: string; lamport: string }
    const parsed = JSON.parse(row.payload)
    expect(parsed.lamport).toBe(row.lamport)
    expect(parsed.id).toBe('d1')
  })
})
