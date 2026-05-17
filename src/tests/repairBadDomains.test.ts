/**
 * Regression tests for malformed primary_domain values like "www" — the user
 * has reported this bug at least twice. Two surfaces under test:
 *
 *   1. Migration 084 sweeps existing rows: bad primary_domain → derived from
 *      website_url (or NULLed if website_url is also unusable).
 *   2. updateCompany re-derives primary_domain when the existing value is
 *      malformed (no dot) — so the user's record self-heals on the next save
 *      without manual intervention.
 *
 * Schema setup is intentionally minimal — these tests only need the columns
 * touched by migration 084 and the auto-derive guard. They avoid the full
 * `getCompany` JOIN graph (whose schema would be a separate maintenance burden).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { runRepairBadPrimaryDomainsMigration } = await import('@cyggie/db/sqlite/migrations/084-repair-bad-primary-domains')

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  // Minimal columns covering: migration 084's WHERE/UPDATE, and updateCompany's
  // primary_domain auto-derive guard. No JOINs so we can avoid 70+ columns.
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL DEFAULT '',
      normalized_name TEXT NOT NULL DEFAULT '',
      primary_domain TEXT,
      website_url TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(company_id, alias_type, alias_value)
    );
  `)
  return db
}

function insertCompany(db: Database.Database, opts: {
  id: string
  primaryDomain?: string | null
  websiteUrl?: string | null
}) {
  db.prepare(
    `INSERT INTO org_companies (id, canonical_name, primary_domain, website_url)
     VALUES (?, ?, ?, ?)`
  ).run(opts.id, `Co ${opts.id}`, opts.primaryDomain ?? null, opts.websiteUrl ?? null)
}

function getDomain(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT primary_domain FROM org_companies WHERE id = ?').get(id) as
    | { primary_domain: string | null }
    | undefined
  return row?.primary_domain ?? null
}

beforeEach(() => {
  testDb = makeDb()
})

describe('migration 084 — repair malformed primary_domain', () => {
  it('repairs bad primary_domain ("www") by deriving from website_url', () => {
    insertCompany(testDb, { id: 'co1', primaryDomain: 'www', websiteUrl: 'https://www.lererhippeau.com' })
    insertCompany(testDb, { id: 'co2', primaryDomain: 'valid.com', websiteUrl: 'https://valid.com' })

    runRepairBadPrimaryDomainsMigration(testDb)

    expect(getDomain(testDb, 'co1')).toBe('lererhippeau.com')
    expect(getDomain(testDb, 'co2')).toBe('valid.com') // untouched
  })

  it('NULLs primary_domain when website_url is also unusable', () => {
    insertCompany(testDb, { id: 'co1', primaryDomain: 'www', websiteUrl: 'www' })
    insertCompany(testDb, { id: 'co2', primaryDomain: 'abc', websiteUrl: null })

    runRepairBadPrimaryDomainsMigration(testDb)

    expect(getDomain(testDb, 'co1')).toBeNull()
    expect(getDomain(testDb, 'co2')).toBeNull()
  })

  it('handles the user\'s exact reproducer (primary_domain = "www", real URL in website_url)', () => {
    insertCompany(testDb, {
      id: 'lererhippeau',
      primaryDomain: 'www',
      websiteUrl: 'https://www.lererhippeau.com'
    })

    runRepairBadPrimaryDomainsMigration(testDb)

    expect(getDomain(testDb, 'lererhippeau')).toBe('lererhippeau.com')
  })

  it('is idempotent — second run is a no-op', () => {
    insertCompany(testDb, { id: 'co1', primaryDomain: 'www', websiteUrl: 'https://valid.com' })

    runRepairBadPrimaryDomainsMigration(testDb)
    expect(getDomain(testDb, 'co1')).toBe('valid.com')

    // Capture updated_at, run again, confirm no change
    const beforeSecondRun = testDb.prepare('SELECT updated_at FROM org_companies WHERE id = ?').get('co1') as { updated_at: string }
    runRepairBadPrimaryDomainsMigration(testDb)
    const afterSecondRun = testDb.prepare('SELECT updated_at FROM org_companies WHERE id = ?').get('co1') as { updated_at: string }
    expect(afterSecondRun.updated_at).toBe(beforeSecondRun.updated_at)
  })

  it('does not touch rows with valid (dot-containing) primary_domain', () => {
    insertCompany(testDb, { id: 'co1', primaryDomain: 'lererhippeau.com', websiteUrl: 'https://different.com' })

    runRepairBadPrimaryDomainsMigration(testDb)

    expect(getDomain(testDb, 'co1')).toBe('lererhippeau.com')
  })
})

describe('updateCompany — re-derive primary_domain when existing value is malformed', () => {
  // updateCompany's auto-derive guard reads primary_domain via a focused 1-column
  // SELECT, then issues a focused UPDATE — neither path needs the full schema.
  // The function ALSO calls getCompany() at the end to return CompanyDetail; that
  // call will fail on our minimal schema, so we run updateCompany inside try/catch
  // and verify the DB state directly. The UPDATE happens before the failing
  // SELECT, so the assertion is meaningful.

  it('re-derives primary_domain when current value is "www" (no dot)', async () => {
    const { updateCompany } = await import('@cyggie/db/sqlite/repositories/org-company.repo')
    insertCompany(testDb, { id: 'co1', primaryDomain: 'www', websiteUrl: null })

    try { updateCompany('co1', { websiteUrl: 'https://www.lererhippeau.com' }) } catch { /* getCompany may fail on minimal schema */ }

    expect(getDomain(testDb, 'co1')).toBe('lererhippeau.com')
  })

  it('does NOT re-derive when current primary_domain is a valid (dot-containing) domain', async () => {
    const { updateCompany } = await import('@cyggie/db/sqlite/repositories/org-company.repo')
    insertCompany(testDb, { id: 'co1', primaryDomain: 'manuallyset.com', websiteUrl: null })

    try { updateCompany('co1', { websiteUrl: 'https://otherdomain.com' }) } catch { /* getCompany may fail on minimal schema */ }

    expect(getDomain(testDb, 'co1')).toBe('manuallyset.com')
  })

  it('derives primary_domain when it was previously empty (regression for migration 074\'s scope)', async () => {
    const { updateCompany } = await import('@cyggie/db/sqlite/repositories/org-company.repo')
    insertCompany(testDb, { id: 'co1', primaryDomain: null, websiteUrl: null })

    try { updateCompany('co1', { websiteUrl: 'https://lererhippeau.com' }) } catch { /* getCompany may fail on minimal schema */ }

    expect(getDomain(testDb, 'co1')).toBe('lererhippeau.com')
  })
})
