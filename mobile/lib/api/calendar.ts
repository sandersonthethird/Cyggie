import { api } from './client'

// Typed client for /calendar/* gateway routes.

export interface CalendarAttendee {
  email: string
  displayName?: string
}

export interface CalendarEvent {
  id: string
  calendarEventId: string
  title: string
  start: string // ISO timestamp
  end: string
  attendees: CalendarAttendee[]
  location?: string
  meetingUrl?: string
  isAllDay: boolean
  /**
   * Server-side meeting status if there's a recording in the meetings
   * table tied to this calendar event (joined by calendar_event_id).
   * Drives the small status pill on the calendar card. Absent when
   * there's no linked recording — events without a recording render
   * the existing variant badge unchanged.
   */
  recordingStatus?: string
  /**
   * Meeting id if this calendar event has an associated meeting row.
   * Mobile uses this to navigate directly to /meetings/<id> on tap
   * without an extra round-trip through POST /meetings/from-calendar-event.
   * Absent when no meeting exists yet (mobile then auto-creates on tap).
   */
  meetingId?: string
}

interface CalendarEventsResponse {
  events: CalendarEvent[]
}

interface FetchCalendarOpts {
  from?: Date
  to?: Date
  limit?: number
  signal?: AbortSignal
}

/**
 * GET /calendar/events — Google Calendar events for the user's primary
 * calendar. Default window if from/to omitted: gateway uses now → +14 days.
 */
export async function fetchCalendarEvents(opts: FetchCalendarOpts = {}): Promise<CalendarEvent[]> {
  const params = new URLSearchParams()
  if (opts.from) params.set('from', opts.from.toISOString())
  if (opts.to) params.set('to', opts.to.toISOString())
  if (opts.limit !== undefined) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const path = qs ? `/calendar/events?${qs}` : '/calendar/events'
  const body = await api.get<CalendarEventsResponse>(path, { signal: opts.signal })
  return body.events
}

/**
 * Convert any date-shaped input to a UTC ISO string, or null when input is
 * missing or unparseable. Used by the calendar-tap handler so all-day
 * events (where `end` may be missing) or malformed values don't crash
 * `new Date(...).toISOString()` with a RangeError.
 *
 *   safeIso(null)                          → null
 *   safeIso('')                            → null
 *   safeIso('not-a-date')                  → null
 *   safeIso('2026-05-22T10:00:00-04:00')   → '2026-05-22T14:00:00.000Z'
 *   safeIso('2026-05-22T14:00:00.000Z')    → same
 *   safeIso('2026-05-22')                  → '2026-05-22T00:00:00.000Z'
 */
export function safeIso(input: string | null | undefined): string | null {
  if (!input) return null
  const d = new Date(input)
  if (!Number.isFinite(d.getTime())) return null
  return d.toISOString()
}

/**
 * Filter helper — events for "today" (caller's local timezone). The gateway
 * returns a wider window; mobile filters down to a single day at render time.
 */
export function eventsForDate(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const start = new Date(day)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return events.filter((ev) => {
    const evStart = new Date(ev.start)
    return evStart >= start && evStart < end
  })
}

/**
 * Bucket today's events into Earlier / Now / Next / Later relative to `now`.
 *   • Earlier:  ended before now
 *   • Now:      now ∈ [start, end]
 *   • Next:     starts after now AND is the soonest upcoming
 *   • Later:    starts after Next
 *
 * The "next" bucket holds at most one event (the soonest) so the calendar
 * can highlight it (crimson border in WIREFRAME 1).
 */
export interface BucketedEvents {
  earlier: CalendarEvent[]
  now: CalendarEvent[]
  next: CalendarEvent | null
  later: CalendarEvent[]
}

export function bucketEvents(events: CalendarEvent[], now: Date): BucketedEvents {
  const earlier: CalendarEvent[] = []
  const nowList: CalendarEvent[] = []
  const upcoming: CalendarEvent[] = []
  for (const ev of events) {
    if (ev.isAllDay) {
      // All-day events are technically "now" for the whole day; surface in
      // the now bucket so they're not lost in earlier/later.
      nowList.push(ev)
      continue
    }
    const start = new Date(ev.start).getTime()
    const end = new Date(ev.end).getTime()
    const t = now.getTime()
    if (end < t) earlier.push(ev)
    else if (start <= t && t <= end) nowList.push(ev)
    else upcoming.push(ev)
  }
  upcoming.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  const next = upcoming[0] ?? null
  const later = upcoming.slice(1)
  return { earlier, now: nowList, next, later }
}

/**
 * A single calendar day's events, used by the Upcoming and Past segments
 * of the mobile calendar tab.
 *
 * dayKey is 'YYYY-MM-DD' in local timezone — stable React key + avoids
 * the toISOString() UTC-shift gotcha.
 */
export interface CalendarDaySection {
  dayKey: string
  date: Date
  events: CalendarEvent[]
}

/**
 * Group events into per-day sections from `from` (inclusive) up to
 * `from + days` (exclusive). Skips days with zero events. Sections
 * are always returned chronologically — caller reverses for Past.
 *
 * Single responsibility: grouping only. Labels are computed by the
 * caller via `formatDayLabel(section.date, now)` at render time so
 * relative wording stays in sync with the per-minute now ticker.
 *
 * Event placement rules (matches desktop's groupCalendarEventsByDate):
 *   - Bucket by the event's START local-day.
 *   - All-day events sort first within their day.
 *   - Non-all-day sort by `start` ASC.
 */
export function groupByDay(
  events: CalendarEvent[],
  from: Date,
  days: number,
): CalendarDaySection[] {
  const windowStart = startOfDay(from)
  const windowEnd = addDays(windowStart, days)
  const byKey = new Map<string, CalendarDaySection>()
  for (const ev of events) {
    const start = new Date(ev.start)
    if (Number.isNaN(start.getTime())) continue
    const day = startOfDay(start)
    if (day < windowStart || day >= windowEnd) continue
    const key = dayKeyOf(day)
    let section = byKey.get(key)
    if (!section) {
      section = { dayKey: key, date: day, events: [] }
      byKey.set(key, section)
    }
    section.events.push(ev)
  }
  for (const section of byKey.values()) {
    section.events.sort(compareEventsWithinDay)
  }
  return Array.from(byKey.values()).sort((a, b) => a.date.getTime() - b.date.getTime())
}

/**
 * Human-readable label for a calendar day relative to `now`.
 *   same day    → 'Today'
 *   +1 day      → 'Tomorrow'
 *   -1 day      → 'Yesterday'
 *   +2..+6 days → weekday name ('Wednesday')
 *   else        → full date ('Thursday, May 28')
 */
export function formatDayLabel(day: Date, now: Date): string {
  const a = startOfDay(day).getTime()
  const b = startOfDay(now).getTime()
  const diffDays = Math.round((a - b) / 86400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Tomorrow'
  if (diffDays === -1) return 'Yesterday'
  if (diffDays >= 2 && diffDays <= 6) {
    return day.toLocaleDateString(undefined, { weekday: 'long' })
  }
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * Compute the calendar fetch window relative to `now`. The mobile
 * calendar tab pulls 7 days of past events and 14 days of future
 * events. Past start is snapped to local midnight so day-boundary
 * filtering is deterministic; future end is `now + 14d` (no snap —
 * the gateway returns whatever falls in the window).
 */
export function getCalendarFetchWindow(now: Date): { from: Date; to: Date } {
  const from = startOfDay(now)
  from.setDate(from.getDate() - 7)
  const to = new Date(now.getTime() + 14 * 86400_000)
  return { from, to }
}

function startOfDay(d: Date): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

function dayKeyOf(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function compareEventsWithinDay(a: CalendarEvent, b: CalendarEvent): number {
  if (a.isAllDay && !b.isAllDay) return -1
  if (!a.isAllDay && b.isAllDay) return 1
  return new Date(a.start).getTime() - new Date(b.start).getTime()
}
