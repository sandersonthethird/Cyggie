/**
 * Tests for listContactsLight in contact.repo.ts
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *
 * Covers:
 *   - Word-split LIKE search: multi-word query matches partial first name
 *     ("Pat McGovern" → finds "Patrick McGovern")
 *   - Single-word search: unchanged existing behaviour
 *   - Email search: still works for single-word queries
 *   - companyId boost: company's contacts sort before others
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

const { listContactsLight, resolveContactsByEmails, getContact, updateContact } = await import('../main/database/repositories/contact.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      normalized_name TEXT,
      email TEXT,
      primary_company_id TEXT REFERENCES org_companies(id),
      title TEXT,
      contact_type TEXT,
      talent_pipeline TEXT,
      linkedin_url TEXT,
      crm_contact_id TEXT,
      crm_provider TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

describe('listContactsLight — word-split search', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.exec(`
      INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name, email)
      VALUES
        ('c1', 'Patrick McGovern', 'Patrick', 'McGovern', 'patrickmcgovern', 'pat@bowery.com'),
        ('c2', 'Alice Smith',      'Alice',   'Smith',    'alicesmith',      'alice@example.com'),
        ('c3', 'Bob Jones',        'Bob',     'Jones',    'bobjones',        NULL)
    `)
  })

  it('multi-word query: "Pat McGovern" matches "Patrick McGovern" via word-split AND', () => {
    const results = listContactsLight({ query: 'Pat McGovern' })
    expect(results.some(c => c.fullName === 'Patrick McGovern')).toBe(true)
  })

  it('multi-word query: does not return unrelated contacts', () => {
    const results = listContactsLight({ query: 'Pat McGovern' })
    expect(results.some(c => c.fullName === 'Alice Smith')).toBe(false)
    expect(results.some(c => c.fullName === 'Bob Jones')).toBe(false)
  })

  it('single-word query: "McGovern" still matches "Patrick McGovern"', () => {
    const results = listContactsLight({ query: 'McGovern' })
    expect(results.some(c => c.fullName === 'Patrick McGovern')).toBe(true)
  })

  it('single-word query: email match still works', () => {
    const results = listContactsLight({ query: 'pat@bowery.com' })
    expect(results.some(c => c.fullName === 'Patrick McGovern')).toBe(true)
  })

  it('no query: returns all contacts', () => {
    const results = listContactsLight()
    expect(results.length).toBe(3)
  })
})

describe('listContactsLight — companyId boost', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name) VALUES
        ('co1', 'Bowery Capital'),
        ('co2', 'Other Fund')
    `)
    testDb.exec(`
      INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name, primary_company_id, updated_at)
      VALUES
        ('c1', 'Patrick McGovern', 'Patrick', 'McGovern', 'patrickmcgovern', 'co1', '2024-01-01T00:00:00.000Z'),
        ('c2', 'Alice Smith',      'Alice',   'Smith',    'alicesmith',      'co2', '2024-01-02T00:00:00.000Z'),
        ('c3', 'Bob Jones',        'Bob',     'Jones',    'bobjones',        NULL,  '2024-01-03T00:00:00.000Z')
    `)
  })

  it('contacts in the specified company sort before others', () => {
    const results = listContactsLight({ companyId: 'co1' })
    expect(results.length).toBe(3)
    expect(results[0].id).toBe('c1')   // Bowery Capital contact first
  })

  it('contacts without the specified company still appear (not filtered out)', () => {
    const results = listContactsLight({ companyId: 'co1' })
    expect(results.some(c => c.id === 'c2')).toBe(true)
    expect(results.some(c => c.id === 'c3')).toBe(true)
  })

  it('boost works alongside a search query', () => {
    const results = listContactsLight({ query: 'Pat', companyId: 'co1' })
    expect(results[0].id).toBe('c1')
  })
})

describe('resolveContactsByEmails — returns { id, fullName }', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT
      );
      CREATE TABLE contact_emails (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        email TEXT NOT NULL
      );
      INSERT INTO contacts (id, full_name, email) VALUES
        ('c1', 'Sandy Cass', 'sandy.cass@gmail.com'),
        ('c2', 'Alice Smith', 'alice@example.com'),
        ('c3', 'No Email', NULL);
      INSERT INTO contact_emails (id, contact_id, email) VALUES
        ('ce1', 'c2', 'alice.alt@example.com');
    `)
  })

  it('resolves primary email to { id, fullName }', () => {
    const result = resolveContactsByEmails(['sandy.cass@gmail.com'])
    expect(result['sandy.cass@gmail.com']).toEqual({ id: 'c1', fullName: 'Sandy Cass' })
  })

  it('resolves secondary contact_emails entry to { id, fullName }', () => {
    const result = resolveContactsByEmails(['alice.alt@example.com'])
    expect(result['alice.alt@example.com']).toEqual({ id: 'c2', fullName: 'Alice Smith' })
  })

  it('unmatched email is absent from result', () => {
    const result = resolveContactsByEmails(['unknown@example.com'])
    expect(result['unknown@example.com']).toBeUndefined()
  })

  it('returns empty object for empty input', () => {
    expect(resolveContactsByEmails([])).toEqual({})
  })

  it('normalizes email casing', () => {
    const result = resolveContactsByEmails(['Sandy.Cass@Gmail.COM'])
    expect(result['sandy.cass@gmail.com']).toEqual({ id: 'c1', fullName: 'Sandy Cass' })
  })
})

describe('getContact / updateContact — keyTakeaways field', () => {
  beforeEach(() => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(`
      CREATE TABLE org_companies (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        primary_domain TEXT,
        website_url TEXT
      );
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        normalized_name TEXT,
        email TEXT,
        primary_company_id TEXT REFERENCES org_companies(id),
        title TEXT,
        contact_type TEXT,
        talent_pipeline TEXT,
        linkedin_url TEXT,
        crm_contact_id TEXT,
        crm_provider TEXT,
        investor_stage TEXT,
        city TEXT,
        state TEXT,
        notes TEXT,
        phone TEXT,
        twitter_handle TEXT,
        other_socials TEXT,
        timezone TEXT,
        pronouns TEXT,
        birthday TEXT,
        university TEXT,
        previous_companies TEXT,
        tags TEXT,
        relationship_strength TEXT,
        last_met_event TEXT,
        warm_intro_path TEXT,
        fund_size REAL,
        typical_check_size_min REAL,
        typical_check_size_max REAL,
        investment_stage_focus TEXT,
        investment_sector_focus TEXT,
        proud_portfolio_companies TEXT,
        field_sources TEXT,
        work_history TEXT,
        education_history TEXT,
        linkedin_headline TEXT,
        linkedin_skills TEXT,
        linkedin_enriched_at TEXT,
        key_takeaways TEXT,
        updated_by_user_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE contact_emails (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL REFERENCES contacts(id),
        email TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE email_messages (
        id TEXT PRIMARY KEY, from_email TEXT, received_at TEXT, sent_at TEXT, created_at TEXT
      );
      CREATE TABLE email_contact_links (
        id TEXT PRIMARY KEY, message_id TEXT, contact_id TEXT
      );
      CREATE TABLE email_message_participants (
        id TEXT PRIMARY KEY, message_id TEXT, contact_id TEXT, email TEXT
      );
      INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name)
      VALUES ('c1', 'Test User', 'Test', 'User', 'testuser');
    `)
    testDb = db
  })

  it('returns keyTakeaways: null when no value is set', () => {
    const contact = getContact('c1')
    expect(contact).not.toBeNull()
    expect(contact!.keyTakeaways).toBeNull()
  })

  it('updateContact persists keyTakeaways and getContact returns it', () => {
    updateContact('c1', { keyTakeaways: '• Bullet one\n• Bullet two' })
    const contact = getContact('c1')
    expect(contact!.keyTakeaways).toBe('• Bullet one\n• Bullet two')
  })

  it('updateContact can clear keyTakeaways to null', () => {
    updateContact('c1', { keyTakeaways: '• Some text' })
    updateContact('c1', { keyTakeaways: null })
    const contact = getContact('c1')
    expect(contact!.keyTakeaways).toBeNull()
  })
})
