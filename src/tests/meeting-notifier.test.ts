/**
 * Tests for meeting-notifier.ts
 *
 * Mock boundaries:
 *   - electron (Notification, app, BrowserWindow, shell) → in-memory stubs
 *   - calendar/google-calendar (getUpcomingEvents) → vi.fn()
 *   - calendar/google-auth (isCalendarConnected) → vi.fn()
 *   - security/current-user (getCurrentUserProfile) → vi.fn()
 *   - storage/paths (getStoragePath) → tmpdir
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { CalendarEvent } from '../shared/types/calendar'

// ─── Mock: electron ───────────────────────────────────────────────────────────

const { notificationConstructorCalls, notificationShowCalls } = vi.hoisted(() => ({
  notificationConstructorCalls: [] as Array<Record<string, unknown>>,
  notificationShowCalls: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => {
  class FakeNotification {
    public title: string
    public subtitle?: string
    public body?: string
    public silent?: boolean
    private handlers: Record<string, Array<() => void>> = {}
    static isSupported(): boolean {
      return true
    }
    constructor(opts: { title: string; subtitle?: string; body?: string; silent?: boolean }) {
      this.title = opts.title
      this.subtitle = opts.subtitle
      this.body = opts.body
      this.silent = opts.silent
      notificationConstructorCalls.push({ ...opts })
    }
    on(event: string, fn: () => void): void {
      if (!this.handlers[event]) this.handlers[event] = []
      this.handlers[event].push(fn)
    }
    show(): void {
      notificationShowCalls.push({ title: this.title, subtitle: this.subtitle, body: this.body })
    }
    close(): void {
      /* noop */
    }
  }
  return {
    app: { dock: { bounce: () => undefined } },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: FakeNotification,
    shell: { openExternal: () => Promise.resolve() }
  }
})

// ─── Mock: calendar deps ──────────────────────────────────────────────────────

const { mockGetUpcomingEvents, mockIsCalendarConnected, mockPrepareMeeting, tmpRef } = vi.hoisted(() => ({
  mockGetUpcomingEvents: vi.fn(),
  mockIsCalendarConnected: vi.fn(),
  mockPrepareMeeting: vi.fn(),
  tmpRef: { dir: '' as string }
}))

vi.mock('../main/calendar/google-calendar', () => ({
  getUpcomingEvents: (hours: number) => mockGetUpcomingEvents(hours)
}))

vi.mock('../main/calendar/google-auth', () => ({
  isCalendarConnected: () => mockIsCalendarConnected()
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserProfile: () => ({ email: 'test@example.com', displayName: 'Test', id: 't' }),
  getCurrentUserId: () => 'user-test'
}))

vi.mock('../main/ipc/meeting.ipc', () => ({
  prepareMeetingFromCalendarEvent: (event: unknown, userId: unknown) => mockPrepareMeeting(event, userId)
}))

vi.mock('../main/storage/paths', () => ({
  getStoragePath: () => tmpRef.dir
}))

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const start = overrides.startTime ?? new Date(Date.now() + 60_000).toISOString()
  const end = overrides.endTime ?? new Date(new Date(start).getTime() + 30 * 60_000).toISOString()
  return {
    id: 'evt-1',
    title: 'Test meeting',
    startTime: start,
    endTime: end,
    attendees: [],
    platform: 'google_meet',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    ...overrides
  } as CalendarEvent
}

// Import the module under test AFTER mocks
import { triggerImmediateCheck, __test } from '../main/calendar/meeting-notifier'

describe('meeting-notifier', () => {
  beforeEach(() => {
    tmpRef.dir = mkdtempSync(join(tmpdir(), 'meeting-notifier-test-'))
    notificationConstructorCalls.length = 0
    notificationShowCalls.length = 0
    mockGetUpcomingEvents.mockReset()
    mockIsCalendarConnected.mockReset().mockReturnValue(true)
    mockPrepareMeeting.mockReset().mockReturnValue({ id: 'meeting-mock' })
    __test.resetState()
  })

  afterEach(() => {
    rmSync(tmpRef.dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('fires once when meeting starts in 90s (inside lead window)', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'e90',
        startTime: new Date(now + 90_000).toISOString(),
        endTime: new Date(now + 90_000 + 30 * 60_000).toISOString()
      })
    ])

    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)

    // Second check at same time should not re-fire (dedupe)
    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
  })

  it('fires when meeting started 30s ago (inside grace window)', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'eGrace',
        startTime: new Date(now - 30_000).toISOString(),
        endTime: new Date(now - 30_000 + 30 * 60_000).toISOString()
      })
    ])

    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
  })

  it('does NOT fire when meeting started 120s ago (past grace window)', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'eLate',
        startTime: new Date(now - 120_000).toISOString(),
        endTime: new Date(now - 120_000 + 30 * 60_000).toISOString()
      })
    ])

    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(0)
  })

  it('does NOT fire when meeting has already ended', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'eEnded',
        // Started 60s ago (inside grace window for start) but ended already.
        startTime: new Date(now - 60_000).toISOString(),
        endTime: new Date(now - 1_000).toISOString()
      })
    ])

    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(0)
  })

  it('persists notified ids across "restarts" so re-load does not double-fire', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'ePersist',
        startTime: new Date(now + 60_000).toISOString(),
        endTime: new Date(now + 60_000 + 30 * 60_000).toISOString()
      })
    ])

    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)

    // State file should exist with one record.
    expect(existsSync(__test.stateFile())).toBe(true)
    const persisted = JSON.parse(readFileSync(__test.stateFile(), 'utf-8'))
    expect(persisted).toHaveLength(1)
    expect(persisted[0].id).toBe('ePersist')

    // Simulate restart: clear in-memory, reload from disk.
    __test.resetState()
    __test.loadNotifiedIds()
    expect(__test.getNotifiedRecords().map((r) => r.id)).toContain('ePersist')

    // Subsequent check should not re-fire.
    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
  })

  it('6 consecutive polls inside lead window emit exactly 1 notification', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'eMany',
        startTime: new Date(now + 100_000).toISOString(),
        endTime: new Date(now + 100_000 + 30 * 60_000).toISOString()
      })
    ])

    for (let i = 0; i < 6; i++) {
      await __test.checkUpcomingMeetings()
      vi.setSystemTime(now + (i + 1) * 1000)
    }
    expect(notificationShowCalls).toHaveLength(1)
  })

  it('triggerImmediateCheck() debounces rapid calls', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockGetUpcomingEvents.mockResolvedValue([])

    triggerImmediateCheck()
    triggerImmediateCheck()
    triggerImmediateCheck()
    triggerImmediateCheck()
    triggerImmediateCheck()

    // Drain microtasks for any in-flight check
    await Promise.resolve()
    await Promise.resolve()

    expect(mockGetUpcomingEvents).toHaveBeenCalledTimes(1)
  })

  it('skips check entirely when calendar is not connected', async () => {
    mockIsCalendarConnected.mockReturnValue(false)
    mockGetUpcomingEvents.mockResolvedValue([])

    await __test.checkUpcomingMeetings()
    expect(mockGetUpcomingEvents).not.toHaveBeenCalled()
    expect(notificationShowCalls).toHaveLength(0)
  })

  it('cleanup prunes records whose events are well past lookback', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    // Seed state file with a record whose endTime is far in the past.
    const oldEnd = new Date(now - __test.constants.STATE_LOOKBACK_MS - 60_000).toISOString()
    writeFileSync(
      __test.stateFile(),
      JSON.stringify([{ id: 'old-evt', endTime: oldEnd }]),
      'utf-8'
    )
    __test.loadNotifiedIds()
    // Lookback filter on load already drops the expired entry.
    expect(__test.getNotifiedRecords()).toHaveLength(0)
  })

  // ── New: notifier-seeds-DB-row behaviour (i had a meeting fix) ─────────────

  it('persists a scheduled meeting row exactly once when notification fires', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const event = makeEvent({
      id: 'evt-persist',
      startTime: new Date(now + 60_000).toISOString(),
      endTime: new Date(now + 60_000 + 30 * 60_000).toISOString(),
      attendees: ['jeff@example.com'],
      attendeeEmails: ['jeff@example.com'],
    })
    mockGetUpcomingEvents.mockResolvedValue([event])

    // First check fires notification AND persists.
    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
    expect(mockPrepareMeeting).toHaveBeenCalledTimes(1)
    const [passedEvent, passedUserId] = mockPrepareMeeting.mock.calls[0]
    expect(passedEvent).toMatchObject({ id: 'evt-persist', title: 'Test meeting' })
    expect(passedUserId).toBe('user-test')

    // Second check is a no-op (markNotified guards on notifiedEventIds).
    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
    expect(mockPrepareMeeting).toHaveBeenCalledTimes(1)
  })

  it('DB persist failure does NOT prevent the notification from firing', async () => {
    const now = new Date('2026-05-12T15:00:00.000Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(now)

    mockPrepareMeeting.mockImplementation(() => {
      throw new Error('SQLITE_BUSY')
    })

    mockGetUpcomingEvents.mockResolvedValue([
      makeEvent({
        id: 'evt-db-fail',
        startTime: new Date(now + 60_000).toISOString(),
        endTime: new Date(now + 60_000 + 30 * 60_000).toISOString(),
      }),
    ])

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await __test.checkUpcomingMeetings()
    expect(notificationShowCalls).toHaveLength(1)
    expect(mockPrepareMeeting).toHaveBeenCalledTimes(1)
    // Structured metric log for observability (Decision 1A).
    const loggedMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(loggedMessages.some((m) => m.includes('meeting.notifier_persist.failed'))).toBe(true)
    errorSpy.mockRestore()
  })
})
