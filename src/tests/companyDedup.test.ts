/**
 * Tests for listSuspectedDuplicateCompanies.
 * Requires better-sqlite3 (native module).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { listSuspectedDuplicateCompanies } = await import('@cyggie/db/sqlite/repositories/org-company.repo')

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
      description TEXT,
      city TEXT,
      state TEXT,
      stage TEXT,
      founding_year INTEGER,
      employee_count_range TEXT,
      linkedin_company_url TEXT,
      twitter_handle TEXT,
      crunchbase_url TEXT,
      sector TEXT,
      target_customer TEXT,
      business_model TEXT,
      product_stage TEXT,
      revenue_model TEXT,
      lead_investor TEXT,
      co_investors TEXT,
      post_money_valuation INTEGER,
      raise_size INTEGER,
      round TEXT,
      key_takeaways TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      alias_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      PRIMARY KEY (meeting_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS email_company_links (
      message_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      PRIMARY KEY (message_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      contact_id TEXT,
      source_meeting_id TEXT
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
  /** Set arbitrary enrichment columns to bump populatedFieldCount in tests. */
  enrichment?: Partial<{
    description: string
    city: string
    state: string
    stage: string
    founding_year: number
    sector: string
    target_customer: string
    business_model: string
    lead_investor: string
    round: string
    key_takeaways: string
  }>
}) {
  const enrichmentCols = ['description', 'city', 'state', 'stage', 'founding_year', 'sector',
    'target_customer', 'business_model', 'lead_investor', 'round', 'key_takeaways'] as const
  const cols = ['id', 'canonical_name', 'primary_domain', 'website_url', 'updated_at', ...enrichmentCols]
  const placeholders = cols.map(() => '?').join(', ')
  const values: unknown[] = [
    opts.id,
    opts.canonicalName,
    opts.primaryDomain ?? null,
    opts.websiteUrl ?? null,
    opts.updatedAt ?? '2026-01-01 00:00:00',
    ...enrichmentCols.map((c) => opts.enrichment?.[c] ?? null)
  ]
  db.prepare(`INSERT INTO org_companies (${cols.join(', ')}) VALUES (${placeholders})`).run(...values)
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

  it('merges a fuzzy-similar no-domain company into an existing domain group', () => {
    // co1 and co2 share a domain → domain group
    insertCompany(testDb, { id: 'co1', canonicalName: 'Stillers', primaryDomain: 'stillerssoda.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Stillers Inc', primaryDomain: 'stillerssoda.com' })
    // co3 has similar name but no domain — should join the domain group
    insertCompany(testDb, { id: 'co3', canonicalName: 'Stillerssoda' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    expect(group.key).toBe('domain:stillerssoda.com')
    expect(group.domain).toBe('stillerssoda.com')
    expect(group.companies.map((c) => c.id).sort()).toEqual(['co1', 'co2', 'co3'])
    expect(group.confidence).toBeGreaterThanOrEqual(80)
    expect(group.reason).toMatch(/similar names/i)
  })
})

// ── Cross-pass merge edge cases (Stillers + orphaned-third + invariants) ────

describe('listSuspectedDuplicateCompanies — cross-pass merge', () => {
  it('groups Stillers trio when only one has a domain (singleton-domain stays ungrouped)', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Stillers', primaryDomain: 'stillerssoda.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Stillers Soda' })
    insertCompany(testDb, { id: 'co3', canonicalName: 'Stillerssoda' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    const group = groups[0]!
    // Singleton-domain company isn't in a domain group, so this is fuzzy-only.
    expect(group.domain).toBeNull()
    expect(group.companies.map((c) => c.id).sort()).toEqual(['co1', 'co2', 'co3'])
    expect(group.confidence).toBeGreaterThanOrEqual(85)
  })

  it('does NOT merge two domain groups even when their names are fuzzy-similar', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Inc', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Acme Corp', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co3', canonicalName: 'Acme Holdings', primaryDomain: 'acme.io' })
    insertCompany(testDb, { id: 'co4', canonicalName: 'Acme Group', primaryDomain: 'acme.io' })

    const groups = listSuspectedDuplicateCompanies()
    const domains = groups.map((g) => g.domain).sort()
    expect(domains).toEqual(['acme.com', 'acme.io'])
    for (const g of groups) {
      // Each domain group stays pure; no fuzzy-merge into the other.
      expect(g.confidence).toBeUndefined()
      expect(g.companies).toHaveLength(2)
    }
  })

  it('recomputes suggestedKeep across the merged set (most-recently-updated wins)', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Stillers', primaryDomain: 'stillerssoda.com', updatedAt: '2026-01-01 00:00:00' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Stillers Inc', primaryDomain: 'stillerssoda.com', updatedAt: '2026-01-02 00:00:00' })
    insertCompany(testDb, { id: 'co3', canonicalName: 'Stillerssoda', updatedAt: '2026-03-01 00:00:00' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.suggestedKeepCompanyId).toBe('co3')
  })

  it('maintains the dedup invariant — no company appears in more than one group', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'Acme Inc', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Acme Corp', primaryDomain: 'acme.com' })
    insertCompany(testDb, { id: 'co3', canonicalName: 'Acme Ltd' })
    insertCompany(testDb, { id: 'co4', canonicalName: 'Stillers' })
    insertCompany(testDb, { id: 'co5', canonicalName: 'Stillers Soda' })

    const groups = listSuspectedDuplicateCompanies()
    const seen = new Set<string>()
    for (const g of groups) {
      for (const c of g.companies) {
        expect(seen.has(c.id), `${c.id} appeared in multiple groups`).toBe(false)
        seen.add(c.id)
      }
    }
  })

  it('groups companies whose only difference is punctuation (uses normalizeCompanyName)', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: "Stiller's" })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Stillers' })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.companies.map((c) => c.id).sort()).toEqual(['co1', 'co2'])
  })

  it('handles older DBs missing some richness columns without crashing', () => {
    // Drop a column the new SQL would normally reference. PRAGMA introspection should skip it.
    testDb.exec(`
      CREATE TABLE org_companies_minimal (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL DEFAULT '',
        normalized_name TEXT NOT NULL DEFAULT '',
        primary_domain TEXT,
        website_url TEXT,
        entity_type TEXT NOT NULL DEFAULT 'startup',
        pipeline_stage TEXT,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    testDb.exec(`DROP TABLE org_companies; ALTER TABLE org_companies_minimal RENAME TO org_companies;`)
    testDb.prepare(
      `INSERT INTO org_companies (id, canonical_name, primary_domain, description, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('co1', 'Cake', 'cake.vc', 'Healthier cake', '2026-01-01 00:00:00')
    testDb.prepare(
      `INSERT INTO org_companies (id, canonical_name, primary_domain, description, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('co2', 'Cake Ventures', 'cake.vc', null, '2026-01-01 00:00:00')

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    const byId = Object.fromEntries(groups[0]!.companies.map((c) => [c.id, c]))
    // Only `description` exists among richness columns → co1 has 1, co2 has 0.
    expect(byId['co1']!.populatedFieldCount).toBe(1)
    expect(byId['co2']!.populatedFieldCount).toBe(0)
  })

  it('reports populatedFieldCount + activity counts on each duplicate summary', () => {
    insertCompany(testDb, {
      id: 'co1', canonicalName: 'Cake', primaryDomain: 'cake.vc',
      enrichment: { description: 'Healthier cake', city: 'NYC', stage: 'Seed', sector: 'Food' }
    })
    insertCompany(testDb, { id: 'co2', canonicalName: 'Cake Ventures', primaryDomain: 'cake.vc' })
    testDb.prepare('INSERT INTO meeting_company_links (meeting_id, company_id) VALUES (?, ?)').run('m1', 'co1')
    testDb.prepare('INSERT INTO meeting_company_links (meeting_id, company_id) VALUES (?, ?)').run('m2', 'co1')
    testDb.prepare('INSERT INTO email_company_links (message_id, company_id) VALUES (?, ?)').run('e1', 'co1')
    testDb.prepare('INSERT INTO notes (id, company_id, source_meeting_id) VALUES (?, ?, ?)').run('n1', 'co1', null)

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    const byId = Object.fromEntries(groups[0]!.companies.map((c) => [c.id, c]))
    expect(byId['co1']!.populatedFieldCount).toBe(4)
    expect(byId['co1']!.meetingCount).toBe(2)
    expect(byId['co1']!.emailCount).toBe(1)
    expect(byId['co1']!.noteCount).toBe(1)
    expect(byId['co2']!.populatedFieldCount).toBe(0)
    expect(byId['co2']!.meetingCount).toBe(0)
  })

  it('suggests the richer record as keep when timestamps tie (Cake Ventures bug)', () => {
    // Both updated at the same instant — recency tiebreaker fails. Richer record should win.
    insertCompany(testDb, {
      id: 'cake_ventures', canonicalName: 'Cake Ventures', primaryDomain: 'cake.vc',
      updatedAt: '2026-03-22 09:24:00',
      enrichment: { description: 'VC fund', city: 'NYC', sector: 'VC', business_model: 'fund', round: 'fund_iv' }
    })
    insertCompany(testDb, {
      id: 'cake_stub', canonicalName: 'Cake', primaryDomain: 'cake.vc',
      updatedAt: '2026-03-22 09:24:00'
      // no enrichment — bare stub
    })

    const groups = listSuspectedDuplicateCompanies()
    expect(groups).toHaveLength(1)
    expect(groups[0]!.suggestedKeepCompanyId).toBe('cake_ventures')
    expect(groups[0]!.companies[0]!.id).toBe('cake_ventures')
  })

  it('skips fuzzy pass and warns when candidate count exceeds MAX_FUZZY_CANDIDATES', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 5001 distinct no-domain companies → exceeds 5000 cap, fuzzy pass exits early.
      const stmt = testDb.prepare(`
        INSERT INTO org_companies (id, canonical_name, primary_domain, website_url, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      const insertMany = testDb.transaction(() => {
        for (let i = 0; i < 5001; i++) {
          const padded = String(i).padStart(5, '0')
          stmt.run(`co${padded}`, `Company ${padded}`, null, null, '2026-01-01 00:00:00')
        }
      })
      insertMany()

      const groups = listSuspectedDuplicateCompanies()
      const fuzzyGroups = groups.filter((g) => g.confidence != null)
      expect(fuzzyGroups).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('fuzzy pass skipped')
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
