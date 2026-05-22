/**
 * Tests for the calendar reconcile path added in the "i had a meeting" fix.
 *
 * Behaviour under test:
 *   - `fetchAndEnrichCalendarEvents` calls `getEventsAround` (not `getUpcomingEvents`)
 *     so it covers the past 24h.
 *   - Past events are passed through `prepareMeetingFromCalendarEvent` exactly once
 *     (the helper's own idempotency guard is unit-tested separately).
 *   - Future events are NOT reconciled but ARE returned to the caller.
 *   - A persist failure for one event is logged with a structured metric
 *     (Decision 1A) and doesn't prevent the rest of the loop from running.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CalendarEvent } from '../shared/types/calendar'

// ─── Mocks (hoisted so import below sees them) ────────────────────────────────

const { mockGetEventsAround, mockPrepareMeeting, mockTriggerImmediateCheck, mockEnrichDomains } =
  vi.hoisted(() => ({
    mockGetEventsAround: vi.fn(),
    mockPrepareMeeting: vi.fn(),
    mockTriggerImmediateCheck: vi.fn(),
    mockEnrichDomains: vi.fn(),
  }))

vi.mock('../main/calendar/google-calendar', () => ({
  getEventsAround: (back: number, ahead: number) => mockGetEventsAround(back, ahead),
  getUpcomingEvents: vi.fn(),
  getEventsInRange: vi.fn(),
  getCurrentMeetingEvent: vi.fn(),
}))

vi.mock('../main/calendar/meeting-notifier', () => ({
  startMeetingNotifier: vi.fn(),
  stopMeetingNotifier: vi.fn(),
  triggerImmediateCheck: () => mockTriggerImmediateCheck(),
}))

vi.mock('../main/calendar/google-auth', () => ({
  authorize: vi.fn(),
  authorizeDriveFiles: vi.fn(),
  disconnect: vi.fn(),
  isCalendarConnected: () => true,
  storeGoogleClientCredentials: vi.fn(),
  getCalendarAccountEmail: () => 'test@example.com',
  getGmailAccountEmail: () => null,
}))

vi.mock('../main/services/company-enrichment', () => ({
  enrichDomainsFromCalendarEvents: (events: CalendarEvent[]) => {
    mockEnrichDomains(events)
    return Promise.resolve()
  },
}))

vi.mock('../main/ipc/meeting.ipc', () => ({
  prepareMeetingFromCalendarEvent: (event: unknown, userId: unknown) =>
    mockPrepareMeeting(event, userId),
}))

vi.mock('../main/security/current-user', () => ({
  getCurrentUserId: () => 'user-test',
}))

vi.mock('../main/cache/persistent-cache', () => ({
  persistentCache: { invalidate: vi.fn(), get: vi.fn() },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function event(overrides: Partial<CalendarEvent> & { id: string; startTime: string }): CalendarEvent {
  return {
    endTime: new Date(new Date(overrides.startTime).getTime() + 30 * 60_000).toISOString(),
    selfName: null,
    attendees: [],
    attendeeEmails: [],
    meetingUrl: null,
    platform: null,
    title: overrides.id,
    description: null,
    ...overrides,
  }
}

// Import after mocks
const { fetchAndEnrichCalendarEvents } = await import('../main/ipc/calendar.ipc')

describe('fetchAndEnrichCalendarEvents — reconcile past events', () => {
  beforeEach(() => {
    mockGetEventsAround.mockReset()
    mockPrepareMeeting.mockReset()
    mockTriggerImmediateCheck.mockReset()
    mockEnrichDomains.mockReset()
  })

  it('fetches a window that includes the past 24h (not just upcoming)', async () => {
    mockGetEventsAround.mockResolvedValue([])

    await fetchAndEnrichCalendarEvents()

    expect(mockGetEventsAround).toHaveBeenCalledTimes(1)
    const [hoursBack, hoursAhead] = mockGetEventsAround.mock.calls[0]
    expect(hoursBack).toBe(24)
    expect(hoursAhead).toBeGreaterThan(0)
  })

  it('reconciles each past event into the meetings table exactly once', async () => {
    const now = Date.now()
    const past1 = event({ id: 'p1', startTime: new Date(now - 60 * 60_000).toISOString() })
    const past2 = event({ id: 'p2', startTime: new Date(now - 5 * 60_000).toISOString() })
    const future = event({ id: 'f1', startTime: new Date(now + 60 * 60_000).toISOString() })

    mockGetEventsAround.mockResolvedValue([past1, past2, future])

    await fetchAndEnrichCalendarEvents()

    expect(mockPrepareMeeting).toHaveBeenCalledTimes(2)
    const persistedIds = mockPrepareMeeting.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(persistedIds.sort()).toEqual(['p1', 'p2'])
  })

  it('returns only future events to the caller (Upcoming UI unchanged)', async () => {
    const now = Date.now()
    const past = event({ id: 'past', startTime: new Date(now - 60 * 60_000).toISOString() })
    const future = event({ id: 'future', startTime: new Date(now + 60 * 60_000).toISOString() })

    mockGetEventsAround.mockResolvedValue([past, future])

    const result = await fetchAndEnrichCalendarEvents()
    expect(result.map((e) => e.id)).toEqual(['future'])
  })

  it('continues reconciling after a single persist failure, logging a structured metric', async () => {
    const now = Date.now()
    const p1 = event({ id: 'good1', startTime: new Date(now - 60 * 60_000).toISOString() })
    const pBad = event({ id: 'bad', startTime: new Date(now - 30 * 60_000).toISOString() })
    const p2 = event({ id: 'good2', startTime: new Date(now - 5 * 60_000).toISOString() })

    mockGetEventsAround.mockResolvedValue([p1, pBad, p2])
    mockPrepareMeeting.mockImplementation((ev: { id: string }) => {
      if (ev.id === 'bad') throw new Error('SQLITE_BUSY')
      return { id: `meeting-${ev.id}` }
    })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await fetchAndEnrichCalendarEvents()

    expect(mockPrepareMeeting).toHaveBeenCalledTimes(3)
    const loggedMessages = errorSpy.mock.calls.map((c) => String(c[0]))
    expect(loggedMessages.some((m) => m.includes('meeting.reconcile.failed'))).toBe(true)
    expect(loggedMessages.some((m) => m.includes('eventId=bad'))).toBe(true)
    errorSpy.mockRestore()
  })

  it('idempotent invocation: calling twice with the same events reconciles each one twice (helper-side guard kicks in inside prepareMeetingFromCalendarEvent)', async () => {
    // Note: helper-side idempotency is tested in meeting-group-event.test.ts;
    // here we just verify the reconcile loop doesn't itself short-circuit.
    const now = Date.now()
    const past = event({ id: 'rep', startTime: new Date(now - 10 * 60_000).toISOString() })
    mockGetEventsAround.mockResolvedValue([past])

    await fetchAndEnrichCalendarEvents()
    await fetchAndEnrichCalendarEvents()

    expect(mockPrepareMeeting).toHaveBeenCalledTimes(2)
  })
})
