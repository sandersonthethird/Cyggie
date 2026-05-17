/**
 * Tests for migration 076 — lead_investor_company_id backfill.
 *
 * Sets up an in-memory DB with the legacy `lead_investor` TEXT column,
 * runs the migration, and verifies:
 *   - Column added
 *   - Existing companies link to existing companies by normalized name
 *   - Stubs created for unrecognized lead investor names
 *   - Companies with empty lead_investor are untouched
 *   - Migration is idempotent
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { runLeadInvestorCompanyIdMigration } from '@cyggie/db/sqlite/migrations/076-lead-investor-company-id'

let testDb: Database.Database

function buildBaseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      include_in_companies_view INTEGER NOT NULL DEFAULT 1,
      classification_source TEXT NOT NULL DEFAULT 'manual',
      classification_confidence REAL,
      lead_investor TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function insertCompany(db: Database.Database, opts: {
  id: string
  canonicalName: string
  leadInvestor?: string | null
}): void {
  const normalized = opts.canonicalName.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  db.prepare(`
    INSERT INTO org_companies (id, canonical_name, normalized_name, lead_investor)
    VALUES (?, ?, ?, ?)
  `).run(opts.id, opts.canonicalName, normalized, opts.leadInvestor ?? null)
}

describe('migration 076 — lead_investor_company_id backfill', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    buildBaseSchema(testDb)
  })

  it('adds the lead_investor_company_id column', () => {
    runLeadInvestorCompanyIdMigration(testDb)
    const cols = testDb.prepare(`PRAGMA table_info(org_companies)`).all() as Array<{ name: string }>
    expect(cols.some((c) => c.name === 'lead_investor_company_id')).toBe(true)
  })

  it('links to an existing company by normalized name', () => {
    insertCompany(testDb, { id: 'sequoia', canonicalName: 'Sequoia Capital' })
    insertCompany(testDb, { id: 'co1', canonicalName: 'PortfolioCo', leadInvestor: 'Sequoia Capital' })

    runLeadInvestorCompanyIdMigration(testDb)

    const row = testDb.prepare(`SELECT lead_investor_company_id FROM org_companies WHERE id = 'co1'`).get() as { lead_investor_company_id: string }
    expect(row.lead_investor_company_id).toBe('sequoia')
  })

  it('creates a stub when lead investor name is not in the DB', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'PortfolioCo', leadInvestor: 'Brand New VC' })

    runLeadInvestorCompanyIdMigration(testDb)

    const row = testDb.prepare(`SELECT lead_investor_company_id FROM org_companies WHERE id = 'co1'`).get() as { lead_investor_company_id: string | null }
    expect(row.lead_investor_company_id).not.toBeNull()
    const stub = testDb.prepare(`SELECT canonical_name FROM org_companies WHERE id = ?`).get(row.lead_investor_company_id) as { canonical_name: string }
    expect(stub.canonical_name).toBe('Brand New VC')
  })

  it('skips rows with empty/null lead_investor', () => {
    insertCompany(testDb, { id: 'co1', canonicalName: 'PortfolioCo', leadInvestor: null })
    insertCompany(testDb, { id: 'co2', canonicalName: 'OtherCo', leadInvestor: '   ' })

    runLeadInvestorCompanyIdMigration(testDb)

    const rows = testDb.prepare(`SELECT id, lead_investor_company_id FROM org_companies WHERE id IN ('co1', 'co2')`).all() as Array<{ id: string; lead_investor_company_id: string | null }>
    expect(rows.every((r) => r.lead_investor_company_id === null)).toBe(true)
  })

  it('normalizes whitespace and case when matching existing companies', () => {
    insertCompany(testDb, { id: 'sequoia', canonicalName: 'Sequoia Capital' })
    insertCompany(testDb, { id: 'co1', canonicalName: 'Pcoa', leadInvestor: '  sequoia  capital  ' })

    runLeadInvestorCompanyIdMigration(testDb)

    const row = testDb.prepare(`SELECT lead_investor_company_id FROM org_companies WHERE id = 'co1'`).get() as { lead_investor_company_id: string }
    expect(row.lead_investor_company_id).toBe('sequoia')
  })

  it('does not link a company to itself even if name matches', () => {
    // PortfolioCo has lead_investor='PortfolioCo' (degenerate but possible)
    insertCompany(testDb, { id: 'co1', canonicalName: 'PortfolioCo', leadInvestor: 'PortfolioCo' })

    runLeadInvestorCompanyIdMigration(testDb)

    const row = testDb.prepare(`SELECT lead_investor_company_id FROM org_companies WHERE id = 'co1'`).get() as { lead_investor_company_id: string | null }
    // Should not be set to 'co1' (self-reference); should be null
    expect(row.lead_investor_company_id).not.toBe('co1')
  })

  it('is idempotent — running twice does nothing on the second pass', () => {
    insertCompany(testDb, { id: 'sequoia', canonicalName: 'Sequoia Capital' })
    insertCompany(testDb, { id: 'co1', canonicalName: 'PortfolioCo', leadInvestor: 'Sequoia Capital' })

    runLeadInvestorCompanyIdMigration(testDb)
    const firstCount = testDb.prepare(`SELECT COUNT(*) AS n FROM org_companies`).get() as { n: number }

    runLeadInvestorCompanyIdMigration(testDb)
    const secondCount = testDb.prepare(`SELECT COUNT(*) AS n FROM org_companies`).get() as { n: number }

    expect(secondCount.n).toBe(firstCount.n) // no new stubs created
  })
})
