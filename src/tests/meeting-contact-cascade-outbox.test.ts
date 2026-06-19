/**
 * Regression test: contacts auto-created from meeting attendees must emit
 * outbox rows so they reach Neon (and mobile). `syncContactsFromAttendees`
 * runs OUTSIDE the withSync wrapper, so it establishes its own context via
 * `runInSyncBatch` and emits each new `contacts` + `contact_emails` row.
 *
 * Also covers the `runInSyncBatch` primitive directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting, runInSyncBatch } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { appendOutboxRow } = await import('@cyggie/db/sqlite/sync-wrapper')
const { syncContactsFromAttendees } = await import('@cyggie/db/sqlite/repositories')

function outboxFor(table: string): Array<{ op: string; payload: string }> {
  return testDb
    .prepare(`SELECT op, payload FROM outbox WHERE table_name = ? ORDER BY id ASC`)
    .all(table) as Array<{ op: string; payload: string }>
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

describe('meeting → contact cascade outbox emission', () => {
  it('emits contacts + contact_emails for a new attendee', () => {
    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], 'user-1')

    const contacts = outboxFor('contacts')
    expect(contacts).toHaveLength(1)
    expect(contacts[0].op).toBe('insert')
    expect(JSON.parse(contacts[0].payload).lamport).not.toBe('0')

    const emails = outboxFor('contact_emails')
    expect(emails.length).toBeGreaterThanOrEqual(1)
    expect(emails[0].op).toBe('insert')
    expect(JSON.parse(emails[0].payload).email).toBe('jane@acme.com')
  })

  it('does not re-emit an already-existing contact', () => {
    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], 'user-1')
    testDb.exec(`DELETE FROM outbox`)

    syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], 'user-1')

    expect(outboxFor('contacts')).toHaveLength(0)
  })

  it('writes SQLite but emits nothing without auth', () => {
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => null,
      getDeviceId: () => null,
    })

    syncContactsFromAttendees(['Bob Roe <bob@beta.com>'], ['bob@beta.com'], 'user-1')

    expect(testDb.prepare(`SELECT id FROM contacts WHERE email = 'bob@beta.com'`).get()).toBeTruthy()
    expect(testDb.prepare(`SELECT count(*) n FROM outbox`).get()).toEqual({ n: 0 })
  })
})

describe('runInSyncBatch', () => {
  it('establishes a context so N appendOutboxRow calls succeed', () => {
    runInSyncBatch(() => {
      testDb.prepare(`INSERT INTO org_companies (id, canonical_name, normalized_name, status) VALUES ('c1','A','a','active')`).run()
      testDb.prepare(`INSERT INTO org_companies (id, canonical_name, normalized_name, status) VALUES ('c2','B','b','active')`).run()
      appendOutboxRow(testDb, { table: 'org_companies', op: 'insert', row: { id: 'c1' } })
      appendOutboxRow(testDb, { table: 'org_companies', op: 'insert', row: { id: 'c2' } })
    })
    expect(outboxFor('org_companies')).toHaveLength(2)
  })

  it('rolls back the whole batch atomically when fn throws', () => {
    expect(() =>
      runInSyncBatch(() => {
        testDb.prepare(`INSERT INTO org_companies (id, canonical_name, normalized_name, status) VALUES ('c1','A','a','active')`).run()
        appendOutboxRow(testDb, { table: 'org_companies', op: 'insert', row: { id: 'c1' } })
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(testDb.prepare(`SELECT count(*) n FROM org_companies`).get()).toEqual({ n: 0 })
    expect(testDb.prepare(`SELECT count(*) n FROM outbox`).get()).toEqual({ n: 0 })
  })

  it('runs the fn with no emission when offline (no user/device)', () => {
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => null,
      getDeviceId: () => null,
    })
    let ran = false
    runInSyncBatch(() => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(testDb.prepare(`SELECT count(*) n FROM outbox`).get()).toEqual({ n: 0 })
  })
})
