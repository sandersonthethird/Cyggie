/**
 * Integration test for `makeSyncedEntityNotesRepo` (the sync-wrapped entity-
 * notes factory) exported from the repositories barrel. This is the repo the
 * company/contact Notes-tab IPC handlers use. The pre-fix code built the repo
 * from the RAW `notes-base` factory, so create/update/delete wrote straight to
 * SQLite and never reached the outbox — company/contact notes silently
 * desynced from Neon / mobile. This test fails on that bypassing code.
 *
 * Asserts each write emits one `notes` outbox row AND that the payload carries
 * the entity FK + content (not merely that a row exists), since a short /
 * mis-shaped payload would be silently rejected at the gateway.
 *
 * Boundaries:
 *   • In-memory better-sqlite3 with the minimal schema the path touches
 *     (notes, org_companies, contacts, outbox, sync_state).
 *   • Imports from the BARREL so the `withSync` wrapper is exercised.
 *   • Configures sync globals so writes can emit outbox rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runUnifiedNotesMigration } from '@cyggie/db/sqlite/migrations/052-unified-notes'
import { runNotesFolderPathMigration } from '@cyggie/db/sqlite/migrations/057-notes-folder-path'
import { runLamportOnOwnedTablesMigration } from '@cyggie/db/sqlite/migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'
import { runNotesIsPrivateMigration } from '@cyggie/db/sqlite/migrations/121-notes-is-private'
import { runNotesSoftDeleteMigration } from '@cyggie/db/sqlite/migrations/130-notes-soft-delete'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { makeSyncedEntityNotesRepo } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
  lamport: string
}

function noteOutbox(): OutboxRow[] {
  return (
    testDb
      .prepare(
        `SELECT table_name, row_id, op, payload, lamport FROM outbox ORDER BY id ASC`,
      )
      .all() as OutboxRow[]
  ).filter((r) => r.table_name === 'notes')
}

const COMPANY_ID = 'company-1'

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE themes (id TEXT PRIMARY KEY);
  `)
  runUnifiedNotesMigration(db)
  runNotesFolderPathMigration(db)
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  runNotesIsPrivateMigration(db)
  runNotesSoftDeleteMigration(db)
  db.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES (?, ?)`).run(
    COMPANY_ID,
    'Superlog',
  )
  return db
}

describe('makeSyncedEntityNotesRepo — sync-wrapped outbox emission', () => {
  const repo = makeSyncedEntityNotesRepo('company_id')

  beforeEach(() => {
    testDb = buildDb()
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => 'user-1',
      getDeviceId: () => 'device-1',
    })
  })

  it('create emits one insert row carrying the company FK + content', () => {
    const note = repo.create({ entityId: COMPANY_ID, content: 'first note' })!
    expect(note.companyId).toBe(COMPANY_ID)

    const rows = noteOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('insert')
    expect(rows[0].row_id).toBe(note.id)
    const payload = JSON.parse(rows[0].payload)
    expect(payload.companyId).toBe(COMPANY_ID)
    expect(payload.content).toBe('first note')
    // lamport stamped from the txn (≥ 1), proving it went through the wrapper.
    expect(BigInt(rows[0].lamport)).toBeGreaterThan(0n)
  })

  it('update emits an update row with the new content', () => {
    const note = repo.create({ entityId: COMPANY_ID, content: 'before' })!
    testDb.exec(`DELETE FROM outbox`)

    const updated = repo.update(note.id, { content: 'after' })!
    expect(updated.content).toBe('after')

    const rows = noteOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('update')
    expect(rows[0].row_id).toBe(note.id)
    const payload = JSON.parse(rows[0].payload)
    expect(payload.content).toBe('after')
    expect(payload.companyId).toBe(COMPANY_ID)
  })

  it('delete emits a delete row carrying the pre-delete state', () => {
    const note = repo.create({ entityId: COMPANY_ID, content: 'doomed' })!
    testDb.exec(`DELETE FROM outbox`)

    const ok = repo.delete(note.id)
    expect(ok).toBe(true)

    const rows = noteOutbox()
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('delete')
    expect(rows[0].row_id).toBe(note.id)
    const payload = JSON.parse(rows[0].payload)
    expect(payload.content).toBe('doomed')
    expect(payload.companyId).toBe(COMPANY_ID)

    // Row is gone locally too.
    expect(repo.get(note.id)).toBeNull()
  })

  it('reads (get/list) do not touch the outbox', () => {
    const note = repo.create({ entityId: COMPANY_ID, content: 'readme' })!
    testDb.exec(`DELETE FROM outbox`)

    repo.get(note.id)
    repo.list(COMPANY_ID)

    expect(noteOutbox()).toHaveLength(0)
  })
})
