/**
 * The bulk contact ops (mergeContacts / applyContactDedupDecisions /
 * enrichExistingContacts) rewire multiple owned tables. They were exported RAW
 * (no outbox emission), so their changes never reached Neon. Task 1 routes them
 * through the cascade snapshot-diff engine; this asserts they now emit the right
 * outbox rows (contacts + contact_emails depth).
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

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { mergeContacts, applyContactDedupDecisions } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  op: 'insert' | 'update' | 'delete'
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
function seedContact(id: string, fullName: string, email: string): void {
  testDb
    .prepare(`INSERT INTO contacts (id, full_name, normalized_name, email) VALUES (?, ?, ?, ?)`)
    .run(id, fullName, fullName.toLowerCase(), email)
  testDb
    .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
    .run(id, email)
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

describe('mergeContacts — cascade outbox emission', () => {
  beforeEach(() => {
    seedContact('keep', 'Pat McGovern', 'pat@bowery.com')
    seedContact('src', 'Patrick McGovern', 'patrick@bowery.com')
  })

  it('emits the kept-contact update + source-contact delete', () => {
    mergeContacts('keep', 'src', 'user-1')

    const contactRows = outboxFor('contacts')
    const byOp = (op: string) => contactRows.filter((r) => r.op === op)
    // source contact deleted
    const del = byOp('delete')
    expect(del).toHaveLength(1)
    expect(JSON.parse(del[0].payload).id).toBe('src')
    // kept contact updated (field-LWW: sparse field_lamports map present)
    const upd = byOp('update')
    expect(upd.length).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(upd[0].payload).id).toBe('keep')
    expect(JSON.parse(upd[0].payload).fieldLamports).toBeDefined()
    // all stamped non-zero
    for (const r of contactRows) expect(r.lamport).not.toBe('0')
  })

  it("re-points the source's contact_emails to the kept contact (move = delete-old + insert-new)", () => {
    mergeContacts('keep', 'src', 'user-1')

    const emailRows = outboxFor('contact_emails')
    const ops = emailRows.map((r) => `${r.op}:${JSON.parse(r.payload).contact_id}:${JSON.parse(r.payload).email}`)
    // the source email row moves from src → keep
    expect(ops).toContain('delete:src:patrick@bowery.com')
    expect(ops).toContain('insert:keep:patrick@bowery.com')
  })

  it('actually merged (source gone, both emails under keep)', () => {
    mergeContacts('keep', 'src', 'user-1')
    expect(testDb.prepare(`SELECT COUNT(*) c FROM contacts WHERE id = 'src'`).get()).toEqual({ c: 0 })
    const emails = testDb
      .prepare(`SELECT email FROM contact_emails WHERE contact_id = 'keep' ORDER BY email`)
      .all() as Array<{ email: string }>
    expect(emails.map((e) => e.email)).toEqual(['pat@bowery.com', 'patrick@bowery.com'])
  })

  // Convergence guard (4A, emission-level): the source delete must carry a
  // lamport strictly greater than the source row's pre-merge lamport, so a stale
  // inbound echo of the source (at the old lamport) loses the LWW compare in
  // applyRemoteRows and can't resurrect it. (The LWW apply itself is covered by
  // sync-remote-apply.test.ts; here we prove the emitted delete wins.)
  it('emits the source delete at a lamport above the source row pre-merge lamport', () => {
    const beforeLamport = (
      testDb.prepare(`SELECT lamport FROM contacts WHERE id = 'src'`).get() as { lamport: string }
    ).lamport
    mergeContacts('keep', 'src', 'user-1')
    const del = outboxFor('contacts').find((r) => r.op === 'delete')!
    expect(BigInt(del.lamport)).toBeGreaterThan(BigInt(beforeLamport))
  })
})

describe('applyContactDedupDecisions — cascade outbox emission', () => {
  beforeEach(() => {
    seedContact('keep', 'Pat McGovern', 'pat@bowery.com')
    seedContact('s1', 'Patrick McGovern', 'patrick@bowery.com')
    seedContact('s2', 'P. McGovern', 'pm@bowery.com')
  })

  it("'merge' action emits the kept update + both source deletes", () => {
    applyContactDedupDecisions(
      [{ groupKey: 'g', action: 'merge', keepContactId: 'keep', contactIds: ['keep', 's1', 's2'] }],
      'user-1',
    )
    const deletes = outboxFor('contacts')
      .filter((r) => r.op === 'delete')
      .map((r) => JSON.parse(r.payload).id)
      .sort()
    expect(deletes).toEqual(['s1', 's2'])
  })

  it("'delete' action emits contacts deletes (+ FK-cascaded contact_emails deletes)", () => {
    applyContactDedupDecisions(
      [{ groupKey: 'g', action: 'delete', keepContactId: 'keep', contactIds: ['keep', 's1'] }],
      'user-1',
    )
    const contactDeletes = outboxFor('contacts')
      .filter((r) => r.op === 'delete')
      .map((r) => JSON.parse(r.payload).id)
    expect(contactDeletes).toEqual(['s1'])
    // its email row (FK ON DELETE CASCADE) is emitted as a delete too
    const emailDeletes = outboxFor('contact_emails').filter((r) => r.op === 'delete')
    expect(emailDeletes.map((r) => JSON.parse(r.payload).contact_id)).toContain('s1')
  })
})
