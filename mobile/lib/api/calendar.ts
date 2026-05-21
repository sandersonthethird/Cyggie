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
