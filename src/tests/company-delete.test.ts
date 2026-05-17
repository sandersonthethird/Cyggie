/**
 * Tests for deleteCompany — full cleanup waterfall.
 *
 * Asserts:
 *   - Explicit DELETEs and FK CASCADEs both fire (foreign_keys = ON).
 *   - No-FK orphans (company_flagged_files, chat_sessions for context_kind='company')
 *     are cleaned up.
 *   - Self-reference lead_investor_company_id is cleared on OTHER companies.
 *   - Companies cache table (`companies`) is scrubbed by display_name.
 *   - meetings.companies and meetings.dismissed_companies JSON columns have the
 *     canonical name removed (case-insensitive), unrelated names preserved.
 *   - A canonical name containing LIKE wildcards (% _) is handled correctly.
 *
 * Mock boundaries: getDatabase() returns an in-memory SQLite DB. Schema is
 * defined inline to mirror the production migrations relevant to deleteCompany.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { deleteCompany } = await import('@cyggie/db/sqlite/repositories/org-company.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT,
      entity_type TEXT NOT NULL DEFAULT 'unknown',
      primary_domain TEXT,
      description TEXT,
      lead_investor TEXT,
      lead_investor_company_id TEXT,
      include_in_companies_view INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      primary_company_id TEXT REFERENCES org_companies(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      companies TEXT,
      dismissed_companies TEXT
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      company_id TEXT REFERENCES org_companies(id) ON DELETE SET NULL,
      contact_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      PRIMARY KEY (meeting_id, company_id)
    );

    CREATE TABLE email_company_links (
      message_id TEXT NOT NULL,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, company_id)
    );

    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL,
      PRIMARY KEY (company_id, contact_id)
    );

    CREATE TABLE deals (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE investment_memos (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL REFERENCES investment_memos(id) ON DELETE CASCADE
    );

    CREATE TABLE org_company_themes (
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      theme_id TEXT NOT NULL,
      PRIMARY KEY (company_id, theme_id)
    );

    CREATE TABLE theses (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES org_companies(id) ON DELETE SET NULL
    );

    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL DEFAULT 'name'
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES org_companies(id) ON DELETE SET NULL
    );

    CREATE TABLE company_investors (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      investor_company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE,
      investor_type TEXT NOT NULL
    );

    CREATE TABLE company_decision_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES org_companies(id) ON DELETE CASCADE
    );

    CREATE TABLE partner_meeting_digests (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );

    CREATE TABLE partner_meeting_items (
      id TEXT PRIMARY KEY,
      digest_id TEXT NOT NULL REFERENCES partner_meeting_digests(id) ON DELETE CASCADE,
      company_id TEXT REFERENCES org_companies(id) ON DELETE CASCADE,
      section TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE company_flagged_files (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      flagged_at TEXT NOT NULL
    );

    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      context_kind TEXT NOT NULL,
      title TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE companies (
      domain TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    );
  `)
  return db
}

function seedCompanyWithRelations(name: string, id = 'co-target', primaryDomain: string | null = 'target.example'): void {
  testDb.prepare(`INSERT INTO org_companies (id, canonical_name, primary_domain) VALUES (?, ?, ?)`).run(id, name, primaryDomain)

  // (a) FK CASCADE participants — none deleted explicitly in deleteCompany.
  testDb.prepare(`INSERT INTO partner_meeting_digests (id, status) VALUES ('digest1', 'active')`).run()
  testDb.prepare(`INSERT INTO partner_meeting_items (id, digest_id, company_id, section, position) VALUES ('pmi1', 'digest1', ?, 'considering', 0)`).run(id)
  testDb.prepare(`INSERT INTO company_decision_logs (id, company_id) VALUES ('cdl1', ?)`).run(id)

  // company_investors — both directions to verify both FKs cascade
  testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co-other', 'OtherCo')`).run()
  testDb.prepare(`INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES ('ci1', 'co-other', ?, 'lead')`).run(id)
  testDb.prepare(`INSERT INTO company_investors (id, company_id, investor_company_id, investor_type) VALUES ('ci2', ?, 'co-other', 'co_investor')`).run(id)

  // (b) FK SET NULL participants — explicit DELETE in deleteCompany too,
  // but the SET NULL FK fires regardless.
  testDb.prepare(`INSERT INTO contacts (id, primary_company_id) VALUES ('ct1', ?)`).run(id)
  testDb.prepare(`INSERT INTO notes (id, company_id) VALUES ('n1', ?)`).run(id)
  testDb.prepare(`INSERT INTO tasks (id, company_id) VALUES ('t1', ?)`).run(id)
  testDb.prepare(`INSERT INTO artifacts (id, company_id) VALUES ('a1', ?)`).run(id)

  // (c) Explicit DELETE participants
  testDb.prepare(`INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('m1', ?)`).run(id)
  testDb.prepare(`INSERT INTO email_company_links (message_id, company_id) VALUES ('msg1', ?)`).run(id)
  testDb.prepare(`INSERT INTO org_company_contacts (company_id, contact_id) VALUES (?, 'ct1')`).run(id)
  testDb.prepare(`INSERT INTO deals (id, company_id) VALUES ('d1', ?)`).run(id)
  testDb.prepare(`INSERT INTO investment_memos (id, company_id) VALUES ('memo1', ?)`).run(id)
  testDb.prepare(`INSERT INTO investment_memo_versions (id, memo_id) VALUES ('memo1v1', 'memo1')`).run()
  testDb.prepare(`INSERT INTO org_company_themes (company_id, theme_id) VALUES (?, 'theme1')`).run(id)
  testDb.prepare(`INSERT INTO theses (id, company_id) VALUES ('th1', ?)`).run(id)
  testDb.prepare(`INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type) VALUES ('al1', ?, 'Alias One', 'name')`).run(id)
  // Domain alias — used for cache cleanup by domain.
  testDb.prepare(`INSERT INTO org_company_aliases (id, company_id, alias_value, alias_type) VALUES ('al2', ?, 'alias.example', 'domain')`).run(id)

  // (d) No-FK / manual cleanup participants
  testDb.prepare(`INSERT INTO company_flagged_files (id, company_id, file_id, file_name, flagged_at) VALUES ('cff1', ?, 'file1', 'plan.pdf', datetime('now'))`).run(id)
  testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind, last_message_at) VALUES ('chat-co', ?, 'company', datetime('now'))`).run(id)
  testDb.prepare(`INSERT INTO chat_sessions (id, context_id, context_kind, last_message_at) VALUES ('chat-mt', 'm1', 'meeting', datetime('now'))`).run()

  // Companies cache fixtures — exercise every cache cleanup branch.
  // 1) match by case-insensitive display_name (lowercase variant of canonical name).
  testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('mismatch-case.example', ?)`).run(name.toLowerCase())
  // 2) match by primary_domain (display_name unrelated, e.g. stale from email parsing).
  testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('target.example', 'StaleNameFromEmail')`).run()
  // 3) match by alias domain (display_name unrelated).
  testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('alias.example', 'AnotherStaleName')`).run()
  // 4) unrelated cache row that must survive.
  testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('keep.example', 'KeepCo')`).run()

  // Self-reference dangling pointer on ANOTHER company.
  testDb.prepare(`UPDATE org_companies SET lead_investor_company_id = ?, lead_investor = ? WHERE id = 'co-other'`).run(id, name)

  // meetings JSON sources for search-dropdown scrub.
  // Use mixed-case stored value 'rnewton3' to prove case-insensitive scrub when
  // the canonical_name in the company row is 'Rnewton3'.
  testDb.prepare(`
    INSERT INTO meetings (id, title, companies, dismissed_companies)
    VALUES ('m1', 'Sync', ?, ?)
  `).run(JSON.stringify([name.toLowerCase(), 'KeepCo']), JSON.stringify([name, 'OtherCo']))

  // A second meeting that mentions only an unrelated company — must not be touched.
  testDb.prepare(`
    INSERT INTO meetings (id, title, companies)
    VALUES ('m2', 'Other meeting', ?)
  `).run(JSON.stringify(['UnrelatedCo']))
}

describe('deleteCompany', () => {
  beforeEach(() => { testDb = buildDb() })

  it('removes the org_companies row', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    const row = testDb.prepare(`SELECT id FROM org_companies WHERE id = 'co-target'`).get()
    expect(row).toBeUndefined()
  })

  it('exercises FK CASCADE for partner_meeting_items, company_decision_logs, and company_investors (both directions)', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    expect(testDb.prepare(`SELECT id FROM partner_meeting_items WHERE company_id = 'co-target'`).all()).toHaveLength(0)
    expect(testDb.prepare(`SELECT id FROM company_decision_logs WHERE company_id = 'co-target'`).all()).toHaveLength(0)
    // ci1 references the target as investor_company_id; ci2 references it as company_id.
    expect(testDb.prepare(`SELECT id FROM company_investors`).all()).toHaveLength(0)
  })

  it('clears notes.company_id and contacts.primary_company_id (SET NULL); hard-deletes tasks and artifacts (explicit DELETE)', () => {
    // Note: deleteCompany has explicit DELETEs for tasks and artifacts that
    // override the FK SET NULL declared in their migrations — chosen because
    // those rows are useless without their parent company. notes and contacts
    // remain (preserved as untagged data).
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    expect((testDb.prepare(`SELECT company_id FROM notes WHERE id = 'n1'`).get() as { company_id: string | null }).company_id).toBeNull()
    expect((testDb.prepare(`SELECT primary_company_id FROM contacts WHERE id = 'ct1'`).get() as { primary_company_id: string | null }).primary_company_id).toBeNull()
    expect(testDb.prepare(`SELECT id FROM tasks WHERE id = 't1'`).get()).toBeUndefined()
    expect(testDb.prepare(`SELECT id FROM artifacts WHERE id = 'a1'`).get()).toBeUndefined()
  })

  it('removes no-FK orphans: company_flagged_files and matching chat_sessions', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    expect(testDb.prepare(`SELECT id FROM company_flagged_files`).all()).toHaveLength(0)
    // Only the company-context chat session is removed; meeting-context one survives.
    const sessions = testDb.prepare(`SELECT id FROM chat_sessions ORDER BY id`).all()
    expect(sessions).toEqual([{ id: 'chat-mt' }])
  })

  it('clears dangling lead_investor_company_id on OTHER companies', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    const other = testDb.prepare(`SELECT lead_investor, lead_investor_company_id FROM org_companies WHERE id = 'co-other'`).get() as { lead_investor: string | null; lead_investor_company_id: string | null }
    expect(other.lead_investor).toBeNull()
    expect(other.lead_investor_company_id).toBeNull()
  })

  it('removes cache rows matching by display_name (case-insensitive), primary_domain, and alias domains, leaving unrelated rows intact', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')
    const remaining = testDb.prepare(`SELECT domain, display_name FROM companies ORDER BY domain`).all()
    // mismatch-case.example: had display_name='rnewton3' → COLLATE NOCASE match
    // target.example:        had stale display_name → caught by primary_domain match
    // alias.example:         had stale display_name → caught by alias-domain match
    // keep.example:          unrelated → survives
    expect(remaining).toEqual([{ domain: 'keep.example', display_name: 'KeepCo' }])
  })

  it('cache cleanup is a no-op when company has no domains and no matching display_name', () => {
    // Company with no primary_domain and no domain aliases: cache delete should
    // skip the IN-clause query (cacheDomains is empty) — verifies the length guard.
    testDb.prepare(`INSERT INTO org_companies (id, canonical_name) VALUES ('co-bare', 'BareCo')`).run()
    testDb.prepare(`INSERT INTO companies (domain, display_name) VALUES ('unrelated.example', 'Whatever')`).run()
    deleteCompany('co-bare')
    const remaining = testDb.prepare(`SELECT domain, display_name FROM companies ORDER BY domain`).all()
    expect(remaining).toEqual([{ domain: 'unrelated.example', display_name: 'Whatever' }])
  })

  it('scrubs the canonical name from meetings.companies (case-insensitive) and dismissed_companies, keeping unrelated names', () => {
    seedCompanyWithRelations('Rnewton3')
    deleteCompany('co-target')

    const m1 = testDb.prepare(`SELECT companies, dismissed_companies FROM meetings WHERE id = 'm1'`).get() as { companies: string | null; dismissed_companies: string | null }
    expect(JSON.parse(m1.companies!)).toEqual(['KeepCo'])
    expect(JSON.parse(m1.dismissed_companies!)).toEqual(['OtherCo'])

    const m2 = testDb.prepare(`SELECT companies FROM meetings WHERE id = 'm2'`).get() as { companies: string }
    expect(JSON.parse(m2.companies)).toEqual(['UnrelatedCo'])
  })

  it('handles canonical names containing LIKE wildcards (% and _)', () => {
    seedCompanyWithRelations('Acme%_Corp')
    deleteCompany('co-target')

    // The target row is gone.
    expect(testDb.prepare(`SELECT id FROM org_companies WHERE id = 'co-target'`).get()).toBeUndefined()

    // The cache row keyed by display_name is gone.
    const cache = testDb.prepare(`SELECT display_name FROM companies WHERE domain = 'target.example'`).get()
    expect(cache).toBeUndefined()

    // The meetings JSON for m1 had 'acme%_corp' (lowercased) — should be scrubbed,
    // not left because LIKE wildcards in the name pre-filter were misinterpreted.
    const m1 = testDb.prepare(`SELECT companies FROM meetings WHERE id = 'm1'`).get() as { companies: string | null }
    expect(JSON.parse(m1.companies!)).toEqual(['KeepCo'])
  })

  it('throws when the company does not exist', () => {
    expect(() => deleteCompany('nonexistent')).toThrow('Company not found')
  })

  it('throws when companyId is empty', () => {
    expect(() => deleteCompany('')).toThrow('companyId is required')
  })
})
