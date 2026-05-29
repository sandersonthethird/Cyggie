/**
 * Regression tests for contact.repo.ts contactType handling.
 *
 * These guard the fix that removed the hardcoded VALID_CONTACT_TYPES whitelist.
 * Before the fix:
 *   - updateContact threw "Invalid contact type: X" for any non-builtin value
 *   - getContact filtered custom values back to null on read
 *   - mergeContacts nulled custom contact_type values during dedup
 *
 * After the fix: any non-empty string is accepted, persisted, read back as-is,
 * and survives merges.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb
}))

const { getContact, updateContact } = await import('@cyggie/db/sqlite/repositories/contact.repo')

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Schema reflects columns referenced by getContact + updateContact + mergeContacts.
  // Keep it broad-but-flat; rows can leave most columns null.
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (contact_id, email)
    );
    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL REFERENCES org_companies(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      role_label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, contact_id)
    );
    -- Empty stubs needed for getContact's email-activity + meetings queries.
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      from_email TEXT,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT
    );
    CREATE TABLE email_contact_links (
      message_id TEXT,
      contact_id TEXT
    );
    CREATE TABLE email_message_participants (
      message_id TEXT,
      contact_id TEXT,
      email TEXT
    );
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      starts_at TEXT,
      ends_at TEXT
    );
    CREATE TABLE meeting_participants (
      meeting_id TEXT,
      email TEXT,
      contact_id TEXT
    );
  `)
  return db
}

function insertContact(id: string, fullName: string, contactType: string | null = null) {
  testDb.prepare(`
    INSERT INTO contacts (id, full_name, normalized_name, contact_type)
    VALUES (?, ?, ?, ?)
  `).run(id, fullName, fullName.toLowerCase().replace(/\s+/g, ''), contactType)
}

describe('contact.repo contactType — custom values', () => {
  beforeEach(() => {
    testDb = buildDb()
  })

  it('updateContact persists a custom contactType value (no whitelist throw)', () => {
    insertContact('c1', 'Test Contact', 'investor')
    expect(() => updateContact('c1', { contactType: 'candidate' })).not.toThrow()
    const row = testDb.prepare(`SELECT contact_type FROM contacts WHERE id = ?`).get('c1') as { contact_type: string }
    expect(row.contact_type).toBe('candidate')
  })

  it('updateContact accepts any non-builtin string value', () => {
    insertContact('c1', 'Test Contact')
    expect(() => updateContact('c1', { contactType: 'strategic_partner' })).not.toThrow()
    expect(() => updateContact('c1', { contactType: 'Acquirer' })).not.toThrow()
    expect(() => updateContact('c1', { contactType: 'mentor' })).not.toThrow()
  })

  it('updateContact still accepts builtin values', () => {
    insertContact('c1', 'Test Contact')
    expect(() => updateContact('c1', { contactType: 'founder' })).not.toThrow()
    const row = testDb.prepare(`SELECT contact_type FROM contacts WHERE id = ?`).get('c1') as { contact_type: string }
    expect(row.contact_type).toBe('founder')
  })

  it('getContact returns a custom contactType value unchanged (no whitelist filter on read)', () => {
    insertContact('c1', 'Custom Type Contact', 'strategic_partner')
    const contact = getContact('c1')
    expect(contact).not.toBeNull()
    expect(contact!.contactType).toBe('strategic_partner')
  })

  it('getContact still returns builtin values', () => {
    insertContact('c1', 'Investor Contact', 'investor')
    const contact = getContact('c1')
    expect(contact!.contactType).toBe('investor')
  })

})

// Note: mergeContacts integration tests intentionally omitted. The merge change
// is mechanical — contact_type now uses the same prefer-non-empty rule as
// title/linkedin_url/etc. in the same function. The write+read tests above are
// the load-bearing regression guard against re-introducing the whitelist.
