/**
 * Tests for the 5 new company hardcoded fields (migration 056).
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - custom-fields.repo → vi.fn() stubs (for enrichment service tests)
 *   - meeting.repo, file-manager, contact.repo → vi.fn() stubs (enrichment tests)
 *
 * Sections:
 *   1. updateCompanyIndustries (4 cases)
 *   2. setCompanyInvestors (3 cases)
 *   3. getCompany new fields (6 cases)
 *   4. migration idempotency (1 case)
 *   5. IPC COMPANY_UPDATE special-cases (4 cases)
 *   6. enrichment — industries normalization (4 cases)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// ─── Mock: database connection ────────────────────────────────────────────────

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// ─── Mock: contact repo (for enrichment service) ─────────────────────────────

vi.mock('../main/database/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(() => ({}))
}))

// ─── Mock: custom-fields repo ─────────────────────────────────────────────────

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('../main/database/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args)
}))

// ─── Mock: meeting repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('../main/database/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args)
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args)
}))

// ─── Audit repo mock ──────────────────────────────────────────────────────────

vi.mock('../main/database/repositories/audit.repo', () => ({
  logAudit: () => undefined
}))

// ─── Import under test (after mocks) ─────────────────────────────────────────

const {
  updateCompanyIndustries,
  setCompanyInvestors,
  getCompany,
} = await import('../main/database/repositories/org-company.repo')

const { getCompanyEnrichmentProposalsFromMeetings } = await import(
  '../main/services/company-summary-sync.service'
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL DEFAULT '',
      description TEXT,
      primary_domain TEXT,
      website_url TEXT,
      city TEXT,
      state TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      crm_provider TEXT,
      crm_company_id TEXT,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      include_in_companies_view INTEGER NOT NULL DEFAULT 0,
      classification_source TEXT NOT NULL DEFAULT 'manual',
      classification_confidence REAL,
      priority TEXT,
      post_money_valuation REAL,
      raise_size REAL,
      round TEXT,
      pipeline_stage TEXT,
      founding_year INTEGER,
      employee_count_range TEXT,
      hq_address TEXT,
      linkedin_company_url TEXT,
      twitter_handle TEXT,
      crunchbase_url TEXT,
      angellist_url TEXT,
      sector TEXT,
      target_customer TEXT,
      business_model TEXT,
      product_stage TEXT,
      revenue_model TEXT,
      arr REAL,
      burn_rate REAL,
      runway_months REAL,
      last_funding_date TEXT,
      total_funding_raised REAL,
      lead_investor TEXT,
      co_investors TEXT,
      relationship_owner TEXT,
      deal_source TEXT,
      warm_intro_source TEXT,
      referral_contact_id TEXT,
      next_followup_date TEXT,
      investment_size TEXT,
      ownership_pct TEXT,
      followon_investment_size TEXT,
      total_invested TEXT,
      field_sources TEXT,
      source_type TEXT,
      source_entity_type TEXT,
      source_entity_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE industries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE org_company_industries (
      company_id TEXT NOT NULL,
      industry_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, industry_id)
    );

    CREATE TABLE org_company_themes (
      company_id TEXT NOT NULL,
      theme_id TEXT NOT NULL,
      relevance_score REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, theme_id)
    );

    CREATE TABLE themes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (investor_company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );
  `)
  return db
}

function insertCompany(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES (?, ?, ?)`
  ).run(id, name, name.toLowerCase())
}

// ─── 1. updateCompanyIndustries ───────────────────────────────────────────────

describe('updateCompanyIndustries', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'Acme Corp')
  })

  it('creates a new industry and junction row', () => {
    updateCompanyIndustries('co1', ['FinTech'])
    const rows = testDb.prepare(`
      SELECT i.name FROM org_company_industries ci
      JOIN industries i ON i.id = ci.industry_id
      WHERE ci.company_id = 'co1'
    `).all() as { name: string }[]
    expect(rows.map((r) => r.name)).toEqual(['FinTech'])
  })

  it('reuses an existing industry by name (case-insensitive)', () => {
    testDb.prepare(`INSERT INTO industries (id, name) VALUES (?, ?)`).run('ind1', 'FinTech')
    updateCompanyIndustries('co1', ['fintech'])
    const indRows = testDb.prepare(`SELECT * FROM industries`).all()
    expect(indRows).toHaveLength(1) // no duplicate
    const junctionRows = testDb.prepare(`SELECT * FROM org_company_industries WHERE company_id = 'co1'`).all()
    expect(junctionRows).toHaveLength(1)
    expect((junctionRows[0] as { industry_id: string }).industry_id).toBe('ind1')
  })

  it('clears all industries when names=[]', () => {
    updateCompanyIndustries('co1', ['FinTech', 'AI/ML'])
    updateCompanyIndustries('co1', [])
    const rows = testDb.prepare(`SELECT * FROM org_company_industries WHERE company_id = 'co1'`).all()
    expect(rows).toHaveLength(0)
  })

  it('handles duplicate names in input (INSERT OR IGNORE)', () => {
    updateCompanyIndustries('co1', ['FinTech', 'FinTech'])
    const rows = testDb.prepare(`SELECT * FROM org_company_industries WHERE company_id = 'co1'`).all()
    expect(rows).toHaveLength(1)
  })
})

// ─── 2. setCompanyInvestors ───────────────────────────────────────────────────

describe('setCompanyInvestors', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'portfolio1', 'StartupCo')
    insertCompany(testDb, 'inv1', 'Sequoia Capital')
    insertCompany(testDb, 'inv2', 'a16z')
  })

  it('inserts co_investor rows', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [
      { id: 'inv1', name: 'Sequoia Capital' },
      { id: 'inv2', name: 'a16z' },
    ])
    const rows = testDb.prepare(
      `SELECT investor_company_id FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'`
    ).all() as { investor_company_id: string }[]
    expect(rows.map((r) => r.investor_company_id).sort()).toEqual(['inv1', 'inv2'].sort())
  })

  it('replaces existing rows on second call (delete + reinsert)', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [{ id: 'inv1', name: 'Sequoia Capital' }])
    setCompanyInvestors('portfolio1', 'co_investor', [{ id: 'inv2', name: 'a16z' }])
    const rows = testDb.prepare(
      `SELECT investor_company_id FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'`
    ).all() as { investor_company_id: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].investor_company_id).toBe('inv2')
  })

  it('inserts prior_investor rows independently of co_investor rows', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [{ id: 'inv1', name: 'Sequoia Capital' }])
    setCompanyInvestors('portfolio1', 'prior_investor', [{ id: 'inv2', name: 'a16z' }])
    const coRows = testDb.prepare(
      `SELECT * FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'`
    ).all()
    const priorRows = testDb.prepare(
      `SELECT * FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'prior_investor'`
    ).all()
    expect(coRows).toHaveLength(1)
    expect(priorRows).toHaveLength(1)
  })
})

// ─── 3. getCompany — new fields ───────────────────────────────────────────────

describe('getCompany — new fields', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'StartupCo')
    insertCompany(testDb, 'linked_co', 'Sequoia Capital')
    testDb.prepare(`INSERT INTO contacts (id, full_name) VALUES (?, ?)`).run('ct1', 'John Smith')
  })

  it('resolves sourceEntityName for company type', () => {
    testDb.prepare(
      `UPDATE org_companies SET source_entity_type = 'company', source_entity_id = 'linked_co' WHERE id = 'co1'`
    ).run()
    const detail = getCompany('co1')
    expect(detail?.sourceEntityName).toBe('Sequoia Capital')
  })

  it('resolves sourceEntityName for contact type', () => {
    testDb.prepare(
      `UPDATE org_companies SET source_entity_type = 'contact', source_entity_id = 'ct1' WHERE id = 'co1'`
    ).run()
    const detail = getCompany('co1')
    expect(detail?.sourceEntityName).toBe('John Smith')
  })

  it('returns null sourceEntityName when source entity is missing (deleted)', () => {
    testDb.prepare(
      `UPDATE org_companies SET source_entity_type = 'company', source_entity_id = 'nonexistent' WHERE id = 'co1'`
    ).run()
    const detail = getCompany('co1')
    expect(detail?.sourceEntityName).toBeNull()
  })

  it('returns coInvestorsList from join table', () => {
    insertCompany(testDb, 'inv1', 'Tiger Global')
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), 'co1', 'inv1', 'co_investor')
    const detail = getCompany('co1')
    expect(detail?.coInvestorsList).toEqual([{ id: 'inv1', name: 'Tiger Global' }])
  })

  it('returns priorInvestorsList from join table', () => {
    insertCompany(testDb, 'inv2', 'Benchmark')
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), 'co1', 'inv2', 'prior_investor')
    const detail = getCompany('co1')
    expect(detail?.priorInvestorsList).toEqual([{ id: 'inv2', name: 'Benchmark' }])
  })

  it('returns coInvestedIn (reverse link)', () => {
    insertCompany(testDb, 'portfolio1', 'PortfolioCo')
    // linked_co co-invested in portfolio1
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), 'portfolio1', 'linked_co', 'co_investor')
    const detail = getCompany('linked_co')
    expect(detail?.coInvestedIn).toEqual([{ id: 'portfolio1', name: 'PortfolioCo' }])
  })
})

// ─── 4. migration idempotency ─────────────────────────────────────────────────

describe('migration idempotency', () => {
  it('running migration 056 twice does not throw', async () => {
    const { runCompanyNewFieldsMigration } = await import(
      '../main/database/migrations/056-company-new-fields'
    )
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE org_companies (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL
      );
    `)
    expect(() => runCompanyNewFieldsMigration(db)).not.toThrow()
    expect(() => runCompanyNewFieldsMigration(db)).not.toThrow()
  })
})

// ─── 5. IPC COMPANY_UPDATE special-cases ─────────────────────────────────────

describe('IPC COMPANY_UPDATE special-cases', () => {
  const mockUpdateCompanyIndustries = vi.fn()
  const mockSetCompanyInvestors = vi.fn()
  const mockUpdateCompany = vi.fn(() => ({ id: 'co1', canonicalName: 'Acme' }))

  beforeEach(() => {
    mockUpdateCompanyIndustries.mockReset()
    mockSetCompanyInvestors.mockReset()
    mockUpdateCompany.mockReset()
    mockUpdateCompany.mockReturnValue({ id: 'co1', canonicalName: 'Acme' })
  })

  // Helper that replicates the IPC handler logic in isolation
  function runIpcHandler(updates: Record<string, unknown>) {
    let remaining: Record<string, unknown> = { ...updates }

    if ('industries' in remaining) {
      mockUpdateCompanyIndustries('co1', (remaining.industries as string[] | null) ?? [])
      const { industries: _, ...rest } = remaining
      remaining = rest
    }
    if ('coInvestorsList' in remaining) {
      mockSetCompanyInvestors('co1', 'co_investor', remaining.coInvestorsList)
      const { coInvestorsList: _, ...rest } = remaining
      remaining = rest
    }
    if ('priorInvestorsList' in remaining) {
      mockSetCompanyInvestors('co1', 'prior_investor', remaining.priorInvestorsList)
      const { priorInvestorsList: _, ...rest } = remaining
      remaining = rest
    }
    mockUpdateCompany('co1', remaining)
    return remaining
  }

  it('industries key → updateCompanyIndustries called, key removed from remaining', () => {
    const remaining = runIpcHandler({ industries: ['FinTech'], description: 'A company' })
    expect(mockUpdateCompanyIndustries).toHaveBeenCalledWith('co1', ['FinTech'])
    expect(remaining).not.toHaveProperty('industries')
    expect(remaining).toHaveProperty('description')
  })

  it('coInvestorsList key → setCompanyInvestors called with co_investor type, key removed', () => {
    const investors = [{ id: 'inv1', name: 'Sequoia' }]
    const remaining = runIpcHandler({ coInvestorsList: investors })
    expect(mockSetCompanyInvestors).toHaveBeenCalledWith('co1', 'co_investor', investors)
    expect(remaining).not.toHaveProperty('coInvestorsList')
  })

  it('priorInvestorsList key → setCompanyInvestors called with prior_investor type, key removed', () => {
    const investors = [{ id: 'inv2', name: 'Benchmark' }]
    const remaining = runIpcHandler({ priorInvestorsList: investors })
    expect(mockSetCompanyInvestors).toHaveBeenCalledWith('co1', 'prior_investor', investors)
    expect(remaining).not.toHaveProperty('priorInvestorsList')
  })

  it('all three keys present → each handler fires, remaining has only scalar keys', () => {
    const remaining = runIpcHandler({
      industries: ['FinTech'],
      coInvestorsList: [{ id: 'inv1', name: 'Sequoia' }],
      priorInvestorsList: [{ id: 'inv2', name: 'Benchmark' }],
      description: 'A company',
    })
    expect(mockUpdateCompanyIndustries).toHaveBeenCalledTimes(1)
    expect(mockSetCompanyInvestors).toHaveBeenCalledTimes(2)
    expect(Object.keys(remaining)).toEqual(['description'])
  })
})

// ─── 6. enrichment — industries normalization ─────────────────────────────────

describe('enrichment — industries normalization', () => {
  function makeCompany(overrides: Record<string, unknown> = {}) {
    return {
      id: 'co1',
      canonicalName: 'Acme Corp',
      description: null,
      round: null,
      raiseSize: null,
      postMoneyValuation: null,
      city: null,
      state: null,
      pipelineStage: null,
      fieldSources: null,
      industries: [] as string[],
      ...overrides,
    }
  }

  function makeMeeting() {
    return { id: 'meet1', date: '2024-01-15T10:00:00Z', summaryFilename: 'summary.md' }
  }

  function makeProvider(response: string) {
    return { generateSummary: vi.fn(async () => response) }
  }

  const mockGetCompany = vi.fn()

  beforeEach(() => {
    testDb = buildDb()
    vi.doMock('../main/database/repositories/org-company.repo', () => ({
      getCompany: (...args: unknown[]) => mockGetCompany(...args),
      updateCompanyIndustries: vi.fn(),
      setCompanyInvestors: vi.fn(),
    }))
    mockGetMeeting.mockReset()
    mockReadSummary.mockReset()
    mockListFieldDefinitions.mockReturnValue([])
    mockGetFieldValuesForEntity.mockReturnValue([])
    mockGetMeeting.mockReturnValue(makeMeeting())
    mockReadSummary.mockReturnValue('Company makes FinTech software.')
    mockGetCompany.mockReturnValue(makeCompany())
  })

  it('LLM returns string[] → industries extracted correctly', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industries: [] }))
    const provider = makeProvider(JSON.stringify({ industries: ['FinTech', 'AI/ML'] }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result?.updates.industries).toEqual(['FinTech', 'AI/ML'])
  })

  it('LLM returns comma-joined string "FinTech, AI" → split to ["FinTech", "AI"]', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industries: [] }))
    const provider = makeProvider(JSON.stringify({ industries: 'FinTech, AI' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result?.updates.industries).toEqual(['FinTech', 'AI'])
  })

  it('LLM returns null → no industries proposal generated', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industries: [] }))
    const provider = makeProvider(JSON.stringify({ industries: null, description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result).toBeNull()  // no changes at all
  })

  it('LLM returns same industries as current → no change (isDiff = false)', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industries: ['FinTech'] }))
    const provider = makeProvider(JSON.stringify({ industries: ['FinTech'] }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    // No industry diff, no other changes either → null
    expect(result?.updates.industries).toBeUndefined()
  })
})
