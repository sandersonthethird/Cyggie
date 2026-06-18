/**
 * Phase 4 — contact privacy opt-out (is_private).
 *
 * updateContact({ isPrivate }) writes is_private, getContact reflects it, and the
 * barrel emits an outbox row carrying it (so the toggle propagates to the gateway,
 * which then withholds the contact from non-owner teammates on /sync/pull —
 * exercised in the gateway sync-pull firm-sharing test).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
const { createContact, updateContact, getContact } = await import('@cyggie/db/sqlite/repositories')

function outboxCount(): number {
  return (
    testDb.prepare(`SELECT count(*) AS n FROM outbox WHERE table_name = 'contacts'`).get() as {
      n: number
    }
  ).n
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES ('user-1','u1@example.com','U1')`)
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({ getDb: () => testDb, getUserId: () => 'user-1', getDeviceId: () => 'device-1' })
})

describe('contact is_private toggle', () => {
  it('defaults to shared (is_private false) on create', () => {
    const c = createContact({ fullName: 'Jane Investor' }, 'user-1')
    expect(getContact(c.id)?.isPrivate).toBe(false)
  })

  it('updateContact({isPrivate:true}) marks it private, persists, and emits an outbox row', () => {
    const c = createContact({ fullName: 'Jane Investor' }, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()

    updateContact(c.id, { isPrivate: true }, 'user-1')

    expect(getContact(c.id)?.isPrivate).toBe(true)
    expect(
      (testDb.prepare('SELECT is_private FROM contacts WHERE id = ?').get(c.id) as { is_private: number })
        .is_private,
    ).toBe(1)
    expect(outboxCount()).toBe(1) // propagates to the gateway
  })

  it('can be toggled back to shared', () => {
    const c = createContact({ fullName: 'Jane Investor' }, 'user-1')
    updateContact(c.id, { isPrivate: true }, 'user-1')
    updateContact(c.id, { isPrivate: false }, 'user-1')
    expect(getContact(c.id)?.isPrivate).toBe(false)
  })
})
