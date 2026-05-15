/**
 * Verifies getCompanyInvestorsByType — the single-query replacement for the
 * three separate getCompanyInvestors calls inside getCompany().
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite with hand-rolled schema for the two
 *     tables this query touches (company_investors, org_companies). Avoids
 *     spinning up the full migration chain.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb,
}))

const { getCompanyInvestorsByType } = await import(
  '../main/database/repositories/org-company.repo'
)

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      primary_domain TEXT
    );
    CREATE TABLE company_investors (
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      position INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

function seedCompany(db: Database.Database, id: string, name: string, domain: string | null) {
  db.prepare('INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES (?, ?, ?)').run(id, name, domain)
}

function seedInvestor(
  db: Database.Database,
  companyId: string,
  investorId: string,
  type: 'co_investor' | 'prior_investor' | 'subsequent_investor',
  position: number,
) {
  db.prepare(
    'INSERT INTO company_investors (company_id, investor_company_id, investor_type, position) VALUES (?, ?, ?, ?)'
  ).run(companyId, investorId, type, position)
}

beforeEach(() => {
  testDb = buildDb()
})

describe('getCompanyInvestorsByType', () => {
  it('returns empty arrays for all three types when the company has no investors', () => {
    seedCompany(testDb, 'co-1', 'Subject Co', 'subject.com')
    const result = getCompanyInvestorsByType(testDb, 'co-1')
    expect(result).toEqual({ co_investor: [], prior_investor: [], subsequent_investor: [] })
  })

  it('groups rows by investor_type and preserves position ordering within each group', () => {
    seedCompany(testDb, 'co-1', 'Subject Co', null)
    seedCompany(testDb, 'inv-a', 'Alpha Capital', 'alpha.vc')
    seedCompany(testDb, 'inv-b', 'Beta Partners', 'beta.vc')
    seedCompany(testDb, 'inv-c', 'Gamma Ventures', null)

    // Intentionally interleaved insertion order; ORDER BY position must sort within groups.
    seedInvestor(testDb, 'co-1', 'inv-b', 'co_investor', 2)
    seedInvestor(testDb, 'co-1', 'inv-c', 'prior_investor', 1)
    seedInvestor(testDb, 'co-1', 'inv-a', 'co_investor', 1)

    const result = getCompanyInvestorsByType(testDb, 'co-1')
    expect(result.co_investor.map((r) => r.id)).toEqual(['inv-a', 'inv-b'])
    expect(result.prior_investor.map((r) => r.id)).toEqual(['inv-c'])
    expect(result.subsequent_investor).toEqual([])
    expect(result.co_investor[0]).toEqual({ id: 'inv-a', name: 'Alpha Capital', domain: 'alpha.vc' })
    expect(result.co_investor[1].domain).toBe('beta.vc')
    expect(result.prior_investor[0].domain).toBeNull()
  })

  it('coerces missing domain to null (not undefined)', () => {
    seedCompany(testDb, 'co-1', 'Subject Co', null)
    seedCompany(testDb, 'inv-a', 'Alpha Capital', null)
    seedInvestor(testDb, 'co-1', 'inv-a', 'subsequent_investor', 1)
    const result = getCompanyInvestorsByType(testDb, 'co-1')
    expect(result.subsequent_investor[0].domain).toBeNull()
  })

  it('ignores investor_type values outside the three known types', () => {
    seedCompany(testDb, 'co-1', 'Subject Co', null)
    seedCompany(testDb, 'inv-a', 'Alpha', null)
    seedCompany(testDb, 'inv-x', 'Unknown', null)
    seedInvestor(testDb, 'co-1', 'inv-a', 'co_investor', 1)
    testDb
      .prepare('INSERT INTO company_investors (company_id, investor_company_id, investor_type, position) VALUES (?, ?, ?, ?)')
      .run('co-1', 'inv-x', 'lead_investor', 1)
    const result = getCompanyInvestorsByType(testDb, 'co-1')
    expect(result.co_investor.map((r) => r.id)).toEqual(['inv-a'])
    expect(result.prior_investor).toEqual([])
    expect(result.subsequent_investor).toEqual([])
  })
})
