/**
 * Tests for the talentPipeline field on contacts.
 *
 * Covers:
 *   - migration 068 applies cleanly (column is created)
 *   - updateContact persists talentPipeline to the DB
 *   - getContact reads talent_pipeline back as talentPipeline
 *   - listContactsLight includes talent_pipeline in the SELECT
 *   - clearing the field (null) works
 *   - migration is idempotent (safe to run twice)
 *
 * Mock boundaries:
 *   - getDatabase() → in-memory SQLite (real SQL, no mocking)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runContactTalentPipelineMigration } from '../main/database/migrations/068-contact-talent-pipeline'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb
}))

// Dynamic imports so the mock is applied before module initialization
const { updateContact, getContact, listContactsLight } = await import(
  '../main/database/repositories/contact.repo'
)

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE contacts (
      id          TEXT PRIMARY KEY,
      full_name   TEXT NOT NULL,
      normalized_name TEXT NOT NULL DEFAULT '',
      email       TEXT,
      primary_company_id TEXT,
      title       TEXT,
      contact_type TEXT,
      linkedin_url TEXT,
      crm_contact_id TEXT,
      crm_provider   TEXT,
      investor_stage TEXT,
      city  TEXT, state TEXT, notes TEXT, phone TEXT,
      twitter_handle TEXT, other_socials TEXT, timezone TEXT,
      pronouns TEXT, birthday TEXT, university TEXT,
      previous_companies TEXT, tags TEXT, relationship_strength TEXT,
      last_met_event TEXT, warm_intro_path TEXT,
      fund_size REAL, typical_check_size_min REAL, typical_check_size_max REAL,
      investment_stage_focus TEXT, investment_sector_focus TEXT,
      proud_portfolio_companies TEXT, field_sources TEXT,
      work_history TEXT, education_history TEXT, linkedin_headline TEXT,
      linkedin_skills TEXT, linkedin_enriched_at TEXT,
      first_name TEXT, last_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL,
      primary_domain TEXT,
      website_url TEXT
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT,
      status TEXT,
      duration_seconds INTEGER,
      attendees TEXT,
      attendee_emails TEXT
    );
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      content TEXT
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      from_email TEXT,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE email_contact_links (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      contact_id TEXT NOT NULL
    );
    CREATE TABLE email_message_participants (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      contact_id TEXT,
      email TEXT
    );
  `)
  runContactTalentPipelineMigration(db)
  return db
}

function insertContact(db: Database.Database, id: string, email: string) {
  db.prepare(`
    INSERT INTO contacts (id, full_name, normalized_name, email)
    VALUES (?, ?, ?, ?)
  `).run(id, 'Test Contact', 'test contact', email)
  db.prepare(`
    INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)
  `).run(`email-${id}`, id, email)
}

// ── Migration ────────────────────────────────────────────────────────────────

describe('migration 068 — contact talent_pipeline', () => {
  it('adds the talent_pipeline column', () => {
    const db = buildDb()
    const cols = db.pragma('table_info(contacts)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('talent_pipeline')
  })

  it('is idempotent — running twice does not throw', () => {
    const db = buildDb()
    expect(() => runContactTalentPipelineMigration(db)).not.toThrow()
  })
})

// ── Repo write + read ────────────────────────────────────────────────────────

describe('talentPipeline field — updateContact / getContact', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertContact(testDb, 'c1', 'test@example.com')
  })

  it('persists a talentPipeline stage', () => {
    updateContact('c1', { talentPipeline: 'exploring' })
    const result = getContact('c1')
    expect(result?.talentPipeline).toBe('exploring')
  })

  it('persists all valid stages', () => {
    const stages = ['identified', 'exploring', 'ideating', 'fundraising', 'portfolio_candidate', 'internal_candidate'] as const
    for (const stage of stages) {
      updateContact('c1', { talentPipeline: stage })
      expect(getContact('c1')?.talentPipeline).toBe(stage)
    }
  })

  it('clears the field when set to null', () => {
    updateContact('c1', { talentPipeline: 'exploring' })
    updateContact('c1', { talentPipeline: null })
    const result = getContact('c1')
    expect(result?.talentPipeline).toBeNull()
  })
})

// ── listContactsLight includes talentPipeline ────────────────────────────────

describe('listContactsLight — includes talentPipeline', () => {
  beforeEach(() => {
    testDb = buildDb()
    insertContact(testDb, 'c2', 'light@example.com')
  })

  it('returns talentPipeline = null when not set', () => {
    const results = listContactsLight()
    const contact = results.find(c => c.id === 'c2')
    expect(contact?.talentPipeline).toBeNull()
  })

  it('returns talentPipeline after it is set', () => {
    testDb.prepare(`UPDATE contacts SET talent_pipeline = ? WHERE id = ?`).run('ideating', 'c2')
    const results = listContactsLight()
    const contact = results.find(c => c.id === 'c2')
    expect(contact?.talentPipeline).toBe('ideating')
  })
})
