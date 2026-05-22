import { describe, expect, it, vi } from 'vitest'

// The api client transitively imports expo-* / react-native modules
// which don't parse in vitest's Node environment. We never call
// fetchCalendarEvents in these tests, so a no-op mock is sufficient.
vi.mock('../client', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
}))

const {
  eventsForDate,
  formatDayLabel,
  getCalendarFetchWindow,
  groupByDay,
  safeIso,
} = await import('../calendar')
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

  describe('getCalendarFetchWindow', () => {
    it('returns from = local-midnight of now-7d, to = now+14d', () => {
      const now = at(2026, 5, 22, 10, 30)
      const { from, to } = getCalendarFetchWindow(now)

      // from snapped to local midnight, 7 days before
      expect(from.getFullYear()).toBe(2026)
      expect(from.getMonth()).toBe(4) // May (0-indexed)
      expect(from.getDate()).toBe(15)
      expect(from.getHours()).toBe(0)
      expect(from.getMinutes()).toBe(0)
      expect(from.getSeconds()).toBe(0)

      // to = now + exactly 14 days, no snap
      const expectedTo = new Date(now.getTime() + 14 * 86400_000)
      expect(to.getTime()).toBe(expectedTo.getTime())
    })

    it('handles month rollover backward', () => {
      const now = at(2026, 6, 3, 10) // June 3
      const { from } = getCalendarFetchWindow(now)
      expect(from.getMonth()).toBe(4) // May
      expect(from.getDate()).toBe(27) // May 27
    })

    it('handles year rollover backward', () => {
      const now = at(2026, 1, 3, 10) // Jan 3
      const { from } = getCalendarFetchWindow(now)
      expect(from.getFullYear()).toBe(2025)
      expect(from.getMonth()).toBe(11) // December
      expect(from.getDate()).toBe(27)
    })

    it('handles DST spring-forward (US: 2026-03-08) without losing a day', () => {
      // March 12 in US Pacific is after spring-forward (March 8); -7d should
      // still land on March 5 at local midnight, not March 4 23:00.
      const now = at(2026, 3, 12, 10)
      const { from } = getCalendarFetchWindow(now)
      expect(from.getDate()).toBe(5)
      expect(from.getHours()).toBe(0)
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
