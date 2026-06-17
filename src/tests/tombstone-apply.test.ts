/**
 * Phase 3 — desktop tombstone apply (hard-purge replication).
 *
 * applyRemoteTombstones hard-deletes a purged company/task locally. ENTITY-ONLY:
 * a company purge preserves active linked tasks (their company_id → NULL), not
 * destroys them. A recorded tombstone gates a same-pull / later re-create via the
 * upsert resurrection guard.
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
const { applyRemoteTombstones, applyRemoteOrgCompanies, applyRemoteTasks } = await import(
  '@main/services/sync-remote-apply'
)

function bare(table: string, id: string): Record<string, unknown> | undefined {
  return testDb.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
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

describe('applyRemoteTombstones', () => {
  it('company purge hard-deletes the company but PRESERVES its task (company_id → NULL)', () => {
    const c = repo.createCompany({ canonicalName: 'Acme' }, 'user-1')
    const t = repo.createTask({ title: 'Linked task', companyId: c.id }, 'user-1')

    applyRemoteTombstones(testDb, 'device-1', 'user-1', [
      { entityType: 'company', entityId: c.id, firmId: 'firm-1', lamport: '999' },
    ])

    expect(bare('org_companies', c.id)).toBeUndefined() // company gone
    const task = bare('tasks', t.id)
    expect(task).toBeDefined() // task survives (entity-only)
    expect(task!.company_id).toBeNull() // link nulled
    // Tombstone recorded locally.
    expect(testDb.prepare(`SELECT 1 FROM tombstones WHERE entity_type='company' AND entity_id=?`).get(c.id)).toBeTruthy()
  })

  it('task purge hard-deletes the task', () => {
    const t = repo.createTask({ title: 'Doomed' }, 'user-1')
    applyRemoteTombstones(testDb, 'device-1', 'user-1', [
      { entityType: 'task', entityId: t.id, firmId: 'firm-1', lamport: '999' },
    ])
    expect(bare('tasks', t.id)).toBeUndefined()
  })

  it('resurrection guard: a pulled company/task with a local tombstone is NOT re-created', () => {
    const c = repo.createCompany({ canonicalName: 'Ghost' }, 'user-1')
    const cId = c.id
    applyRemoteTombstones(testDb, 'device-1', 'user-1', [
      { entityType: 'company', entityId: cId, firmId: 'firm-1', lamport: '999' },
    ])
    expect(bare('org_companies', cId)).toBeUndefined()

    // A stale company update for the purged id arrives in a later pull → dropped.
    applyRemoteOrgCompanies(testDb, 'device-1', 'user-1', [
      {
        id: cId, userId: 'user-1', canonicalName: 'Ghost', normalizedName: 'ghost-' + cId,
        status: 'active', entityType: 'unknown', includeInCompaniesView: 0, classificationSource: 'auto',
        createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
        lamport: '99999999999999', fieldLamports: { canonical_name: '99999999999999' },
      } as never,
    ])
    expect(bare('org_companies', cId)).toBeUndefined() // still gone — not resurrected

    // Same for a purged task.
    const t = repo.createTask({ title: 'GhostTask' }, 'user-1')
    const tId = t.id
    applyRemoteTombstones(testDb, 'device-1', 'user-1', [
      { entityType: 'task', entityId: tId, firmId: 'firm-1', lamport: '1000' },
    ])
    applyRemoteTasks(testDb, 'device-1', 'user-1', [
      {
        id: tId, userId: 'user-1', title: 'GhostTask', description: null, meetingId: null,
        companyId: null, contactId: null, status: 'open', category: 'action_item', priority: null,
        assignee: null, dueDate: null, source: 'manual', sourceSection: null, extractionHash: null,
        deletedAt: null, deletedByUserId: null, createdByUserId: null, updatedByUserId: null,
        createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
        lamport: '99999999999999', fieldLamports: { title: '99999999999999' },
      } as never,
    ])
    expect(bare('tasks', tId)).toBeUndefined()
  })
})
