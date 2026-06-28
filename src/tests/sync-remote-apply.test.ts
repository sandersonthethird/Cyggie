// Tests for the Phase 1.5c pull-side apply primitive.
//
// Approach: build a minimal in-memory SQLite with just the columns
// applyRemoteMeetings touches. Bypasses buildTestDbFull (which currently
// stops at migration 095) since this test only needs `users`, `meetings`,
// and `sync_state`.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyRemoteMeetings, type PulledMeetingRow } from '@main/services/sync-remote-apply'

const DEVICE_ID = 'device-test-1'
const USER_ID = 'user-test-1'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')

  // Minimal users table (only the columns the FK-existence pre-check reads).
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      google_sub TEXT,
      email TEXT,
      display_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Subset of the production meetings schema sufficient to round-trip an
  // applyRemote write. Lamport is the key correctness column.
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      duration_seconds INTEGER,
      calendar_event_id TEXT,
      meeting_platform TEXT,
      meeting_url TEXT,
      location TEXT,
      transcript_path TEXT,
      summary_path TEXT,
      recording_path TEXT,
      transcript_drive_id TEXT,
      summary_drive_id TEXT,
      template_id TEXT,
      speaker_count INTEGER NOT NULL DEFAULT 0,
      speaker_map TEXT NOT NULL DEFAULT '{}',
      transcript_segments TEXT,
      notes TEXT,
      summary TEXT,
      attendees TEXT,
      attendee_emails TEXT,
      chat_messages TEXT,
      companies TEXT,
      dismissed_companies TEXT,
      status TEXT NOT NULL DEFAULT 'recording',
      was_impromptu INTEGER NOT NULL DEFAULT 0,
      is_group_event INTEGER NOT NULL DEFAULT 0,
      is_group_event_user_set INTEGER NOT NULL DEFAULT 0,
      scheduled_end_at TEXT,
      is_private INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      deleted_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0',
      field_lamports TEXT
    )
  `)

  // Child table — proves applyRemote does NOT cascade-delete via REPLACE.
  db.exec(`
    CREATE TABLE meeting_company_links (
      meeting_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (meeting_id, company_id),
      FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  // Outbox so a regression where applyRemote calls withSync would have
  // an observable place to land.
  db.exec(`
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      lamport TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT
    )
  `)

  // Seed the user row that applyRemote's pre-check requires.
  db.prepare('INSERT INTO users (id) VALUES (?)').run(USER_ID)
  return db
}

function makeRow(overrides: Partial<PulledMeetingRow> & { id: string; lamport: string }): PulledMeetingRow {
  return {
    id: overrides.id,
    userId: USER_ID,
    title: 'Test',
    date: '2026-05-22T10:00:00.000Z',
    durationSeconds: null,
    calendarEventId: null,
    meetingPlatform: null,
    meetingUrl: null,
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

describe('applyRemoteMeetings', () => {
  let db: Database.Database
  beforeEach(() => {
    db = freshDb()
  })
  afterEach(() => {
    db.close()
  })

  it('inserts a new row when no local row exists', () => {
    const result = applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '5', title: 'Hello' }),
    ])
    expect(result.appliedIds).toEqual(['mtg-1'])
    const row = db.prepare('SELECT id, title, lamport FROM meetings WHERE id = ?').get('mtg-1') as
      | { id: string; title: string; lamport: string }
      | undefined
    expect(row?.title).toBe('Hello')
    expect(row?.lamport).toBe('5')
  })

  // Field-LWW (Phase 4.5): meetings no longer skip at the row level — the apply
  // always descends into the per-column merge, which itself no-ops every column
  // whose incoming clock loses. So a lower/equal incoming clock leaves the local
  // value untouched (the guarantee that matters), via the merge rather than a
  // row-level skip. (Whole-row skip bookkeeping no longer applies.)
  it('a lower per-column clock wins no columns (local value preserved)', () => {
    db.prepare(
      "INSERT INTO meetings (id, title, date, lamport) VALUES ('mtg-1', 'Local', '2026-05-22T10:00:00.000Z', '10')",
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '5', title: 'Older' }),
    ])
    const row = db.prepare('SELECT title FROM meetings WHERE id = ?').get('mtg-1') as { title: string }
    expect(row.title).toBe('Local')
  })

  it('an equal clock wins no columns (strictly-greater required; local preserved)', () => {
    db.prepare(
      "INSERT INTO meetings (id, title, date, lamport) VALUES ('mtg-1', 'Local', '2026-05-22T10:00:00.000Z', '7')",
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '7', title: 'Tied' }),
    ])
    const row = db.prepare('SELECT title FROM meetings WHERE id = ?').get('mtg-1') as { title: string }
    expect(row.title).toBe('Local')
  })

  it('overwrites row when incoming lamport > local', () => {
    db.prepare(
      "INSERT INTO meetings (id, title, date, lamport) VALUES ('mtg-1', 'Local', '2026-05-22T10:00:00.000Z', '5')",
    ).run()
    const result = applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '6', title: 'Newer' }),
    ])
    expect(result.appliedIds).toEqual(['mtg-1'])
    const row = db.prepare('SELECT title, lamport FROM meetings WHERE id = ?').get('mtg-1') as {
      title: string
      lamport: string
    }
    expect(row.title).toBe('Newer')
    expect(row.lamport).toBe('6')
  })

  it('does NOT cascade-delete child rows on overwrite (ON CONFLICT UPDATE, not REPLACE)', () => {
    db.prepare(
      "INSERT INTO meetings (id, title, date, lamport) VALUES ('mtg-1', 'Local', '2026-05-22T10:00:00.000Z', '5')",
    ).run()
    db.prepare(
      "INSERT INTO meeting_company_links (meeting_id, company_id) VALUES ('mtg-1', 'co-1')",
    ).run()

    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '99' }),
    ])

    const link = db
      .prepare("SELECT meeting_id, company_id FROM meeting_company_links WHERE meeting_id = 'mtg-1'")
      .get() as { meeting_id: string } | undefined
    expect(link?.meeting_id).toBe('mtg-1')
  })

  it('does NOT emit any outbox row (bypasses withSync entirely)', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '5' }),
    ])
    const count = (db.prepare('SELECT count(*) AS n FROM outbox').get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('bumps sync_state.last_pulled_lamport AND last_pushed_lamport (Issue 1A)', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '50' }),
      makeRow({ id: 'mtg-2', lamport: '99' }),
    ])
    const state = db
      .prepare(
        'SELECT last_pulled_lamport, last_pushed_lamport FROM sync_state WHERE device_id = ?',
      )
      .get(DEVICE_ID) as
      | { last_pulled_lamport: string; last_pushed_lamport: string }
      | undefined
    expect(state?.last_pulled_lamport).toBe('99')
    expect(state?.last_pushed_lamport).toBe('99')
  })

  it('does NOT regress last_pushed_lamport when incoming is below local high-water', () => {
    db.prepare(
      "INSERT INTO sync_state (device_id, user_id, last_pushed_lamport) VALUES (?, ?, '500')",
    ).run(DEVICE_ID, USER_ID)
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-1', lamport: '10' }),
    ])
    const state = db
      .prepare('SELECT last_pushed_lamport FROM sync_state WHERE device_id = ?')
      .get(DEVICE_ID) as { last_pushed_lamport: string }
    expect(state.last_pushed_lamport).toBe('500')
  })

  it('pre-skips rows whose userId does not match any local user', () => {
    const result = applyRemoteMeetings(db, DEVICE_ID, 'unknown-user', [
      makeRow({ id: 'mtg-1', lamport: '5', userId: 'unknown-user' }),
    ])
    expect(result.appliedIds).toEqual([])
    expect(result.skippedPreValidation).toBe(1)
    const count = (db.prepare('SELECT count(*) AS n FROM meetings').get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('pre-skips malformed rows (missing required fields) without crashing', () => {
    const result = applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      // @ts-expect-error — intentional malformed shape
      { id: 'no-lamport', userId: USER_ID, title: 'Bad' },
      makeRow({ id: 'mtg-good', lamport: '5' }),
    ])
    expect(result.appliedIds).toEqual(['mtg-good'])
    expect(result.skippedPreValidation).toBe(1)
  })

  it('emits onApplied callback with applied ids (Issue 5A IPC hook)', () => {
    const onApplied = vi.fn()
    applyRemoteMeetings(
      db,
      DEVICE_ID,
      USER_ID,
      [
        makeRow({ id: 'a', lamport: '1' }),
        makeRow({ id: 'b', lamport: '2' }),
      ],
      { onApplied },
    )
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(onApplied.mock.calls[0][0]).toEqual(['a', 'b'])
  })

  it('chunks into sub-batches of opts.chunkSize, emitting onApplied per chunk (Issue 4A)', () => {
    const onApplied = vi.fn()
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({ id: `mtg-${i}`, lamport: String(i + 1) }),
    )
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, rows, { chunkSize: 2, onApplied })
    // 5 rows in 2-row chunks → [2, 2, 1] = 3 invocations
    expect(onApplied).toHaveBeenCalledTimes(3)
    expect(onApplied.mock.calls[0][0]).toHaveLength(2)
    expect(onApplied.mock.calls[1][0]).toHaveLength(2)
    expect(onApplied.mock.calls[2][0]).toHaveLength(1)
  })

  it('preserves JSON fields (attendees, attendeeEmails, transcriptSegments)', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-json',
        lamport: '1',
        attendees: ['Alice', 'Bob'],
        attendeeEmails: ['alice@example.com', 'bob@example.com'],
        transcriptSegments: [{ speaker: 0, text: 'Hi', startTime: 0, endTime: 1 }],
      }),
    ])
    const row = db
      .prepare(
        'SELECT attendees, attendee_emails, transcript_segments FROM meetings WHERE id = ?',
      )
      .get('mtg-json') as {
      attendees: string
      attendee_emails: string
      transcript_segments: string
    }
    expect(JSON.parse(row.attendees)).toEqual(['Alice', 'Bob'])
    expect(JSON.parse(row.attendee_emails)).toEqual(['alice@example.com', 'bob@example.com'])
    expect(JSON.parse(row.transcript_segments)).toEqual([
      { speaker: 0, text: 'Hi', startTime: 0, endTime: 1 },
    ])
  })

  // Regression — `meetings.summary` (the AI-generated markdown) was added in
  // migration 099 and is dual-written by the desktop summarizer + by the
  // mobile POST /meetings/:id/enhance gateway route. Before this fix the
  // upsert silently dropped the column, so a summary generated from mobile
  // would land in Neon but never propagate to the desktop SQLite cache.
  it('persists the summary markdown column on insert and on update', () => {
    const summaryMarkdown = '# Meeting Summary\n\n## Key points\n- Foo\n- Bar'

    // Insert path.
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-sum', lamport: '1', summary: summaryMarkdown }),
    ])
    let row = db
      .prepare('SELECT summary FROM meetings WHERE id = ?')
      .get('mtg-sum') as { summary: string | null }
    expect(row.summary).toBe(summaryMarkdown)

    // Update path — newer lamport with a different summary body overwrites.
    const updatedMarkdown = '# Updated Summary\n\nNew content from mobile enhance.'
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-sum', lamport: '2', summary: updatedMarkdown }),
    ])
    row = db
      .prepare('SELECT summary FROM meetings WHERE id = ?')
      .get('mtg-sum') as { summary: string | null }
    expect(row.summary).toBe(updatedMarkdown)
  })

  // ─────────────────────────────────────────────────────────────────────
  // transcript_segments null-clobber guard (A1–A4)
  //
  // Gateway suppresses transcript_segments on /sync/pull for in-progress
  // meetings (see MEETING_IN_PROGRESS_STATUSES in api-gateway/src/routes/
  // sync.ts). If a cross-device write bumps lamport on an in-progress
  // meeting (calendar sync, stale-sweeper, mobile PATCH on title/attendees),
  // the next pull on the recording desktop would ship transcript_segments=
  // null with lamport > local_lamport. Without COALESCE in upsertMeetingRow,
  // this silently clobbers the desktop's live transcript.
  // ─────────────────────────────────────────────────────────────────────

  const sampleSegments = [
    { speaker: 0, text: 'hello', startTime: 0, endTime: 1 },
    { speaker: 1, text: 'world', startTime: 1, endTime: 2 },
  ]

  it('A1: does_not_clobber_local_transcript_when_remote_transcript_segments_null', () => {
    // Seed local row with a transcript already in place (the live recording).
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a1',
        lamport: '10',
        status: 'recording',
        transcriptSegments: sampleSegments,
      }),
    ])
    const beforeRow = db
      .prepare('SELECT transcript_segments FROM meetings WHERE id = ?')
      .get('mtg-a1') as { transcript_segments: string | null }
    expect(JSON.parse(beforeRow.transcript_segments ?? 'null')).toEqual(sampleSegments)

    // Cross-device race: gateway-side metadata bump (e.g. calendar sync)
    // arrives via /sync/pull. Status still 'recording', lamport higher,
    // transcript_segments suppressed to null.
    const result = applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a1',
        lamport: '20',
        status: 'recording',
        transcriptSegments: null,
        title: 'Updated by calendar sync',
      }),
    ])
    expect(result.appliedIds).toEqual(['mtg-a1'])

    const afterRow = db
      .prepare('SELECT transcript_segments, title, lamport FROM meetings WHERE id = ?')
      .get('mtg-a1') as { transcript_segments: string | null; title: string; lamport: string }
    // Title + lamport updated — proves the upsert ran.
    expect(afterRow.title).toBe('Updated by calendar sync')
    expect(afterRow.lamport).toBe('20')
    // CRITICAL: transcript preserved despite null on the wire.
    expect(JSON.parse(afterRow.transcript_segments ?? 'null')).toEqual(sampleSegments)
  })

  it('A2: local transcript null, incoming non-null → local updated', () => {
    // Seed local with no transcript (a meeting that has never been transcribed).
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a2',
        lamport: '10',
        status: 'scheduled',
        transcriptSegments: null,
      }),
    ])

    // Terminal-state delivery — gateway now ships the transcript.
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a2',
        lamport: '20',
        status: 'transcribed',
        transcriptSegments: sampleSegments,
      }),
    ])

    const row = db
      .prepare('SELECT transcript_segments FROM meetings WHERE id = ?')
      .get('mtg-a2') as { transcript_segments: string | null }
    expect(JSON.parse(row.transcript_segments ?? 'null')).toEqual(sampleSegments)
  })

  it('A3: local transcript non-null, incoming different non-null → local replaced', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a3',
        lamport: '10',
        status: 'transcribed',
        transcriptSegments: sampleSegments,
      }),
    ])

    const replacement = [
      { speaker: 0, text: 'replaced', startTime: 0, endTime: 5 },
    ]
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a3',
        lamport: '20',
        status: 'transcribed',
        transcriptSegments: replacement,
      }),
    ])

    const row = db
      .prepare('SELECT transcript_segments FROM meetings WHERE id = ?')
      .get('mtg-a3') as { transcript_segments: string | null }
    expect(JSON.parse(row.transcript_segments ?? 'null')).toEqual(replacement)
  })

  it('A4: local null, incoming null → local stays null', () => {
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a4',
        lamport: '10',
        status: 'scheduled',
        transcriptSegments: null,
      }),
    ])

    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-a4',
        lamport: '20',
        status: 'recording',
        transcriptSegments: null,
      }),
    ])

    const row = db
      .prepare('SELECT transcript_segments FROM meetings WHERE id = ?')
      .get('mtg-a4') as { transcript_segments: string | null }
    expect(row.transcript_segments).toBeNull()
  })

  // ── Field-LWW (Phase 4.5) ──────────────────────────────────────────────────
  it('keepLocal: a null transcript at the SAME field clock keeps local value + clock', () => {
    // Recorder's own write round-tripping (or an in-progress suppression): the
    // transcript was nulled in transport but its field clock matches local —
    // there is no newer transcript, so keep the local copy and clock. A teammate
    // retitle (sparse stamping → only title's clock advances to 10) must not
    // disturb the transcript.
    db.prepare(
      `INSERT INTO meetings (id, title, date, lamport, field_lamports, transcript_segments)
       VALUES ('mtg-keep', 'Local', '2026-05-22T10:00:00.000Z', '5',
               '{"transcript_segments":"5","title":"5"}', '[{"text":"local"}]')`,
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-keep',
        lamport: '10',
        title: 'Renamed',
        transcriptSegments: null,
        // transcript clock UNCHANGED (only title was edited) — realistic sparse map.
        fieldLamports: { transcript_segments: '5', title: '10' },
      }),
    ])
    const row = db
      .prepare('SELECT title, transcript_segments, field_lamports FROM meetings WHERE id = ?')
      .get('mtg-keep') as { title: string; transcript_segments: string; field_lamports: string }
    expect(row.title).toBe('Renamed') // the real winner applied
    expect(row.transcript_segments).toBe('[{"text":"local"}]') // local transcript preserved
    expect(JSON.parse(row.field_lamports).transcript_segments).toBe('5') // clock unchanged
    expect(JSON.parse(row.field_lamports).title).toBe('10')
  })

  it('3A: a null transcript at a NEWER field clock clears the local copy (forces refetch)', () => {
    // The transcript was genuinely re-generated elsewhere (clock 5 → 10) and the
    // value was suppressed on the wire (T40). Keeping the local copy would show a
    // stale transcript forever, so we clear it and adopt the new clock; the
    // renderer then refetches via MEETING_GET_TRANSCRIPT on next open.
    db.prepare(
      `INSERT INTO meetings (id, title, date, lamport, field_lamports, transcript_segments)
       VALUES ('mtg-3a', 'Local', '2026-05-22T10:00:00.000Z', '5',
               '{"transcript_segments":"5"}', '[{"text":"stale"}]')`,
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({
        id: 'mtg-3a',
        lamport: '10',
        transcriptSegments: null,
        fieldLamports: { transcript_segments: '10' },
      }),
    ])
    const row = db
      .prepare('SELECT transcript_segments, field_lamports FROM meetings WHERE id = ?')
      .get('mtg-3a') as { transcript_segments: string | null; field_lamports: string }
    expect(row.transcript_segments).toBeNull() // stale copy cleared
    expect(JSON.parse(row.field_lamports).transcript_segments).toBe('10') // adopt newer clock
  })

  it('2A: the lazy cache-fill UPDATE writes the transcript without an outbox row or clock bump', () => {
    // Mirrors the MEETING_GET_TRANSCRIPT handler's deliberate raw write
    // (meeting.ipc.ts): a bare UPDATE that bypasses withSync. It must not emit an
    // outbox row (this device must not push a transcript it merely fetched back)
    // nor bump field_lamports (a cache fill is not an edit).
    db.prepare(
      `INSERT INTO meetings (id, title, date, lamport, field_lamports, transcript_segments)
       VALUES ('mtg-2a', 'Local', '2026-05-22T10:00:00.000Z', '5',
               '{"transcript_segments":"5"}', NULL)`,
    ).run()
    db.prepare('UPDATE meetings SET transcript_segments = @segments WHERE id = @id').run({
      id: 'mtg-2a',
      segments: JSON.stringify([{ speaker: 0, text: 'fetched', startTime: 0, endTime: 1, isFinal: true }]),
    })
    const row = db
      .prepare('SELECT transcript_segments, field_lamports, lamport FROM meetings WHERE id = ?')
      .get('mtg-2a') as { transcript_segments: string; field_lamports: string; lamport: string }
    expect(JSON.parse(row.transcript_segments)[0].text).toBe('fetched')
    expect(JSON.parse(row.field_lamports).transcript_segments).toBe('5') // clock NOT bumped
    expect(row.lamport).toBe('5')
    const outboxCount = db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }
    expect(outboxCount.n).toBe(0) // no push generated
  })

  it('NULL field_lamports (migrated row) → first field-LWW write degrades to whole-row', () => {
    // Phase-4 rows have field_lamports = NULL (no backfill). The first merge must
    // densify at the row baseline and let the higher incoming row clock win.
    db.prepare(
      `INSERT INTO meetings (id, title, date, lamport, field_lamports)
       VALUES ('mtg-nm', 'Local', '2026-05-22T10:00:00.000Z', '5', NULL)`,
    ).run()
    applyRemoteMeetings(db, DEVICE_ID, USER_ID, [
      makeRow({ id: 'mtg-nm', lamport: '10', title: 'Newer' }), // no fieldLamports
    ])
    const row = db
      .prepare('SELECT title, lamport FROM meetings WHERE id = ?')
      .get('mtg-nm') as { title: string; lamport: string }
    expect(row.title).toBe('Newer')
    expect(row.lamport).toBe('10')
  })
})
