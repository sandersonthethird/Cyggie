/**
 * Tests for the contact tombstone mechanism (migration 098).
 *
 *   • Tombstone read in applyCandidates skips creation for tombstoned emails.
 *   • Tombstone does NOT block name updates for existing contacts that share
 *     a tombstoned email (live row beats stale tombstone).
 *   • Tombstone clear on createContact + addContactEmail.
 *   • AWS forensic regression — full delete → re-sync cycle, contact stays gone.
 *
 * Integration-style: in-memory better-sqlite3 with the minimal schema the
 * code path touches, mirroring contactDedup.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))
vi.mock('@cyggie/db/sqlite/repositories/_sync', () => ({
  withSync: (fn: unknown) => fn,
  configureSyncGlobals: () => {},
}))

const {
  syncContactsFromAttendees,
  syncContactsFromMeetings,
  createContact,
  addContactEmail,
} = await import('@cyggie/db/sqlite/repositories/contact.repo')

function makeTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      date TEXT,
      attendees TEXT,
      attendee_emails TEXT,
      is_group_event INTEGER NOT NULL DEFAULT 0,
      is_group_event_user_set INTEGER NOT NULL DEFAULT 0
    );
    -- Generous column set so getContact (called from addContactEmail) can
    -- SELECT through. Production schema lives across many migrations; we
    -- mirror just the column names here, all nullable.
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      first_name TEXT,
      last_name TEXT,
      normalized_name TEXT NOT NULL DEFAULT '',
      email TEXT,
      primary_company_id TEXT,
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
      fund_size TEXT,
      typical_check_size_min TEXT,
      typical_check_size_max TEXT,
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
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (contact_id, email)
    );
    CREATE TABLE contact_tombstones (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id TEXT
    );
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT,
      normalized_name TEXT,
      primary_domain TEXT
    );
    CREATE TABLE org_company_aliases (
      alias_value TEXT,
      alias_type TEXT,
      company_id TEXT
    );
    CREATE TABLE org_company_contacts (
      company_id TEXT,
      contact_id TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY);
  `)
  return db
}

function insertTombstone(db: Database.Database, email: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO contact_tombstones (id, email, user_id) VALUES (?, ?, ?)`,
  ).run(randomUUID(), email.toLowerCase().trim(), null)
}

function insertContactRaw(db: Database.Database, opts: { id?: string; fullName: string; email: string }): string {
  const id = opts.id ?? randomUUID()
  db.prepare(
    `INSERT INTO contacts (id, full_name, normalized_name, email) VALUES (?, ?, ?, ?)`,
  ).run(id, opts.fullName, opts.fullName.toLowerCase(), opts.email)
  db.prepare(
    `INSERT INTO contact_emails (contact_id, email, is_primary) VALUES (?, ?, 1)`,
  ).run(id, opts.email)
  return id
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ── applyCandidates tombstone filter ─────────────────────────────────────────

describe('syncContactsFromAttendees — tombstone filter at create-new', () => {
  it('skips creating a contact for a tombstoned email', () => {
    insertTombstone(testDb, 'alon@upright.gg')
    syncContactsFromAttendees(['Alon Shavit'], ['alon@upright.gg'], null)
    const contacts = testDb.prepare(`SELECT id FROM contacts`).all() as { id: string }[]
    expect(contacts).toHaveLength(0)
  })

  it('creates contacts for non-tombstoned emails alongside skipped ones', () => {
    insertTombstone(testDb, 'noise@bigcorp.com')
    syncContactsFromAttendees(
      ['Real Person', 'Noise Person'],
      ['real@partner.com', 'noise@bigcorp.com'],
      null,
    )
    const contacts = testDb.prepare(`SELECT email FROM contacts ORDER BY email`).all() as {
      email: string
    }[]
    expect(contacts).toEqual([{ email: 'real@partner.com' }])
  })

  it('does NOT block name updates when contact already exists for tombstoned email', () => {
    // Pre-existing live contact with the tombstoned email — invariant: live
    // row beats stale tombstone. Per Issue 3 of the eng review, the filter
    // fires only at the create-new branch.
    const existingId = insertContactRaw(testDb, {
      fullName: 'A',
      email: 'shared@partner.com',
    })
    insertTombstone(testDb, 'shared@partner.com')

    syncContactsFromAttendees(
      ['Alex Bigsworth'],
      ['shared@partner.com'],
      null,
    )

    const after = testDb
      .prepare(`SELECT id, full_name FROM contacts WHERE id = ?`)
      .get(existingId) as { id: string; full_name: string }
    expect(after.full_name).toBe('Alex Bigsworth')
  })
})

// ── tombstone clear paths ────────────────────────────────────────────────────

describe('tombstone clear paths', () => {
  it('createContact clears any tombstone matching the email', () => {
    insertTombstone(testDb, 'returner@partner.com')
    createContact(
      { fullName: 'The Returner', email: 'returner@partner.com' },
      null,
    )
    const remaining = testDb
      .prepare(`SELECT email FROM contact_tombstones WHERE email = ?`)
      .all('returner@partner.com')
    expect(remaining).toHaveLength(0)
  })

  it('addContactEmail clears tombstone for the added email', () => {
    const contactId = createContact(
      { fullName: 'Owner', email: 'primary@partner.com' },
      null,
    ).id
    insertTombstone(testDb, 'alias@partner.com')

    // addContactEmail's transaction commits the tombstone DELETE before its
    // postscript getContact() runs. We catch any return-shape error from the
    // post-tx read (test schema is intentionally minimal) — the transactional
    // side-effect we care about (tombstone cleared) has already landed.
    try {
      addContactEmail(contactId, 'alias@partner.com', null)
    } catch {
      // Acceptable: production getContact reads columns this test schema
      // doesn't model. The tombstone-clear inside the tx has already committed.
    }

    const remaining = testDb
      .prepare(`SELECT email FROM contact_tombstones WHERE email = ?`)
      .all('alias@partner.com')
    expect(remaining).toHaveLength(0)
  })
})

// ── AWS forensic regression ──────────────────────────────────────────────────

describe('AWS forensic regression — delete + re-sync cycle does not resurrect', () => {
  it('previously-deleted contact stays deleted across syncContactsFromMeetings', () => {
    // Set up the meeting + initial contacts (mirrors the 2026-05-19 audit log
    // pattern: 2-attendee AWS Activate session → 2 contacts created).
    testDb
      .prepare(
        `INSERT INTO meetings (id, title, date, attendee_emails, is_group_event)
         VALUES (?, ?, ?, ?, 0)`,
      )
      .run(
        'm1',
        'AWS Activate',
        '2026-05-19T17:00:00Z',
        JSON.stringify(['alon@upright.gg', 'rliyakat@amazon.com']),
      )

    // First sync: contacts get created from the meeting.
    syncContactsFromMeetings(null)
    let contacts = testDb.prepare(`SELECT email FROM contacts ORDER BY email`).all() as {
      email: string
    }[]
    expect(contacts.map((c) => c.email)).toEqual([
      'alon@upright.gg',
      'rliyakat@amazon.com',
    ])

    // User deletes one contact and writes a tombstone (simulates the IPC
    // handler's transaction).
    testDb.prepare(`DELETE FROM contacts WHERE email = ?`).run('alon@upright.gg')
    insertTombstone(testDb, 'alon@upright.gg')

    // Second sync: should NOT resurrect the deleted contact.
    syncContactsFromMeetings(null)
    contacts = testDb.prepare(`SELECT email FROM contacts ORDER BY email`).all() as {
      email: string
    }[]
    expect(contacts.map((c) => c.email)).toEqual(['rliyakat@amazon.com'])

    // Tombstone is still in place.
    const tomb = testDb
      .prepare(`SELECT email FROM contact_tombstones`)
      .all() as { email: string }[]
    expect(tomb.map((t) => t.email)).toEqual(['alon@upright.gg'])
  })
})
