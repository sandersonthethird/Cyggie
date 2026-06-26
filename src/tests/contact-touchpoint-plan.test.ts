/**
 * Regression tests for the Contacts "activity touchpoint" meeting fix
 * (migration 135-meeting-attendee-emails + the meeting_touch rewrite).
 *
 * Background: listContactsLight({ includeActivityTouchpoint: true }) runs
 * TOUCHPOINT_CTES synchronously on the Electron main thread on every Contacts
 * mount. Its meeting_touch branch used to correlate json_each(attendee_emails)
 * against every contact email — O(contacts × meetings), ~1s at ~5k meetings,
 * which beachballed the whole app. It now joins meeting_attendee_emails, a
 * trigger-maintained, indexed lookup table (~3ms).
 *
 * Two failure modes guarded here:
 *   1. PLAN DRIFT — meeting_touch silently stops using idx_mae_email (e.g. the
 *      CTE join or the table's email_lc normalization is edited out of sync),
 *      reverting to a scan and re-freezing the app. The plan-pinning test fails.
 *   2. SYNC DRIFT — the triggers stop maintaining meeting_attendee_emails, so
 *      touchpoints silently regress to the updated_at fallback. The trigger
 *      tests fail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', () => ({
  getDatabase: () => testDb,
}))

const { listContactsLight } = await import('@cyggie/db/sqlite/repositories/contact.repo')
const { runMeetingAttendeeEmailsMigration } = await import(
  '@cyggie/db/sqlite/migrations/135-meeting-attendee-emails'
)

function baseSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, first_name TEXT, last_name TEXT,
      is_private INTEGER NOT NULL DEFAULT 0, normalized_name TEXT, email TEXT,
      primary_company_id TEXT, title TEXT, contact_type TEXT, talent_pipeline TEXT,
      linkedin_url TEXT, crm_contact_id TEXT, crm_provider TEXT, phone TEXT, street TEXT,
      city TEXT, state TEXT, postal_code TEXT, country TEXT, timezone TEXT, twitter_handle TEXT,
      university TEXT, pronouns TEXT, last_met_event TEXT, warm_intro_path TEXT, notes TEXT,
      fund_size REAL, typical_check_size_min REAL, typical_check_size_max REAL,
      investment_sector_focus_notes TEXT, proud_portfolio_companies TEXT, tags TEXT,
      previous_companies TEXT, investment_stage_focus TEXT, investment_sector_focus TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE contact_emails (
      contact_id TEXT NOT NULL, email TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (contact_id, email)
    );
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, date TEXT, attendee_emails TEXT, attendees TEXT);
    CREATE TABLE email_messages (
      id TEXT PRIMARY KEY, from_email TEXT, received_at TEXT, sent_at TEXT, created_at TEXT
    );
    CREATE TABLE email_message_participants (
      id TEXT PRIMARY KEY, message_id TEXT, contact_id TEXT, email TEXT
    );
    CREATE TABLE email_contact_links (id TEXT PRIMARY KEY, message_id TEXT, contact_id TEXT);
  `)
}

/** Capture the exact SQL listContactsLight prepares for the touchpoint path. */
function captureTouchpointSql(): string {
  let captured = ''
  const orig = testDb.prepare.bind(testDb)
  testDb.prepare = ((sql: string) => {
    if (sql.length > captured.length) captured = sql
    return orig(sql)
  }) as typeof testDb.prepare
  try {
    listContactsLight({ includeActivityTouchpoint: true })
  } finally {
    testDb.prepare = orig
  }
  return captured
}

describe('meeting_touch — query plan uses idx_mae_email, not json_each', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    baseSchema(testDb)
    // Representative cardinality: a moderate contact set joined against a much
    // larger meeting graph, so the indexed lookup is the unambiguous plan.
    const CONTACTS = 50
    const MEETINGS = 3000
    const tx = testDb.transaction(() => {
      const ic = testDb.prepare(`INSERT INTO contacts (id, full_name, email, updated_at) VALUES (?, ?, ?, '2020-01-01T00:00:00.000Z')`)
      const ice = testDb.prepare(`INSERT INTO contact_emails (contact_id, email) VALUES (?, ?)`)
      for (let i = 0; i < CONTACTS; i++) { ic.run(`c${i}`, `Person ${i}`, `person${i}@x.com`); ice.run(`c${i}`, `person${i}@x.com`) }
      const im = testDb.prepare(`INSERT INTO meetings (id, date, attendee_emails) VALUES (?, ?, ?)`)
      for (let i = 0; i < MEETINGS; i++) im.run(`m${i}`, '2022-03-01T00:00:00.000Z', JSON.stringify([`person${i % CONTACTS}@x.com`, 'noise@x.com']))
    })
    tx()
    runMeetingAttendeeEmailsMigration(testDb)
  })

  it('plans an indexed join on meeting_attendee_emails', () => {
    const sql = captureTouchpointSql()
    const detail = (testDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(200, 0) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join('\n')

    // The meeting branch must use the email index on the derived table...
    expect(detail).toContain('idx_mae_email')
    // ...and must NOT fall back to a per-row json_each scan of the meetings table
    // (the O(contacts×meetings) form that beachballed the app).
    expect(detail).not.toMatch(/json_each|VIRTUAL TABLE/i)
  })
})

describe('meeting_attendee_emails — triggers keep touchpoints in sync', () => {
  beforeEach(() => {
    testDb = new Database(':memory:')
    baseSchema(testDb)
    testDb.prepare(`INSERT INTO contacts (id, full_name, email, updated_at) VALUES ('c1', 'Ann', 'ann@x.com', '2020-01-01T00:00:00.000Z')`).run()
    testDb.prepare(`INSERT INTO contact_emails (contact_id, email) VALUES ('c1', 'ann@x.com')`).run()
    runMeetingAttendeeEmailsMigration(testDb)
  })

  const touchpoint = () =>
    listContactsLight({ includeActivityTouchpoint: true }).find((r) => r.id === 'c1')?.lastTouchpoint

  it('INSERT meeting → contact gains the meeting touchpoint (case/space-insensitive)', () => {
    expect(touchpoint()).toBe('2020-01-01T00:00:00.000Z') // updated_at fallback
    testDb.prepare(`INSERT INTO meetings (id, date, attendee_emails) VALUES ('mt1', '2023-05-01T00:00:00.000Z', ?)`).run(JSON.stringify(['  ANN@x.com ']))
    expect(touchpoint()).toBe('2023-05-01T00:00:00.000Z')
  })

  it('UPDATE meeting attendees → touchpoint follows', () => {
    testDb.prepare(`INSERT INTO meetings (id, date, attendee_emails) VALUES ('mt1', '2023-05-01T00:00:00.000Z', ?)`).run(JSON.stringify(['ann@x.com']))
    expect(touchpoint()).toBe('2023-05-01T00:00:00.000Z')
    // Remove ann from the meeting → she loses the touchpoint, back to fallback.
    testDb.prepare(`UPDATE meetings SET attendee_emails = ? WHERE id = 'mt1'`).run(JSON.stringify(['other@x.com']))
    expect(touchpoint()).toBe('2020-01-01T00:00:00.000Z')
  })

  it('DELETE meeting → derived rows and touchpoint revert', () => {
    testDb.prepare(`INSERT INTO meetings (id, date, attendee_emails) VALUES ('mt1', '2023-05-01T00:00:00.000Z', ?)`).run(JSON.stringify(['ann@x.com']))
    expect(touchpoint()).toBe('2023-05-01T00:00:00.000Z')
    testDb.prepare(`DELETE FROM meetings WHERE id = 'mt1'`).run()
    expect(touchpoint()).toBe('2020-01-01T00:00:00.000Z')
    expect(testDb.prepare(`SELECT COUNT(*) AS n FROM meeting_attendee_emails`).get()).toEqual({ n: 0 })
  })
})
