/**
 * Phase 3 — soft-delete + recycle bin (companies + tasks).
 *
 * Soft-delete is a field-LWW UPDATE that syncs (emits an outbox row), hides the
 * row from live reads, and surfaces it in the recycle-bin list. Restore reverses
 * it. Re-deleting is a no-op. getOrCreateCompanyByName revives a trashed match
 * (SQLite normalized_name is UNIQUE, so a re-reference brings the row back).
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
const repo = await import('@cyggie/db/sqlite/repositories')

function outbox(table: string): number {
  return (
    testDb.prepare(`SELECT count(*) AS n FROM outbox WHERE table_name = ?`).get(table) as {
      n: number
    }
  ).n
}
function bare(table: string, id: string): Record<string, unknown> | undefined {
  return testDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES ('user-1','u1@example.com','User One')`)
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({ getDb: () => testDb, getUserId: () => 'user-1', getDeviceId: () => 'device-1' })
})

describe('company soft-delete / restore', () => {
  it('soft-delete hides from live reads, shows in recycle bin, emits a synced update', () => {
    const c = repo.createCompany({ canonicalName: 'Acme' }, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()

    repo.softDeleteCompany(c.id, 'user-1')

    // Hidden from live reads.
    expect(repo.getCompany(c.id)).toBeNull()
    expect(repo.listCompanies().some((x) => x.id === c.id)).toBe(false)
    // Present in the recycle bin with metadata.
    const deleted = repo.listDeletedCompanies()
    expect(deleted.map((d) => d.id)).toContain(c.id)
    const entry = deleted.find((d) => d.id === c.id)!
    expect(entry.entityType).toBe('company')
    expect(entry.deletedByName).toBe('User One')
    expect(entry.purgesAt).toBeTruthy()
    // Synced: outbox update + deleted_at stamped in field_lamports.
    expect(outbox('org_companies')).toBe(1)
    expect(bare('org_companies', c.id)!.deleted_at).not.toBeNull()
    expect(JSON.parse(bare('org_companies', c.id)!.field_lamports as string).deleted_at).toBeDefined()
  })

  it('re-deleting a trashed company is a no-op (no second outbox row)', () => {
    const c = repo.createCompany({ canonicalName: 'Acme' }, 'user-1')
    repo.softDeleteCompany(c.id, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()
    repo.softDeleteCompany(c.id, 'user-1') // already deleted
    expect(outbox('org_companies')).toBe(0)
  })

  it('restore un-hides + emits', () => {
    const c = repo.createCompany({ canonicalName: 'Acme' }, 'user-1')
    repo.softDeleteCompany(c.id, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()

    repo.restoreCompany(c.id, 'user-1')

    expect(repo.getCompany(c.id)).not.toBeNull()
    expect(repo.listDeletedCompanies().some((d) => d.id === c.id)).toBe(false)
    expect(bare('org_companies', c.id)!.deleted_at).toBeNull()
    expect(outbox('org_companies')).toBe(1)
  })

  it('getOrCreateCompanyByName revives a soft-deleted match instead of creating a dup', () => {
    const c = repo.createCompany({ canonicalName: 'Acme Inc' }, 'user-1')
    repo.softDeleteCompany(c.id, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()

    const got = repo.getOrCreateCompanyByName('Acme Inc', 'user-1')

    expect(got.id).toBe(c.id) // same row revived, not a new one
    expect(bare('org_companies', c.id)!.deleted_at).toBeNull() // un-deleted locally
    // Only one company row with that normalized_name (UNIQUE respected).
    const n = (testDb.prepare(`SELECT count(*) AS n FROM org_companies`).get() as { n: number }).n
    expect(n).toBe(1)
  })
})

describe('task soft-delete / restore', () => {
  it('soft-delete hides from live reads + summary, shows in recycle bin, emits', () => {
    const t = repo.createTask({ title: 'Do it' }, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()

    repo.softDeleteTask(t.id, 'user-1')

    expect(repo.getTask(t.id)).toBeNull()
    expect(repo.listTasks().some((x) => x.id === t.id)).toBe(false)
    expect(repo.getTaskSummaryStats().openCount).toBe(0)
    const deleted = repo.listDeletedTasks()
    expect(deleted.map((d) => d.id)).toContain(t.id)
    expect(deleted.find((d) => d.id === t.id)!.entityType).toBe('task')
    expect(outbox('tasks')).toBe(1)
    expect(JSON.parse(bare('tasks', t.id)!.field_lamports as string).deleted_at).toBeDefined()
  })

  it('restore un-hides + emits; re-delete is a no-op', () => {
    const t = repo.createTask({ title: 'Do it' }, 'user-1')
    repo.softDeleteTask(t.id, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()
    repo.softDeleteTask(t.id, 'user-1')
    expect(outbox('tasks')).toBe(0) // no-op re-delete

    repo.restoreTask(t.id, 'user-1')
    expect(repo.getTask(t.id)).not.toBeNull()
    expect(outbox('tasks')).toBe(1)
  })
})
