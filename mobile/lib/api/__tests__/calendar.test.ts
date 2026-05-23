import { beforeEach, describe, expect, it, vi } from 'vitest'

// The api client transitively imports expo-* / react-native modules
// which don't parse in vitest's Node environment. The infinite-query
// hook also pulls react via @tanstack — we only call the non-hook
// helpers in this file, so the api mock covers them.
const apiGetMock = vi.fn()
vi.mock('../client', () => ({
  api: { get: apiGetMock, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}))

const {
  bucketEvents: _bucketEvents,
  eventsForDate,
  fetchCalendarPage,
  formatDayLabel,
  getCalendarTodayWindow,
  groupByDay,
  MAX_EMPTY_PAGES_BEFORE_STOP,
  PAGE_DAYS,
  PAGE_LIMIT,
  safeIso,
} = await import('../calendar')
void _bucketEvents
type CalendarEvent = import('../calendar').CalendarEvent

function makeEvent(partial: Partial<CalendarEvent> & { id: string; start: string }): CalendarEvent {
  return {
    id: partial.id,
    calendarEventId: partial.calendarEventId ?? partial.id,
    title: partial.title ?? 'Untitled',
    start: partial.start,
    end: partial.end ?? new Date(new Date(partial.start).getTime() + 30 * 60_000).toISOString(),
    attendees: partial.attendees ?? [],
    isAllDay: partial.isAllDay ?? false,
    ...(partial.location !== undefined ? { location: partial.location } : {}),
    ...(partial.meetingUrl !== undefined ? { meetingUrl: partial.meetingUrl } : {}),
    ...(partial.recordingStatus !== undefined ? { recordingStatus: partial.recordingStatus } : {}),
    ...(partial.meetingId !== undefined ? { meetingId: partial.meetingId } : {}),
  }
}

// Anchor the test "now" to a fixed local-noon moment so day arithmetic
// is stable regardless of when CI runs.
function at(yyyy: number, mm: number, dd: number, hh = 12, min = 0): Date {
  return new Date(yyyy, mm - 1, dd, hh, min, 0, 0)
}

describe('api/calendar', () => {
  describe('groupByDay', () => {
    it('buckets events into per-day sections from `from` for `days` days', () => {
      const from = at(2026, 5, 22) // Friday
      const events = [
        makeEvent({ id: 'a', start: at(2026, 5, 22, 10).toISOString(), title: 'Fri 10am' }),
        makeEvent({ id: 'b', start: at(2026, 5, 22, 14).toISOString(), title: 'Fri 2pm' }),
        makeEvent({ id: 'c', start: at(2026, 5, 23, 9).toISOString(), title: 'Sat 9am' }),
        makeEvent({ id: 'd', start: at(2026, 5, 24, 11).toISOString(), title: 'Sun 11am' }),
      ]
      const sections = groupByDay(events, from, 3)
      expect(sections).toHaveLength(3)
      expect(sections.map((s) => s.dayKey)).toEqual(['2026-05-22', '2026-05-23', '2026-05-24'])
      expect(sections[0]?.events.map((e) => e.id)).toEqual(['a', 'b'])
      expect(sections[1]?.events.map((e) => e.id)).toEqual(['c'])
      expect(sections[2]?.events.map((e) => e.id)).toEqual(['d'])
    })

    it('skips days that have zero events', () => {
      const from = at(2026, 5, 22)
      const events = [
        makeEvent({ id: 'a', start: at(2026, 5, 22, 10).toISOString() }),
        // No events on the 23rd or 24th.
        makeEvent({ id: 'b', start: at(2026, 5, 25, 9).toISOString() }),
      ]
      const sections = groupByDay(events, from, 7)
      expect(sections.map((s) => s.dayKey)).toEqual(['2026-05-22', '2026-05-25'])
    })

    it('sorts non-all-day events chronologically within a day', () => {
      const from = at(2026, 5, 22)
      const events = [
        makeEvent({ id: 'late', start: at(2026, 5, 22, 16).toISOString() }),
        makeEvent({ id: 'early', start: at(2026, 5, 22, 9).toISOString() }),
        makeEvent({ id: 'mid', start: at(2026, 5, 22, 12).toISOString() }),
      ]
      const sections = groupByDay(events, from, 1)
      expect(sections[0]?.events.map((e) => e.id)).toEqual(['early', 'mid', 'late'])
    })

    it('places all-day events at the top of their day, ahead of timed events', () => {
      const from = at(2026, 5, 22)
      const events = [
        makeEvent({ id: 'timed-early', start: at(2026, 5, 22, 9).toISOString() }),
        makeEvent({
          id: 'allday',
          start: at(2026, 5, 22, 0).toISOString(),
          end: at(2026, 5, 23, 0).toISOString(),
          isAllDay: true,
        }),
        makeEvent({ id: 'timed-late', start: at(2026, 5, 22, 16).toISOString() }),
      ]
      const sections = groupByDay(events, from, 1)
      expect(sections[0]?.events.map((e) => e.id)).toEqual(['allday', 'timed-early', 'timed-late'])
    })

    it('files a midnight-spanning event under its start day', () => {
      // Event runs 11:30pm on the 22nd through 12:30am on the 23rd.
      const from = at(2026, 5, 22)
      const events = [
        makeEvent({
          id: 'spanning',
          start: at(2026, 5, 22, 23, 30).toISOString(),
          end: at(2026, 5, 23, 0, 30).toISOString(),
        }),
      ]
      const sections = groupByDay(events, from, 2)
      expect(sections).toHaveLength(1)
      expect(sections[0]?.dayKey).toBe('2026-05-22')
      expect(sections[0]?.events.map((e) => e.id)).toEqual(['spanning'])
    })

    it('caps the window — events past `from + days` are excluded', () => {
      const from = at(2026, 5, 22)
      const events = [
        makeEvent({ id: 'in', start: at(2026, 5, 24, 10).toISOString() }),
        makeEvent({ id: 'out', start: at(2026, 6, 6, 10).toISOString() }), // +15 days
      ]
      const sections = groupByDay(events, from, 14)
      const allIds = sections.flatMap((s) => s.events.map((e) => e.id))
      expect(allIds).toContain('in')
      expect(allIds).not.toContain('out')
    })

    it('works with a `from` in the past (used by the Past segment)', () => {
      const from = at(2026, 5, 15) // 7 days before May 22
      const events = [
        makeEvent({ id: 'a', start: at(2026, 5, 16, 10).toISOString() }),
        makeEvent({ id: 'b', start: at(2026, 5, 18, 14).toISOString() }),
      ]
      const sections = groupByDay(events, from, 7)
      expect(sections.map((s) => s.dayKey)).toEqual(['2026-05-16', '2026-05-18'])
    })

    it('returns [] for empty input', () => {
      expect(groupByDay([], at(2026, 5, 22), 14)).toEqual([])
    })

    it('past-segment derivation reverses sections to yesterday-first', () => {
      const from = at(2026, 5, 15)
      const events = [
        makeEvent({ id: 'oldest', start: at(2026, 5, 16, 10).toISOString() }),
        makeEvent({ id: 'middle', start: at(2026, 5, 18, 10).toISOString() }),
        makeEvent({ id: 'newest', start: at(2026, 5, 20, 10).toISOString() }),
      ]
      const reversed = [...groupByDay(events, from, 7)].reverse()
      expect(reversed.map((s) => s.dayKey)).toEqual(['2026-05-20', '2026-05-18', '2026-05-16'])
    })
  })

  describe('formatDayLabel', () => {
    const now = at(2026, 5, 22, 10) // Friday May 22, 2026

    it("returns 'Today' for the same calendar day", () => {
      expect(formatDayLabel(at(2026, 5, 22, 0), now)).toBe('Today')
      expect(formatDayLabel(at(2026, 5, 22, 23, 59), now)).toBe('Today')
    })

    it("returns 'Tomorrow' for now + 1 day", () => {
      expect(formatDayLabel(at(2026, 5, 23, 10), now)).toBe('Tomorrow')
    })

    it("returns 'Yesterday' for now - 1 day", () => {
      expect(formatDayLabel(at(2026, 5, 21, 10), now)).toBe('Yesterday')
    })

    it('returns the weekday name for now + 2..6 days', () => {
      // May 22 2026 is a Friday → +3 days = Monday
      expect(formatDayLabel(at(2026, 5, 25, 10), now)).toBe('Monday')
    })

    it('returns a full date for now + 7 days or beyond', () => {
      const label = formatDayLabel(at(2026, 5, 30, 10), now)
      expect(label).toContain('Saturday')
      expect(label).toMatch(/May/)
      expect(label).toContain('30')
    })

    it('returns a full date for past beyond yesterday', () => {
      const label = formatDayLabel(at(2026, 5, 17, 10), now)
      expect(label).toContain('Sunday')
      expect(label).toMatch(/May/)
      expect(label).toContain('17')
    })
  })

  describe('getCalendarTodayWindow', () => {
    it('returns from = start-of-today, to = start-of-tomorrow', () => {
      const now = at(2026, 5, 22, 10, 30)
      const { from, to } = getCalendarTodayWindow(now)

      expect(from.getFullYear()).toBe(2026)
      expect(from.getMonth()).toBe(4) // May (0-indexed)
      expect(from.getDate()).toBe(22)
      expect(from.getHours()).toBe(0)
      expect(from.getMinutes()).toBe(0)
      expect(from.getSeconds()).toBe(0)

      expect(to.getFullYear()).toBe(2026)
      expect(to.getMonth()).toBe(4)
      expect(to.getDate()).toBe(23)
      expect(to.getHours()).toBe(0)
    })

    it('handles month rollover at end-of-month noon', () => {
      const now = at(2026, 5, 31, 23, 30) // May 31 23:30
      const { from, to } = getCalendarTodayWindow(now)
      expect(from.getDate()).toBe(31)
      expect(to.getMonth()).toBe(5) // June
      expect(to.getDate()).toBe(1)
    })
  })

  describe('eventsForDate (regression)', () => {
    it('returns events whose start falls within the given local day', () => {
      const day = at(2026, 5, 22, 12)
      const events = [
        makeEvent({ id: 'in', start: at(2026, 5, 22, 10).toISOString() }),
        makeEvent({ id: 'out-prev', start: at(2026, 5, 21, 23, 30).toISOString() }),
        makeEvent({ id: 'out-next', start: at(2026, 5, 23, 0, 30).toISOString() }),
      ]
      const filtered = eventsForDate(events, day)
      expect(filtered.map((e) => e.id)).toEqual(['in'])
    })
  })

  describe('safeIso', () => {
    it('returns null for null', () => {
      expect(safeIso(null)).toBeNull()
    })
    it('returns null for undefined', () => {
      expect(safeIso(undefined)).toBeNull()
    })
    it('returns null for empty string', () => {
      expect(safeIso('')).toBeNull()
    })
    it('returns null for garbage', () => {
      expect(safeIso('not-a-date')).toBeNull()
      expect(safeIso('2026-13-99T99:99:99Z')).toBeNull()
    })
    it('normalizes a TZ-offset ISO to UTC Z', () => {
      expect(safeIso('2026-05-22T10:00:00-04:00')).toBe('2026-05-22T14:00:00.000Z')
    })
    it('roundtrips a UTC Z ISO unchanged', () => {
      expect(safeIso('2026-05-22T14:00:00.000Z')).toBe('2026-05-22T14:00:00.000Z')
    })
    it('parses a date-only string to UTC midnight', () => {
      // All-day Google events come as YYYY-MM-DD. Treating as UTC midnight is
      // good-enough; the gateway and detail screen don't depend on the
      // time-of-day component for all-day events.
      expect(safeIso('2026-05-22')).toBe('2026-05-22T00:00:00.000Z')
    })
  })
})

// ─── fetchCalendarPage (Item 1 infinite-scroll page primitive) ──────────────
//
// The function drives the entire infinite-scroll behavior — every
// branch of the cursor/emptyCount/pageToken state machine has a test
// here. Most of the "is the wrong window being fetched" classes of
// bugs would surface as wrong api.get URLs, which we assert directly.

describe('fetchCalendarPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset()
  })

  function mockApiResponse(opts: {
    events: CalendarEvent[]
    nextPageToken?: string
  }) {
    apiGetMock.mockResolvedValueOnce({
      events: opts.events,
      ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
    })
  }

  it('past direction: fetches [cursor-30d, cursor); advances cursor backward; resets emptyCount on non-empty', async () => {
    const cursor = new Date(2026, 4, 22) // May 22 local midnight
    mockApiResponse({
      events: [makeEvent({ id: 'e1', start: new Date(2026, 4, 10).toISOString() })],
    })

    const page = await fetchCalendarPage({ direction: 'past', cursor, emptyCount: 0 })

    expect(page.events.map((e) => e.id)).toEqual(['e1'])
    expect(page.nextCursor).not.toBeNull()
    // cursor advanced 30 days backward
    const expected = new Date(cursor)
    expected.setDate(expected.getDate() - PAGE_DAYS)
    expect(page.nextCursor?.getTime()).toBe(expected.getTime())
    expect(page.emptyCount).toBe(0)
    expect(page.nextPageToken).toBeUndefined()

    // The query was for the right window + limit
    const path = apiGetMock.mock.calls[0]?.[0] as string
    expect(path).toContain(`limit=${PAGE_LIMIT}`)
    expect(path).toContain('from=')
    expect(path).toContain('to=')
  })

  it('future direction: fetches [cursor, cursor+30d); advances cursor forward', async () => {
    const cursor = new Date(2026, 4, 22)
    mockApiResponse({
      events: [makeEvent({ id: 'e1', start: new Date(2026, 4, 23).toISOString() })],
    })

    const page = await fetchCalendarPage({ direction: 'future', cursor, emptyCount: 0 })

    const expected = new Date(cursor)
    expected.setDate(expected.getDate() + PAGE_DAYS)
    expect(page.nextCursor?.getTime()).toBe(expected.getTime())
  })

  it('truncation drain: nextPageToken keeps cursor + propagates token; emptyCount resets', async () => {
    const cursor = new Date(2026, 4, 22)
    const events = Array.from({ length: PAGE_LIMIT }, (_, i) =>
      makeEvent({ id: `e${i}`, start: new Date(2026, 4, 22, 10, i).toISOString() }),
    )
    mockApiResponse({ events, nextPageToken: 'tok-2' })

    const page = await fetchCalendarPage({ direction: 'past', cursor, emptyCount: 3 })

    // Cursor stays on the same window so the next call drains the token
    expect(page.nextCursor?.getTime()).toBe(cursor.getTime())
    expect(page.nextPageToken).toBe('tok-2')
    expect(page.emptyCount).toBe(0)
  })

  it('forwards an inbound pageToken to the gateway as a query param', async () => {
    mockApiResponse({ events: [] })
    await fetchCalendarPage({
      direction: 'past',
      cursor: new Date(2026, 4, 22),
      emptyCount: 0,
      pageToken: 'tok-A',
    })
    const path = apiGetMock.mock.calls[0]?.[0] as string
    expect(path).toContain('pageToken=tok-A')
  })

  it('empty page: increments emptyCount; advances cursor; still has nextCursor', async () => {
    mockApiResponse({ events: [] })
    const cursor = new Date(2026, 4, 22)

    const page = await fetchCalendarPage({ direction: 'past', cursor, emptyCount: 2 })

    expect(page.events).toEqual([])
    expect(page.emptyCount).toBe(3)
    expect(page.nextCursor).not.toBeNull()
  })

  it('stops after MAX_EMPTY_PAGES_BEFORE_STOP consecutive empties (nextCursor=null)', async () => {
    mockApiResponse({ events: [] })

    const page = await fetchCalendarPage({
      direction: 'past',
      cursor: new Date(2026, 4, 22),
      emptyCount: MAX_EMPTY_PAGES_BEFORE_STOP - 1,
    })

    expect(page.events).toEqual([])
    expect(page.emptyCount).toBe(MAX_EMPTY_PAGES_BEFORE_STOP)
    expect(page.nextCursor).toBeNull()
  })

  it('non-empty page after 4 empties resets the counter (does not trip the stop on next empty)', async () => {
    // After this call returns emptyCount=0, the next empty page only sees
    // emptyCount=0+1=1 — well below the stop threshold.
    mockApiResponse({
      events: [makeEvent({ id: 'e1', start: new Date(2026, 4, 1).toISOString() })],
    })

    const page = await fetchCalendarPage({
      direction: 'past',
      cursor: new Date(2026, 4, 22),
      emptyCount: 4,
    })

    expect(page.emptyCount).toBe(0)
    expect(page.nextCursor).not.toBeNull()
  })
})
