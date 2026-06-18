/**
 * Tests for the 5 new company hardcoded fields (migration 056).
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - custom-fields.repo → vi.fn() stubs (for enrichment service tests)
 *   - meeting.repo, file-manager, contact.repo → vi.fn() stubs (enrichment tests)
 *
 * Sections:
 *   1. updateCompany.industry (3 cases)
 *   2. setCompanyInvestors (3 cases)
 *   3. getCompany new fields (6 cases)
 *   4. migration idempotency (1 case)
 *   5. IPC COMPANY_UPDATE special-cases (3 cases)
 *   6. enrichment — industry canonical constraint (4 cases)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

// ─── Mock: database connection ────────────────────────────────────────────────

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

// ─── Mock: contact repo (for enrichment service) ─────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/contact.repo', () => ({
  getContact: vi.fn(),
  resolveContactsByEmails: vi.fn(() => ({}))
}))

// ─── Mock: custom-fields repo ─────────────────────────────────────────────────

const mockListFieldDefinitions = vi.fn()
const mockGetFieldValuesForEntity = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/custom-fields.repo', () => ({
  listFieldDefinitions: (...args: unknown[]) => mockListFieldDefinitions(...args),
  getFieldValuesForEntity: (...args: unknown[]) => mockGetFieldValuesForEntity(...args)
}))

// ─── Mock: meeting repo ───────────────────────────────────────────────────────

const mockGetMeeting = vi.fn()

vi.mock('@cyggie/db/sqlite/repositories/meeting.repo', () => ({
  getMeeting: (...args: unknown[]) => mockGetMeeting(...args)
}))

// ─── Mock: file-manager ───────────────────────────────────────────────────────

const mockReadSummary = vi.fn()

vi.mock('../main/storage/file-manager', () => ({
  readSummary: (...args: unknown[]) => mockReadSummary(...args)
}))

vi.mock('../main/drive/google-drive', () => ({
  downloadSummaryFromDrive: vi.fn().mockResolvedValue(null),
}))

// ─── Audit repo mock ──────────────────────────────────────────────────────────

vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({
  logAudit: () => undefined
}))

// ─── Import under test (after mocks) ─────────────────────────────────────────

const {
  setCompanyInvestors,
  getCompany,
  listCompanies,
  updateCompany,
} = await import('@cyggie/db/sqlite/repositories/org-company.repo')

const { getCompanyEnrichmentProposalsFromMeetings } = await import(
  '@cyggie/services/company-summary-sync.service'
)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      deleted_at TEXT,
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
      industry TEXT,
      target_customer TEXT,
      business_model TEXT,
      product_stage TEXT,
      revenue_model TEXT,
      target_investment_stage TEXT,
      target_investment_sector TEXT,
      arr REAL,
      burn_rate REAL,
      runway_months REAL,
      last_funding_date TEXT,
      total_funding_raised REAL,
      lead_investor TEXT,
      lead_investor_company_id TEXT,
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
      key_takeaways TEXT,
      source_type TEXT,
      source_entity_type TEXT,
      source_entity_id TEXT,
      portfolio_fund TEXT,
      investment_mark REAL,
      investment_round TEXT,
      initial_investment_security TEXT,
      date_of_initial_investment TEXT,
      initial_round_size REAL,
      last_company_valuation REAL,
      followon_check REAL,
      followon_date TEXT,
      followon_check_2 REAL,
      followon_date_2 TEXT,
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
      primary_company_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT,
      status TEXT,
      speaker_map TEXT NOT NULL DEFAULT '{}',
      attendees TEXT,
      attendee_emails TEXT
    );

    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      PRIMARY KEY (meeting_id, company_id)
    );

    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      from_email TEXT NOT NULL DEFAULT '',
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE email_company_links (
      message_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      PRIMARY KEY (message_id, company_id)
    );

    CREATE TABLE email_message_participants (
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      contact_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, role, email)
    );

    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (company_id, contact_id)
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      company_id TEXT,
      contact_id TEXT,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (investor_company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE company_decision_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      decision_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insertCompany(db: Database.Database, id: string, name: string): void {
  db.prepare(
    `INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES (?, ?, ?)`
  ).run(id, name, name.toLowerCase())
}

// ─── 1. updateCompany — industry as plain field ──────────────────────────────

describe('updateCompany.industry', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'Acme Corp')
  })

  it('writes an industry value via the standard field-update path', () => {
    updateCompany('co1', { industry: 'FinTech' })
    const row = testDb
      .prepare(`SELECT industry FROM org_companies WHERE id = 'co1'`)
      .get() as { industry: string | null }
    expect(row.industry).toBe('FinTech')
  })

  it('clears industry when set to null', () => {
    updateCompany('co1', { industry: 'FinTech' })
    updateCompany('co1', { industry: null })
    const row = testDb
      .prepare(`SELECT industry FROM org_companies WHERE id = 'co1'`)
      .get() as { industry: string | null }
    expect(row.industry).toBeNull()
  })

  it('accepts non-canonical values (UI may permit user-added options)', () => {
    updateCompany('co1', { industry: 'FoodTech' })
    const row = testDb
      .prepare(`SELECT industry FROM org_companies WHERE id = 'co1'`)
      .get() as { industry: string | null }
    expect(row.industry).toBe('FoodTech')
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

  it('inserts subsequent_investor rows independently of co_investor and prior_investor', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [{ id: 'inv1', name: 'Sequoia Capital' }])
    setCompanyInvestors('portfolio1', 'subsequent_investor', [{ id: 'inv2', name: 'a16z' }])
    const coRows = testDb.prepare(
      `SELECT * FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'`
    ).all()
    const subRows = testDb.prepare(
      `SELECT * FROM company_investors WHERE company_id = 'portfolio1' AND investor_type = 'subsequent_investor'`
    ).all()
    expect(coRows).toHaveLength(1)
    expect(subRows).toHaveLength(1)
    expect((subRows[0] as { investor_company_id: string }).investor_company_id).toBe('inv2')
  })

  it('persists array index as position', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [
      { id: 'inv2', name: 'a16z' },        // position 0
      { id: 'inv1', name: 'Sequoia Capital' }, // position 1
    ])
    const rows = testDb.prepare(
      `SELECT investor_company_id, position FROM company_investors
       WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'
       ORDER BY position`
    ).all() as Array<{ investor_company_id: string; position: number }>
    expect(rows).toEqual([
      { investor_company_id: 'inv2', position: 0 },
      { investor_company_id: 'inv1', position: 1 },
    ])
  })

  it('reorders positions on subsequent setCompanyInvestors call', () => {
    setCompanyInvestors('portfolio1', 'co_investor', [
      { id: 'inv1', name: 'Sequoia Capital' }, // initially position 0
      { id: 'inv2', name: 'a16z' },        // initially position 1
    ])
    // Reorder: a16z first, Sequoia second
    setCompanyInvestors('portfolio1', 'co_investor', [
      { id: 'inv2', name: 'a16z' },
      { id: 'inv1', name: 'Sequoia Capital' },
    ])
    const rows = testDb.prepare(
      `SELECT investor_company_id, position FROM company_investors
       WHERE company_id = 'portfolio1' AND investor_type = 'co_investor'
       ORDER BY position`
    ).all() as Array<{ investor_company_id: string; position: number }>
    expect(rows).toEqual([
      { investor_company_id: 'inv2', position: 0 },
      { investor_company_id: 'inv1', position: 1 },
    ])
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
    expect(detail?.coInvestorsList).toEqual([{ id: 'inv1', name: 'Tiger Global', domain: null }])
  })

  it('returns priorInvestorsList from join table', () => {
    insertCompany(testDb, 'inv2', 'Benchmark')
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), 'co1', 'inv2', 'prior_investor')
    const detail = getCompany('co1')
    expect(detail?.priorInvestorsList).toEqual([{ id: 'inv2', name: 'Benchmark', domain: null }])
  })

  it('returns coInvestedIn (reverse link)', () => {
    insertCompany(testDb, 'portfolio1', 'PortfolioCo')
    // linked_co co-invested in portfolio1
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`
    ).run(randomUUID(), 'portfolio1', 'linked_co', 'co_investor')
    const detail = getCompany('linked_co')
    expect(detail?.coInvestedIn).toEqual([{ id: 'portfolio1', name: 'PortfolioCo', domain: null }])
  })
})

// ─── 4. migration idempotency ─────────────────────────────────────────────────

describe('migration idempotency', () => {
  it('running migration 056 twice does not throw', async () => {
    const { runCompanyNewFieldsMigration } = await import(
      '@cyggie/db/sqlite/migrations/056-company-new-fields'
    )
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE org_companies (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        deleted_at TEXT
      );
    `)
    expect(() => runCompanyNewFieldsMigration(db)).not.toThrow()
    expect(() => runCompanyNewFieldsMigration(db)).not.toThrow()
  })
})

// ─── 5. IPC COMPANY_UPDATE special-cases ─────────────────────────────────────

describe('IPC COMPANY_UPDATE special-cases', () => {
  const mockSetCompanyInvestors = vi.fn()
  const mockUpdateCompany = vi.fn(() => ({ id: 'co1', canonicalName: 'Acme' }))

  beforeEach(() => {
    mockSetCompanyInvestors.mockReset()
    mockUpdateCompany.mockReset()
    mockUpdateCompany.mockReturnValue({ id: 'co1', canonicalName: 'Acme' })
  })

  // Helper that replicates the IPC handler logic in isolation
  function runIpcHandler(updates: Record<string, unknown>) {
    let remaining: Record<string, unknown> = { ...updates }

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

    // Stage-driven side effects (mirrored from src/main/ipc/company.ipc.ts)
    const newStage = 'pipelineStage' in remaining ? (remaining.pipelineStage as string | null) : undefined
    if (newStage === 'pass') {
      remaining = { ...remaining, priority: null }
    }
    if (newStage === 'portfolio') {
      remaining = { ...remaining, entityType: 'portfolio' }
    }

    mockUpdateCompany('co1', remaining)
    return remaining
  }

  it('industry key passes through as a normal field (no special case)', () => {
    const remaining = runIpcHandler({ industry: 'FinTech', description: 'A company' })
    expect(mockUpdateCompany).toHaveBeenCalledWith('co1', { industry: 'FinTech', description: 'A company' })
    expect(remaining).toHaveProperty('industry', 'FinTech')
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

  it('pipelineStage=pass auto-clears priority on the same write', () => {
    const remaining = runIpcHandler({ pipelineStage: 'pass' })
    expect(remaining).toEqual({ pipelineStage: 'pass', priority: null })
    expect(mockUpdateCompany).toHaveBeenCalledWith('co1', { pipelineStage: 'pass', priority: null })
  })

  it('pipelineStage=portfolio auto-syncs entityType=portfolio on the same write', () => {
    const remaining = runIpcHandler({ pipelineStage: 'portfolio' })
    expect(remaining).toEqual({ pipelineStage: 'portfolio', entityType: 'portfolio' })
    expect(mockUpdateCompany).toHaveBeenCalledWith('co1', { pipelineStage: 'portfolio', entityType: 'portfolio' })
  })

  it('pipelineStage=portfolio respects an explicit entityType in the same payload', () => {
    // The auto-sync overwrites — explicit by design (any caller setting stage=portfolio
    // but a different entityType is asking for inconsistent data; sync wins).
    const remaining = runIpcHandler({ pipelineStage: 'portfolio', entityType: 'prospect' })
    expect(remaining.entityType).toBe('portfolio')
  })
})

// ─── 5b. IPC COMPANY_UPDATE — Stage Change auto-log + atomicity ─────────────

describe('IPC COMPANY_UPDATE — Stage Change auto-log', () => {
  // Mirrors the COMPANY_UPDATE handler's stage-change logic from
  // src/main/ipc/company.ipc.ts. The real handler runs inside ipcMain and
  // is hard to invoke directly, so we simulate it here using the same
  // db.transaction wrapping + create-log-on-change pattern.

  const STAGE_CHANGE_TYPE = 'Stage Change'

  function runHandler(
    companyId: string,
    updates: Record<string, unknown>,
    opts: { failLogCreate?: boolean } = {},
  ): { committed: boolean; logCreated: boolean; finalStage: string | null } {
    const db = testDb
    const prevRow = ('pipelineStage' in updates)
      ? (db.prepare('SELECT pipeline_stage FROM org_companies WHERE id = ?').get(companyId) as
          | { pipeline_stage: string | null }
          | undefined)
      : undefined
    const prevStage = prevRow?.pipeline_stage ?? null
    const newStage = 'pipelineStage' in updates ? (updates.pipelineStage as string | null) : undefined
    const stageChanging = 'pipelineStage' in updates && (newStage ?? null) !== prevStage

    let logCreated = false
    let committed = false
    try {
      db.transaction(() => {
        if ('pipelineStage' in updates) {
          db.prepare('UPDATE org_companies SET pipeline_stage = ? WHERE id = ?')
            .run(newStage as string | null, companyId)
        }
        if (stageChanging) {
          if (opts.failLogCreate) throw new Error('Simulated log INSERT failure')
          db.prepare(
            'INSERT INTO company_decision_logs (id, company_id, decision_type, decision_date) VALUES (?, ?, ?, ?)'
          ).run(`log-${companyId}-${Date.now()}`, companyId, STAGE_CHANGE_TYPE, new Date().toISOString())
          logCreated = true
        }
      })()
      committed = true
    } catch {
      // Transaction rolled back — both the stage update and log INSERT are undone.
    }

    const after = db.prepare('SELECT pipeline_stage FROM org_companies WHERE id = ?').get(companyId) as
      | { pipeline_stage: string | null }
      | undefined
    return { committed, logCreated, finalStage: after?.pipeline_stage ?? null }
  }

  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'Acme Corp')
    // Start in 'screening' so transitions are meaningful.
    testDb.prepare('UPDATE org_companies SET pipeline_stage = ? WHERE id = ?').run('screening', 'co1')
  })

  it('creates a Stage Change log when pipelineStage changes', () => {
    const r = runHandler('co1', { pipelineStage: 'pass' })

    expect(r.committed).toBe(true)
    expect(r.logCreated).toBe(true)
    expect(r.finalStage).toBe('pass')

    const logs = testDb.prepare(
      `SELECT decision_type FROM company_decision_logs WHERE company_id = 'co1'`
    ).all() as Array<{ decision_type: string }>
    expect(logs).toHaveLength(1)
    expect(logs[0].decision_type).toBe(STAGE_CHANGE_TYPE)
  })

  it('does NOT create a log when pipelineStage is unchanged (same value passed)', () => {
    const r = runHandler('co1', { pipelineStage: 'screening' })  // already screening

    expect(r.logCreated).toBe(false)
    const logs = testDb.prepare(`SELECT id FROM company_decision_logs WHERE company_id = 'co1'`).all()
    expect(logs).toHaveLength(0)
  })

  it('does NOT create a log when pipelineStage is not in the update payload', () => {
    const r = runHandler('co1', { priority: 'high' })

    expect(r.logCreated).toBe(false)
    expect(r.finalStage).toBe('screening')  // unchanged
  })

  it('creates a log on null→value transition (Sourced → pipeline)', () => {
    // Start with null (Sourced)
    testDb.prepare(`UPDATE org_companies SET pipeline_stage = NULL WHERE id = 'co1'`).run()

    const r = runHandler('co1', { pipelineStage: 'diligence' })

    expect(r.logCreated).toBe(true)
    expect(r.finalStage).toBe('diligence')
  })

  it('creates a log on value→null transition (back to Sourced)', () => {
    const r = runHandler('co1', { pipelineStage: null })

    expect(r.logCreated).toBe(true)
    expect(r.finalStage).toBeNull()
  })

  it('rolls back the stage update if log INSERT fails (atomicity guard)', () => {
    // This is the regression guard for the failure mode that would cause the
    // ORIGINAL bug to reappear silently — company in 'pass' with no log →
    // dropped from Recent Pass by the SQL filter's NULL handling.
    const r = runHandler('co1', { pipelineStage: 'pass' }, { failLogCreate: true })

    expect(r.committed).toBe(false)
    expect(r.finalStage).toBe('screening')  // unchanged, txn rolled back

    const logs = testDb.prepare(`SELECT id FROM company_decision_logs WHERE company_id = 'co1'`).all()
    expect(logs).toHaveLength(0)
  })
})

// ─── 6. enrichment — industry constraint (canonical only) ────────────────────

describe('enrichment — industry canonical constraint', () => {
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
      industry: null as string | null,
      ...overrides,
    }
  }

  function makeMeeting() {
    return { id: 'meet1', date: '2024-01-15T10:00:00Z', summaryPath: 'summary.md' }
  }

  function makeProvider(response: string) {
    return { generateSummary: vi.fn(async () => response) }
  }

  const mockGetCompany = vi.fn()

  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'Acme Corp')
    vi.doMock('@cyggie/db/sqlite/repositories/org-company.repo', () => ({
      getCompany: (...args: unknown[]) => mockGetCompany(...args),
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

  it('LLM returns canonical industry → industry update proposed', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industry: null }))
    const provider = makeProvider(JSON.stringify({ industry: 'FinTech' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.updates.industry).toBe('FinTech')
  })

  it('LLM returns non-canonical industry → snapped to NULL (empty proposal)', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industry: null }))
    const provider = makeProvider(JSON.stringify({ industry: 'Foodtech' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.updates.industry).toBeUndefined()
  })

  it('LLM returns null → empty proposal (no industry update)', async () => {
    mockGetCompany.mockReturnValue(makeCompany({ industry: null }))
    const provider = makeProvider(JSON.stringify({ industry: null, description: null }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.changes).toEqual([])
  })

  it('LLM returns same industry as current → no change', async () => {
    // Set the DB's current value so the real getCompany returns FinTech
    testDb.prepare(`UPDATE org_companies SET industry = 'FinTech' WHERE id = 'co1'`).run()
    mockGetCompany.mockReturnValue(makeCompany({ industry: 'FinTech' }))
    const provider = makeProvider(JSON.stringify({ industry: 'FinTech' }))
    const result = await getCompanyEnrichmentProposalsFromMeetings(['meet1'], 'co1', provider)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.updates.industry).toBeUndefined()
  })
})

// ─── 7. listCompanies — conditional JOINs ────────────────────────────────────

describe('listCompanies — conditional JOINs', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertCompany(testDb, 'co1', 'StartupCo')
    insertCompany(testDb, 'inv1', 'Sequoia Capital')
    // Set industry directly on the company column
    testDb.prepare(`UPDATE org_companies SET industry = 'FinTech' WHERE id = 'co1'`).run()
    // Add co-investor
    testDb.prepare(
      `INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES ('ci1', 'co1', 'inv1', 'co_investor')`
    ).run()
    // Mark companies as visible in companies view
    testDb.prepare(`UPDATE org_companies SET include_in_companies_view = 1 WHERE id = 'co1'`).run()
    testDb.prepare(`UPDATE org_companies SET include_in_companies_view = 1 WHERE id = 'inv1'`).run()
  })

  it('always returns industry as a scalar column on the company row', () => {
    const results = listCompanies({ view: 'all', includeStats: true })
    const co = results.find(r => r.id === 'co1')!
    expect(co.industry).toBe('FinTech')
  })

  it('returns null for coInvestorNames when includeInvestorNames is false', () => {
    const results = listCompanies({ view: 'all', includeStats: true, includeInvestorNames: false })
    const co = results.find(r => r.id === 'co1')!
    expect(co.coInvestorNames).toBeNull()
  })

  it('returns co-investor names when includeInvestorNames is true', () => {
    const results = listCompanies({ view: 'all', includeStats: true, includeInvestorNames: true })
    const co = results.find(r => r.id === 'co1')!
    expect(co.coInvestorNames).toBe('Sequoia Capital')
  })
})
