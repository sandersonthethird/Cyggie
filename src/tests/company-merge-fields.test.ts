/**
 * Tests for the per-field merge logic in mergeCompanies + getCompanyMergePreview.
 *
 * Covers:
 *   - Auto-fill from source when target column is null/empty (no override given)
 *   - Target wins on conflict by default (no override given)
 *   - fieldOverrides supplies the final value (any value, including null and
 *     custom strings — backend doesn't second-guess)
 *   - canonical_name is NOT mergeable
 *   - Investor relinks (lead_investor_company_id on other companies +
 *     company_investors rows in both directions)
 *   - getCompanyMergePreview classifies fields into conflicts / autoFill /
 *     equal-skip correctly
 *
 * Schema mirrors the production columns relevant to mergeCompanies. We keep it
 * minimal — the broader merge waterfall (notes/themes/aliases/etc) is already
 * tested by company-merge-cache.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { mergeCompanies, getCompanyMergePreview } = await import(
  '../main/database/repositories/org-company.repo'
)

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
      lead_investor_company_id TEXT,
      key_takeaways            TEXT,
      field_sources            TEXT,
      created_at               TEXT DEFAULT (datetime('now')),
      updated_at               TEXT DEFAULT (datetime('now'))
    );

    -- Tables touched by the merge waterfall (kept minimal — most are empty in
    -- these tests). Schemas match what mergeCompanies actually writes to.
    CREATE TABLE meetings (id TEXT PRIMARY KEY, date TEXT, companies TEXT);
    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL, company_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0, linked_by TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (meeting_id, company_id)
    );
    CREATE TABLE email_company_links (
      message_id TEXT NOT NULL, company_id TEXT NOT NULL,
      confidence REAL, linked_by TEXT, reason TEXT, created_at TEXT,
      PRIMARY KEY (message_id, company_id)
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT,
      primary_company_id TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      role_label TEXT, is_primary INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, contact_id)
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY, company_id TEXT, contact_id TEXT,
      source_meeting_id TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE deals (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE investment_memos (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE org_company_themes (
      company_id TEXT NOT NULL, theme_id TEXT NOT NULL,
      relevance_score REAL, rationale TEXT, linked_by TEXT,
      last_reviewed_at TEXT, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, theme_id)
    );
    CREATE TABLE theses (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, company_id TEXT, updated_at TEXT);
    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL, alias_type TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, alias_value, alias_type)
    );
    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      investor_company_id TEXT NOT NULL,
      investor_type TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(company_id, investor_company_id, investor_type),
      FOREIGN KEY (company_id) REFERENCES org_companies(id) ON DELETE CASCADE,
      FOREIGN KEY (investor_company_id) REFERENCES org_companies(id) ON DELETE CASCADE
    );
    CREATE TABLE companies (
      domain TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      enriched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, user_id TEXT, entity_type TEXT, entity_id TEXT,
      action TEXT, details TEXT, created_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insertCompany(id: string, name: string, fields: Record<string, unknown> = {}): void {
  const cols = Object.keys(fields)
  const colList = ['id', 'canonical_name', ...cols].map((c) => `"${c}"`).join(', ')
  const placeholders = ['?', '?', ...cols.map(() => '?')].join(', ')
  const values = [id, name, ...cols.map((c) => fields[c])]
  testDb.prepare(`INSERT INTO org_companies (${colList}) VALUES (${placeholders})`).run(...values)
}

function readCompany(id: string): Record<string, unknown> {
  return testDb.prepare('SELECT * FROM org_companies WHERE id = ?').get(id) as Record<string, unknown>
}

describe('mergeCompanies — per-field resolution', () => {
  beforeEach(() => { testDb = buildDb() })

  it('auto-fills source value when target column is null', () => {
    insertCompany('t1', 'TargetCo', { description: null, city: 'NYC' })
    insertCompany('s1', 'SourceCo', { description: 'A long detailed description', city: null })

    mergeCompanies('t1', 's1')

    const t = readCompany('t1')
    expect(t.description).toBe('A long detailed description')
    expect(t.city).toBe('NYC')
  })

  it('auto-fills source value when target column is empty string or whitespace', () => {
    insertCompany('t1', 'TargetCo', { description: '', city: '   ' })
    insertCompany('s1', 'SourceCo', { description: 'src desc', city: 'SF' })

    mergeCompanies('t1', 's1')

    const t = readCompany('t1')
    expect(t.description).toBe('src desc')
    expect(t.city).toBe('SF')
  })

  it('keeps target value on conflict when no override is given', () => {
    insertCompany('t1', 'TargetCo', { description: 'TARGET', city: 'NYC' })
    insertCompany('s1', 'SourceCo', { description: 'SOURCE', city: 'SF' })

    mergeCompanies('t1', 's1')

    const t = readCompany('t1')
    expect(t.description).toBe('TARGET')
    expect(t.city).toBe('NYC')
  })

  it('takes source value when fieldOverrides specifies it', () => {
    insertCompany('t1', 'TargetCo', { description: 'TARGET', city: 'NYC' })
    insertCompany('s1', 'SourceCo', { description: 'SOURCE', city: 'SF' })

    mergeCompanies('t1', 's1', { description: 'SOURCE' })

    const t = readCompany('t1')
    expect(t.description).toBe('SOURCE')
    expect(t.city).toBe('NYC')
  })

  it('accepts arbitrary override values (e.g. concatenated)', () => {
    insertCompany('t1', 'TargetCo', { description: 'TARGET' })
    insertCompany('s1', 'SourceCo', { description: 'SOURCE' })

    mergeCompanies('t1', 's1', { description: 'TARGET / SOURCE' })

    expect(readCompany('t1').description).toBe('TARGET / SOURCE')
  })

  it('explicit null override wins over auto-fill', () => {
    insertCompany('t1', 'TargetCo', { description: null })
    insertCompany('s1', 'SourceCo', { description: 'src' })

    // User explicitly chose to drop source's value despite target being empty.
    mergeCompanies('t1', 's1', { description: null })

    expect(readCompany('t1').description).toBeNull()
  })

  it('canonical_name is NOT mergeable — overrides are silently ignored', () => {
    insertCompany('t1', 'TargetCo')
    insertCompany('s1', 'SourceCo')

    // canonical_name is not in MERGEABLE_COLUMNS — override should be a no-op.
    mergeCompanies('t1', 's1', { canonical_name: 'Hacked' })

    expect(readCompany('t1').canonical_name).toBe('TargetCo')
  })

  it('does not generate a spurious UPDATE when target and source agree', () => {
    insertCompany('t1', 'TargetCo', { city: 'SF', founding_year: 2020 })
    insertCompany('s1', 'SourceCo', { city: 'SF', founding_year: 2020 })

    mergeCompanies('t1', 's1')

    const t = readCompany('t1')
    expect(t.city).toBe('SF')
    expect(t.founding_year).toBe(2020)
  })

  it('handles many fields at once with a mix of conflicts, auto-fills, and equal values', () => {
    insertCompany('t1', 'TargetCo', {
      description: 'T desc',
      city: null,
      stage: 'Series A',
      industry: 'fintech',
      founding_year: null
    })
    insertCompany('s1', 'SourceCo', {
      description: 'S desc',
      city: 'SF',
      stage: 'Series A',     // equal — passes through
      industry: 'fintech-b', // conflict — target wins by default
      founding_year: 2019    // auto-fill from source
    })

    mergeCompanies('t1', 's1', { description: 'S desc' })

    const t = readCompany('t1')
    expect(t.description).toBe('S desc')   // override
    expect(t.city).toBe('SF')              // auto-fill
    expect(t.stage).toBe('Series A')       // equal
    expect(t.industry).toBe('fintech')     // target wins
    expect(t.founding_year).toBe(2019)     // auto-fill numeric
  })
})

describe('mergeCompanies — investor relinks', () => {
  beforeEach(() => { testDb = buildDb() })

  it("repoints other companies' lead_investor_company_id from source to target", () => {
    insertCompany('t1', 'TargetInvestor')
    insertCompany('s1', 'SourceInvestor')
    insertCompany('p1', 'Portfolio1', { lead_investor_company_id: 's1' })
    insertCompany('p2', 'Portfolio2', { lead_investor_company_id: 's1' })
    // A company that points at a third investor — must not be touched.
    insertCompany('q1', 'OtherInvestor')
    insertCompany('p3', 'Portfolio3', { lead_investor_company_id: 'q1' })

    mergeCompanies('t1', 's1')

    expect(readCompany('p1').lead_investor_company_id).toBe('t1')
    expect(readCompany('p2').lead_investor_company_id).toBe('t1')
    expect(readCompany('p3').lead_investor_company_id).toBe('q1')
  })

  it('moves company_investors rows where source is the investor side (e.g. source was a co-investor in another)', () => {
    insertCompany('t1', 'TargetInvestor')
    insertCompany('s1', 'SourceInvestor')
    insertCompany('p1', 'Portfolio1')

    // p1 has source as a co-investor.
    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci1', 'p1', 's1', 'co_investor', 0)
    `).run()

    mergeCompanies('t1', 's1')

    const rows = testDb.prepare(
      `SELECT company_id, investor_company_id, investor_type FROM company_investors`
    ).all()
    expect(rows).toEqual([{ company_id: 'p1', investor_company_id: 't1', investor_type: 'co_investor' }])
  })

  it('moves company_investors rows where source is the company side (e.g. source had its own investors)', () => {
    insertCompany('t1', 'TargetCo')
    insertCompany('s1', 'SourceCo')
    insertCompany('vc1', 'VC1')

    // s1 had vc1 as a lead investor.
    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci1', 's1', 'vc1', 'lead', 0)
    `).run()

    mergeCompanies('t1', 's1')

    const rows = testDb.prepare(
      `SELECT company_id, investor_company_id, investor_type FROM company_investors`
    ).all()
    expect(rows).toEqual([{ company_id: 't1', investor_company_id: 'vc1', investor_type: 'lead' }])
  })

  it('dedupes when target already has the same investor relationship', () => {
    insertCompany('t1', 'TargetCo')
    insertCompany('s1', 'SourceCo')
    insertCompany('vc1', 'VC1')

    // Both target and source had vc1 as lead. After merge, only one row should remain.
    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci1', 't1', 'vc1', 'lead', 0)
    `).run()
    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci2', 's1', 'vc1', 'lead', 0)
    `).run()

    mergeCompanies('t1', 's1')

    const rows = testDb.prepare(
      `SELECT company_id, investor_company_id, investor_type FROM company_investors ORDER BY id`
    ).all()
    expect(rows).toEqual([{ company_id: 't1', investor_company_id: 'vc1', investor_type: 'lead' }])
  })

  it('drops a self-investment edge that would form when source had target as investor', () => {
    insertCompany('t1', 'TargetCo')
    insertCompany('s1', 'SourceCo')

    // s1 had t1 as a lead — naive relink would create (t1, t1, lead) self-edge.
    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci1', 's1', 't1', 'lead', 0)
    `).run()

    mergeCompanies('t1', 's1')

    const rows = testDb.prepare(`SELECT * FROM company_investors`).all()
    expect(rows).toEqual([])
  })
})

describe('getCompanyMergePreview', () => {
  beforeEach(() => { testDb = buildDb() })

  it('classifies columns into conflicts, autoFill, and silent-equal/silent-empty', () => {
    insertCompany('t1', 'TargetCo', {
      description: 'T desc',          // conflict (both have value, differ)
      city: null,                     // autoFill (target empty, source has value)
      stage: 'Series A',              // equal — silent
      industry: null,                 // both empty — silent
      founding_year: 2020             // conflict (numeric)
    })
    insertCompany('s1', 'SourceCo', {
      description: 'S desc',
      city: 'SF',
      stage: 'Series A',
      industry: null,
      founding_year: 2019
    })

    const preview = getCompanyMergePreview('t1', 's1')
    expect(preview.target).toEqual({ id: 't1', canonicalName: 'TargetCo' })
    expect(preview.source).toEqual({ id: 's1', canonicalName: 'SourceCo' })

    const conflictCols = preview.conflicts.map((c) => c.column).sort()
    expect(conflictCols).toEqual(['description', 'founding_year'])

    const descConflict = preview.conflicts.find((c) => c.column === 'description')
    expect(descConflict?.targetValue).toBe('T desc')
    expect(descConflict?.sourceValue).toBe('S desc')

    const autoFillCols = preview.autoFill.map((c) => c.column).sort()
    expect(autoFillCols).toEqual(['city'])
    expect(preview.autoFill[0].targetValue).toBeNull()
    expect(preview.autoFill[0].sourceValue).toBe('SF')
  })

  it('skips fields where source is empty (nothing to bring over)', () => {
    insertCompany('t1', 'TargetCo', { description: 'T desc' })
    insertCompany('s1', 'SourceCo', { description: null })

    const preview = getCompanyMergePreview('t1', 's1')
    expect(preview.conflicts).toEqual([])
    expect(preview.autoFill).toEqual([])
  })

  it('reports investor and theme array additions', () => {
    insertCompany('t1', 'TargetCo')
    insertCompany('s1', 'SourceCo')
    insertCompany('vc1', 'VC1')

    testDb.prepare(`
      INSERT INTO company_investors (id, company_id, investor_company_id, investor_type, position)
      VALUES ('ci1', 's1', 'vc1', 'lead', 0)
    `).run()
    testDb.prepare(`
      INSERT INTO org_company_themes (company_id, theme_id) VALUES ('s1', 'theme-x')
    `).run()

    const preview = getCompanyMergePreview('t1', 's1')
    const names = preview.arrayUnions.map((u) => u.name).sort()
    expect(names).toContain('Investor relations')
    expect(names).toContain('Themes')
  })

  it('throws when target equals source', () => {
    insertCompany('t1', 'TargetCo')
    expect(() => getCompanyMergePreview('t1', 't1')).toThrow('different')
  })

  it('throws when either company is missing', () => {
    insertCompany('t1', 'TargetCo')
    expect(() => getCompanyMergePreview('t1', 'missing')).toThrow('Source company not found')
    expect(() => getCompanyMergePreview('missing', 't1')).toThrow('Target company not found')
  })
})
