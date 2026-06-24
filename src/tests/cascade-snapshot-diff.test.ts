/**
 * Unit tests for the cascade snapshot-diff engine (`runInSyncBatchWithCascade`
 * + `withCascadeUnderDeclarationGuard`) in `_sync.ts`.
 *
 * The engine declares owned-table scopes, snapshots them pre/post the inner fn,
 * diffs by primary key, and auto-emits insert/update/delete outbox rows — so a
 * raw multi-table write reaches Neon without hand-rolled `appendOutboxRow`.
 *
 * Matrix covered:
 *   insert / update / no-op / delete · whole-row vs field-LWW routing ·
 *   composite-PK move (delete-old + insert-new) · offline no-emit ·
 *   all-or-nothing rollback on mid-fn throw · dev under-declaration guard.
 *
 * Harness mirrors meeting-company-cascade-outbox.test.ts: full in-memory schema
 * via runAllMigrations, mocked connection, configured sync globals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const {
  configureSyncGlobals,
  _resetSyncGlobalsForTesting,
  runInSyncBatchWithCascade,
  withCascadeUnderDeclarationGuard,
} = await import('@cyggie/db/sqlite/repositories/_sync')

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

function insertContact(id: string, fullName: string): void {
  testDb
    .prepare(`INSERT INTO contacts (id, full_name, normalized_name) VALUES (?, ?, ?)`)
    .run(id, fullName, fullName.toLowerCase())
}
function emailScope(contactId: string) {
  return { table: 'contact_emails', where: 'contact_id = ?', params: [contactId] }
}
function contactScope(id: string) {
  return { table: 'contacts', where: 'id = ?', params: [id] }
}

function online(): void {
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run('user-1', 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  online()
})

afterEach(() => {
  _resetSyncGlobalsForTesting()
})

describe('runInSyncBatchWithCascade — whole-row (contact_emails)', () => {
  beforeEach(() => insertContact('c1', 'Cara One'))

  it('emits an insert for a new scoped row, with a non-zero stamped lamport', () => {
    runInSyncBatchWithCascade([emailScope('c1')], () => {
      testDb
        .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
        .run('c1', 'cara@x.com')
    })
    const rows = outboxFor('contact_emails')
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('insert')
    const payload = JSON.parse(rows[0].payload)
    expect(payload.contact_id).toBe('c1')
    expect(payload.email).toBe('cara@x.com')
    // local row stamped + outbox lamport match, and not the '0' backfill sentinel
    expect(rows[0].lamport).not.toBe('0')
    const local = testDb
      .prepare(`SELECT lamport FROM contact_emails WHERE contact_id = ? AND email = ?`)
      .get('c1', 'cara@x.com') as { lamport: string }
    expect(local.lamport).toBe(rows[0].lamport)
  })

  it('emits an update when a data column changes', () => {
    testDb
      .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 0)`)
      .run('c1', 'cara@x.com')
    runInSyncBatchWithCascade([emailScope('c1')], () => {
      testDb
        .prepare(`UPDATE contact_emails SET is_primary = 1 WHERE contact_id = ? AND email = ?`)
        .run('c1', 'cara@x.com')
    })
    const rows = outboxFor('contact_emails')
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('update')
    expect(JSON.parse(rows[0].payload).is_primary).toBe(1)
  })

  it('emits NOTHING for a no-op write (re-save identical values)', () => {
    testDb
      .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
      .run('c1', 'cara@x.com')
    runInSyncBatchWithCascade([emailScope('c1')], () => {
      testDb
        .prepare(`UPDATE contact_emails SET is_primary = 1 WHERE contact_id = ? AND email = ?`)
        .run('c1', 'cara@x.com')
    })
    expect(outboxFor('contact_emails')).toHaveLength(0)
  })

  it('emits a delete for a removed scoped row (payload = pre-row)', () => {
    testDb
      .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
      .run('c1', 'cara@x.com')
    runInSyncBatchWithCascade([emailScope('c1')], () => {
      testDb
        .prepare(`DELETE FROM contact_emails WHERE contact_id = ? AND email = ?`)
        .run('c1', 'cara@x.com')
    })
    const rows = outboxFor('contact_emails')
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('delete')
    expect(JSON.parse(rows[0].payload).email).toBe('cara@x.com')
  })

  it('a composite-PK move (contact_id change) surfaces as delete-old + insert-new', () => {
    insertContact('c2', 'Cara Two')
    testDb
      .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
      .run('c1', 'cara@x.com')
    runInSyncBatchWithCascade([emailScope('c1'), emailScope('c2')], () => {
      testDb
        .prepare(`UPDATE contact_emails SET contact_id = 'c2' WHERE contact_id = 'c1' AND email = ?`)
        .run('cara@x.com')
    })
    const rows = outboxFor('contact_emails')
    const ops = rows.map((r) => `${r.op}:${JSON.parse(r.payload).contact_id}`)
    expect(ops).toContain('delete:c1')
    expect(ops).toContain('insert:c2')
    expect(rows).toHaveLength(2)
  })
})

describe('runInSyncBatchWithCascade — field-LWW routing (contacts)', () => {
  beforeEach(() => insertContact('c1', 'Cara One'))

  it('field-LWW update emits a sparse field_lamports map + stamps the local row', () => {
    runInSyncBatchWithCascade([contactScope('c1')], () => {
      testDb.prepare(`UPDATE contacts SET title = 'CEO' WHERE id = ?`).run('c1')
    })
    const rows = outboxFor('contacts')
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('update')
    const payload = JSON.parse(rows[0].payload)
    // sparse map carries ONLY the changed column
    expect(payload.fieldLamports).toBeDefined()
    expect(Object.keys(payload.fieldLamports)).toEqual(['title'])
    const local = testDb.prepare(`SELECT lamport FROM contacts WHERE id = ?`).get('c1') as {
      lamport: string
    }
    expect(local.lamport).not.toBe('0')
  })
})

describe('runInSyncBatchWithCascade — safety', () => {
  it('offline (no auth) runs fn but emits nothing', () => {
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => null,
      getDeviceId: () => null,
    })
    insertContact('c1', 'Cara One')
    runInSyncBatchWithCascade([emailScope('c1')], () => {
      testDb
        .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
        .run('c1', 'cara@x.com')
    })
    expect(outboxFor('contact_emails')).toHaveLength(0)
    // the raw write still happened (offline operation works)
    expect(
      testDb.prepare(`SELECT COUNT(*) AS c FROM contact_emails`).get() as { c: number },
    ).toEqual({ c: 1 })
  })

  it('all-or-nothing: a throw mid-fn rolls back BOTH the data write and any emit', () => {
    insertContact('c1', 'Cara One')
    expect(() =>
      runInSyncBatchWithCascade([emailScope('c1')], () => {
        testDb
          .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
          .run('c1', 'cara@x.com')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(outboxFor('contact_emails')).toHaveLength(0)
    expect(
      testDb.prepare(`SELECT COUNT(*) AS c FROM contact_emails`).get() as { c: number },
    ).toEqual({ c: 0 })
  })
})

describe('withCascadeUnderDeclarationGuard (dev)', () => {
  beforeEach(() => insertContact('c1', 'Cara One'))

  it('throws when the op writes an owned table outside the declared scopes', () => {
    expect(() =>
      withCascadeUnderDeclarationGuard(['contact_emails'], [], () => {
        // writes contacts (NOT declared, NOT allow-listed) — structural change
        insertContact('c2', 'Sneaky Two')
      }),
    ).toThrow(/under-declared/)
  })

  it('does NOT throw for an allow-listed table (intentionally backfill-covered)', () => {
    expect(() =>
      withCascadeUnderDeclarationGuard(['contacts'], ['contact_emails'], () => {
        testDb
          .prepare(`INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`)
          .run('c1', 'cara@x.com')
      }),
    ).not.toThrow()
  })

  it('does NOT throw when only declared tables change', () => {
    expect(() =>
      withCascadeUnderDeclarationGuard(['contacts'], [], () => {
        insertContact('c3', 'Declared Three')
      }),
    ).not.toThrow()
  })
})
