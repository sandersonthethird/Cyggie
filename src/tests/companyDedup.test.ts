/**
 * Tests for listSuspectedDuplicateCompanies.
 * Requires better-sqlite3 (native module).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { listSuspectedDuplicateCompanies } = await import('../main/database/repositories/org-company.repo')

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL DEFAULT '',
      normalized_name TEXT NOT NULL DEFAULT '',
      primary_domain TEXT,
      website_url TEXT,
      entity_type TEXT NOT NULL DEFAULT 'startup',
      pipeline_stage TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      alias_value TEXT NOT NULL
    );
  `)
  return db
}

function insertCompany(db: Database.Database, opts: {
  id: string
  canonicalName: string
  primaryDomain?: string | null
  websiteUrl?: string | null
  updatedAt?: string
}) {
  db.prepare(`
    INSERT INTO org_companies (id, canonical_name, primary_domain, website_url, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    opts.id,
    opts.canonicalName,
    opts.primaryDomain ?? null,
    opts.websiteUrl ?? null,
    opts.updatedAt ?? '2026-01-01 00:00:00'
  )
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ── Domain match (existing behavior) ─────────────────────────────────────────

describe('listSuspectedDuplicateCompanies — domain match', () => {
  it('groups companies sharing the same domain', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Corp', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Acme Inc', primaryDomain: 'acme.com' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.companies).toHaveLength(2)
    expect(groups[0]!.confidence).toBeUndefined()
    expect(groups[0]!.domain).toBe('acme.com')
  })
})

// ── Fuzzy name match for domain-less companies ────────────────────────────────

describe('listSuspectedDuplicateCompanies — fuzzy name match', () => {
  it('groups similar company names without a domain with confidence set', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Inc' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Acme Corp' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.companies).toHaveLength(2)
    expect(group.confidence).toBeDefined()
    expect(group.confidence).toBeGreaterThanOrEqual(80)
    expect(group.domain).toBeNull()
  })

  it('does NOT group companies with dissimilar names', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Inc' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Banana Republic' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(0)
  })

  it('does NOT double-group a company already in a domain group', () => {
    // co1 and co2 share a domain → domain group
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Inc', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Acme Corp', primaryDomain: 'acme.com' })
    // co3 has similar name but no domain
    insertCompany(testDb, { id: 'co3', canonicalName: 'Acme Ltd' })

    const groups = listSuspectedDuplicateCompanies()
    // co1+co2 in domain group; co3 alone (no pair for fuzzy)
    const domainGroup = groups.find((g) => g.domain === 'acme.com')
    expect(domainGroup).toBeDefined()
    expect(domainGroup!.companies.map((c) => c.id)).not.toContain('co3')

    // co3 has no fuzzy partner → no fuzzy group
    const fuzzyGroups = groups.filter((g) => g.confidence != null)
    expect(fuzzyGroups).toHaveLength(0)
  })
})
