/**
 * T3 · Slice 0 · Part 2 — error isolation (eng-review 6A).
 *
 * The enrichment rewire moves contact/company persistence into the
 * SqliteEnrichmentStore. This proves a FAILING store doesn't change the failure
 * behaviour the call sites already had. We induce a REAL persister failure (drop a
 * table it writes to) rather than mocking, so the actual store + transaction paths
 * are exercised:
 *   • Contact sync (recording-start / calendar-prepare) is fire-and-forget: the
 *     caller's try/catch swallows the throw, the surrounding op proceeds, and the
 *     rolled-back transaction leaves NO partial contact / outbox rows.
 *   • Company links run inside createMeeting's wrapped transaction: a throw rolls
 *     the WHOLE thing back atomically — no half-written meeting / company / outbox.
 *
 * Harness mirrors meeting-company-cascade-outbox.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runAllMigrations } from '@cyggie/db/sqlite/connection'

let testDb: Database.Database

vi.mock('@cyggie/db/sqlite/connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyggie/db/sqlite/connection')>()
  return { ...actual, getDatabase: () => testDb }
})

const { configureSyncGlobals, _resetSyncGlobalsForTesting } = await import(
  '@cyggie/db/sqlite/repositories/_sync'
)
const { createMeeting, syncContactsFromAttendees } = await import('@cyggie/db/sqlite/repositories')

const USER_ID = 'user-1'

function count(table: string, where = ''): number {
  return (testDb.prepare(`SELECT count(*) n FROM ${table} ${where}`).get() as { n: number }).n
}

beforeEach(() => {
  testDb = new Database(':memory:')
  runAllMigrations(testDb)
  testDb
    .prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .run(USER_ID, 'user-1@example.com', 'User One')
  _resetSyncGlobalsForTesting()
  configureSyncGlobals({
    getDb: () => testDb,
    getUserId: () => USER_ID,
    getDeviceId: () => 'device-1',
  })
})

describe('enrichment store — error isolation (6A)', () => {
  it('recording-start contact sync: caller try/catch isolates a failing persister', () => {
    // A meeting already exists (recording started); its row must survive.
    createMeeting({ title: 'Standup', date: '2026-06-18T10:00:00.000Z' }, USER_ID)
    const meetingsBefore = count('meetings')
    testDb.exec('DELETE FROM outbox')
    // Force the persister to throw mid-apply: the new contact inserts, then the
    // contact_emails attach hits a missing table and the transaction rolls back.
    testDb.exec('DROP TABLE contact_emails')

    // Mirror RecordingSession / meeting.ipc: contact sync is fire-and-forget.
    let caught: unknown = null
    try {
      syncContactsFromAttendees(['Jane Doe <jane@acme.com>'], ['jane@acme.com'], USER_ID)
    } catch (err) {
      caught = err
    }

    // The throw surfaced to the caller (not silently lost at the wrong layer)…
    expect(caught).toBeInstanceOf(Error)
    // …the surrounding op is unaffected — the meeting is still there…
    expect(count('meetings')).toBe(meetingsBefore)
    // …and the rolled-back transaction wrote NO partial contact state or outbox.
    expect(count('contacts')).toBe(0)
    expect(count('outbox', `WHERE table_name = 'contacts'`)).toBe(0)
  })

  it('createMeeting company links: a failing persister rolls back the whole tx atomically', () => {
    // The meeting + company insert, then the link insert hits a missing table — the
    // whole wrapped createMeeting transaction must roll back.
    testDb.exec('DROP TABLE meeting_company_links')

    let caught: unknown = null
    try {
      createMeeting(
        {
          title: 'Kickoff',
          date: '2026-06-18T10:00:00.000Z',
          companies: ['Acme'],
          attendeeEmails: ['x@acme.com'],
        },
        USER_ID,
      )
    } catch (err) {
      caught = err
    }

    // The company persister threw inside createMeeting's wrapped transaction…
    expect(caught).toBeInstanceOf(Error)
    // …so EVERYTHING rolls back — no half-written meeting / company / outbox.
    expect(count('meetings')).toBe(0)
    expect(count('org_companies')).toBe(0)
    expect(count('outbox')).toBe(0)
  })
})
