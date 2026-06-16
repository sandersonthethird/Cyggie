/**
 * Company attribution (multiplayer): getCompany resolves created/edited-by
 * names from the local users table, and the pull-apply carries the audit FKs —
 * defensively NULLing a teammate's id when that user isn't in the local
 * directory yet (so a company never FK-fails to apply).
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
const { createCompany, getCompany } = await import('@cyggie/db/sqlite/repositories')
const { upsertFirmMembers } = await import('@cyggie/db/sqlite/repositories/user.repo')
const { applyRemoteOrgCompanies } = await import('@main/services/sync-remote-apply')

function addUser(id: string, name: string): void {
  testDb
    .prepare(`INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)`)
    .run(id, `${id}@example.com`, name)
}

function incoming(over: Partial<PulledOrgCompanyRow> & { id: string; lamport: string }): PulledOrgCompanyRow {
  return {
    userId: 'me',
    canonicalName: 'Acme',
    normalizedName: 'acme-' + over.id,
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
  addUser('me', 'Sandy Cass')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => 'me',
    getDeviceId: () => 'device-1',
  })
})

describe('company attribution', () => {
  it('getCompany resolves the creator name for a locally-created company', () => {
    const company = createCompany({ canonicalName: 'Acme' }, 'me')
    const detail = getCompany(company.id)
    expect(detail?.createdByUserId).toBe('me')
    expect(detail?.createdByName).toBe('Sandy Cass')
  })

  it('pull carries a teammate id + resolves the name when the user is local', () => {
    addUser('andy', 'Andy Partner')
    applyRemoteOrgCompanies(testDb, 'device-1', 'me', [
      incoming({ id: 'co-andy', lamport: '999999999999999', createdByUserId: 'andy', updatedByUserId: 'andy' }),
    ])
    const detail = getCompany('co-andy')
    expect(detail?.createdByUserId).toBe('andy')
    expect(detail?.createdByName).toBe('Andy Partner')
  })

  it('firm-directory upsert makes a teammate name resolve for a previously-ghost company', () => {
    // Ghost company arrives before the directory has the teammate.
    applyRemoteOrgCompanies(testDb, 'device-1', 'me', [
      incoming({ id: 'co-late', lamport: '999999999999999', createdByUserId: 'late', updatedByUserId: 'late' }),
    ])
    expect(getCompany('co-late')?.createdByName).toBeNull()

    // Directory sync lands the member, then the company re-applies (higher clock).
    upsertFirmMembers([
      { id: 'late', email: 'late@example.com', displayName: 'Late Joiner', avatarUrl: null, role: 'member' },
    ])
    applyRemoteOrgCompanies(testDb, 'device-1', 'me', [
      incoming({ id: 'co-late', lamport: '9999999999999999', createdByUserId: 'late', updatedByUserId: 'late' }),
    ])
    const detail = getCompany('co-late')
    expect(detail?.createdByUserId).toBe('late')
    expect(detail?.createdByName).toBe('Late Joiner')
  })

  it('directory upsert survives an email collision with a different local id', () => {
    // 'me' already exists locally with email me@example.com (a generated id).
    // A gateway member carries the SAME email under a DIFFERENT (gateway) id.
    // upsertFirmMembers must not throw on the users.email UNIQUE constraint;
    // the member row still lands (name resolvable) so attribution works.
    expect(() =>
      upsertFirmMembers([
        { id: 'me-gateway-id', email: 'me@example.com', displayName: 'Sandy Cass', avatarUrl: null, role: 'admin' },
        { id: 'andy', email: 'andy@example.com', displayName: 'Andy Partner', avatarUrl: null, role: 'member' },
      ]),
    ).not.toThrow()

    applyRemoteOrgCompanies(testDb, 'device-1', 'me', [
      incoming({ id: 'co-x', lamport: '999999999999999', createdByUserId: 'me-gateway-id', updatedByUserId: 'andy' }),
    ])
    const detail = getCompany('co-x')
    expect(detail?.createdByName).toBe('Sandy Cass') // landed despite email clash
    expect(detail?.updatedByName).toBe('Andy Partner')
  })

  it('pull NULLs an unknown teammate id (FK-safe) and still applies the company', () => {
    applyRemoteOrgCompanies(testDb, 'device-1', 'me', [
      incoming({
        id: 'co-ghost',
        canonicalName: 'GhostCo',
        lamport: '999999999999999',
        createdByUserId: 'not-synced-yet',
        updatedByUserId: 'not-synced-yet',
      }),
    ])
    const detail = getCompany('co-ghost')
    expect(detail?.canonicalName).toBe('GhostCo') // company applied, no FK crash
    expect(detail?.createdByUserId).toBeNull() // id NULLed until directory syncs
    expect(detail?.createdByName).toBeNull()
  })
})
