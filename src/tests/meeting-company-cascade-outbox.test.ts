/**
 * Regression test: companies auto-created from a meeting must emit outbox rows
 * so they reach Neon (and therefore mobile). Before the fix, `createMeeting` →
 * `syncMeetingCompanyLinks` → `createCompanyForMeeting` wrote `org_companies` /
 * `org_company_aliases` / `meeting_company_links` straight to SQLite with NO
 * outbox emission, so the company lived only on desktop.
 *
 * Harness mirrors sync-company-attribution.test.ts: full in-memory schema via
 * runAllMigrations, mocked connection, configured sync globals, barrel imports.
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
const { createMeeting } = await import('@cyggie/db/sqlite/repositories')

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

function makeMeeting(companies: string[], emails: string[]) {
  return createMeeting(
    {
      title: 'Sync sync',
      date: '2026-06-18T10:00:00.000Z',
      companies,
      attendeeEmails: emails,
    },
    'user-1',
  )
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

describe('meeting → company cascade outbox emission', () => {
  it('emits org_companies + aliases + link when a meeting creates a new company', () => {
    makeMeeting(['Superlog'], ['ceo@superlog.com'])

    const companyRows = outboxFor('org_companies')
    expect(companyRows).toHaveLength(1)
    expect(companyRows[0].op).toBe('insert')
    expect(JSON.parse(companyRows[0].payload).canonical_name).toBe('Superlog')
    // lamport must be stamped (non-zero) so the backfill sentinel stays accurate.
    expect(JSON.parse(companyRows[0].payload).lamport).not.toBe('0')

    expect(outboxFor('org_company_aliases').length).toBeGreaterThanOrEqual(1)

    const linkRows = outboxFor('meeting_company_links')
    expect(linkRows).toHaveLength(1)
    expect(linkRows[0].op).toBe('insert')

    // The wrapper still emits the primary meeting row.
    expect(outboxFor('meetings')).toHaveLength(1)
  })

  it('does not re-emit org_companies for an already-existing company', () => {
    makeMeeting(['Superlog'], ['ceo@superlog.com'])
    testDb.exec(`DELETE FROM outbox`)

    // Second meeting references the same company by name.
    makeMeeting(['Superlog'], ['cto@superlog.com'])

    // No new company insert — only the new meeting's link.
    expect(outboxFor('org_companies')).toHaveLength(0)
    expect(outboxFor('meeting_company_links')).toHaveLength(1)
  })

  it('writes SQLite but emits nothing when called without auth', () => {
    _resetSyncGlobalsForTesting()
    configureSyncGlobals({
      getDb: () => testDb,
      getUserId: () => null,
      getDeviceId: () => null,
    })

    makeMeeting(['Soxton'], ['hi@soxton.com'])

    // Company exists locally...
    const local = testDb
      .prepare(`SELECT id FROM org_companies WHERE canonical_name = 'Soxton'`)
      .get()
    expect(local).toBeTruthy()
    // ...but nothing was emitted.
    expect(testDb.prepare(`SELECT count(*) n FROM outbox`).get()).toEqual({ n: 0 })
  })
})
