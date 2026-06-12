// Tests for SyncPullService — the periodic pull-side counterpart to
// SyncAgent (push). Vitest, node env, no Electron.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SyncPullService,
  type PullTransport,
  type PullResponse,
} from '@main/services/sync-pull.service'
import type { PulledMeetingRow } from '@main/services/sync-remote-apply'
import type { SyncAgent } from '@main/services/sync-agent'

const DEVICE_ID = 'device-test'
const USER_ID = 'user-test'

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      lamport TEXT NOT NULL DEFAULT '0'
    );
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  db.prepare('INSERT INTO users (id) VALUES (?)').run(USER_ID)
  return db
}

function fakeRow(id: string, lamport: string): PulledMeetingRow {
  return {
    id,
    userId: USER_ID,
    title: 'Test ' + id,
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
    lamport,
  }
}

function makeAgent(state: 'idle' | 'flushing' = 'idle'): SyncAgent {
  return {
    getState: () => state,
  } as unknown as SyncAgent
}

interface MockTransport extends PullTransport {
  __calls: Array<{ deviceId: string; since: string }>
  __setResponse(r: PullResponse | (() => Promise<PullResponse>)): void
  __setError(err: unknown): void
}
function makeTransport(): MockTransport {
  let response: PullResponse | (() => Promise<PullResponse>) = { meetings: [], serverLamport: '0' }
  let error: unknown = null
  const calls: Array<{ deviceId: string; since: string }> = []
  const t: MockTransport = {
    pull: async ({ deviceId, since }) => {
      calls.push({ deviceId, since })
      if (error) throw error
      return typeof response === 'function' ? response() : response
    },
    __calls: calls,
    __setResponse: (r) => {
      response = r
      error = null
    },
    __setError: (e) => {
      error = e
    },
  }
  return t
}

describe('SyncPullService', () => {
  let db: Database.Database
  beforeEach(() => {
    db = buildDb()
  })
  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('pull returns 0 meetings → no-op but lastPulledAt updates', async () => {
    const transport = makeTransport()
    transport.__setResponse({ meetings: [], serverLamport: '0' })
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999, // don't auto-tick during test
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()

    expect(transport.__calls).toHaveLength(1)
    expect(transport.__calls[0]?.since).toBe('0')
    const snap = svc.snapshot()
    expect(snap.lastPulledAt).not.toBeNull()
    expect(snap.lastError).toBeNull()
    expect(snap.state).toBe('idle')
  })

  it('pull returns rows → applyRemoteMeetings persists them and snapshot.lastPulledLamport advances', async () => {
    const transport = makeTransport()
    transport.__setResponse({
      meetings: [fakeRow('m1', '5'), fakeRow('m2', '10')],
      serverLamport: '10',
    })
    const onApplied = vi.fn()
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
      onMeetingsApplied: onApplied,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()

    const rows = db.prepare('SELECT id FROM meetings ORDER BY id').all() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2'])
    expect(onApplied).toHaveBeenCalledWith(['m1', 'm2'])
    expect(svc.snapshot().lastPulledLamport).toBe('10')
  })

  it('Issue 2A — push state !== idle → drops tick (no transport call)', async () => {
    const transport = makeTransport()
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('flushing'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    expect(transport.__calls).toHaveLength(0)
  })

  it('no userId → paused_no_auth, no transport call', async () => {
    const transport = makeTransport()
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => null,
      getAccessToken: async () => null,
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    expect(transport.__calls).toHaveLength(0)
    expect(svc.snapshot().state).toBe('paused_no_auth')
  })

  it('401 from transport → records lastError, backs off', async () => {
    const transport = makeTransport()
    transport.__setError(Object.assign(new Error('UNAUTHORIZED'), { status: 401 }))
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    const snap = svc.snapshot()
    expect(snap.state).toBe('backing_off')
    expect(snap.lastError).toContain('UNAUTHORIZED')
  })

  it('5xx from transport → backing_off with lastError', async () => {
    const transport = makeTransport()
    transport.__setError(Object.assign(new Error('gateway 503'), { status: 503 }))
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    expect(svc.snapshot().state).toBe('backing_off')
  })

  it('network error → backing_off with lastError', async () => {
    const transport = makeTransport()
    transport.__setError(new Error('ECONNRESET'))
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    const snap = svc.snapshot()
    expect(snap.state).toBe('backing_off')
    expect(snap.lastError).toContain('ECONNRESET')
  })

  it('triggerPull() fires an immediate extra tick', async () => {
    const transport = makeTransport()
    transport.__setResponse({ meetings: [], serverLamport: '0' })
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    svc.triggerPull()
    await svc.waitForIdle()
    svc.stop()
    expect(transport.__calls.length).toBeGreaterThanOrEqual(2)
  })

  it('uses last_pulled_lamport as `since` on subsequent ticks', async () => {
    const transport = makeTransport()
    transport.__setResponse({ meetings: [fakeRow('m1', '42')], serverLamport: '42' })
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
    })
    svc.start()
    await svc.waitForIdle()
    transport.__setResponse({ meetings: [], serverLamport: '42' })
    svc.triggerPull()
    await svc.waitForIdle()
    svc.stop()

    // First call: since=0. Second call: since=42 (advanced after the first apply).
    expect(transport.__calls[0]?.since).toBe('0')
    expect(transport.__calls[1]?.since).toBe('42')
  })

  it('emits onStateChange transitions through pulling → idle on happy path', async () => {
    const transport = makeTransport()
    transport.__setResponse({ meetings: [], serverLamport: '0' })
    const onStateChange = vi.fn()
    const svc = new SyncPullService({
      db,
      getDeviceId: () => DEVICE_ID,
      getUserId: () => USER_ID,
      getAccessToken: async () => 'tok',
      syncAgent: makeAgent('idle'),
      transport,
      tickIntervalMs: 99_999,
      onStateChange,
    })
    svc.start()
    await svc.waitForIdle()
    svc.stop()
    const states = onStateChange.mock.calls.map((c) => c[0].state)
    expect(states).toContain('pulling')
    expect(states[states.length - 1]).toBe('idle')
  })
})
