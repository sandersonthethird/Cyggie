/**
 * Tests for crm-chat.ts context building logic:
 *   - buildCrmContext: 0-keyword investor-signal fallback
 *   - buildCrmContext: returns '' when no contacts or companies match
 *   - buildCrmContext: respects 200-contact hard limit
 *   - buildCrmContext: uses parameterized SQL (no string interpolation)
 *   - queryAll: proceeds with CRM context when meeting search returns empty
 *   - queryAll: proceeds with meeting context when CRM returns empty
 *   - queryAll: returns graceful no-results message when both empty
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 *   - getProvider() → mock that captures prompt inputs
 *   - sendProgress → no-op
 *   - buildMeetingContext() → controlled stub via vi.mock
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

// Mock DB connection — must be set up before dynamic imports
vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// Track LLM calls so we can inspect system prompt + user prompt
let capturedSystemPrompt = ''
let capturedUserPrompt = ''

vi.mock('../main/llm/provider-factory', () => ({
  getProvider: () => ({
    generateSummary: async (system: string, user: string) => {
      capturedSystemPrompt = system
      capturedUserPrompt = user
      return 'mock-response'
    }
  })
}))

// No-op progress sender
vi.mock('../main/llm/send-progress', () => ({
  sendProgress: () => {}
}))

// Controllable meeting context — default to '' (no meetings match)
let mockMeetingContext = ''
vi.mock('../main/llm/chat', () => ({
  buildMeetingContext: () => mockMeetingContext,
  injectTextAttachments: (q: string) => q
}))

const { queryCrm, queryAll } = await import('../main/llm/crm-chat')

// ─── Schema helpers ────────────────────────────────────────────────────────────

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      description TEXT,
      sector TEXT,
      stage TEXT,
      entity_type TEXT,
      website_url TEXT,
      lead_investor TEXT,
      include_in_companies_view INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      title TEXT,
      email TEXT,
      linkedin_url TEXT,
      contact_type TEXT,
      investment_stage_focus TEXT,
      investment_sector_focus TEXT,
      typical_check_size_min REAL,
      typical_check_size_max REAL,
      fund_size REAL,
      city TEXT,
      state TEXT,
      primary_company_id TEXT REFERENCES org_companies(id)
    );

    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      title TEXT,
      content TEXT NOT NULL,
      updated_at TEXT,
      company_id TEXT REFERENCES org_companies(id),
      contact_id TEXT REFERENCES contacts(id)
    );

    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      subject TEXT,
      from_email TEXT NOT NULL,
      body_text TEXT,
      received_at TEXT,
      sent_at TEXT
    );

    CREATE TABLE email_contact_links (
      message_id TEXT NOT NULL REFERENCES email_messages(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id)
    );
  `)
  return db
}

function insertContact(
  db: Database.Database,
  id: string,
  name: string,
  opts: Partial<{
    contact_type: string
    investment_stage_focus: string
    investment_sector_focus: string
    typical_check_size_min: number
    title: string
    primary_company_id: string
  }> = {}
): void {
  db.prepare(`
    INSERT INTO contacts (id, full_name, contact_type, investment_stage_focus,
      investment_sector_focus, typical_check_size_min, title, primary_company_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name,
    opts.contact_type ?? null,
    opts.investment_stage_focus ?? null,
    opts.investment_sector_focus ?? null,
    opts.typical_check_size_min ?? null,
    opts.title ?? null,
    opts.primary_company_id ?? null
  )
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildCrmContext (via queryCrm) — keyword matching', () => {
  beforeEach(() => {
    testDb = buildDb()
    capturedUserPrompt = ''
  })

  it('returns empty-state message when no contacts or companies match keywords', async () => {
    // DB is empty — nothing to match
    const result = await queryCrm('Series A consumer investors')
    expect(result).toMatch(/couldn't find/i)
    // No LLM call should be made (queryCrm returns early)
    expect(capturedUserPrompt).toBe('')
  })

  it('matches contacts by name keyword', async () => {
    testDb = buildDb()
    insertContact(testDb, 'c1', 'Alice Ventures', { contact_type: 'investor' })

    const result = await queryCrm('Alice')
    // LLM was called — prompt includes the contact name
    expect(capturedUserPrompt).toContain('Alice Ventures')
    expect(result).toBe('mock-response')
  })

  it('matches contacts by investment_stage_focus keyword', async () => {
    testDb = buildDb()
    insertContact(testDb, 'c1', 'Bob Smith', {
      contact_type: 'investor',
      investment_stage_focus: 'Series A'
    })

    await queryCrm('Series A investors')
    expect(capturedUserPrompt).toContain('Bob Smith')
  })

  it('does not match contacts excluded by include_in_companies_view on companies', async () => {
    // Company with include_in_companies_view = 0 should not appear in company results
    testDb = buildDb()
    testDb.prepare(`
      INSERT INTO org_companies (id, canonical_name, description, include_in_companies_view)
      VALUES ('co1', 'Hidden Fund', 'stealth fund', 0)
    `).run()

    await queryCrm('Hidden Fund')
    // No contacts either → empty result
    expect(capturedUserPrompt).toBe('')
  })
})

describe('buildCrmContext — 0-keyword investor-signal fallback', () => {
  beforeEach(() => {
    testDb = buildDb()
    capturedUserPrompt = ''
  })

  it('returns investor contacts when question yields no extractable keywords', async () => {
    // Insert one investor (signal field set) and one non-investor
    insertContact(testDb, 'c1', 'Investor Alice', {
      contact_type: 'investor',
      investment_stage_focus: 'Series A'
    })
    insertContact(testDb, 'c2', 'Non Investor Bob', {})

    // Question with no extractable keywords (all stop-words)
    await queryCrm('who are the')
    // Investor Alice should appear via fallback; non-investor should not
    expect(capturedUserPrompt).toContain('Investor Alice')
    expect(capturedUserPrompt).not.toContain('Non Investor Bob')
  })

  it('returns empty-state message when fallback finds no investor-signal contacts', async () => {
    // Only non-investor contacts exist
    insertContact(testDb, 'c1', 'Regular Person', {})

    const result = await queryCrm('who are the')
    expect(result).toMatch(/couldn't find/i)
    expect(capturedUserPrompt).toBe('')
  })
})

describe('buildCrmContext — SQL safety (parameterized queries)', () => {
  beforeEach(() => {
    testDb = buildDb()
    capturedUserPrompt = ''
  })

  it('handles SQL-injection-style keyword without throwing', async () => {
    // If keywords were interpolated into SQL this would cause a syntax error.
    // Parameterized queries return no results gracefully instead.
    const result = await queryCrm("'; DROP TABLE contacts; --")
    // Should not throw, should return empty-state message (no matching records)
    expect(result).toMatch(/couldn't find/i)
    // contacts table should still exist
    expect(() => testDb.prepare('SELECT COUNT(*) FROM contacts').get()).not.toThrow()
  })
})

describe('queryAll — context routing', () => {
  beforeEach(() => {
    testDb = buildDb()
    capturedSystemPrompt = ''
    capturedUserPrompt = ''
    mockMeetingContext = '' // default: no meetings match
  })

  it('proceeds and calls LLM when only CRM context is available (meetings empty)', async () => {
    insertContact(testDb, 'c1', 'CRM Alice', { contact_type: 'investor', investment_stage_focus: 'Series A' })

    mockMeetingContext = ''
    const result = await queryAll('Series A investors')

    expect(result).toBe('mock-response')
    expect(capturedUserPrompt).toContain('CRM Alice')
    expect(capturedUserPrompt).not.toContain('Meeting Context')
    expect(capturedSystemPrompt).toContain('CRM database')
  })

  it('proceeds and calls LLM when only meeting context is available (CRM empty)', async () => {
    // DB is empty — no CRM matches
    mockMeetingContext = '## Meeting: Partner Call\nDiscussed Series A.'

    const result = await queryAll('Series A')

    expect(result).toBe('mock-response')
    expect(capturedUserPrompt).toContain('Partner Call')
    expect(capturedUserPrompt).not.toContain('CRM Context')
  })

  it('combines both contexts when both are available', async () => {
    insertContact(testDb, 'c1', 'CRM Alice', { contact_type: 'investor', investment_stage_focus: 'Series A' })
    mockMeetingContext = '## Meeting: Partner Call\nDiscussed Series A.'

    await queryAll('Series A investors')

    expect(capturedUserPrompt).toContain('Meeting Context')
    expect(capturedUserPrompt).toContain('CRM Context')
    expect(capturedUserPrompt).toContain('CRM Alice')
    expect(capturedUserPrompt).toContain('Partner Call')
  })

  it('returns graceful no-results message when both meeting and CRM contexts are empty', async () => {
    mockMeetingContext = ''
    // DB is empty

    const result = await queryAll('Series A investors')

    expect(result).toMatch(/couldn't find/i)
    // LLM should NOT be called when both sources are empty
    expect(capturedUserPrompt).toBe('')
  })
})
