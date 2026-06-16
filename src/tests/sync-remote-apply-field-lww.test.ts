/**
 * Desktop pull-apply field-LWW merge (sync-remote-apply.ts, org_companies).
 * The gateway already merges authoritatively on push; this protects UN-PUSHED
 * LOCAL edits when an incoming pulled row touched DIFFERENT columns:
 *
 *   • insert (row absent locally) → whole incoming row written.
 *   • update → only the columns the incoming write wins (incoming per-column
 *     clock > local) are applied; a column the local device edited more
 *     recently (higher local clock) is preserved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'
import type { PulledOrgCompanyRow } from '@main/services/sync-remote-apply'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createCompany, updateCompany } = await import('@cyggie/db/sqlite/repositories')
const { applyRemoteOrgCompanies } = await import('@main/services/sync-remote-apply')

function localRow(id: string): Record<string, unknown> {
  return testDb.prepare('SELECT * FROM org_companies WHERE id = ?').get(id) as Record<
    string,
    unknown
  >
}

function incoming(over: Partial<PulledOrgCompanyRow> & { id: string; lamport: string }): PulledOrgCompanyRow {
  return {
    userId: 'user-1',
    canonicalName: 'Remote',
    normalizedName: 'remote-' + over.id,
    status: 'active',
    entityType: 'unknown',
    includeInCompaniesView: 0,
    classificationSource: 'auto',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  } as PulledOrgCompanyRow
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
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

describe('pull-apply field-LWW (org_companies)', () => {
  it('inserts an absent row with field_lamports', () => {
    const id = 'co-insert'
    applyRemoteOrgCompanies(testDb, 'device-1', 'user-1', [
      incoming({ id, canonicalName: 'Acme', lamport: '500', fieldLamports: { canonical_name: '500' } }),
    ])
    const row = localRow(id)
    expect(row.canonical_name).toBe('Acme')
    expect(row.lamport).toBe('500')
    expect(JSON.parse(row.field_lamports as string).canonical_name).toBe('500')
  })

  it('protects an un-pushed local edit when the incoming row changed a DIFFERENT column', () => {
    // 1. Local create, then a local city edit (un-pushed) → city gets a fresh,
    //    high local clock.
    const company = createCompany({ canonicalName: 'Acme', city: 'LocalCity' }, 'user-1')
    updateCompany(company.id, { city: 'LocalCity-edited' }, 'user-1')
    const localCityClock = JSON.parse(localRow(company.id).field_lamports as string).city as string

    // 2. A teammate's pulled row changed canonical_name (high clock) but carries
    //    a STALE city at a LOW clock (server hadn't seen our city edit).
    applyRemoteOrgCompanies(testDb, 'device-1', 'user-1', [
      incoming({
        id: company.id,
        canonicalName: 'TeammateName',
        city: 'StaleRemoteCity',
        normalizedName: 'acme-' + company.id,
        lamport: '9999999999999999',
        fieldLamports: { canonical_name: '9999999999999999', city: '1' },
      }),
    ])

    const row = localRow(company.id)
    expect(row.canonical_name).toBe('TeammateName') // incoming won this column
    expect(row.city).toBe('LocalCity-edited') // un-pushed local edit PRESERVED
    // Merged map keeps the higher clock per column.
    const merged = JSON.parse(row.field_lamports as string)
    expect(merged.canonical_name).toBe('9999999999999999')
    expect(merged.city).toBe(localCityClock)
  })

  it('same-column race: higher incoming clock wins', () => {
    const company = createCompany({ canonicalName: 'Acme' }, 'user-1')
    applyRemoteOrgCompanies(testDb, 'device-1', 'user-1', [
      incoming({
        id: company.id,
        canonicalName: 'Newer',
        normalizedName: 'acme-' + company.id,
        lamport: '9999999999999999',
        fieldLamports: { canonical_name: '9999999999999999' },
      }),
    ])
    expect(localRow(company.id).canonical_name).toBe('Newer')
  })
})
