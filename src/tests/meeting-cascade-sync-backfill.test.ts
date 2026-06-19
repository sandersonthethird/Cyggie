/**
 * Backfill test: rows auto-created from meetings before the cascade-emit fix
 * shipped sit in SQLite at lamport='0' (never emitted). The launch backfill
 * enqueues one outbox insert per such row (parents before children) and bumps
 * its lamport, so the SyncAgent pushes them to Neon. Idempotent: a second run
 * enqueues nothing; rows already at a non-zero lamport are skipped.
 *
 * Modeled on memo-sync-backfill.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { backfillMeetingCascadeForSync } = await import(
  '@main/services/meeting-cascade-sync-backfill.service'
)

function seedCompany(id: string, lamport = '0'): void {
  testDb
    .prepare(
      `INSERT INTO org_companies (id, canonical_name, normalized_name, status, lamport)
       VALUES (?, ?, ?, 'active', ?)`,
    )
    .run(id, `Co ${id}`, `co-${id}`, lamport)
}

function seedContact(id: string, email: string, lamport = '0'): void {
  testDb
    .prepare(
      `INSERT INTO contacts (id, full_name, normalized_name, email, lamport)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `Name ${id}`, `name-${id}`, email, lamport)
  testDb
    .prepare(
      `INSERT INTO contact_emails (contact_id, email, is_primary, lamport)
       VALUES (?, ?, 1, ?)`,
    )
    .run(id, email, lamport)
}

function outboxCount(table: string): number {
  return (
    testDb
      .prepare(`SELECT count(*) n FROM outbox WHERE table_name = ?`)
      .get(table) as { n: number }
  ).n
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb.prepare(`INSERT INTO settings (key, value) VALUES ('syncDeviceId', 'device-1')`).run()
})

describe('backfillMeetingCascadeForSync', () => {
  it('enqueues every lamport=0 company + contact row and bumps its lamport', () => {
    seedCompany('c1')
    seedCompany('c2')
    seedContact('p1', 'a@x.com')

    const res = backfillMeetingCascadeForSync('user-1')

    expect(res.enqueued['org_companies']).toBe(2)
    expect(res.enqueued['contacts']).toBe(1)
    expect(res.enqueued['contact_emails']).toBe(1)
    expect(outboxCount('org_companies')).toBe(2)
    expect(outboxCount('contacts')).toBe(1)
    expect(outboxCount('contact_emails')).toBe(1)

    // Local lamports bumped off the '0' sentinel.
    const stuck = testDb
      .prepare(`SELECT count(*) n FROM org_companies WHERE lamport = '0'`)
      .get() as { n: number }
    expect(stuck.n).toBe(0)
  })

  it('is idempotent — a second run enqueues nothing', () => {
    seedCompany('c1')
    backfillMeetingCascadeForSync('user-1')
    testDb.exec(`DELETE FROM outbox`)

    const res = backfillMeetingCascadeForSync('user-1')
    expect(res.enqueued['org_companies']).toBe(0)
    expect(outboxCount('org_companies')).toBe(0)
  })

  it('skips rows already at a non-zero lamport', () => {
    seedCompany('synced', '5')
    seedCompany('stuck', '0')

    const res = backfillMeetingCascadeForSync('user-1')

    expect(res.enqueued['org_companies']).toBe(1)
    const payloads = testDb
      .prepare(`SELECT payload FROM outbox WHERE table_name = 'org_companies'`)
      .all() as Array<{ payload: string }>
    expect(payloads.map((p) => JSON.parse(p.payload).id)).toEqual(['stuck'])
  })

  it('no-ops without a user id', () => {
    seedCompany('c1')
    const res = backfillMeetingCascadeForSync(null)
    expect(res.enqueued).toEqual({})
    expect(outboxCount('org_companies')).toBe(0)
  })
})
