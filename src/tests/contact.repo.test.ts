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

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { listContacts, listContactsLight, resolveContactsByEmails, resolveContactsByLowercasedNames, getContact, updateContact, getContactEmailRow } = await import('@cyggie/db/sqlite/repositories/contact.repo')

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
      is_private INTEGER NOT NULL DEFAULT 0,
      normalized_name TEXT,
      email TEXT,
      primary_company_id TEXT REFERENCES org_companies(id),
      title TEXT,
      contact_type TEXT,
      talent_pipeline TEXT,
      linkedin_url TEXT,
      crm_contact_id TEXT,
      crm_provider TEXT,
      phone TEXT,
      street TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      country TEXT,
      timezone TEXT,
      twitter_handle TEXT,
      university TEXT,
      pronouns TEXT,
      last_met_event TEXT,
      warm_intro_path TEXT,
      notes TEXT,
      fund_size REAL,
      typical_check_size_min REAL,
      typical_check_size_max REAL,
      investment_sector_focus_notes TEXT,
      proud_portfolio_companies TEXT,
      tags TEXT,
      previous_companies TEXT,
      investment_stage_focus TEXT,
      investment_sector_focus TEXT,
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

describe('listContactsLight — surfaces extended fields for table columns', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.exec(`
      INSERT INTO contacts (
        id, full_name, first_name, last_name, normalized_name, email,
        city, state, fund_size, tags
      )
      VALUES (
        'c1', 'Pat McGovern', 'Pat', 'McGovern', 'patmcgovern', 'pat@bowery.com',
        'New York', 'NY', 5000000, '["Lead","Warm"]'
      )
    `)
  })

  it('round-trips address fields (city/state) into the summary', () => {
    const [c] = listContactsLight({ query: 'Pat' })
    expect(c.city).toBe('New York')
    expect(c.state).toBe('NY')
  })

  it('round-trips numeric and raw JSON fields', () => {
    const [c] = listContactsLight({ query: 'Pat' })
    expect(c.fundSize).toBe(5000000)
    // JSON fields are passed through raw; the table layer formats them.
    expect(c.tags).toBe('["Lead","Warm"]')
  })
})

describe('listContacts — keeps manual/tagged no-email CRM contacts', () => {
  beforeEach(() => {
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
        is_private INTEGER NOT NULL DEFAULT 0,
        normalized_name TEXT,
        email TEXT,
        primary_company_id TEXT REFERENCES org_companies(id),
        title TEXT,
        contact_type TEXT,
        talent_pipeline TEXT,
        linkedin_url TEXT,
        crm_contact_id TEXT,
        crm_provider TEXT,
        tags TEXT,
        phone TEXT,
        street TEXT,
        city TEXT,
        state TEXT,
        postal_code TEXT,
        country TEXT,
        timezone TEXT,
        twitter_handle TEXT,
        university TEXT,
        pronouns TEXT,
        last_met_event TEXT,
        warm_intro_path TEXT,
        notes TEXT,
        fund_size REAL,
        typical_check_size_min REAL,
        typical_check_size_max REAL,
        investment_sector_focus_notes TEXT,
        proud_portfolio_companies TEXT,
        previous_companies TEXT,
        investment_stage_focus TEXT,
        investment_sector_focus TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE contact_emails (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        email TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE meetings (
        id TEXT PRIMARY KEY,
        date TEXT,
        attendee_emails TEXT
      );
      CREATE TABLE email_messages (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        received_at TEXT,
        sent_at TEXT,
        created_at TEXT
      );
      CREATE TABLE email_message_participants (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        email TEXT
      );
      INSERT INTO contacts (id, full_name, normalized_name, email, contact_type, tags) VALUES
        -- Has email: always shown
        ('with-email', 'Alice WithEmail', 'alicewithemail', 'alice@example.com', NULL, NULL),
        -- No email but user tagged with contact_type → intentional CRM contact
        ('tagged-type', 'Bob Tagged', 'bobtagged', NULL, 'investor', NULL),
        -- No email but user added tags → intentional CRM contact
        ('tagged-tags', 'Carol Tagged', 'caroltagged', NULL, NULL, '["Lead","Warm"]'),
        -- No email and no tags / no contact_type → should still be hidden (auto-sync artifact)
        ('bare-no-email', 'Dan Bare', 'danbare', NULL, NULL, NULL),
        -- Tags column with empty array string should not count as tagged
        ('empty-tags', 'Eve Empty', 'eveempty', NULL, NULL, '[]')
    `)
    testDb = db
  })

  it('returns contacts with an email', () => {
    const results = listContacts()
    expect(results.some(c => c.id === 'with-email')).toBe(true)
  })

  it('returns no-email contacts that have a contact_type set', () => {
    const results = listContacts()
    expect(results.some(c => c.id === 'tagged-type')).toBe(true)
  })

  it('returns no-email contacts that have non-empty tags', () => {
    const results = listContacts()
    expect(results.some(c => c.id === 'tagged-tags')).toBe(true)
  })

  it('still hides no-email contacts with no contact_type and no tags', () => {
    const results = listContacts()
    expect(results.some(c => c.id === 'bare-no-email')).toBe(false)
  })

  it('treats an empty-array tags value as untagged', () => {
    const results = listContacts()
    expect(results.some(c => c.id === 'empty-tags')).toBe(false)
  })
})

describe('listContactsLight — keeps manual/tagged no-email CRM contacts (regression)', () => {
  beforeEach(() => {
    testDb = buildDb()
    testDb.exec(`
      INSERT INTO contacts (id, full_name, first_name, last_name, normalized_name, email, contact_type)
      VALUES
        ('manual', 'Manual Contact', 'Manual', 'Contact', 'manualcontact', NULL, 'founder')
    `)
  })

  it('returns no-email contacts that the user has tagged with a contact_type', () => {
    const results = listContactsLight()
    expect(results.some(c => c.id === 'manual')).toBe(true)
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

describe('resolveContactsByLowercasedNames — fallback for attendees without email', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.exec(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        email TEXT
      );
      INSERT INTO contacts (id, full_name, email) VALUES
        ('c1', 'Sandy Cass', NULL),
        ('c2', 'Alice Smith', 'alice@example.com'),
        ('c3', 'Bob Jones', NULL),
        ('c4', 'Bob Jones', NULL);
    `)
  })

  it('resolves unique name to { id, fullName } keyed by lowercased trimmed name', () => {
    const result = resolveContactsByLowercasedNames(['Sandy Cass'])
    expect(result['sandy cass']).toEqual({ id: 'c1', fullName: 'Sandy Cass' })
  })

  it('skips ambiguous names (multiple contacts share the name)', () => {
    const result = resolveContactsByLowercasedNames(['Bob Jones'])
    expect(result['bob jones']).toBeUndefined()
  })

  it('handles surrounding whitespace and mixed case', () => {
    const result = resolveContactsByLowercasedNames(['  SANDY CASS  '])
    expect(result['sandy cass']).toEqual({ id: 'c1', fullName: 'Sandy Cass' })
  })

  it('returns empty for empty input', () => {
    expect(resolveContactsByLowercasedNames([])).toEqual({})
  })

  it('ignores blank entries', () => {
    const result = resolveContactsByLowercasedNames(['', '   ', 'Sandy Cass'])
    expect(result['sandy cass']).toEqual({ id: 'c1', fullName: 'Sandy Cass' })
    expect(Object.keys(result)).toHaveLength(1)
  })
})

describe('getContactEmailRow — outbox payload shape for sync wrappers', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    testDb.exec(`
      CREATE TABLE contact_emails (
        contact_id TEXT NOT NULL,
        email TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (contact_id, email)
      );
      INSERT INTO contact_emails (contact_id, email, is_primary, created_at) VALUES
        ('c1', 'eric@caphub.com', 1, '2026-05-27T12:00:00Z'),
        ('c1', 'eric.alt@caphub.com', 0, '2026-05-27T12:05:00Z');
    `)
  })

  it('returns snake_case row with the composite PK + is_primary + created_at', () => {
    const row = getContactEmailRow('c1', 'eric@caphub.com')
    expect(row).toEqual({
      contact_id: 'c1',
      email: 'eric@caphub.com',
      is_primary: 1,
      created_at: '2026-05-27T12:00:00Z',
    })
  })

  it('normalizes email casing before lookup', () => {
    const row = getContactEmailRow('c1', 'Eric@CapHub.COM')
    expect(row?.email).toBe('eric@caphub.com')
  })

  it('returns null when contact_id + email does not match', () => {
    expect(getContactEmailRow('c1', 'missing@caphub.com')).toBeNull()
  })

  it('returns null when email is invalid (normalize fails)', () => {
    expect(getContactEmailRow('c1', 'not-an-email')).toBeNull()
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
        is_private INTEGER NOT NULL DEFAULT 0,
        normalized_name TEXT,
        email TEXT,
        primary_company_id TEXT REFERENCES org_companies(id),
        title TEXT,
        contact_type TEXT,
        talent_pipeline TEXT,
        linkedin_url TEXT,
        crm_contact_id TEXT,
        crm_provider TEXT,
        city TEXT,
        state TEXT,
        street TEXT,
        postal_code TEXT,
        country TEXT,
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
        investment_sector_focus_notes TEXT,
        proud_portfolio_companies TEXT,
        field_sources TEXT,
        work_history TEXT,
        education_history TEXT,
        linkedin_headline TEXT,
        linkedin_skills TEXT,
        linkedin_enriched_at TEXT,
        key_takeaways TEXT,
        key_takeaways_user_note TEXT,
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

  // ─── keyTakeawaysUserNote — user-authored note pinned to top of card ───

  it('returns keyTakeawaysUserNote: null when no value is set', () => {
    const contact = getContact('c1')
    expect(contact!.keyTakeawaysUserNote).toBeNull()
  })

  it('updateContact persists keyTakeawaysUserNote and getContact returns it', () => {
    updateContact('c1', { keyTakeawaysUserNote: 'My note\nSecond bullet' })
    const contact = getContact('c1')
    expect(contact!.keyTakeawaysUserNote).toBe('My note\nSecond bullet')
  })

  it('updateContact can clear keyTakeawaysUserNote to null', () => {
    updateContact('c1', { keyTakeawaysUserNote: 'temp' })
    updateContact('c1', { keyTakeawaysUserNote: null })
    const contact = getContact('c1')
    expect(contact!.keyTakeawaysUserNote).toBeNull()
  })

  it('updating keyTakeawaysUserNote does NOT clobber keyTakeaways (independent fields)', () => {
    updateContact('c1', { keyTakeaways: '• AI bullet' })
    updateContact('c1', { keyTakeawaysUserNote: 'My personal note' })
    const contact = getContact('c1')
    expect(contact!.keyTakeaways).toBe('• AI bullet')
    expect(contact!.keyTakeawaysUserNote).toBe('My personal note')
  })

  it('updating keyTakeaways does NOT clobber keyTakeawaysUserNote (Generate must preserve it)', () => {
    updateContact('c1', { keyTakeawaysUserNote: 'My personal note' })
    updateContact('c1', { keyTakeaways: '• Fresh AI bullet' })
    const contact = getContact('c1')
    expect(contact!.keyTakeawaysUserNote).toBe('My personal note')
    expect(contact!.keyTakeaways).toBe('• Fresh AI bullet')
  })
})
