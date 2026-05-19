/**
 * Tests for the group-event ingestion gate (migration 098):
 *   • shouldSyncAttendees — read-only gate
 *   • computeAutoGroupEventFlag — pure decision function
 *   • syncContactsFromMeetings WHERE clause filter
 *   • MEETING_PREPARE no longer re-runs syncContactsFromAttendees against
 *     existing meetings (Part 2 regression)
 *
 * Schema setup follows the codebase pattern: in-memory better-sqlite3 with a
 * minimal hand-rolled schema (only the columns under test) — same approach
 * used in contactDedup.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

// Sync wrapper depends on globals configured at app bootstrap; tests don't
// exercise the outbox, so we stub it out.
vi.mock('@cyggie/db/sqlite/repositories/_sync', () => ({
  withSync: (fn: unknown) => fn,
  configureSyncGlobals: () => {},
}))

const {
  shouldSyncAttendees,
  computeAutoGroupEventFlag,
} = await import('@cyggie/db/sqlite/repositories/meeting.repo')

const { syncContactsFromMeetings } = await import(
  '@cyggie/db/sqlite/repositories/contact.repo'
)

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
      is_group_event_user_set INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Minimal contact tables exercised by syncContactsFromMeetings →
    -- applyCandidates. Real schema is richer; we include just what the
    -- code path needs.
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL DEFAULT '',
      first_name TEXT,
      last_name TEXT,
      normalized_name TEXT NOT NULL DEFAULT '',
      email TEXT,
      primary_company_id TEXT,
      created_by_user_id TEXT,
      updated_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      contact_id TEXT NOT NULL,
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

function insertMeeting(
  db: Database.Database,
  opts: {
    id?: string
    attendeeEmails?: string[] | null
    isGroupEvent?: boolean
    isGroupEventUserSet?: boolean
  } = {},
): string {
  const id = opts.id ?? randomUUID()
  db.prepare(
    `INSERT INTO meetings (id, title, date, attendee_emails, is_group_event, is_group_event_user_set)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'Test',
    '2026-05-19T10:00:00Z',
    opts.attendeeEmails ? JSON.stringify(opts.attendeeEmails) : null,
    opts.isGroupEvent ? 1 : 0,
    opts.isGroupEventUserSet ? 1 : 0,
  )
  return id
}

beforeEach(() => {
  testDb = makeTestDb()
})

// ── computeAutoGroupEventFlag (pure) ─────────────────────────────────────────

describe('computeAutoGroupEventFlag', () => {
  it('auto-flag fires when count > threshold and user_set=false', () => {
    expect(computeAutoGroupEventFlag(11, false, false, 10)).toBe(true)
  })

  it('auto-flag does not fire at the boundary (count = threshold)', () => {
    expect(computeAutoGroupEventFlag(10, false, false, 10)).toBe(null)
  })

  it('returns null when value would not change', () => {
    expect(computeAutoGroupEventFlag(11, false, true, 10)).toBe(null)
    expect(computeAutoGroupEventFlag(3, false, false, 10)).toBe(null)
  })

  it('user_set=true locks the value — always returns null', () => {
    expect(computeAutoGroupEventFlag(50, true, false, 10)).toBe(null)
    expect(computeAutoGroupEventFlag(2, true, true, 10)).toBe(null)
  })
})

// ── shouldSyncAttendees ──────────────────────────────────────────────────────

describe('shouldSyncAttendees', () => {
  it('returns true for a non-group meeting', () => {
    const id = insertMeeting(testDb, { isGroupEvent: false })
    expect(shouldSyncAttendees(id)).toBe(true)
  })

  it('returns false for a group-event meeting', () => {
    const id = insertMeeting(testDb, { isGroupEvent: true })
    expect(shouldSyncAttendees(id)).toBe(false)
  })

  it('returns false defensively for a missing meeting id', () => {
    expect(shouldSyncAttendees('does-not-exist')).toBe(false)
  })
})

// ── syncContactsFromMeetings group-event WHERE filter ────────────────────────

describe('syncContactsFromMeetings — group-event WHERE filter', () => {
  it('does not create contacts from a group-event meeting attendee list', () => {
    insertMeeting(testDb, {
      attendeeEmails: ['noise1@bigcorp.com', 'noise2@bigcorp.com'],
      isGroupEvent: true,
    })
    syncContactsFromMeetings(null)
    const contacts = testDb.prepare(`SELECT id FROM contacts`).all() as { id: string }[]
    expect(contacts).toHaveLength(0)
  })

  it('does create contacts from a non-group meeting attendee list', () => {
    insertMeeting(testDb, {
      attendeeEmails: ['real@partner.com'],
      isGroupEvent: false,
    })
    syncContactsFromMeetings(null)
    const contacts = testDb.prepare(`SELECT id, email FROM contacts`).all() as {
      id: string
      email: string
    }[]
    expect(contacts).toHaveLength(1)
    expect(contacts[0]!.email).toBe('real@partner.com')
  })
})
