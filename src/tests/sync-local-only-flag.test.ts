/**
 * CYGGIE_LOCAL_ONLY — dev/test escape hatch that keeps data on the local drive.
 *
 * When the flag is set, withSync writes the row to local SQLite but emits NO
 * outbox row, so a signed-in test firm's imports can never push to Neon. When
 * unset, the normal path emits exactly one outbox row (control).
 *
 * Harness mirrors sync-whole-row-lamport-stamp.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createFolder } = await import('@cyggie/db/sqlite/repositories')

function outboxCount(table: string): number {
  return (
    testDb.prepare(`SELECT COUNT(*) c FROM outbox WHERE table_name = ?`).get(table) as { c: number }
  ).c
}

beforeEach(() => {
  delete process.env['CYGGIE_LOCAL_ONLY']
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run('user-1', 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1', // signed-in test firm
    getDeviceId: () => 'device-1',
  })
})
afterEach(() => {
  delete process.env['CYGGIE_LOCAL_ONLY']
  _resetSyncGlobalsForTesting()
})

describe('CYGGIE_LOCAL_ONLY', () => {
  it('control: a wrapped write emits one outbox row when the flag is unset', () => {
    createFolder('Wrapped')
    expect(
      testDb.prepare(`SELECT COUNT(*) c FROM note_folders WHERE path = 'Wrapped'`).get(),
    ).toEqual({ c: 1 })
    expect(outboxCount('note_folders')).toBe(1)
  })

  it('writes to local SQLite but emits NO outbox row when the flag is set', () => {
    process.env['CYGGIE_LOCAL_ONLY'] = '1'
    createFolder('LocalOnly')
    // Data lands locally...
    expect(
      testDb.prepare(`SELECT COUNT(*) c FROM note_folders WHERE path = 'LocalOnly'`).get(),
    ).toEqual({ c: 1 })
    // ...but nothing is queued for Neon.
    expect(outboxCount('note_folders')).toBe(0)
  })

  it('does not require configured sync globals (still writes locally)', () => {
    process.env['CYGGIE_LOCAL_ONLY'] = '1'
    _resetSyncGlobalsForTesting() // simulate pre-bootstrap; flag short-circuits before the configured check
    expect(() => createFolder('NoGlobals')).not.toThrow()
    expect(
      testDb.prepare(`SELECT COUNT(*) c FROM note_folders WHERE path = 'NoGlobals'`).get(),
    ).toEqual({ c: 1 })
    expect(outboxCount('note_folders')).toBe(0)
  })
})
