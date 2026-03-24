/**
 * Tests for contact data repair migrations.
 *
 * Covers:
 *   1. repairContactCompanyMismatches — unlinks contacts whose email domain
 *      doesn't match the company's primary domain; keeps matching ones.
 *
 *   2. enrichContact / companyHitsByEmail domain validation — ensures that
 *      meeting co-attendance alone no longer causes a contact to be assigned
 *      to the host company when their email domain doesn't match.
 *      (Root cause of 331 contacts incorrectly linked to Red Swan Ventures.)
 *
 *   3. runRepairOwnerLinkedinUrlMigration — clears LinkedIn URLs that were
 *      incorrectly copied from the owner's contact record onto other contacts.
 *
 *   4. runRemoveNotificationContactsMigration — deletes contacts created from
 *      notification/bot email addresses (e.g. calendar-notification@google.com).
 *
 * Mock boundary: getDatabase() → in-memory SQLite (real SQL, no mocking).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('../main/database/connection', () => ({
  getDatabase: () => testDb,
}))

const { repairContactCompanyMismatches, enrichContact } = await import(
  '../main/database/repositories/contact.repo'
)
const { runRepairOwnerLinkedinUrlMigration } = await import(
  '../main/database/migrations/062-repair-owner-linkedin-url'
)
const { runRemoveNotificationContactsMigration } = await import(
  '../main/database/migrations/063-remove-notification-contacts'
)

// ---------------------------------------------------------------------------
// Minimal schema helpers
// ---------------------------------------------------------------------------

function buildRepairDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF') // avoid FK order issues in tests
  db.exec(`
    CREATE TABLE org_companies (
      id TEXT PRIMARY KEY,
      canonical_name TEXT NOT NULL DEFAULT '',
      primary_domain TEXT
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL DEFAULT '',
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      primary_company_id TEXT,
      linkedin_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY DEFAULT (hex(randomblob(8))),
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (company_id, contact_id)
    );
  `)
  return db
}

function buildEnrichDb(): Database.Database {
  const db = buildRepairDb()
  // Additional tables needed by enrichContactCandidates
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      attendees TEXT,
      attendee_emails TEXT,
      date TEXT
    );
    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL
    );
    CREATE TABLE email_message_participants (
      id TEXT PRIMARY KEY DEFAULT (hex(randomblob(8))),
      message_id TEXT NOT NULL,
      contact_id TEXT,
      email TEXT,
      display_name TEXT
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      from_email TEXT,
      from_name TEXT,
      body_text TEXT,
      snippet TEXT,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE org_company_aliases (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      alias_value TEXT NOT NULL,
      alias_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Additional columns org_companies needs for createOrgCompany
  `)
  db.exec(`
    -- Expand org_companies to full schema for createOrgCompany writes
    ALTER TABLE org_companies ADD COLUMN normalized_name TEXT;
    ALTER TABLE org_companies ADD COLUMN website_url TEXT;
    ALTER TABLE org_companies ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE org_companies ADD COLUMN include_in_companies_view INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE org_companies ADD COLUMN classification_source TEXT NOT NULL DEFAULT 'auto';
    ALTER TABLE org_companies ADD COLUMN classification_confidence REAL;
    ALTER TABLE org_companies ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'));
    ALTER TABLE org_companies ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'));
  `)
  return db
}

// ---------------------------------------------------------------------------
// repairContactCompanyMismatches
// ---------------------------------------------------------------------------

describe('repairContactCompanyMismatches', () => {
  beforeEach(() => {
    testDb = buildRepairDb()
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, primary_domain)
      VALUES ('rsv', 'Red Swan Ventures', 'redswanventures.com');

      -- Internal employee — email matches domain → keep
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-internal', 'Alice Internal', 'aliceinternal', 'alice@redswanventures.com', 'rsv');
      INSERT INTO org_company_contacts (company_id, contact_id, is_primary)
      VALUES ('rsv', 'c-internal', 1);

      -- External contact, email doesn't match → remove
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-external', 'Bob External', 'bobexternal', 'bob@techcorp.com', 'rsv');
      INSERT INTO org_company_contacts (company_id, contact_id, is_primary)
      VALUES ('rsv', 'c-external', 1);

      -- External contact with email in contact_emails table (not contacts.email) → remove
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-extra', 'Carol Extra', 'carolextra', NULL, 'rsv');
      INSERT INTO contact_emails (id, contact_id, email, is_primary)
      VALUES ('ce-1', 'c-extra', 'carol@vc-fund.com', 1);
      INSERT INTO org_company_contacts (company_id, contact_id, is_primary)
      VALUES ('rsv', 'c-extra', 1);
    `)
  })

  it('removes contacts whose email domain does not match the company primary domain', () => {
    const removed = repairContactCompanyMismatches('rsv')
    expect(removed).toBe(2) // bob@techcorp.com and carol@vc-fund.com
  })

  it('clears primary_company_id for removed contacts', () => {
    repairContactCompanyMismatches('rsv')
    const bob = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-external'`)
      .get() as { primary_company_id: string | null }
    expect(bob.primary_company_id).toBeNull()
  })

  it('removes removed contacts from org_company_contacts', () => {
    repairContactCompanyMismatches('rsv')
    const link = testDb
      .prepare(
        `SELECT 1 FROM org_company_contacts WHERE company_id = 'rsv' AND contact_id = 'c-external'`,
      )
      .get()
    expect(link).toBeUndefined()
  })

  it('retains contacts whose email matches the company domain', () => {
    repairContactCompanyMismatches('rsv')
    const alice = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-internal'`)
      .get() as { primary_company_id: string | null }
    expect(alice.primary_company_id).toBe('rsv')
  })

  it('returns 0 when company has no primary domain', () => {
    testDb.exec(`INSERT INTO org_companies (id, canonical_name) VALUES ('no-domain', 'No Domain Co')`)
    testDb.exec(
      `INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id) VALUES ('cx', 'X', 'x', 'x@x.com', 'no-domain')`,
    )
    const removed = repairContactCompanyMismatches('no-domain')
    expect(removed).toBe(0)
  })

  it('returns 0 when all contacts have matching domain', () => {
    // Remove external contacts, leave only internal
    testDb.exec(`
      UPDATE contacts SET primary_company_id = NULL WHERE id IN ('c-external', 'c-extra')
    `)
    const removed = repairContactCompanyMismatches('rsv')
    expect(removed).toBe(0)
  })

  it('checks contact_emails table for domain match when contacts.email is null', () => {
    // carol has email only in contact_emails, and it doesn't match
    repairContactCompanyMismatches('rsv')
    const carol = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-extra'`)
      .get() as { primary_company_id: string | null }
    expect(carol.primary_company_id).toBeNull()
  })

  it('retains contact whose domain match is in contact_emails (not contacts.email)', () => {
    // Add internal contact where the match is in contact_emails, not contacts.email
    testDb.exec(`
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-email-table', 'Dave Internal', 'daveinternal', NULL, 'rsv');
      INSERT INTO contact_emails (id, contact_id, email, is_primary)
      VALUES ('ce-2', 'c-email-table', 'dave@redswanventures.com', 1);
      INSERT INTO org_company_contacts (company_id, contact_id, is_primary)
      VALUES ('rsv', 'c-email-table', 1);
    `)
    repairContactCompanyMismatches('rsv')
    const dave = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-email-table'`)
      .get() as { primary_company_id: string | null }
    expect(dave.primary_company_id).toBe('rsv')
  })
})

// ---------------------------------------------------------------------------
// enrichContact — companyHitsByEmail domain validation
//
// Scenario: alice@techcorp.com attended 8 Red Swan–hosted meetings and 0
// TechCorp meetings. TechCorp doesn't yet exist in org_companies.
//
// BEFORE FIX: alice would be assigned to Red Swan (highest meeting hits).
// AFTER FIX:  Red Swan is rejected (domain mismatch), TechCorp is created
//             from alice's actual email domain, alice is assigned to TechCorp.
// ---------------------------------------------------------------------------

describe('enrichContact — companyHitsByEmail domain validation', () => {
  beforeEach(() => {
    testDb = buildEnrichDb()
    testDb.exec(`
      -- Only Red Swan exists in org_companies
      INSERT INTO org_companies (id, canonical_name, primary_domain, entity_type, classification_source)
      VALUES ('rsv', 'Red Swan Ventures', 'redswanventures.com', 'vc_fund', 'manual');

      -- Alice has no primary company yet; her email is @techcorp.com (not Red Swan)
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-alice', 'Alice Example', 'aliceexample', 'alice@techcorp.com', NULL);

      -- Red Swan is linked to 8 meetings that Alice attended
      INSERT INTO meetings (id, attendees, attendee_emails, date) VALUES
        ('m1', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-01'),
        ('m2', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-02'),
        ('m3', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-03'),
        ('m4', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-04'),
        ('m5', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-05'),
        ('m6', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-06'),
        ('m7', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-07'),
        ('m8', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-08');

      -- All 8 meetings are linked to Red Swan (not to TechCorp, which doesn't exist)
      INSERT INTO meeting_company_links (meeting_id, company_id) VALUES
        ('m1', 'rsv'), ('m2', 'rsv'), ('m3', 'rsv'), ('m4', 'rsv'),
        ('m5', 'rsv'), ('m6', 'rsv'), ('m7', 'rsv'), ('m8', 'rsv');
    `)
  })

  it('does NOT assign alice@techcorp.com to Red Swan despite 8 meeting co-attendances', async () => {
    enrichContact('c-alice')

    const alice = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-alice'`)
      .get() as { primary_company_id: string | null }

    expect(alice.primary_company_id).not.toBe('rsv')
  })

  it('assigns alice@techcorp.com to a TechCorp company (created from her email domain)', async () => {
    enrichContact('c-alice')

    const alice = testDb
      .prepare(`
        SELECT c.primary_company_id, oc.primary_domain
        FROM contacts c
        JOIN org_companies oc ON oc.id = c.primary_company_id
        WHERE c.id = 'c-alice'
      `)
      .get() as { primary_company_id: string; primary_domain: string } | undefined

    expect(alice).toBeDefined()
    expect(alice!.primary_domain).toBe('techcorp.com')
  })
})

// ---------------------------------------------------------------------------
// enrichContact — domain-matched meeting hit still works
//
// If alice@techcorp.com appears in meetings LINKED to a TechCorp company
// (and TechCorp is in the DB), the meeting-context hit is valid since the
// email domain matches TechCorp's primary_domain.
// ---------------------------------------------------------------------------

describe('enrichContact — meeting hit accepted when domain matches', () => {
  beforeEach(() => {
    testDb = buildEnrichDb()
    testDb.exec(`
      INSERT INTO org_companies (id, canonical_name, primary_domain, entity_type, classification_source)
      VALUES
        ('rsv', 'Red Swan Ventures', 'redswanventures.com', 'vc_fund', 'manual'),
        ('tc',  'TechCorp',          'techcorp.com',        'unknown', 'auto');

      -- Alice has no company; email domain matches TechCorp
      INSERT INTO contacts (id, full_name, normalized_name, email, primary_company_id)
      VALUES ('c-alice', 'Alice Example', 'aliceexample', 'alice@techcorp.com', NULL);

      -- 3 Red Swan meetings, 2 TechCorp meetings
      INSERT INTO meetings (id, attendees, attendee_emails, date) VALUES
        ('m1', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-01'),
        ('m2', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-02'),
        ('m3', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-03'),
        ('m4', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-04'),
        ('m5', '["Alice Example"]', '["alice@techcorp.com"]', '2024-01-05');

      INSERT INTO meeting_company_links (meeting_id, company_id) VALUES
        ('m1', 'rsv'), ('m2', 'rsv'), ('m3', 'rsv'),
        ('m4', 'tc'),  ('m5', 'tc');
    `)
  })

  it('assigns alice to TechCorp (domain-matched hit) rather than Red Swan (more hits but no match)', () => {
    enrichContact('c-alice')

    const alice = testDb
      .prepare(`SELECT primary_company_id FROM contacts WHERE id = 'c-alice'`)
      .get() as { primary_company_id: string | null }

    expect(alice.primary_company_id).toBe('tc')
  })
})

// ---------------------------------------------------------------------------
// runRepairOwnerLinkedinUrlMigration
//
// Owner's LinkedIn URL was incorrectly copied onto co-attendee contacts during
// enrichment. The migration finds the owner's contact by their configured
// email, then clears that same URL from all other contacts.
// ---------------------------------------------------------------------------

function buildMigration062Db(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL DEFAULT '',
      email TEXT,
      linkedin_url TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY DEFAULT (hex(randomblob(8))),
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY,
      from_email TEXT,
      body_text TEXT,
      snippet TEXT,
      received_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

describe('runRepairOwnerLinkedinUrlMigration', () => {
  beforeEach(() => {
    testDb = buildMigration062Db()
    testDb.exec(`
      -- Owner email configured in settings
      INSERT INTO settings (key, value) VALUES ('currentUserEmail', 'owner@redswan.com');

      -- Owner's own contact record with their LinkedIn URL
      INSERT INTO contacts (id, full_name, normalized_name, email, linkedin_url)
      VALUES ('c-owner', 'Sandy Cass', 'sandycass', 'owner@redswan.com', 'https://linkedin.com/in/sandycass');

      -- Two contacts that incorrectly inherited the owner's LinkedIn URL
      INSERT INTO contacts (id, full_name, normalized_name, email, linkedin_url)
      VALUES ('c-kathleen', 'Kathleen Perley', 'kathleenperley', 'kathleen@adair.ai', 'https://linkedin.com/in/sandycass');

      INSERT INTO contacts (id, full_name, normalized_name, email, linkedin_url)
      VALUES ('c-other', 'Other Person', 'otherperson', 'other@example.com', 'https://linkedin.com/in/sandycass');

      -- Contact with a different LinkedIn URL — must not be touched
      INSERT INTO contacts (id, full_name, normalized_name, email, linkedin_url)
      VALUES ('c-distinct', 'Distinct Person', 'distinctperson', 'distinct@example.com', 'https://linkedin.com/in/distinctperson');

      -- Contact with no LinkedIn URL — must not be touched
      INSERT INTO contacts (id, full_name, normalized_name, email, linkedin_url)
      VALUES ('c-nourl', 'No URL', 'nourl', 'nourl@example.com', NULL);
    `)
  })

  it('clears the owner LinkedIn URL from contacts that inherited it', () => {
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    const other = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-other'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBeNull()
    expect(other.linkedin_url).toBeNull()
  })

  it('does not clear the LinkedIn URL from the owner contact itself', () => {
    runRepairOwnerLinkedinUrlMigration(testDb)
    const owner = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-owner'`)
      .get() as { linkedin_url: string | null }
    expect(owner.linkedin_url).toBe('https://linkedin.com/in/sandycass')
  })

  it('does not touch contacts with a different LinkedIn URL', () => {
    runRepairOwnerLinkedinUrlMigration(testDb)
    const distinct = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-distinct'`)
      .get() as { linkedin_url: string | null }
    expect(distinct.linkedin_url).toBe('https://linkedin.com/in/distinctperson')
  })

  it('is a no-op when owner email is not configured and no duplicate slugs', () => {
    testDb.exec(`DELETE FROM settings WHERE key = 'currentUserEmail'`)
    // Give each contact a unique URL so Strategy C has nothing to act on
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/kathleen' WHERE id = 'c-kathleen'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/other' WHERE id = 'c-other'`)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBe('https://linkedin.com/in/kathleen')
  })

  it('is a no-op when the owner has no contact record and no emails and no duplicate slugs', () => {
    testDb.exec(`DELETE FROM contacts WHERE id = 'c-owner'`)
    // Give remaining contacts unique URLs so Strategy C has nothing to act on
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/kathleen' WHERE id = 'c-kathleen'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/other' WHERE id = 'c-other'`)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBe('https://linkedin.com/in/kathleen')
  })

  it('is a no-op when owner contact has no LinkedIn URL and no emails and no duplicate slugs', () => {
    testDb.exec(`UPDATE contacts SET linkedin_url = NULL WHERE id = 'c-owner'`)
    // Give remaining contacts unique URLs so Strategy C has nothing to act on
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/kathleen' WHERE id = 'c-kathleen'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/other' WHERE id = 'c-other'`)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBe('https://linkedin.com/in/kathleen')
  })

  it('strategy B: clears URL found in owner email signature when owner has no contact record', () => {
    testDb.exec(`DELETE FROM contacts WHERE id = 'c-owner'`)
    // Seed an outbound email from the owner whose signature contains their LinkedIn URL
    testDb.exec(`
      INSERT INTO email_messages (id, from_email, body_text)
      VALUES ('em-1', 'owner@redswan.com',
        'Hi Kathleen,\n\nLet us connect!\n\nSandy\nhttps://linkedin.com/in/sandycass');
    `)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBeNull()
  })

  it('clears URL even when stored without protocol (www.linkedin.com/in/...)', () => {
    // Owner's contact has the https:// version; Kathleen has the www. version (no protocol)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'www.linkedin.com/in/sandycass/' WHERE id = 'c-kathleen'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'www.linkedin.com/in/sandycass/' WHERE id = 'c-other'`)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    const other = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-other'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBeNull()
    expect(other.linkedin_url).toBeNull()
  })

  it('strategy B: clears URL when email body contains www. URL without protocol', () => {
    testDb.exec(`DELETE FROM contacts WHERE id = 'c-owner'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'www.linkedin.com/in/sandycass/' WHERE id = 'c-kathleen'`)
    testDb.exec(`
      INSERT INTO email_messages (id, from_email, body_text)
      VALUES ('em-2', 'owner@redswan.com',
        'Sandy Cass\nwww.linkedin.com/in/sandycass');
    `)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    expect(kathleen.linkedin_url).toBeNull()
  })

  it('strategy C: clears contacts sharing the same slug even without owner email configured', () => {
    // Remove owner email from settings so strategies A and B are skipped
    testDb.exec(`DELETE FROM settings WHERE key = 'currentUserEmail'`)
    // Two contacts share the same slug in different formats
    testDb.exec(`UPDATE contacts SET linkedin_url = 'https://linkedin.com/in/sandycass' WHERE id = 'c-owner'`)
    testDb.exec(`UPDATE contacts SET linkedin_url = 'www.linkedin.com/in/sandycass/' WHERE id = 'c-kathleen'`)
    runRepairOwnerLinkedinUrlMigration(testDb)
    const owner = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-owner'`)
      .get() as { linkedin_url: string | null }
    const kathleen = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-kathleen'`)
      .get() as { linkedin_url: string | null }
    const distinct = testDb
      .prepare(`SELECT linkedin_url FROM contacts WHERE id = 'c-distinct'`)
      .get() as { linkedin_url: string | null }
    // Both sharing the same slug are cleared
    expect(owner.linkedin_url).toBeNull()
    expect(kathleen.linkedin_url).toBeNull()
    // Contact with a unique slug is untouched
    expect(distinct.linkedin_url).toBe('https://linkedin.com/in/distinctperson')
  })
})

// ---------------------------------------------------------------------------
// runRemoveNotificationContactsMigration (migration 063)
// ---------------------------------------------------------------------------

function buildNotificationContactsDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      email TEXT,
      updated_at TEXT
    );
    CREATE TABLE contact_emails (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      email TEXT NOT NULL
    );
    CREATE TABLE org_company_contacts (
      company_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      PRIMARY KEY (company_id, contact_id)
    );
    INSERT INTO contacts (id, full_name, email) VALUES
      ('c-cal',   'Google Calendar',   'calendar-notification@google.com'),
      ('c-noreply', 'No Reply',        'noreply@example.com'),
      ('c-alice', 'Alice Smith',       'alice@techcorp.com'),
      ('c-bounce', 'Bounce',           'bounces@mail.example.com');
    INSERT INTO org_company_contacts VALUES ('co-1', 'c-cal');
    INSERT INTO org_company_contacts VALUES ('co-1', 'c-alice');
  `)
  return db
}

describe('runRemoveNotificationContactsMigration', () => {
  beforeEach(() => {
    testDb = buildNotificationContactsDb()
  })

  it('removes contacts with notification email addresses', () => {
    runRemoveNotificationContactsMigration(testDb)
    const remaining = testDb
      .prepare(`SELECT id FROM contacts ORDER BY id`)
      .all() as Array<{ id: string }>
    const ids = remaining.map((r) => r.id)
    expect(ids).toContain('c-alice')
    expect(ids).not.toContain('c-cal')
    expect(ids).not.toContain('c-noreply')
    expect(ids).not.toContain('c-bounce')
  })

  it('removes associated junction rows for deleted contacts', () => {
    runRemoveNotificationContactsMigration(testDb)
    const junctions = testDb
      .prepare(`SELECT contact_id FROM org_company_contacts`)
      .all() as Array<{ contact_id: string }>
    const ids = junctions.map((r) => r.contact_id)
    expect(ids).not.toContain('c-cal')
    expect(ids).toContain('c-alice')
  })

  it('is a no-op when no notification contacts exist', () => {
    testDb.exec(`DELETE FROM contacts WHERE id IN ('c-cal', 'c-noreply', 'c-bounce')`)
    expect(() => runRemoveNotificationContactsMigration(testDb)).not.toThrow()
    const count = (testDb.prepare(`SELECT COUNT(*) AS n FROM contacts`).get() as { n: number }).n
    expect(count).toBe(1) // only alice remains
  })
})
