/**
 * Bugfix — "Edited by X just now" on mere view. updateCompany must be
 * change-aware: re-saving current values (a no-op) must NOT bump updated_at /
 * updated_by_user_id (Fix 1) and must NOT emit an outbox row / bump lamport
 * (Fix 2). A genuine change must still write + emit (the dangerous
 * false-positive guard — never silently drop a real edit).
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
const { createCompany, updateCompany } = await import('@cyggie/db/sqlite/repositories')

const OLD = '2020-01-01 00:00:00'

function row(id: string): { updated_at: string; city: string | null; arr: number | null } {
  return testDb
    .prepare('SELECT updated_at, city, arr FROM org_companies WHERE id = ?')
    .get(id) as { updated_at: string; city: string | null; arr: number | null }
}
function outboxCount(): number {
  return (
    testDb.prepare(`SELECT count(*) AS n FROM outbox WHERE table_name = 'org_companies'`).get() as {
      n: number
    }
  ).n
}
/** Reset updated_at to a known-old value + clear the outbox so the next call is observable. */
function arm(id: string): void {
  testDb.prepare(`UPDATE org_companies SET updated_at = ? WHERE id = ?`).run(OLD, id)
  testDb.prepare(`DELETE FROM outbox`).run()
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES ('user-1', 'u1@example.com', 'User One')`)
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
})

describe('updateCompany no-op safety', () => {
  it('no-op (re-send current values): no updated_at bump, no outbox row', () => {
    const c = createCompany({ canonicalName: 'Acme', city: 'SF' }, 'user-1')
    arm(c.id)

    updateCompany(c.id, { city: 'SF' }, 'user-1') // unchanged

    const r = row(c.id)
    expect(r.city).toBe('SF')
    expect(r.updated_at).toBe(OLD) // Fix 1 — not bumped
    expect(outboxCount()).toBe(0) // Fix 2 — no emission
  })

  it('real change still writes + emits (false-positive / dropped-edit guard)', () => {
    const c = createCompany({ canonicalName: 'Acme', city: 'SF' }, 'user-1')
    arm(c.id)

    updateCompany(c.id, { city: 'NYC' }, 'user-1')

    const r = row(c.id)
    expect(r.city).toBe('NYC')
    expect(r.updated_at).not.toBe(OLD) // bumped to now()
    expect(outboxCount()).toBe(1) // emitted
  })

  it('per-type: a numeric field re-sent unchanged is a no-op, changed is written', () => {
    const c = createCompany({ canonicalName: 'Acme' }, 'user-1')
    updateCompany(c.id, { arr: 5 }, 'user-1') // establish arr=5
    expect(row(c.id).arr).toBe(5)

    arm(c.id)
    updateCompany(c.id, { arr: 5 }, 'user-1') // same number → no-op
    expect(row(c.id).updated_at).toBe(OLD)
    expect(outboxCount()).toBe(0)

    arm(c.id)
    updateCompany(c.id, { arr: 9 }, 'user-1') // changed
    expect(row(c.id).arr).toBe(9)
    expect(row(c.id).updated_at).not.toBe(OLD)
    expect(outboxCount()).toBe(1)
  })

  it('mixed payload: one changed + several unchanged still writes (only the real change)', () => {
    const c = createCompany({ canonicalName: 'Acme', city: 'SF' }, 'user-1')
    arm(c.id)
    updateCompany(c.id, { city: 'SF', canonicalName: 'Acme', stage: 'Seed' }, 'user-1')
    const r = row(c.id)
    expect(r.updated_at).not.toBe(OLD) // stage changed → write happened
    expect(outboxCount()).toBe(1)
  })
})
