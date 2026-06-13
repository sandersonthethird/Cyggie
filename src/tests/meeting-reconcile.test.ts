import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyRemoteMeetings,
  applyRemoteMeetingCompanyLinks,
  type PulledMeetingRow,
} from '@main/services/sync-remote-apply'

// ─── Calendar-meeting id-divergence reconcile (PR 2) ─────────────────────────
//
// When a mobile recording creates gateway row B before desktop's stub row A
// reaches Neon, the two diverge on the same calendar_event_id. The reconcile in
// upsertMeetingRow heals this on pull: migrate A's children to B, delete A,
// purge A's stuck outbox entries, then adopt B (with its transcript).
//
// Hand-rolled schema (the sync-test convention — buildTestDbFull's migration
// list has drifted and omits the lamport/outbox migrations) carrying every
// child table migrateMeetingChildren touches, so the reconcile exercises real
// FK/UNIQUE behavior.

const USER_ID = 'user-1'
const DEVICE_ID = 'device-1'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT);
    CREATE TABLE org_companies (id TEXT PRIMARY KEY, canonical_name TEXT, normalized_name TEXT);
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
      duration_seconds INTEGER, calendar_event_id TEXT, meeting_platform TEXT,
      meeting_url TEXT, location TEXT, transcript_path TEXT, summary_path TEXT,
      recording_path TEXT, transcript_drive_id TEXT, summary_drive_id TEXT,
      template_id TEXT, speaker_count INTEGER NOT NULL DEFAULT 0,
      speaker_map TEXT NOT NULL DEFAULT '{}', transcript_segments TEXT, notes TEXT,
      summary TEXT, attendees TEXT, attendee_emails TEXT, chat_messages TEXT,
      companies TEXT, dismissed_companies TEXT, status TEXT NOT NULL DEFAULT 'recording',
      was_impromptu INTEGER NOT NULL DEFAULT 0, is_group_event INTEGER NOT NULL DEFAULT 0,
      is_group_event_user_set INTEGER NOT NULL DEFAULT 0, scheduled_end_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), lamport TEXT NOT NULL DEFAULT '0'
    );
    CREATE UNIQUE INDEX idx_meetings_cal ON meetings(calendar_event_id) WHERE calendar_event_id IS NOT NULL;
    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL, company_id TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
      linked_by TEXT NOT NULL DEFAULT 'auto', created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (meeting_id, company_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE meeting_speakers (
      meeting_id TEXT NOT NULL, speaker_index INTEGER NOT NULL, speaker_id TEXT,
      label TEXT NOT NULL DEFAULT 'Speaker', lamport TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (meeting_id, speaker_index),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE meeting_theme_links (
      meeting_id TEXT NOT NULL, theme_id TEXT NOT NULL,
      PRIMARY KEY (meeting_id, theme_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE meeting_speaker_contact_links (
      meeting_id TEXT NOT NULL, speaker_index INTEGER NOT NULL, contact_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), lamport TEXT NOT NULL DEFAULT '0',
      PRIMARY KEY (meeting_id, speaker_index),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    );
    CREATE TABLE notes (id TEXT PRIMARY KEY, source_meeting_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, meeting_id TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, meeting_id TEXT);
    CREATE TABLE partner_meeting_digests (id TEXT PRIMARY KEY, meeting_id TEXT);
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0', last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL,
      lamport TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), acked_at TEXT
    );
  `)
  db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').run(USER_ID, 'Tester')
  db.prepare(
    "INSERT INTO org_companies (id, canonical_name, normalized_name) VALUES ('co-1', 'Acme', 'acme')",
  ).run()
  return db
}

function makeRow(
  overrides: Partial<PulledMeetingRow> & { id: string; lamport: string },
): PulledMeetingRow {
  return {
    id: overrides.id,
    userId: USER_ID,
    title: 'Test',
    date: '2026-05-22T10:00:00.000Z',
    durationSeconds: null,
    calendarEventId: null,
    meetingPlatform: null,
    meetingUrl: null,
    location: null,
    transcriptPath: null,
    summaryPath: null,
    recordingPath: null,
    transcriptDriveId: null,
    summaryDriveId: null,
    templateId: null,
    speakerCount: 0,
    speakerMap: {},
    transcriptSegments: null,
    notes: null,
    summary: null,
    attendees: null,
    attendeeEmails: null,
    chatMessages: null,
    companies: null,
    dismissedCompanies: null,
    status: 'scheduled',
    wasImpromptu: false,
    isGroupEvent: false,
    isGroupEventUserSet: false,
    scheduledEndAt: null,
    createdAt: '2026-05-22T10:00:00.000Z',
    updatedAt: '2026-05-22T10:00:00.000Z',
    lamport: overrides.lamport,
    ...overrides,
  }
}

function seedStubA(db: Database.Database, calEvent = 'cal-x'): void {
  db.prepare(
    `INSERT INTO meetings (id, title, date, calendar_event_id, status, lamport)
     VALUES ('A', 'Stub', '2026-05-22T10:00:00.000Z', ?, 'scheduled', '1')`,
  ).run(calEvent)
}

describe('calendar-meeting reconcile', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })
  afterEach(() => {
    db.close()
  })

  it('(a) adopts B and deletes the diverged stub A; transcript lands on B', () => {
    seedStubA(db)
    const segments = [{ speaker: 0, text: 'hi', startTime: 0, endTime: 1 }]
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x', status: 'transcribed', transcriptSegments: segments }),
    ])
    const rows = db
      .prepare("SELECT id FROM meetings WHERE calendar_event_id = 'cal-x'")
      .all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['B'])
    const b = db.prepare("SELECT transcript_segments FROM meetings WHERE id = 'B'").get() as {
      transcript_segments: string | null
    }
    expect(JSON.parse(b.transcript_segments!)).toEqual(segments)
  })

  it('(b) a company link on A survives onto B (no cascade loss)', () => {
    seedStubA(db)
    db.prepare("INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('A', 'co-1')").run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x' })])
    const link = db
      .prepare("SELECT meeting_id FROM meeting_company_links WHERE company_id = 'co-1'")
      .get() as { meeting_id: string } | undefined
    expect(link?.meeting_id).toBe('B')
  })

  it('(c) A and B both link company X → dedupe to a single link, no crash', () => {
    seedStubA(db)
    db.prepare("INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('A', 'co-1')").run()
    db.prepare(
      `INSERT INTO meetings (id, title, date, status, lamport)
       VALUES ('B', 'B', '2026-05-22T10:00:00.000Z', 'transcribed', '0')`,
    ).run()
    db.prepare("INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('B', 'co-1')").run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x' })])
    const links = db
      .prepare("SELECT meeting_id FROM meeting_company_links WHERE company_id = 'co-1'")
      .all()
    expect(links).toEqual([{ meeting_id: 'B' }])
  })

  it('(g) purges A’s stuck outbox entries (parent + composite child, any status)', () => {
    seedStubA(db)
    db.prepare("INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('A', 'co-1')").run()
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport, status)
       VALUES (?, ?, 'meetings', 'A', 'insert', '{}', '1', 'dead')`,
    ).run(USER_ID, DEVICE_ID)
    db.prepare(
      `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport, status)
       VALUES (?, ?, 'meeting_company_links', '{"meeting_id":"A","company_id":"co-1"}', 'insert', '{}', '1', 'failed')`,
    ).run(USER_ID, DEVICE_ID)
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x' })])
    expect((db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0)
  })

  it('(e) deterministic path: A.id == B.id → plain upsert, no reconcile', () => {
    db.prepare(
      `INSERT INTO meetings (id, title, date, calendar_event_id, status, lamport)
       VALUES ('cal_same', 'Old', '2026-05-22T10:00:00.000Z', 'cal-x', 'scheduled', '1')`,
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'cal_same', lamport: '5', calendarEventId: 'cal-x', title: 'New' }),
    ])
    expect(db.prepare("SELECT id, title FROM meetings WHERE calendar_event_id = 'cal-x'").all()).toEqual([
      { id: 'cal_same', title: 'New' },
    ])
  })

  it('(f) idempotent: applying B twice does not double-migrate or error', () => {
    seedStubA(db)
    const apply = () =>
      applyRemoteMeetings(db, DEVICE_ID, USER_ID, [makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x' })])
    apply()
    expect(apply).not.toThrow()
    expect(db.prepare("SELECT id FROM meetings WHERE calendar_event_id = 'cal-x'").all()).toEqual([{ id: 'B' }])
  })

  it('(h) failure isolation: a reconcile failure leaves A intact and still applies other rows', () => {
    seedStubA(db)
    db.prepare("INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('A', 'co-1')").run()
    db.prepare('DROP TABLE tasks').run() // makes migrateMeetingChildren throw mid-way

    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'B', lamport: '5', calendarEventId: 'cal-x' }), // diverged → reconcile fails
      makeRow({ id: 'other', lamport: '5', title: 'Innocent' }), // no cal event → applies fine
    ])
    expect(db.prepare("SELECT id FROM meetings WHERE id = 'A'").get()).toBeTruthy()
    expect(db.prepare("SELECT id FROM meetings WHERE id = 'B'").get()).toBeUndefined()
    expect((db.prepare("SELECT title FROM meetings WHERE id = 'other'").get() as { title: string }).title).toBe(
      'Innocent',
    )
  })

  it('(i) impromptu B (no calendar_event_id) → no reconcile lookup, plain insert', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [makeRow({ id: 'imp', lamport: '5' })])
    expect(db.prepare("SELECT id FROM meetings WHERE id = 'imp'").get()).toBeTruthy()
  })
})

describe('meeting child-link down-sync', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
    db.prepare(
      `INSERT INTO meetings (id, title, date, status, lamport)
       VALUES ('m-1', 'M', '2026-05-22T10:00:00.000Z', 'transcribed', '1')`,
    ).run()
  })
  afterEach(() => db.close())

  it('applies a pulled meeting_company_link onto the local meeting', () => {
    applyRemoteMeetingCompanyLinks(db, DEVICE_ID, USER_ID, [
      { meetingId: 'm-1', companyId: 'co-1', confidence: 1, linkedBy: 'auto', createdAt: '2026-05-22T10:00:00.000Z', lamport: '3' },
    ])
    expect(
      db.prepare("SELECT meeting_id, company_id FROM meeting_company_links WHERE meeting_id = 'm-1'").get(),
    ).toEqual({ meeting_id: 'm-1', company_id: 'co-1' })
  })

  it('a child whose parent meeting is absent does not crash (FK rollback, isolated)', () => {
    expect(() =>
      applyRemoteMeetingCompanyLinks(db, DEVICE_ID, USER_ID, [
        { meetingId: 'missing', companyId: 'co-1', confidence: 1, linkedBy: 'auto', createdAt: '2026-05-22T10:00:00.000Z', lamport: '3' },
      ]),
    ).not.toThrow()
    expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_company_links WHERE meeting_id = 'missing'").get()).toEqual({
      n: 0,
    })
  })
})
