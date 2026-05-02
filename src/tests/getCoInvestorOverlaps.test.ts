/**
 * Tests for getCoInvestorOverlaps — Phase 2C bidirectional intelligence.
 *
 * Sets up portfolio companies sharing co-investors and verifies the
 * aggregation correctly counts OTHER portfolio companies that share each
 * co-investor. Non-portfolio companies (entity_type != 'portfolio') are
 * excluded from the count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

import { getCoInvestorOverlaps } from '../main/database/repositories/org-company.repo'

function buildSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT UNIQUE NOT NULL,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function insertCompany(id: string, name: string, entityType: string = 'portfolio'): void {
  const norm = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  testDb.prepare(`INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type) VALUES (?, ?, ?, ?)`)
    .run(id, name, norm, entityType)
}

function linkInvestor(companyId: string, investorId: string, type: string = 'co_investor'): void {
  testDb.prepare(`INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), companyId, investorId, type)
}

describe('getCoInvestorOverlaps', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    buildSchema(testDb)
  })

  it('returns empty object when no co-investors are set', () => {
    insertCompany('co1', 'PortCo One')
    expect(getCoInvestorOverlaps('co1')).toEqual({})
  })

  it('counts other portfolio companies sharing a co-investor', () => {
    // Setup: Sequoia is a co-investor in 3 portfolio companies.
    insertCompany('co1', 'PortCo One')
    insertCompany('co2', 'PortCo Two')
    insertCompany('co3', 'PortCo Three')
    insertCompany('sequoia', 'Sequoia Capital', 'vc_fund')

    linkInvestor('co1', 'sequoia')
    linkInvestor('co2', 'sequoia')
    linkInvestor('co3', 'sequoia')

    // From co1's perspective: Sequoia is also in co2 + co3 → overlap = 2
    expect(getCoInvestorOverlaps('co1')).toEqual({ sequoia: 2 })
  })

  it('returns separate counts for multiple co-investors', () => {
    insertCompany('co1', 'PortCo One')
    insertCompany('co2', 'PortCo Two')
    insertCompany('co3', 'PortCo Three')
    insertCompany('seq', 'Sequoia', 'vc_fund')
    insertCompany('acc', 'Accel', 'vc_fund')

    // co1 has both Sequoia + Accel
    linkInvestor('co1', 'seq')
    linkInvestor('co1', 'acc')
    // co2 only has Sequoia
    linkInvestor('co2', 'seq')
    // co3 only has Accel
    linkInvestor('co3', 'acc')

    expect(getCoInvestorOverlaps('co1')).toEqual({ seq: 1, acc: 1 })
  })

  it('excludes self from the overlap count', () => {
    insertCompany('co1', 'PortCo One')
    insertCompany('seq', 'Sequoia', 'vc_fund')
    linkInvestor('co1', 'seq')

    // co1's only co-investor (Sequoia) is in NO other portfolio company
    expect(getCoInvestorOverlaps('co1')).toEqual({})
  })

  it('excludes non-portfolio companies from the count', () => {
    insertCompany('co1', 'PortCo One', 'portfolio')
    insertCompany('co2', 'Prospect Co', 'prospect')   // not portfolio
    insertCompany('co3', 'Another Portfolio', 'portfolio')
    insertCompany('seq', 'Sequoia', 'vc_fund')

    linkInvestor('co1', 'seq')
    linkInvestor('co2', 'seq')   // not counted (not portfolio)
    linkInvestor('co3', 'seq')   // counted

    expect(getCoInvestorOverlaps('co1')).toEqual({ seq: 1 })
  })

  it('does not include investor types other than co_investor', () => {
    insertCompany('co1', 'PortCo One')
    insertCompany('co2', 'PortCo Two')
    insertCompany('seq', 'Sequoia', 'vc_fund')

    linkInvestor('co1', 'seq', 'co_investor')
    linkInvestor('co2', 'seq', 'subsequent_investor') // wrong type
    linkInvestor('co2', 'seq', 'prior_investor')      // wrong type

    expect(getCoInvestorOverlaps('co1')).toEqual({})
  })

  it('handles a company with multiple shared co-investors across many portfolio companies', () => {
    // 4 portfolio companies all share 2 investors
    for (let i = 1; i <= 4; i++) insertCompany(`p${i}`, `Portfolio ${i}`)
    insertCompany('a', 'Alpha VC', 'vc_fund')
    insertCompany('b', 'Beta VC', 'vc_fund')

    for (let i = 1; i <= 4; i++) {
      linkInvestor(`p${i}`, 'a')
      linkInvestor(`p${i}`, 'b')
    }

    // From p1: alpha is in p2,p3,p4 (3); beta same (3)
    expect(getCoInvestorOverlaps('p1')).toEqual({ a: 3, b: 3 })
  })
})
