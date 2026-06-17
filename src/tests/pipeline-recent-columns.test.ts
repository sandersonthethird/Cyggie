/**
 * Tests for the "Recent Pass" / "Recent Portfolio" pipeline filter — guards
 * the bug fix where a company moved to Pass/Portfolio must appear in the
 * kanban for 14 days, then roll off.
 *
 * Covers `listPipelineCompanies` with `passExpiryBefore` and
 * `portfolioExpiryBefore` against a real in-memory SQLite + real
 * `company_decision_logs` rows of type 'Stage Change'.
 *
 * Sections:
 *   1. Recent Pass — fresh log included; stale log excluded
 *   2. Recent Portfolio — fresh log included; stale log excluded
 *   3. Legacy data (no Stage Change log) — terminal rows EXCLUDED (NULL
 *      semantics drop the row from WHERE; intended UX)
 *   4. Non-terminal stages are unaffected by either expiry filter
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

vi.mock('@cyggie/db/sqlite/repositories/audit.repo', () => ({
  logAudit: () => undefined
}))

const { listPipelineCompanies } = await import('@cyggie/db/sqlite/repositories/org-company.repo')
const { SYSTEM_DECISION_TYPE_STAGE_CHANGE } = await import('@shared/types/company')

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

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      primary_company_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

function insertCompanyAt(
  db: Database.Database,
  id: string,
  name: string,
  stage: string | null,
): void {
  db.prepare(
    `INSERT INTO org_companies (id, canonical_name, normalized_name, pipeline_stage) VALUES (?, ?, ?, ?)`
  ).run(id, name, name.toLowerCase(), stage)
}

function insertStageChangeLog(
  db: Database.Database,
  companyId: string,
  decisionDate: string,
): void {
  db.prepare(
    `INSERT INTO company_decision_logs (id, company_id, decision_type, decision_date) VALUES (?, ?, ?, ?)`
  ).run(`log-${companyId}-${decisionDate}`, companyId, SYSTEM_DECISION_TYPE_STAGE_CHANGE, decisionDate)
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString()
}

const cutoff14d = () => new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)

// ─── 1. Recent Pass ───────────────────────────────────────────────────────────

describe('listPipelineCompanies — Recent Pass window', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('includes a pass-stage company whose Stage Change log is within 14 days', () => {
    insertCompanyAt(testDb, 'co-fresh-pass', 'Fresh Pass Co', 'pass')
    insertStageChangeLog(testDb, 'co-fresh-pass', daysAgoISO(3))

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).toContain('co-fresh-pass')
  })

  it('excludes a pass-stage company whose Stage Change log is older than 14 days', () => {
    insertCompanyAt(testDb, 'co-stale-pass', 'Stale Pass Co', 'pass')
    insertStageChangeLog(testDb, 'co-stale-pass', daysAgoISO(20))

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).not.toContain('co-stale-pass')
  })

  it('uses the MOST RECENT Stage Change log when multiple exist', () => {
    insertCompanyAt(testDb, 'co-multi', 'Multi Log Co', 'pass')
    insertStageChangeLog(testDb, 'co-multi', daysAgoISO(30))
    insertStageChangeLog(testDb, 'co-multi', daysAgoISO(5))

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).toContain('co-multi')
  })
})

// ─── 2. Recent Portfolio ──────────────────────────────────────────────────────

describe('listPipelineCompanies — Recent Portfolio window', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('includes a portfolio-stage company whose Stage Change log is within 14 days', () => {
    insertCompanyAt(testDb, 'co-fresh-port', 'Fresh Portfolio Co', 'portfolio')
    insertStageChangeLog(testDb, 'co-fresh-port', daysAgoISO(2))

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).toContain('co-fresh-port')
  })

  it('excludes a portfolio-stage company whose Stage Change log is older than 14 days', () => {
    insertCompanyAt(testDb, 'co-stale-port', 'Stale Portfolio Co', 'portfolio')
    insertStageChangeLog(testDb, 'co-stale-port', daysAgoISO(60))

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).not.toContain('co-stale-port')
  })

  it('Recent Pass cutoff does not affect portfolio companies and vice versa', () => {
    // A portfolio company with no stale pass-cutoff filter applied should still
    // be filtered by its own portfolio-cutoff. Verifies the two clauses are
    // independent.
    insertCompanyAt(testDb, 'co-port-stale', 'Stale Port', 'portfolio')
    insertStageChangeLog(testDb, 'co-port-stale', daysAgoISO(60))

    const onlyPass = listPipelineCompanies({ passExpiryBefore: cutoff14d() })
    const both = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(onlyPass.map(c => c.id)).toContain('co-port-stale')  // portfolio filter not applied
    expect(both.map(c => c.id)).not.toContain('co-port-stale')  // both applied
  })
})

// ─── 3. Legacy data: no Stage Change log → excluded ──────────────────────────

describe('listPipelineCompanies — legacy terminal rows (no Stage Change log)', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('excludes a pass-stage company that has NO Stage Change log (NULL semantics)', () => {
    // This is the regression guard for the deceptive SQLite NULL behavior:
    // (SELECT MAX(...) returning NULL) < cutoff → NULL → NOT NULL → NULL → row dropped.
    // The intended UX: legacy pass companies (pre-dating the auto-log) stay out
    // of the Recent Pass column. If this test fails after a future filter rewrite,
    // the user will see a flood of stale terminal rows.
    insertCompanyAt(testDb, 'co-legacy-pass', 'Legacy Pass Co', 'pass')
    // No log inserted.

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).not.toContain('co-legacy-pass')
  })

  it('excludes a portfolio-stage company that has NO Stage Change log', () => {
    insertCompanyAt(testDb, 'co-legacy-port', 'Legacy Portfolio Co', 'portfolio')

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).not.toContain('co-legacy-port')
  })
})

// ─── 4. Non-terminal stages unaffected ───────────────────────────────────────

describe('listPipelineCompanies — non-terminal stages are unaffected by expiry filters', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it.each([
    ['screening'],
    ['diligence'],
    ['decision'],
    ['documentation'],
  ])('includes %s-stage company regardless of expiry cutoffs', (stage) => {
    insertCompanyAt(testDb, `co-${stage}`, `${stage} Co`, stage)
    // No log inserted — should still be included since the filter only targets pass + portfolio.

    const results = listPipelineCompanies({
      passExpiryBefore: cutoff14d(),
      portfolioExpiryBefore: cutoff14d(),
    })

    expect(results.map(c => c.id)).toContain(`co-${stage}`)
  })
})
