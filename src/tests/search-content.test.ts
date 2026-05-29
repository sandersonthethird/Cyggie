/**
 * Tests for global keyword search:
 *   - getContentMatchPreviews (dropdown content matches)
 *   - searchUnified company + contact blocks
 *   - sanitizeSnippet (XSS prevention)
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

// company.repo is used by getCategorizedSuggestions — stub it
vi.mock('@cyggie/db/sqlite/repositories/company.repo', () => ({
  getByDomain: () => null
}))

const { getContentMatchPreviews, searchUnified } = await import('@cyggie/db/sqlite/repositories/search.repo')
const { sanitizeSnippet } = await import('../renderer/routes/SearchResults')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      normalized_name TEXT,
      primary_domain TEXT,
      description TEXT,
      industry TEXT,
      target_customer TEXT,
      business_model TEXT,
      key_takeaways TEXT,
      lead_investor TEXT,
      co_investors TEXT,
      status TEXT DEFAULT 'active',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT,
      email TEXT,
      title TEXT,
      primary_company_id TEXT REFERENCES org_companies(id),
      university TEXT,
      previous_companies TEXT,
      education_history TEXT,
      linkedin_headline TEXT,
      work_history TEXT,
      notes TEXT,
      key_takeaways TEXT,
      key_takeaways_user_note TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT,
      speaker_map TEXT NOT NULL DEFAULT '{}',
      attendees TEXT,
      attendee_emails TEXT,
      companies TEXT,
      duration_seconds INTEGER,
      status TEXT DEFAULT 'summarized'
    );
    CREATE VIRTUAL TABLE meetings_fts USING fts5(
      meeting_id UNINDEXED,
      title,
      transcript_text,
      summary_text,
      content='',
      tokenize='porter unicode61'
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      subject TEXT,
      snippet TEXT,
      body_text TEXT,
      from_name TEXT,
      from_email TEXT,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE email_company_links (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      company_id TEXT,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE investment_memos (
      id TEXT PRIMARY KEY,
      company_id TEXT REFERENCES org_companies(id),
      theme_id TEXT,
      deal_id TEXT,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      latest_version_number INTEGER DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE investment_memo_versions (
      id TEXT PRIMARY KEY,
      memo_id TEXT NOT NULL REFERENCES investment_memos(id),
      version_number INTEGER NOT NULL,
      content_markdown TEXT,
      structured_json TEXT,
      change_note TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE meeting_company_links (
      id TEXT PRIMARY KEY,
      meeting_id TEXT,
      company_id TEXT,
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      company_id TEXT REFERENCES org_companies(id),
      contact_id TEXT,
      source_meeting_id TEXT,
      theme_id TEXT,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE companies (
      domain TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE themes (id TEXT PRIMARY KEY);
  `)
  return db
}

describe('getContentMatchPreviews', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('returns empty array for empty query', () => {
    const results = getContentMatchPreviews('', 5)
    expect(results).toEqual([])
  })

  it('finds company by description keyword', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, description)
      VALUES ('co1', 'Robotics Inc', 'Founded by a CMU professor specializing in robotics')
    `)
    const results = getContentMatchPreviews('CMU', 5)
    expect(results.some((r) => r.entityType === 'company' && r.entityId === 'co1')).toBe(true)
  })

  it('finds contact by university field', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, university)
      VALUES ('ct1', 'Dr. John Doe', 'Carnegie Mellon University')
    `)
    const results = getContentMatchPreviews('Carnegie', 5)
    expect(results.some((r) => r.entityType === 'contact' && r.entityId === 'ct1')).toBe(true)
  })

  it('finds contact by education_history field', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, education_history)
      VALUES ('ct2', 'Jane Smith', '{"schools": ["MIT", "Stanford"]}')
    `)
    const results = getContentMatchPreviews('Stanford', 5)
    expect(results.some((r) => r.entityType === 'contact' && r.entityId === 'ct2')).toBe(true)
  })

  it('finds contact by linkedin_headline', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, linkedin_headline)
      VALUES ('ct3', 'Bob Builder', 'Serial entrepreneur | YC W21 | AI/ML')
    `)
    const results = getContentMatchPreviews('entrepreneur', 5)
    expect(results.some((r) => r.entityType === 'contact' && r.entityId === 'ct3')).toBe(true)
  })

  it('includes company context for contact matches', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name) VALUES ('co2', 'Acme Corp');
      INSERT INTO contacts (id, full_name, university, primary_company_id)
      VALUES ('ct4', 'Alice', 'Harvard', 'co2')
    `)
    const results = getContentMatchPreviews('Harvard', 5)
    const match = results.find((r) => r.entityId === 'ct4')
    expect(match).toBeTruthy()
    expect(match!.context).toBe('Acme Corp')
  })

  it('handles null fields gracefully', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name)
      VALUES ('co3', 'NullCo')
    `)
    // All text fields are null — should not error
    expect(() => getContentMatchPreviews('anything', 5)).not.toThrow()
  })

  it('handles special characters in query', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, description)
      VALUES ('co4', 'Test Co', 'normal description')
    `)
    expect(() => getContentMatchPreviews('test (special) "chars"', 5)).not.toThrow()
  })

  it('caps results at the limit', () => {
    for (let i = 0; i < 10; i++) {
      testDb.exec(`
        INSERT INTO org_companies (id, canonical_name, description)
        VALUES ('co${i}', 'Company ${i}', 'They all mention keyword here')
      `)
    }
    const results = getContentMatchPreviews('keyword', 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('finds email by body_text', () => {
    testDb.exec(`
      INSERT INTO email_messages (id, subject, body_text, snippet)
      VALUES ('em1', 'Intro Email', 'I studied at CMU and would love to connect', 'I studied at CMU')
    `)
    const results = getContentMatchPreviews('CMU', 5)
    expect(results.some((r) => r.entityType === 'email' && r.entityId === 'em1')).toBe(true)
  })

  it('finds memo by content_markdown', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name) VALUES ('co-memo', 'MemoTestCo');
      INSERT INTO investment_memos (id, company_id, title) VALUES ('memo1', 'co-memo', 'Investment Memo');
      INSERT INTO investment_memo_versions (id, memo_id, version_number, content_markdown)
      VALUES ('v1', 'memo1', 1, 'The founder graduated from CMU with a PhD in robotics')
    `)
    const results = getContentMatchPreviews('CMU', 5)
    expect(results.some((r) => r.entityType === 'memo' && r.entityId === 'memo1')).toBe(true)
  })
})

describe('searchUnified — company block', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('finds company by description keyword', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, description)
      VALUES ('co1', 'Robotics Inc', 'AI-powered manufacturing founded by CMU researchers')
    `)
    const results = searchUnified('CMU', 20)
    const companyResults = results.grouped.company
    expect(companyResults.some((r) => r.entityId === 'co1')).toBe(true)
  })

  it('finds company by industry keyword', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, industry)
      VALUES ('co2', 'GreenTech Co', 'Climate Technology')
    `)
    const results = searchUnified('Climate', 20)
    expect(results.grouped.company.some((r) => r.entityId === 'co2')).toBe(true)
  })

  it('finds company by key_takeaways keyword', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, key_takeaways)
      VALUES ('co3', 'DataCo', 'Strong technical team from Google and Meta')
    `)
    const results = searchUnified('Google', 20)
    expect(results.grouped.company.some((r) => r.entityId === 'co3')).toBe(true)
  })

  it('returns empty for no match', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, description)
      VALUES ('co4', 'Nothing Here', 'totally unrelated content')
    `)
    const results = searchUnified('xyznonexistent', 20)
    expect(results.grouped.company).toHaveLength(0)
  })

  it('handles empty/null fields gracefully', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name)
      VALUES ('co5', 'MinimalCo')
    `)
    expect(() => searchUnified('anything', 20)).not.toThrow()
  })
})

describe('searchUnified — contact block', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('finds contact by university', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, university)
      VALUES ('ct1', 'Dr. Smith', 'Carnegie Mellon University')
    `)
    const results = searchUnified('Carnegie', 20)
    expect(results.grouped.contact.some((r) => r.entityId === 'ct1')).toBe(true)
  })

  it('finds contact by education_history', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, education_history)
      VALUES ('ct2', 'Jane Doe', 'PhD Stanford, BS MIT')
    `)
    const results = searchUnified('Stanford', 20)
    expect(results.grouped.contact.some((r) => r.entityId === 'ct2')).toBe(true)
  })

  it('finds contact by linkedin_headline', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, linkedin_headline)
      VALUES ('ct3', 'Bob Tech', 'CTO at Stripe | ex-Google')
    `)
    const results = searchUnified('Stripe', 20)
    expect(results.grouped.contact.some((r) => r.entityId === 'ct3')).toBe(true)
  })

  it('includes company context from join', () => {
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name) VALUES ('co1', 'Acme Corp');
      INSERT INTO contacts (id, full_name, university, primary_company_id)
      VALUES ('ct4', 'Alice', 'Harvard', 'co1')
    `)
    const results = searchUnified('Harvard', 20)
    const match = results.grouped.contact.find((r) => r.entityId === 'ct4')
    expect(match).toBeTruthy()
    expect(match!.companyName).toBe('Acme Corp')
  })

  it('returns empty for no match', () => {
    testDb.exec(`
      INSERT INTO contacts (id, full_name, university)
      VALUES ('ct5', 'Nobody', 'Unrelated University')
    `)
    const results = searchUnified('xyznonexistent', 20)
    expect(results.grouped.contact).toHaveLength(0)
  })
})

describe('sanitizeSnippet', () => {
  it('preserves <mark> tags', () => {
    const input = 'found <mark>CMU</mark> in the text'
    expect(sanitizeSnippet(input)).toBe('found <mark>CMU</mark> in the text')
  })

  it('strips <script> tags', () => {
    const input = 'text <script>alert("xss")</script> more'
    expect(sanitizeSnippet(input)).toBe('text alert("xss") more')
  })

  it('strips <img> tags with event handlers', () => {
    const input = 'text <img onerror="alert(1)" src="x"> more'
    expect(sanitizeSnippet(input)).toBe('text  more')
  })

  it('strips nested HTML tags but keeps <mark>', () => {
    const input = '<div><b>bold</b> <mark>highlighted</mark> <a href="bad">link</a></div>'
    expect(sanitizeSnippet(input)).toBe('bold <mark>highlighted</mark> link')
  })

  it('handles empty input', () => {
    expect(sanitizeSnippet('')).toBe('')
  })

  it('handles input with no HTML', () => {
    const input = 'just plain text'
    expect(sanitizeSnippet(input)).toBe('just plain text')
  })

  it('preserves self-closing mark-like patterns correctly', () => {
    const input = 'text <mark>word</mark> and <marquee>scroll</marquee>'
    // <marquee> should be stripped (not <mark>)
    expect(sanitizeSnippet(input)).toBe('text <mark>word</mark> and scroll')
  })
})
