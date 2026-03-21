/**
 * Integration tests for fixConcatenatedCompanyNames() in org-company.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *
 * Fix-pass algorithm (applied in order, first match wins):
 *   1. CamelCase split:   "AcmeCorp"        → "Acme Corp"         (high confidence)
 *   2. DOMAIN_WORDS:      "redswanventures" → "Red Swan Ventures"  (medium confidence)
 *   3. Suffix regex:      "bowleycapital"   → "Bowley Capital"     (lower confidence)
 *
 * On conflict (suggested name already exists): mergeCompanies(existing, current)
 * On success: updateCompany + logAudit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { fixConcatenatedCompanyNames } = await import(
  '../main/database/repositories/org-company.repo'
)

// ---------------------------------------------------------------------------
// Schema: all tables required by fixConcatenatedCompanyNames, updateCompany
// (→ getCompany → baseCompanySelect), mergeCompanies, and logAudit.
// ---------------------------------------------------------------------------
function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    -- Primary companies table: all columns read by baseCompanySelect + updateCompany
    CREATE TABLE org_companies (
      id                       TEXT PRIMARY KEY,
      canonical_name           TEXT NOT NULL,
      normalized_name          TEXT,
      description              TEXT,
      primary_domain           TEXT,
      website_url              TEXT,
      city                     TEXT,
      state                    TEXT,
      stage                    TEXT,
      status                   TEXT DEFAULT 'active',
      crm_provider             TEXT,
      crm_company_id           TEXT,
      entity_type              TEXT DEFAULT 'unknown',
      include_in_companies_view INTEGER DEFAULT 0,
      classification_source    TEXT DEFAULT 'manual',
      classification_confidence REAL,
      priority                 TEXT,
      post_money_valuation     REAL,
      raise_size               REAL,
      round                    TEXT,
      pipeline_stage           TEXT,
      founding_year            INTEGER,
      employee_count_range     TEXT,
      hq_address               TEXT,
      linkedin_company_url     TEXT,
      twitter_handle           TEXT,
      crunchbase_url           TEXT,
      angellist_url            TEXT,
      sector                   TEXT,
      target_customer          TEXT,
      business_model           TEXT,
      product_stage            TEXT,
      revenue_model            TEXT,
      arr                      REAL,
      burn_rate                REAL,
      runway_months            REAL,
      last_funding_date        TEXT,
      total_funding_raised     REAL,
      lead_investor            TEXT,
      co_investors             TEXT,
      source_type              TEXT,
      source_entity_type       TEXT,
      source_entity_id         TEXT,
      relationship_owner       TEXT,
      deal_source              TEXT,
      warm_intro_source        TEXT,
      referral_contact_id      TEXT,
      next_followup_date       TEXT,
      field_sources            TEXT,
      updated_by_user_id       TEXT,
      created_at               TEXT DEFAULT (datetime('now')),
      updated_at               TEXT DEFAULT (datetime('now'))
    );

    -- Stub tables for baseCompanySelect LEFT JOINs (empty = COALESCE to 0)
    CREATE TABLE meetings (id TEXT PRIMARY KEY, date TEXT);
    CREATE TABLE meeting_company_links (
      meeting_id  TEXT NOT NULL,
      company_id  TEXT NOT NULL,
      confidence  REAL,
      linked_by   TEXT,
      created_at  TEXT,
      PRIMARY KEY (meeting_id, company_id)
    );
    CREATE TABLE email_messages (
      id          TEXT PRIMARY KEY,
      received_at TEXT,
      sent_at     TEXT,
      created_at  TEXT
    );
    CREATE TABLE email_company_links (
      message_id  TEXT NOT NULL,
      company_id  TEXT NOT NULL,
      confidence  REAL,
      linked_by   TEXT,
      reason      TEXT,
      created_at  TEXT,
      PRIMARY KEY (message_id, company_id)
    );
    CREATE TABLE contacts (
      id                 TEXT PRIMARY KEY,
      full_name          TEXT NOT NULL,
      primary_company_id TEXT,
      updated_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE email_message_participants (message_id TEXT, contact_id TEXT);
    CREATE TABLE org_company_contacts (
      company_id  TEXT NOT NULL,
      contact_id  TEXT NOT NULL,
      role_label  TEXT,
      is_primary  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, contact_id)
    );
    CREATE TABLE notes (
      id         TEXT PRIMARY KEY,
      company_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Needed by getCompany (industries + themes lookups)
    CREATE TABLE industries (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE org_company_industries (
      company_id  TEXT NOT NULL,
      industry_id TEXT NOT NULL,
      confidence  REAL,
      is_primary  INTEGER DEFAULT 0,
      tagged_by   TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, industry_id)
    );
    CREATE TABLE themes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE org_company_themes (
      company_id      TEXT NOT NULL,
      theme_id        TEXT NOT NULL,
      relevance_score REAL,
      rationale       TEXT,
      linked_by       TEXT,
      last_reviewed_at TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, theme_id)
    );

    -- Tables for mergeCompanies
    CREATE TABLE deals (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE company_conversations (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE investment_memos (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE theses (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);

    -- For upsertCompanyAlias (called by updateCompany) + findCompanyIdByNameOrDomain
    CREATE TABLE org_company_aliases (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type  TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, alias_value, alias_type)
    );

    -- For logAudit
    CREATE TABLE audit_log (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,
      entity_type TEXT,
      entity_id   TEXT,
      action      TEXT,
      changes_json TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

// Inserts a company with the normalized_name derived the same way normalizeCompanyName() does.
function insertCompany(id: string, name: string): void {
  const normalized = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  testDb.prepare(
    `INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES (?, ?, ?)`
  ).run(id, name, normalized)
}

// ---------------------------------------------------------------------------

describe('fixConcatenatedCompanyNames', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  // ─── Step 1: CamelCase ──────────────────────────────────────────────────────

  it('renames CamelCase company: "AcmeCorp" → "Acme Corp"', () => {
    insertCompany('co1', 'AcmeCorp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.merged).toBe(0)
    expect(result.changes).toHaveLength(1)
    expect(result.changes[0]).toMatchObject({
      id: 'co1',
      before: 'AcmeCorp',
      after: 'Acme Corp',
      action: 'renamed',
    })
    const row = testDb.prepare('SELECT canonical_name FROM org_companies WHERE id = ?').get('co1') as { canonical_name: string }
    expect(row.canonical_name).toBe('Acme Corp')
  })

  it('renames multi-word CamelCase: "BowleyCapital" → "Bowley Capital"', () => {
    insertCompany('co1', 'BowleyCapital')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0].after).toBe('Bowley Capital')
  })

  // ─── Step 2: DOMAIN_WORDS segmentation ─────────────────────────────────────

  it('renames via DOMAIN_WORDS: "redswanventures" → "Red Swan Ventures"', () => {
    insertCompany('co1', 'redswanventures')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0]).toMatchObject({
      before: 'redswanventures',
      after: 'Red Swan Ventures',
      action: 'renamed',
    })
  })

  it('renames via DOMAIN_WORDS with new legal suffixes: "nextcorp" → "Next Corp"', () => {
    insertCompany('co1', 'nextcorp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0].after).toBe('Next Corp')
  })

  // ─── Step 3: Suffix regex fallback ─────────────────────────────────────────

  it('renames via suffix regex: "bowleycapital" → "Bowley Capital"', () => {
    insertCompany('co1', 'bowleycapital')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(1)
    expect(result.changes[0]).toMatchObject({
      before: 'bowleycapital',
      after: 'Bowley Capital',
      action: 'renamed',
    })
  })

  // ─── Conflict → merge ───────────────────────────────────────────────────────

  it('merges "AcmeCorp" into existing "Acme Corp"', () => {
    insertCompany('co-canonical', 'Acme Corp')  // canonical already exists
    insertCompany('co-concat', 'AcmeCorp')      // concatenated duplicate
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
    expect(result.merged).toBe(1)
    expect(result.changes[0]).toMatchObject({
      id: 'co-concat',
      before: 'AcmeCorp',
      after: 'Acme Corp',
      action: 'merged',
    })
    // Source company should be deleted after merge
    const gone = testDb.prepare('SELECT id FROM org_companies WHERE id = ?').get('co-concat')
    expect(gone).toBeUndefined()
    // Canonical company should survive
    const canonical = testDb.prepare('SELECT id FROM org_companies WHERE id = ?').get('co-canonical')
    expect(canonical).toBeDefined()
  })

  // ─── Skip guards ───────────────────────────────────────────────────────────

  it('skips all-uppercase names (abbreviations like "IBM")', () => {
    insertCompany('co1', 'IBM')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
    expect(result.merged).toBe(0)
    expect(result.changes).toHaveLength(0)
  })

  it('skips names with length ≤ 3 ("AI")', () => {
    insertCompany('co1', 'AI')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names that cannot be segmented ("Stripe")', () => {
    insertCompany('co1', 'Stripe')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names containing digits', () => {
    insertCompany('co1', 'Web3Corp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  it('skips names already containing a space (idempotent guard)', () => {
    insertCompany('co1', 'Acme Corp')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(0)
  })

  // ─── Idempotency ───────────────────────────────────────────────────────────

  it('is idempotent: second run returns zero changes', () => {
    insertCompany('co1', 'AcmeCorp')
    const first = fixConcatenatedCompanyNames(null)
    expect(first.fixed).toBe(1)

    const second = fixConcatenatedCompanyNames(null)
    expect(second.fixed).toBe(0)
    expect(second.merged).toBe(0)
    expect(second.changes).toHaveLength(0)
  })

  // ─── Multiple companies in one pass ────────────────────────────────────────

  it('processes multiple companies in a single pass', () => {
    insertCompany('co1', 'AcmeCorp')
    insertCompany('co2', 'redswanventures')
    const result = fixConcatenatedCompanyNames(null)
    expect(result.fixed).toBe(2)
    const names = result.changes.map(c => c.after)
    expect(names).toContain('Acme Corp')
    expect(names).toContain('Red Swan Ventures')
  })

  // ─── Audit logging ─────────────────────────────────────────────────────────

  it('writes an audit_log entry for each rename', () => {
    insertCompany('co1', 'AcmeCorp')
    fixConcatenatedCompanyNames('user-123')
    const log = testDb.prepare('SELECT * FROM audit_log WHERE entity_id = ?').get('co1') as {
      user_id: string; action: string; changes_json: string
    } | undefined
    expect(log).toBeDefined()
    expect(log!.user_id).toBe('user-123')
    expect(log!.action).toBe('update')
    const changes = JSON.parse(log!.changes_json)
    expect(changes.before).toBe('AcmeCorp')
    expect(changes.after).toBe('Acme Corp')
  })
})
