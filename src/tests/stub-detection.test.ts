/**
 * Tests for Phase 3 stub-pollution detection.
 *
 * Covers:
 *   - countStubCompanies returns 0 when no qualifying companies exist
 *   - Counts a sparse company referenced as someone's investor
 *   - Excludes companies with primary_domain set
 *   - Excludes companies with description set
 *   - Excludes companies with entity_type != 'unknown'
 *   - Excludes companies with meeting/email activity
 *   - Excludes orphan companies that aren't referenced as an investor anywhere
 *   - listCompanies({ view: 'stubs' }) returns the same set
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

import { countStubCompanies, listCompanies } from '@cyggie/db/sqlite/repositories/org-company.repo'

function buildSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      deleted_at TEXT,
      normalized_name TEXT UNIQUE NOT NULL,
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
      include_in_companies_view INTEGER NOT NULL DEFAULT 1,
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
      source_type TEXT,
      source_entity_type TEXT,
      source_entity_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      date TEXT
    );
    CREATE TABLE email_company_links (
      message_id TEXT NOT NULL,
      company_id TEXT NOT NULL
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT
    );
    CREATE TABLE email_message_participants (
      message_id TEXT NOT NULL,
      contact_id TEXT NOT NULL
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      primary_company_id TEXT
    );
    CREATE TABLE org_company_contacts (
      contact_id TEXT NOT NULL,
      company_id TEXT NOT NULL
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      created_at TEXT
    );
  `)
}

interface CompanyOpts {
  id: string
  name: string
  entityType?: string
  primaryDomain?: string | null
  description?: string | null
  leadInvestor?: string | null
}

function insertCompany(opts: CompanyOpts): void {
  const norm = opts.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  testDb.prepare(`
    INSERT INTO org_companies (id, canonical_name, normalized_name, entity_type, primary_domain, description, lead_investor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opts.id, opts.name, norm, opts.entityType ?? 'unknown', opts.primaryDomain ?? null, opts.description ?? null, opts.leadInvestor ?? null)
}

function linkInvestor(companyId: string, investorId: string): void {
  testDb.prepare(`INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES (?, ?, ?, 'co_investor')`)
    .run(randomUUID(), companyId, investorId)
}

function linkMeeting(companyId: string): void {
  const mid = randomUUID()
  testDb.prepare(`INSERT INTO meetings (id, date) VALUES (?, datetime('now'))`).run(mid)
  testDb.prepare(`INSERT INTO meeting_company_links (meeting_id, company_id) VALUES (?, ?)`).run(mid, companyId)
}

describe('countStubCompanies', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    buildSchema(testDb)
  })

  it('returns 0 when no qualifying stubs exist', () => {
    expect(countStubCompanies()).toBe(0)
  })

  it('counts a sparse company referenced as a co-investor', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 'stub', name: 'Sparse Stub' })
    linkInvestor('portco', 'stub')
    expect(countStubCompanies()).toBe(1)
  })

  it('excludes companies with primary_domain set', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 'enriched', name: 'Sequoia', primaryDomain: 'sequoiacap.com' })
    linkInvestor('portco', 'enriched')
    expect(countStubCompanies()).toBe(0)
  })

  it('excludes companies with description set', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 'enriched', name: 'Sequoia', description: 'Top-tier VC' })
    linkInvestor('portco', 'enriched')
    expect(countStubCompanies()).toBe(0)
  })

  it('excludes non-unknown entity_type', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 'real', name: 'Sequoia', entityType: 'vc_fund' })
    linkInvestor('portco', 'real')
    expect(countStubCompanies()).toBe(0)
  })

  it('excludes companies with meeting activity', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 'active', name: 'Active Stub' })
    linkInvestor('portco', 'active')
    linkMeeting('active')
    expect(countStubCompanies()).toBe(0)
  })

  it('excludes orphans not referenced as any investor', () => {
    insertCompany({ id: 'orphan', name: 'Lonely Stub' })
    expect(countStubCompanies()).toBe(0)
  })

  it('counts multiple distinct stubs', () => {
    insertCompany({ id: 'portco', name: 'PortCo' })
    insertCompany({ id: 's1', name: 'Stub A' })
    insertCompany({ id: 's2', name: 'Stub B' })
    insertCompany({ id: 's3', name: 'Stub C' })
    linkInvestor('portco', 's1')
    linkInvestor('portco', 's2')
    linkInvestor('portco', 's3')
    expect(countStubCompanies()).toBe(3)
  })
})

describe('listCompanies({ view: stubs })', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    buildSchema(testDb)
  })

  it('returns stub-likely companies and excludes the rest', () => {
    insertCompany({ id: 'portco', name: 'PortCo', primaryDomain: 'portco.com' })
    insertCompany({ id: 'stub', name: 'Sparse Stub' })
    insertCompany({ id: 'enriched', name: 'Sequoia', entityType: 'vc_fund' })
    linkInvestor('portco', 'stub')
    linkInvestor('portco', 'enriched')

    const stubs = listCompanies({ view: 'stubs' })
    const ids = stubs.map((c) => c.id).sort()
    expect(ids).toEqual(['stub'])
  })
})
