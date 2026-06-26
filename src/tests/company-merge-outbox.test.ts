/**
 * T42 — `mergeCompanies` must be fully sync-aware.
 *
 * Before this, the merge ran ~25 writes across 9 owned tables in a plain
 * transaction with ZERO outbox emission, so the source-company delete + every
 * relink stranded on desktop and the merge silently un-did itself on other
 * devices. Now the whole merge runs inside the declared-scope snapshot-diff
 * engine (`runInSyncBatchWithCascade`) under the dev under-declaration guard.
 *
 * This asserts the outbox after a merge of a richly-populated source:
 *
 *   org_companies      delete(source) + field-LWW update(target, lead-inv backref)
 *   meeting/email_company_links   delete(source PK) + insert(target PK)
 *   org_company_aliases  insert(name/domain copies, NO same_as) + delete(source)
 *   contacts             field-LWW update (primary_company_id → target)
 *   notes / investment_memos   update (company_id → target)
 *   company_investors    re-homed insert
 *   meetings             field-LWW update (companies JSON cache)
 *   tasks                NONE (company_id SET NULL on source delete is a pure
 *                        UPDATE — undeclared, not emitted; the count-based guard
 *                        doesn't flag it; remote re-runs SET NULL on the delete)
 *
 * Boundaries: full runAllMigrations schema + foreign_keys=ON (so the source
 * delete's CASCADE/SET NULL FKs actually fire) + configured sync globals +
 * barrel imports. Both wrappers no-op without auth.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting, runInSyncBatchWithCascade } =
  await import('@cyggie/db/sqlite/repositories/_sync')
const { createCompany, addSameAsAlias, mergeCompanies } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  op: 'insert' | 'update' | 'delete'
  payload: string
}

function outboxFor(table: string): OutboxRow[] {
  return testDb
    .prepare(`SELECT table_name, op, payload FROM outbox WHERE table_name = ? ORDER BY id ASC`)
    .all(table) as OutboxRow[]
}
const payloads = (rows: OutboxRow[]) => rows.map((r) => JSON.parse(r.payload))

function mkCompany(name: string, domain?: string): string {
  return createCompany({ canonicalName: name, ...(domain ? { primaryDomain: domain } : {}) }, 'user-1').id
}

/** target T, source S (rich), other (lead-investor backref + investor), inv. */
function seedMergePair() {
  const T = mkCompany('BigCo', 'bigco.com')
  const S = mkCompany('BigCorp', 'bigcorp.com')
  const other = mkCompany('Other Holdings')
  const inv = mkCompany('Sequoia')

  // other points at S as its lead investor → merge flips it to T (field-LWW update)
  testDb.prepare(`UPDATE org_companies SET lead_investor_company_id = ? WHERE id = ?`).run(S, other)

  // a meeting linked to S whose JSON cache names the source
  testDb.prepare(`INSERT INTO meetings (id, title, date, companies) VALUES (?, ?, ?, ?)`)
    .run('mtg-1', 'Pitch', '2026-06-18T10:00:00.000Z', JSON.stringify(['BigCorp']))
  testDb.prepare(`INSERT INTO meeting_company_links (meeting_id, company_id) VALUES (?, ?)`)
    .run('mtg-1', S)

  // (email_company_links is mechanically identical to meeting_company_links —
  // same composite-PK whole-row table, same `company_id IN (s,t)` scope, same
  // delete+insert relink — so meeting_company_links below covers that path
  // without dragging in the email_messages → accounts FK chain.)

  // a contact whose primary company is S
  testDb.prepare(`INSERT INTO contacts (id, full_name, normalized_name, primary_company_id) VALUES (?, ?, ?, ?)`)
    .run('con-1', 'Jane Doe', 'jane doe', S)

  // a note + a memo on S
  testDb.prepare(`INSERT INTO notes (id, company_id, content) VALUES (?, ?, ?)`)
    .run('note-1', S, 'diligence note')
  testDb.prepare(`INSERT INTO investment_memos (id, company_id, title) VALUES (?, ?, ?)`)
    .run('memo-1', S, 'IC memo')

  // company_investors: S invests in `inv` → re-homed to T
  testDb.prepare(`INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`)
    .run('ci-1', S, inv, 'vc')

  // a same_as link (S ↔ other) — must NOT be copied onto T during the merge
  addSameAsAlias(S, other)

  // a task on S — tasks.company_id is ON DELETE SET NULL, so deleting S nulls it
  // (a pure UPDATE, not a row-count change). It's an owned table NOT in the
  // declared scopes; the test passing proves the count-based guard doesn't
  // false-positive on it, and it's correctly NOT emitted (remote re-runs SET
  // NULL when it applies the org_companies delete).
  testDb.prepare(`INSERT INTO tasks (id, title, company_id) VALUES (?, ?, ?)`)
    .run('task-1', 'Follow up', S)

  return { T, S, other, inv }
}

beforeEach(() => {
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  runAllMigrations(testDb)
  testDb.prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run('user-1', 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
})

describe('mergeCompanies — cascade outbox emission (T42)', () => {
  it('emits the source delete + every relinked owned-table mutation', () => {
    const { T, S, other } = seedMergePair()
    testDb.exec(`DELETE FROM outbox`) // drop all the setup emissions

    mergeCompanies(T, S) // must not throw — the dev under-declaration guard is active

    // org_companies: source delete + lead-investor backref update
    const orgRows = outboxFor('org_companies')
    expect(orgRows.some((r) => r.op === 'delete' && JSON.parse(r.payload).id === S)).toBe(true)
    const otherUpdate = payloads(orgRows.filter((r) => r.op === 'update')).find((p) => p.id === other)
    expect(otherUpdate?.lead_investor_company_id).toBe(T)

    // link table: composite PK ⇒ delete(source) + insert(target)
    const linkRows = outboxFor('meeting_company_links')
    expect(linkRows.some((r) => r.op === 'delete' && JSON.parse(r.payload).company_id === S)).toBe(true)
    expect(linkRows.some((r) => r.op === 'insert' && JSON.parse(r.payload).company_id === T)).toBe(true)

    // aliases: name/domain copied to target, NO same_as copied; source rows deleted
    const aliasRows = outboxFor('org_company_aliases')
    const aliasInserts = payloads(aliasRows.filter((r) => r.op === 'insert'))
    expect(aliasInserts.length).toBeGreaterThan(0)
    expect(aliasInserts.every((p) => p.alias_type !== 'same_as')).toBe(true)
    expect(aliasInserts.every((p) => p.company_id === T)).toBe(true)
    expect(aliasRows.some((r) => r.op === 'delete')).toBe(true)

    // field-LWW contacts move
    const contactUpd = payloads(outboxFor('contacts')).find((p) => p.id === 'con-1')
    expect(contactUpd?.primary_company_id).toBe(T)

    // whole-row company_id flips
    expect(payloads(outboxFor('notes')).find((p) => p.id === 'note-1')?.company_id).toBe(T)
    expect(payloads(outboxFor('investment_memos')).find((p) => p.id === 'memo-1')?.company_id).toBe(T)

    // re-homed investor link
    expect(outboxFor('company_investors').some((r) => r.op === 'insert' && JSON.parse(r.payload).company_id === T)).toBe(true)

    // meetings JSON cache (field-LWW) updated for the linked meeting
    expect(outboxFor('meetings').some((r) => r.op === 'update' && JSON.parse(r.payload).id === 'mtg-1')).toBe(true)

    // tasks.company_id SET NULL on source delete: a pure UPDATE, NOT emitted
    // (undeclared owned table), and the count-based guard didn't false-positive.
    expect(outboxFor('tasks')).toHaveLength(0)
    expect(testDb.prepare(`SELECT company_id FROM tasks WHERE id = 'task-1'`).get())
      .toEqual({ company_id: null })
  })

  it('writes locally but emits nothing when called without auth (offline fallback)', () => {
    const { T, S } = seedMergePair()
    testDb.exec(`DELETE FROM outbox`)
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({ getDb: () => testDb, getUserId: () => null, getDeviceId: () => null })

    mergeCompanies(T, S)

    // merge happened locally (source gone)...
    expect(testDb.prepare(`SELECT 1 FROM org_companies WHERE id = ?`).get(S)).toBeUndefined()
    // ...but nothing was emitted.
    expect(testDb.prepare(`SELECT count(*) AS n FROM outbox`).get()).toEqual({ n: 0 })
  })

  // Mirrors the IPC handler's post-merge name-based meetings-JSON rewrite: the
  // same engine + scope shape, proving that wrap emits a field-LWW meetings
  // update for a meeting that mentions the source only by name.
  it('the IPC-style name-mention meetings rewrite emits a meetings update', () => {
    mkCompany('Acme', 'acme.com')
    testDb.prepare(`INSERT INTO meetings (id, title, date, companies) VALUES (?, ?, ?, ?)`)
      .run('mtg-name', 'Sync', '2026-06-18T10:00:00.000Z', JSON.stringify(['Acme']))
    testDb.exec(`DELETE FROM outbox`)

    runInSyncBatchWithCascade(
      [{ table: 'meetings', where: 'companies LIKE ?', params: ['%Acme%'] }],
      () => {
        testDb.prepare(`UPDATE meetings SET companies = REPLACE(companies, ?, ?) WHERE companies LIKE ?`)
          .run('Acme', 'AcmeCo', '%Acme%')
      },
    )

    const rows = outboxFor('meetings')
    expect(rows.some((r) => r.op === 'update' && JSON.parse(r.payload).id === 'mtg-name')).toBe(true)
  })
})
