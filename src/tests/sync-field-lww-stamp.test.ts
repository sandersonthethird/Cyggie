/**
 * Integration test for the field-LWW write stamp in `withSync` (stampFieldLww).
 * Exercises the BARREL exports (createCompany / updateCompany) against a real
 * in-memory SQLite with the full schema, asserting:
 *
 *   • insert  → outbox payload carries a `fieldLamports` map covering the
 *     inserted columns; the local row gets `lamport` + `field_lamports`.
 *   • update of ONE field → the outbox `fieldLamports` map contains the changed
 *     column and NOT unchanged ones (so the gateway only lets that column win);
 *     the local `field_lamports` is densified (unchanged columns retained).
 *
 * org_companies is the Phase 1 `fieldLww` tracer table.
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
const { createCompany, updateCompany } = await import(
  '@cyggie/db/sqlite/repositories'
)

interface OutboxRow {
  table_name: string
  op: string
  payload: string
}

function companyOutbox(): OutboxRow[] {
  return testDb
    .prepare(
      `SELECT table_name, op, payload FROM outbox WHERE table_name = 'org_companies' ORDER BY id ASC`,
    )
    .all() as OutboxRow[]
}

function localRow(id: string): { lamport: string; field_lamports: string | null } {
  return testDb
    .prepare(`SELECT lamport, field_lamports FROM org_companies WHERE id = ?`)
    .get(id) as { lamport: string; field_lamports: string | null }
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  // Attribution FKs (created_by_user_id / updated_by_user_id → users.id) need a
  // real user row.
  testDb
    .prepare(
      `INSERT INTO users (id, email, display_name) VALUES ('user-1', 'u1@example.com', 'User One')`,
    )
    .run()
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'user-1',
    getDeviceId: () => 'device-1',
  })
})

describe('field-LWW write stamp', () => {
  it('insert: outbox + local row carry field_lamports', () => {
    const company = createCompany({ canonicalName: 'Acme' }, 'user-1')

    const out = companyOutbox()
    expect(out).toHaveLength(1)
    expect(out[0]!.op).toBe('insert')
    const payload = JSON.parse(out[0]!.payload) as Record<string, unknown>
    const wireMap = payload['fieldLamports'] as Record<string, string>
    expect(wireMap).toBeTypeOf('object')
    // The inserted data columns get a clock (snake_case keys).
    expect(wireMap['canonical_name']).toBeDefined()
    // Meta/PK columns are not tracked.
    expect(wireMap['id']).toBeUndefined()
    expect(wireMap['lamport']).toBeUndefined()
    expect(wireMap['field_lamports']).toBeUndefined()

    const row = localRow(company.id)
    expect(row.lamport).not.toBe('0') // stamped (org-company repo doesn't self-stamp)
    const localMap = JSON.parse(row.field_lamports!) as Record<string, string>
    expect(localMap['canonical_name']).toBe(row.lamport)
  })

  it('update of one field: wire map is sparse, local map densified', () => {
    const company = createCompany({ canonicalName: 'Acme' }, 'user-1')
    const insertLamport = localRow(company.id).lamport

    updateCompany(company.id, { stage: 'seed' }, 'user-1')

    const out = companyOutbox()
    expect(out).toHaveLength(2)
    const updatePayload = JSON.parse(out[1]!.payload) as Record<string, unknown>
    const wireMap = updatePayload['fieldLamports'] as Record<string, string>

    // Only the changed column(s) are on the wire — NOT canonical_name.
    expect(wireMap['stage']).toBeDefined()
    expect(wireMap['canonical_name']).toBeUndefined()

    const row = localRow(company.id)
    expect(BigInt(row.lamport)).toBeGreaterThan(BigInt(insertLamport))
    const localMap = JSON.parse(row.field_lamports!) as Record<string, string>
    // Densified: stage at the new clock, canonical_name retained at the old.
    expect(localMap['stage']).toBe(row.lamport)
    expect(localMap['canonical_name']).toBe(insertLamport)
  })
})
