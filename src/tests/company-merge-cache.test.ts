/**
 * Tests for mergeCompanies() denormalized cache update.
 *
 * Verifies that when merging company A into company B, the
 * meetings.companies JSON column is updated to replace A's name with B's.
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { mergeCompanies } = await import(
  '@cyggie/db/sqlite/repositories/org-company.repo'
)

// ---------------------------------------------------------------------------
// Schema: minimal tables required by mergeCompanies + getCompany
// ---------------------------------------------------------------------------
function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
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
      industry                 TEXT,
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

    CREATE TABLE meetings (
      id        TEXT PRIMARY KEY,
      date      TEXT,
      companies TEXT
    );
    CREATE TABLE meeting_company_links (
      meeting_id  TEXT NOT NULL,
      company_id  TEXT NOT NULL,
      confidence  REAL DEFAULT 1.0,
      linked_by   TEXT DEFAULT 'manual',
      created_at  TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (meeting_id, company_id)
    );

    CREATE TABLE email_messages (id TEXT PRIMARY KEY, received_at TEXT, sent_at TEXT, created_at TEXT);
    CREATE TABLE email_company_links (
      message_id TEXT NOT NULL, company_id TEXT NOT NULL,
      confidence REAL, linked_by TEXT, reason TEXT, created_at TEXT,
      PRIMARY KEY (message_id, company_id)
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL,
      primary_company_id TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE email_message_participants (message_id TEXT, contact_id TEXT);
    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      role_label TEXT, is_primary INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, contact_id)
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      contact_id TEXT,
      source_meeting_id TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE themes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE org_company_themes (
      company_id TEXT NOT NULL, theme_id TEXT NOT NULL,
      relevance_score REAL, rationale TEXT, linked_by TEXT,
      last_reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, theme_id)
    );

    CREATE TABLE deals (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE company_conversations (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE investment_memos (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE theses (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL, alias_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, alias_value, alias_type)
    );

    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, user_id TEXT, entity_type TEXT, entity_id TEXT,
      action TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE companies (
      domain TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      enriched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insertCompany(db: Database.Database, id: string, name: string) {
  db.prepare(`
    INSERT INTO org_companies (id, canonical_name, normalized_name, status, entity_type)
    VALUES (?, ?, ?, 'active', 'prospect')
  `).run(id, name, name.toLowerCase())
}

function insertMeeting(db: Database.Database, id: string, companies: string[]) {
  db.prepare('INSERT INTO meetings (id, companies) VALUES (?, ?)').run(id, JSON.stringify(companies))
}

function linkMeetingCompany(db: Database.Database, meetingId: string, companyId: string) {
  db.prepare('INSERT INTO meeting_company_links (meeting_id, company_id) VALUES (?, ?)').run(meetingId, companyId)
}

function getMeetingCompanies(db: Database.Database, meetingId: string): string[] {
  const row = db.prepare('SELECT companies FROM meetings WHERE id = ?').get(meetingId) as { companies: string | null }
  return row?.companies ? JSON.parse(row.companies) : []
}

describe('mergeCompanies – denormalized cache update', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('replaces source company name with target in meetings.companies JSON', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'Get Revamp')
    insertMeeting(testDb, 'meeting-1', ['Get Revamp', 'Acme Corp'])
    linkMeetingCompany(testDb, 'meeting-1', 'source-1')

    mergeCompanies('target-1', 'source-1')

    const companies = getMeetingCompanies(testDb, 'meeting-1')
    expect(companies).toContain('Revamp')
    expect(companies).toContain('Acme Corp')
    expect(companies).not.toContain('Get Revamp')
  })

  it('does not duplicate target name if already present in JSON', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'Get Revamp')
    insertMeeting(testDb, 'meeting-1', ['Get Revamp', 'Revamp'])
    linkMeetingCompany(testDb, 'meeting-1', 'source-1')

    mergeCompanies('target-1', 'source-1')

    const companies = getMeetingCompanies(testDb, 'meeting-1')
    const revampCount = companies.filter((n: string) => n === 'Revamp').length
    expect(revampCount).toBe(1)
    expect(companies).not.toContain('Get Revamp')
  })

  it('handles case-insensitive name matching', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'get revamp')
    insertMeeting(testDb, 'meeting-1', ['Get Revamp'])
    linkMeetingCompany(testDb, 'meeting-1', 'source-1')

    mergeCompanies('target-1', 'source-1')

    const companies = getMeetingCompanies(testDb, 'meeting-1')
    expect(companies).toContain('Revamp')
    expect(companies).not.toContain('Get Revamp')
  })

  it('leaves unaffected meetings untouched', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'Get Revamp')
    insertMeeting(testDb, 'meeting-1', ['Acme Corp'])
    // meeting-1 is NOT linked to source company

    mergeCompanies('target-1', 'source-1')

    const companies = getMeetingCompanies(testDb, 'meeting-1')
    expect(companies).toEqual(['Acme Corp'])
  })
})

describe('mergeCompanies – companies cache cleanup', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('deletes cache rows whose display_name matches the source name (case-insensitive)', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'Get Revamp')

    // Two cache rows that should disappear: exact case and lowercase variant.
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('a.example', 'Get Revamp')`).run()
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('b.example', 'get revamp')`).run()

    mergeCompanies('target-1', 'source-1')

    const remaining = testDb.prepare(`SELECT domain FROM companies ORDER BY domain`).all()
    expect(remaining).toEqual([])
  })

  it("rewrites cache rows keyed by source's primary_domain to use target's canonical_name", () => {
    // Future calendar ingest from source's domain should surface the target's
    // name. Before this fix, the cache would still serve the merged-away
    // source name to enrichCompany on cache hit.
    insertCompany(testDb, 'target-1', 'Revamp')
    // source has primary_domain set so the merge picks it up.
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, normalized_name, status, entity_type, primary_domain)
      VALUES ('source-1', 'Get Revamp', 'get revamp', 'active', 'prospect', 'source-domain.example')
    `).run()

    // Cache row stored "Get Revamp" against source's domain (typical for a
    // calendar-ingest auto-created company).
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('source-domain.example', 'Get Revamp')`).run()

    mergeCompanies('target-1', 'source-1')

    const cacheRow = testDb.prepare(`SELECT domain, display_name FROM companies WHERE domain = ?`).get('source-domain.example') as { domain: string; display_name: string }
    expect(cacheRow.display_name).toBe('Revamp')
  })

  it("rewrites cache rows keyed by source's alias domains too", () => {
    // Source has primary_domain plus an alias domain. After merge, both
    // domains should serve the target's name from the legacy cache.
    insertCompany(testDb, 'target-1', 'Revamp')
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, normalized_name, status, entity_type, primary_domain)
      VALUES ('source-1', 'Get Revamp', 'get revamp', 'active', 'prospect', 'src1.example')
    `).run()
    testDb.prepare(`
      INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type)
      VALUES ('al1', 'source-1', 'src2.example', 'domain')
    `).run()

    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('src1.example', 'Get Revamp')`).run()
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('src2.example', 'Some Other Stale Name')`).run()

    mergeCompanies('target-1', 'source-1')

    const rows = testDb.prepare(`SELECT domain, display_name FROM companies ORDER BY domain`).all()
    expect(rows).toEqual([
      { domain: 'src1.example', display_name: 'Revamp' },
      { domain: 'src2.example', display_name: 'Revamp' }
    ])
  })

  it('leaves unrelated cache rows alone', () => {
    insertCompany(testDb, 'target-1', 'Revamp')
    insertCompany(testDb, 'source-1', 'Get Revamp')

    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('keep.example', 'KeepCo')`).run()

    mergeCompanies('target-1', 'source-1')

    const remaining = testDb.prepare(`SELECT domain, display_name FROM companies ORDER BY domain`).all()
    expect(remaining).toEqual([{ domain: 'keep.example', display_name: 'KeepCo' }])
  })
})
