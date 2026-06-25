/**
 * Task 2 — whole-row-LWW local lamport stamp.
 *
 * `withSync` stamps `field_lamports`/`lamport` on the local row for field-LWW
 * tables (`stampFieldLww`), but whole-row-LWW rows used to keep `lamport='0'`
 * until a pull echo healed them — a transient flicker, and (worse) a relaunch
 * re-emit because the `lamport='0'` backfill selectors re-picked the row. Now
 * `withSync` calls `stampWholeRowLww` on every whole-row insert/update.
 *
 * Asserts:
 *   • local row lamport === the outbox lamport, and != '0', across representative
 *     PK shapes (string PK note_folders, single-PK notes, composite-PK
 *     contact_emails).
 *   • backfill-skip: a wrapped write leaves a real lamport (the `lamport='0'`
 *     selector now skips it); a raw-written '0' row is left untouched.
 *   • atomicity: a throw inside a wrapped write rolls back the row + any stamp.
 *
 * Harness mirrors meeting-company-cascade-outbox.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting, withSync } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createFolder, createNote, createContact, addContactEmail } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  op: string
  payload: string
  lamport: string
}
function outboxFor(table: string): OutboxRow[] {
  return testDb
    .prepare(
      `SELECT table_name, op, payload, lamport FROM outbox WHERE table_name = ? ORDER BY id ASC`,
    )
    .all(table) as OutboxRow[]
}
function localLamport(sql: string, ...params: unknown[]): string {
  return (testDb.prepare(sql).get(...params) as { lamport: string }).lamport
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run('user-1', 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
})
afterEach(() => _resetSyncGlobalsForTesting())

describe('withSync stamps whole-row-LWW lamport (local === outbox, != 0)', () => {
  it('note_folders (string PK)', () => {
    createFolder('Skills')
    const ob = outboxFor('note_folders')
    expect(ob).toHaveLength(1)
    expect(ob[0].lamport).not.toBe('0')
    expect(localLamport(`SELECT lamport FROM note_folders WHERE path = ?`, 'Skills')).toBe(
      ob[0].lamport,
    )
  })

  it('notes (single PK)', () => {
    const note = createNote({ content: 'hi' })!
    const ob = outboxFor('notes')
    expect(ob).toHaveLength(1)
    expect(ob[0].lamport).not.toBe('0')
    expect(localLamport(`SELECT lamport FROM notes WHERE id = ?`, note.id)).toBe(ob[0].lamport)
  })

  it('contact_emails (composite PK)', () => {
    createContact({ fullName: 'Pat M', email: 'pat@x.com' }, 'user-1')
    const detail = createContact({ fullName: 'Cara O' }, 'user-1')
    addContactEmail(detail.id, 'cara@x.com', 'user-1')
    const ob = outboxFor('contact_emails').filter((r) => JSON.parse(r.payload).email === 'cara@x.com')
    expect(ob).toHaveLength(1)
    expect(ob[0].lamport).not.toBe('0')
    expect(
      localLamport(
        `SELECT lamport FROM contact_emails WHERE contact_id = ? AND email = ?`,
        detail.id,
        'cara@x.com',
      ),
    ).toBe(ob[0].lamport)
  })
})

describe('backfill-skip: stamped rows leave the lamport=0 selector', () => {
  it('a wrapped write is invisible to WHERE lamport=0; a raw 0-row stays visible', () => {
    // raw write (no wrapper) → stays at the '0' backfill sentinel
    testDb.prepare(`INSERT INTO note_folders (path) VALUES ('Raw')`).run()
    // wrapped write → stamped to a real lamport
    createFolder('Wrapped')

    const zeros = testDb
      .prepare(`SELECT path FROM note_folders WHERE lamport = '0' ORDER BY path`)
      .all() as Array<{ path: string }>
    expect(zeros.map((z) => z.path)).toEqual(['Raw'])
  })
})

describe('atomicity: stamp + emit roll back together on throw', () => {
  it('a throw inside a wrapped whole-row insert leaves no row and no outbox', () => {
    const boom = withSync(
      (path: string) => {
        testDb.prepare(`INSERT INTO note_folders (path) VALUES (?)`).run(path)
        throw new Error('boom')
      },
      { table: 'note_folders', op: 'insert' },
    )
    expect(() => boom('Boom')).toThrow('boom')
    expect(
      testDb.prepare(`SELECT COUNT(*) c FROM note_folders WHERE path = 'Boom'`).get(),
    ).toEqual({ c: 0 })
    expect(outboxFor('note_folders')).toHaveLength(0)
  })
})
