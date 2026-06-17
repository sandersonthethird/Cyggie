/**
 * Phase 2 multiplayer — tasks firm-shared + field-LWW (desktop side).
 *
 * Two halves:
 *   1. BARREL EMITS OUTBOX — the sync-wrapped task writes (createTask /
 *      updateTask / bulkCreate) land an outbox row + stamp lamport/field_lamports
 *      on the local row. bulkCreate is the extraction/reconcile path (1A): its
 *      tasks must sync, not silently stay local.
 *   2. PULL-APPLY field-LWW — applyRemoteTasks merges per column (protecting an
 *      un-pushed local edit) and defensively NULLs an audit FK for a user who
 *      isn't in the local directory yet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import type { PulledTaskRow } from '@main/services/sync-remote-apply'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createTask, updateTask, bulkCreate } = await import('@cyggie/db/sqlite/repositories')
const { applyRemoteTasks } = await import('@main/services/sync-remote-apply')

function localRow(id: string): Record<string, unknown> {
  return testDb.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
}
function outboxCount(): number {
  return (
    testDb.prepare(`SELECT count(*) AS n FROM outbox WHERE table_name = 'tasks'`).get() as {
      n: number
    }
  ).n
}

function incoming(over: Partial<PulledTaskRow> & { id: string; lamport: string }): PulledTaskRow {
  return {
    userId: 'user-1',
    title: 'Remote task',
    description: null,
    meetingId: null,
    companyId: null,
    contactId: null,
    status: 'open',
    category: 'action_item',
    priority: null,
    assignee: null,
    dueDate: null,
    source: 'manual',
    sourceSection: null,
    extractionHash: null,
    deletedAt: null,
    deletedByUserId: null,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  } as PulledTaskRow
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

describe('tasks barrel — emits outbox + stamps field-LWW', () => {
  it('createTask emits one outbox row and stamps lamport + field_lamports locally', () => {
    const t = createTask({ title: 'Email founder' }, 'user-1')
    expect(outboxCount()).toBe(1)
    const row = localRow(t.id)
    expect(row.title).toBe('Email founder')
    expect(row.lamport).not.toBe('0') // stamped off '0' default
    expect(row.field_lamports).not.toBeNull()
    // The first write densifies the map across every data column.
    const map = JSON.parse(row.field_lamports as string)
    expect(map.title).toBeDefined()
    expect(map.status).toBeDefined()
  })

  it('updateTask emits on a real change (status flip)', () => {
    const t = createTask({ title: 'Review deck' }, 'user-1')
    testDb.prepare(`DELETE FROM outbox`).run()
    updateTask(t.id, { status: 'done' }, 'user-1')
    expect(localRow(t.id).status).toBe('done')
    expect(outboxCount()).toBe(1)
  })

  it('bulkCreate (the extraction/reconcile path) emits one outbox row per task', () => {
    const created = bulkCreate(
      [
        { title: 'Task A', source: 'auto' },
        { title: 'Task B', source: 'auto' },
      ],
      'user-1',
    )
    expect(created).toHaveLength(2)
    expect(outboxCount()).toBe(2)
    // Both rows carry a stamped field_lamports (they sync, not stay local).
    for (const t of created) {
      expect(localRow(t.id).field_lamports).not.toBeNull()
    }
  })
})

describe('pull-apply field-LWW (tasks)', () => {
  it('inserts an absent task with field_lamports', () => {
    const id = 'task-insert'
    applyRemoteTasks(testDb, 'device-1', 'user-1', [
      incoming({ id, title: 'Pulled', lamport: '500', fieldLamports: { title: '500' } }),
    ])
    const row = localRow(id)
    expect(row.title).toBe('Pulled')
    expect(row.lamport).toBe('500')
    expect(JSON.parse(row.field_lamports as string).title).toBe('500')
  })

  it('protects an un-pushed local edit when the incoming row changed a DIFFERENT column', () => {
    // Local create + a local priority edit (un-pushed) → priority gets a fresh,
    // high local clock.
    const t = createTask({ title: 'Acme task', priority: 'low' }, 'user-1')
    updateTask(t.id, { priority: 'high' }, 'user-1')
    const localPriorityClock = JSON.parse(localRow(t.id).field_lamports as string).priority as string

    // A teammate's pulled row changed status (high clock) but carries a STALE
    // priority at a LOW clock (server hadn't seen our priority edit).
    applyRemoteTasks(testDb, 'device-1', 'user-1', [
      incoming({
        id: t.id,
        title: 'Acme task',
        status: 'done',
        priority: 'low',
        lamport: '9999999999999999',
        fieldLamports: { status: '9999999999999999', priority: '1' },
      }),
    ])

    const row = localRow(t.id)
    expect(row.status).toBe('done') // incoming won this column
    expect(row.priority).toBe('high') // un-pushed local edit PRESERVED
    const merged = JSON.parse(row.field_lamports as string)
    expect(merged.status).toBe('9999999999999999')
    expect(merged.priority).toBe(localPriorityClock)
  })

  it('defensively NULLs an audit FK for a user not in the local directory', () => {
    const id = 'task-ghost'
    applyRemoteTasks(testDb, 'device-1', 'user-1', [
      incoming({
        id,
        title: 'From a teammate',
        createdByUserId: 'ghost-user', // not in local users table
        updatedByUserId: 'ghost-user',
        lamport: '500',
        fieldLamports: { title: '500' },
      }),
    ])
    const row = localRow(id)
    // Row applied (no FK failure) with the unknown actor NULLed.
    expect(row.title).toBe('From a teammate')
    expect(row.created_by_user_id).toBeNull()
    expect(row.updated_by_user_id).toBeNull()
  })

  it('same-column race: higher incoming clock wins', () => {
    const t = createTask({ title: 'Acme', status: 'open' }, 'user-1')
    applyRemoteTasks(testDb, 'device-1', 'user-1', [
      incoming({
        id: t.id,
        title: 'Acme',
        status: 'dismissed',
        lamport: '9999999999999999',
        fieldLamports: { status: '9999999999999999' },
      }),
    ])
    expect(localRow(t.id).status).toBe('dismissed')
  })
})
