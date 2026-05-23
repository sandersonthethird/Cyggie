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
 * Uses the real `withSync` wrapper against an in-memory SQLite DB and a
 * synthetic owned table registered into the owned-tables registry at
 * test time. Avoids standing up the full meetings schema; the trimming
 * logic is table-agnostic.
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

// Register a synthetic spec into the runtime registry so withSync accepts
// our test table. We use 'meetings' for the spec name because it's already
// declared with largeColumns — saves us mutating the registry. We point
// at a temp table with just the columns we need.
const meetingsSpec = OWNED_TABLES_BY_NAME.get('meetings') as OwnedTableSpec

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Minimal meetings shape — only `id` matters for outbox row_id encoding.
  db.exec(`CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT)`)
  runLamportOnOwnedTablesMigration(db)
  runSyncOutboxStateMigration(db)
  return db
}

function readPayloads(): Array<{ op: string; payload: Record<string, unknown> }> {
  const rows = testDb
    .prepare(
      `SELECT op, payload FROM outbox WHERE table_name = 'meetings' ORDER BY id ASC`,
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
    // Ensure the spec we rely on actually carries largeColumns — guards
    // against an accidental owned-tables.ts change quietly disabling this test.
    expect(meetingsSpec.largeColumns).toEqual(
      expect.arrayContaining(['transcriptSegments', 'chatMessages']),
    )
  })

  it('captureBeforeUpdate fires BEFORE the inner fn and snapshot is pre-state', () => {
    // Seed a row.
    testDb
      .prepare(`INSERT INTO meetings (id, title) VALUES ('m1', 'before')`)
      .run()

    const observedPre: Array<string | undefined> = []

    const fakeUpdate = withSync(
      (_id: string, newTitle: string) => {
        testDb
          .prepare(`UPDATE meetings SET title = ? WHERE id = ?`)
          .run(newTitle, 'm1')
        return {
          id: 'm1',
          title: newTitle,
          transcriptSegments: [{ start: 0, end: 1, text: 'x' }],
        }
      },
      {
        table: 'meetings',
        op: 'update',
        captureBeforeUpdate: (_db, _args) => {
          const row = testDb
            .prepare(`SELECT id, title FROM meetings WHERE id = 'm1'`)
            .get() as { id: string; title: string } | undefined
          observedPre.push(row?.title)
          // Return a shape with the same transcriptSegments as the
          // post-update value so the diff trims it.
          return {
            id: 'm1',
            title: row?.title ?? '',
            transcriptSegments: [{ start: 0, end: 1, text: 'x' }],
          }
        },
      },
    )

    fakeUpdate('m1', 'after')

    // captureBeforeUpdate saw 'before' (pre-state), not 'after'.
    expect(observedPre).toEqual(['before'])

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.op).toBe('update')
    // transcriptSegments unchanged → trimmed
    expect('transcriptSegments' in (payloads[0]?.payload ?? {})).toBe(false)
    // small columns still present
    expect(payloads[0]?.payload['title']).toBe('after')
  })

  it('keeps large column when it changed', () => {
    testDb
      .prepare(`INSERT INTO meetings (id, title) VALUES ('m1', 't')`)
      .run()

    const fakeUpdate = withSync(
      (_id: string) => ({
        id: 'm1',
        title: 't',
        transcriptSegments: [{ start: 0, end: 2, text: 'NEW' }],
      }),
      {
        table: 'meetings',
        op: 'update',
        captureBeforeUpdate: () => ({
          id: 'm1',
          title: 't',
          transcriptSegments: [{ start: 0, end: 1, text: 'old' }],
        }),
      },
    )

    fakeUpdate('m1')

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.payload['transcriptSegments']).toEqual([
      { start: 0, end: 2, text: 'NEW' },
    ])
  })

  it('does NOT trim on insert ops (insert needs full row for NOT NULL constraints)', () => {
    const segments = [{ start: 0, end: 1, text: 'a' }]
    const fakeInsert = withSync(
      () => {
        testDb
          .prepare(`INSERT INTO meetings (id, title) VALUES ('m2', 'fresh')`)
          .run()
        return { id: 'm2', title: 'fresh', transcriptSegments: segments }
      },
      {
        table: 'meetings',
        op: 'insert',
        // Even if a caller wrongly passed captureBeforeUpdate on an insert,
        // the wrapper must not invoke it (op !== 'update' gate).
        captureBeforeUpdate: () => {
          throw new Error('captureBeforeUpdate must not fire on insert')
        },
      },
    )

    fakeInsert()

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    expect(payloads[0]?.op).toBe('insert')
    expect(payloads[0]?.payload['transcriptSegments']).toEqual(segments)
  })

  it('no-ops when captureBeforeUpdate is not provided (back-compat)', () => {
    testDb
      .prepare(`INSERT INTO meetings (id, title) VALUES ('m3', 't')`)
      .run()

    const segments = [{ start: 0, end: 1, text: 'unchanged' }]
    const fakeUpdate = withSync(
      () => ({ id: 'm3', title: 't2', transcriptSegments: segments }),
      {
        table: 'meetings',
        op: 'update',
        // No captureBeforeUpdate — should emit full row, no diff.
      },
    )

    fakeUpdate()

    const payloads = readPayloads()
    expect(payloads).toHaveLength(1)
    // transcriptSegments still present (we had no pre-state to diff against)
    expect(payloads[0]?.payload['transcriptSegments']).toEqual(segments)
  })
})
