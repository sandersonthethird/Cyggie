import { useState, useEffect, useRef, useMemo } from 'react'
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
  isToday,
  format
} from 'date-fns'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import type { CalendarEvent } from '../../../shared/types/calendar'
import type { Meeting } from '../../../shared/types/meeting'
import CalendarBadge from '../meetings/CalendarBadge'
import styles from './MiniCalendar.module.css'

const DAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

/** Parse an event's startTime into a local Date, handling date-only strings correctly. */
function parseEventDate(dateStr: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(dateStr)
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface MiniCalendarProps {
  calendarConnected: boolean
  dismissedEventIds: Set<string>
  storeEvents: CalendarEvent[]
  onRecordEvent: (event: CalendarEvent) => void
  onPrepareEvent: (event: CalendarEvent) => void
  onDismissEvent: (event: CalendarEvent) => void
  onClickMeeting: (meetingId: string) => void
}

export default function MiniCalendar({
  calendarConnected,
  dismissedEventIds,
  storeEvents,
  onRecordEvent,
  onPrepareEvent,
  onDismissEvent,
  onClickMeeting
}: MiniCalendarProps) {
  const [viewedMonth, setViewedMonth] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState<Date>(new Date())
  const [rangeEvents, setRangeEvents] = useState<CalendarEvent[]>([])
  const [monthMeetings, setMonthMeetings] = useState<Meeting[]>([])
  const eventCacheRef = useRef(new Map<string, CalendarEvent[]>())
  const meetingCacheRef = useRef(new Map<string, Meeting[]>())

  // Fetch calendar events for the viewed month
  useEffect(() => {
    if (!calendarConnected) {
      setRangeEvents([])
      return
    }

    const key = format(viewedMonth, 'yyyy-MM')
    const cached = eventCacheRef.current.get(key)
    if (cached) {
      setRangeEvents(cached)
      return
    }

    const rangeStart = startOfMonth(viewedMonth).toISOString()
    const rangeEnd = startOfMonth(addMonths(viewedMonth, 1)).toISOString()

    window.api
      .invoke<CalendarEvent[]>(IPC_CHANNELS.CALENDAR_EVENTS_RANGE, rangeStart, rangeEnd)
      .then((events) => {
        eventCacheRef.current.set(key, events)
        setRangeEvents(events)
      })
      .catch((err) => console.error('Failed to fetch month events:', err))
  }, [viewedMonth, calendarConnected])

  // Fetch past meetings for the viewed month
  useEffect(() => {
    const key = format(viewedMonth, 'yyyy-MM')
    const cached = meetingCacheRef.current.get(key)
    if (cached) {
      setMonthMeetings(cached)
      return
    }

    const dateFrom = startOfMonth(viewedMonth).toISOString()
    const dateTo = startOfMonth(addMonths(viewedMonth, 1)).toISOString()

    window.api
      .invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, { dateFrom, dateTo })
      .then((meetings) => {
        const past = meetings.filter(
          (m) => m.status === 'transcribed' || m.status === 'summarized'
        )
        meetingCacheRef.current.set(key, past)
        setMonthMeetings(past)
      })
      .catch((err) => console.error('Failed to fetch month meetings:', err))
  }, [viewedMonth])

  // Merge range-fetched events with store events (deduplicate by ID)
  const allEvents = useMemo(() => {
    const byId = new Map<string, CalendarEvent>()
    for (const e of storeEvents) byId.set(e.id, e)
    for (const e of rangeEvents) byId.set(e.id, e)
    return Array.from(byId.values())
  }, [storeEvents, rangeEvents])

  const monthStart = startOfMonth(viewedMonth)
  const monthEnd = endOfMonth(viewedMonth)
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 })
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd })

  const visibleEvents = allEvents.filter((e) => !dismissedEventIds.has(e.id))

  // Build set of dates that have either calendar events or past meetings
  const datesWithActivity = useMemo(() => {
    const dates = new Set<string>()
    for (const e of visibleEvents) {
      dates.add(format(parseEventDate(e.startTime), 'yyyy-MM-dd'))
    }
    for (const m of monthMeetings) {
      dates.add(format(parseEventDate(m.date), 'yyyy-MM-dd'))
    }
    return dates
  }, [visibleEvents, monthMeetings])

  const now = new Date()

  const selectedDayAllEvents = visibleEvents.filter((e) =>
    isSameDay(parseEventDate(e.startTime), selectedDate)
  )
  const selectedDayEvents = selectedDayAllEvents.filter((e) => parseEventDate(e.startTime) > now)
  const selectedDayPastEvents = selectedDayAllEvents.filter((e) => parseEventDate(e.startTime) <= now)

  const pastEventIds = new Set(selectedDayPastEvents.map((e) => e.id))

  const selectedDayMeetings = monthMeetings.filter(
    (m) => isSameDay(parseEventDate(m.date), selectedDate) && !pastEventIds.has(m.calendarEventId ?? '')
  )

  const hasRecentContent = selectedDayPastEvents.length > 0 || selectedDayMeetings.length > 0
  const hasSelectedDayContent = selectedDayEvents.length > 0 || hasRecentContent

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.monthLabel}>{format(viewedMonth, 'MMMM yyyy')}</span>
        <div className={styles.arrows}>
          <button onClick={() => setViewedMonth((m) => subMonths(m, 1))} title="Previous month">
            &lsaquo;
          </button>
          <button onClick={() => setViewedMonth((m) => addMonths(m, 1))} title="Next month">
            &rsaquo;
          </button>
        </div>
      </div>

      <div className={styles.grid}>
        {DAY_HEADERS.map((d, i) => (
          <div key={i} className={styles.dayHeader}>
            {d}
          </div>
        ))}
        {days.map((day) => {
          const inMonth = isSameMonth(day, viewedMonth)
          const today = isToday(day)
          const selected = isSameDay(day, selectedDate)
          const hasActivity = datesWithActivity.has(format(day, 'yyyy-MM-dd'))

          return (
            <button
              key={day.toISOString()}
              className={[
                styles.dayCell,
                !inMonth && styles.outsideMonth,
                today && !selected && styles.today,
                selected && styles.selected
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setSelectedDate(day)}
            >
              <span>{format(day, 'd')}</span>
              {hasActivity && inMonth && <span className={styles.dot} />}
            </button>
          )
        })}
      </div>

      {hasSelectedDayContent && (
        <div className={styles.dayEvents}>
          {selectedDayEvents.map((event) => (
            <CalendarBadge
              key={event.id}
              event={event}
              onRecord={onRecordEvent}
              onPrepare={onPrepareEvent}
              onDismiss={onDismissEvent}
            />
          ))}
          {hasRecentContent && selectedDayEvents.length > 0 && (
            <div className={styles.recentHeader}>Recent Meetings</div>
          )}
          {selectedDayPastEvents.map((event) => (
            <CalendarBadge
              key={event.id}
              event={event}
              onRecord={onRecordEvent}
              onPrepare={onPrepareEvent}
              onDismiss={onDismissEvent}
            />
          ))}
          {selectedDayMeetings.map((meeting) => (
            <div
              key={meeting.id}
              className={styles.meetingItem}
              onClick={() => onClickMeeting(meeting.id)}
            >
              <span className={styles.meetingTitle}>{meeting.title}</span>
              <span className={styles.meetingTime}>{formatTime(meeting.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
