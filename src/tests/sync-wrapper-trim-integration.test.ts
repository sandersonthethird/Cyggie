/**
 * T38 — integration test for the `withSync` payload-trimming path.
 *
 * Confirms the wrapper:
 *   1. Calls `captureBeforeUpdate` BEFORE the inner fn runs (so the
 *      snapshot reflects pre-state, not post-state).
 *   2. Emits an outbox payload with unchanged large columns OMITTED.
 *   3. Keeps the same large columns when they actually changed.
 *   4. Leaves inserts and deletes untouched (no trimming).
 *
 * Uses the real `withSync` wrapper against an in-memory SQLite DB. We borrow
 * the `company_flagged_files` spec — a NON-fieldLww table that carries a
 * camelCase `largeColumns: ['extractedText']`, exercising the pure whole-row
 * T38 trim path in isolation. (meetings moved to field-LWW + snake largeColumns
 * in Phase 4.5, so its trimming now runs through the bare-row stamp path —
 * covered by the apply + stamp tests, not here.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runLamportOnOwnedTablesMigration } from '@cyggie/db/sqlite/migrations/096-lamport-on-owned-tables'
import { runSyncOutboxStateMigration } from '@cyggie/db/sqlite/migrations/097-sync-outbox-state'
import {
  OWNED_TABLES_BY_NAME,
  type OwnedTableSpec,
} from '@cyggie/db/sync/owned-tables'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { configureSyncGlobals, _resetSyncGlobalsForTesting, withSync } =
  await import('@cyggie/db/sqlite/repositories/_sync')

// Borrow company_flagged_files: a non-fieldLww spec with a camelCase
// largeColumns (['extractedText']) — the pure whole-row T38 trim path.
const flaggedSpec = OWNED_TABLES_BY_NAME.get('company_flagged_files') as OwnedTableSpec

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal shape — only `id` matters for outbox row_id encoding.
  db.exec(`CREATE TABLE company_flagged_files (id TEXT PRIMARY KEY, status TEXT)`)
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  return db
}

function readPayloads(): Array<{ op: string; payload: Record<string, unknown> }> {
  const rows = testDb
    .prepare(
      `SELECT op, payload FROM outbox WHERE table_name = 'company_flagged_files' ORDER BY id ASC`,
    )
    .all() as Array<{ op: string; payload: string }>
  return rows.map((r) => ({ op: r.op, payload: JSON.parse(r.payload) }))
}

describe('withSync — T38 large-column trimming', () => {
  beforeEach(() => {
    testDb = buildDb()
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => 'user-1',
      getDeviceId: () => 'device-1',
    })
    // Guard against an accidental owned-tables.ts change quietly disabling this
    // test (and confirm the spec is NOT fieldLww — this path is whole-row trim).
    expect(flaggedSpec.largeColumns).toEqual(expect.arrayContaining(['extractedText']))
    expect(flaggedSpec.fieldLww).not.toBe(true)
  })

  it('captureBeforeUpdate fires BEFORE the inner fn and snapshot is pre-state', () => {
    testDb
      .prepare(`INSERT INTO company_flagged_files (id, status) VALUES ('m1', 'before')`)
      .run()

    const observedPre: Array<string | undefined> = []

    const fakeUpdate = withSync(
      (_id: string, newStatus: string) => {
        testDb
          .prepare(`UPDATE company_flagged_files SET status = ? WHERE id = ?`)
          .run(newStatus, 'm1')
        return { id: 'm1', status: newStatus, extractedText: 'x' }
      },
      {
        table: 'company_flagged_files',
        op: 'update',
        captureBeforeUpdate: (_db, _args) => {
          const row = testDb
            .prepare(`SELECT id, status FROM company_flagged_files WHERE id = 'm1'`)
            .get() as { id: string; status: string } | undefined
          observedPre.push(row?.status)
          // Same extractedText as post-update so the diff trims it.
          return { id: 'm1', status: row?.status ?? '', extractedText: 'x' }
        },
      },
    )

    fakeUpdate('m1', 'after')

    expect(observedPre).toEqual(['before'])

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.op).toBe('update')
    // extractedText unchanged → trimmed
    expect('extractedText' in (payloads[0]?.payload ?? {})).toBe(false)
    expect(payloads[0]?.payload['status']).toBe('after')
  })

  it('keeps large column when it changed', () => {
    testDb
      .prepare(`INSERT INTO company_flagged_files (id, status) VALUES ('m1', 't')`)
      .run()

    const fakeUpdate = withSync(
      (_id: string) => ({ id: 'm1', status: 't', extractedText: 'NEW' }),
      {
        table: 'company_flagged_files',
        op: 'update',
        captureBeforeUpdate: () => ({ id: 'm1', status: 't', extractedText: 'old' }),
      },
    )

    fakeUpdate('m1')

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.payload['extractedText']).toBe('NEW')
  })

  it('does NOT trim on insert ops (insert needs full row for NOT NULL constraints)', () => {
    const fakeInsert = withSync(
      () => {
        testDb
          .prepare(`INSERT INTO company_flagged_files (id, status) VALUES ('m2', 'fresh')`)
          .run()
        return { id: 'm2', status: 'fresh', extractedText: 'a' }
      },
      {
        table: 'company_flagged_files',
        op: 'insert',
        captureBeforeUpdate: () => {
          throw new Error('captureBeforeUpdate must not fire on insert')
        },
      },
    )

    fakeInsert()

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.op).toBe('insert')
    expect(payloads[0]?.payload['extractedText']).toBe('a')
  })

  it('no-ops when captureBeforeUpdate is not provided (back-compat)', () => {
    testDb
      .prepare(`INSERT INTO company_flagged_files (id, status) VALUES ('m3', 't')`)
      .run()

    const fakeUpdate = withSync(
      () => ({ id: 'm3', status: 't2', extractedText: 'unchanged' }),
      {
        table: 'company_flagged_files',
        op: 'update',
        // No captureBeforeUpdate — should emit full row, no diff.
      },
    )

    fakeUpdate()

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    // extractedText still present (no pre-state to diff against)
    expect(payloads[0]?.payload['extractedText']).toBe('unchanged')
  })
})
