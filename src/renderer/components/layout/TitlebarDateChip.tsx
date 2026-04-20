import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { format, isSameDay } from 'date-fns'
import { Calendar } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useMiniCalendarActions } from '../../hooks/useMiniCalendarActions'
import MiniCalendar from './MiniCalendar'
import type { CalendarEvent } from '../../../shared/types/calendar'
import styles from './TitlebarDateChip.module.css'

// ── Helpers ──────────────────────────────────────────────

/** Parse an event's startTime into a local Date, handling date-only strings. */
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

const TWO_HOURS_MS = 2 * 60 * 60 * 1000

// ── formatChipLabel ──────────────────────────────────────

export interface ChipLabel {
  dateLabel: string
  state: 'idle' | 'next' | 'now' | 'empty'
  nextLabel?: string
  nextTime?: string
  hasDot: boolean
}

/**
 * Compute the chip's display label from the current time and event state.
 * Exported for unit testing.
 */
export function formatChipLabel(
  now: Date,
  nextEvent: CalendarEvent | null,
  currentEvent: CalendarEvent | null
): ChipLabel {
  const dateLabel = format(now, 'EEE, MMM d')

  // Currently in a meeting — highest priority
  if (currentEvent) {
    const title = currentEvent.title.length > 14
      ? currentEvent.title.slice(0, 14).trimEnd() + '…'
      : currentEvent.title
    return { dateLabel, state: 'now', nextLabel: 'Now', nextTime: title, hasDot: true }
  }

  // Next event upcoming
  if (nextEvent) {
    const startMs = parseEventDate(nextEvent.startTime).getTime()
    if (isNaN(startMs)) {
      return { dateLabel, state: 'empty', hasDot: false }
    }
    const withinTwoHours = startMs - now.getTime() <= TWO_HOURS_MS
    return {
      dateLabel,
      state: 'next',
      nextLabel: 'NEXT',
      nextTime: formatTime(nextEvent.startTime),
      hasDot: withinTwoHours
    }
  }

  // No events
  return { dateLabel, state: 'empty', hasDot: false }
}

// ── Component ────────────────────────────────────────────

export default function TitlebarDateChip() {
  const navigate = useNavigate()
  const location = useLocation()

  const [popoverOpen, setPopoverOpen] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const wrapperRef = useRef<HTMLDivElement>(null)

  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const { handleRecordEvent, handlePrepareEvent, handleDismissEvent, handleClickMeeting } =
    useMiniCalendarActions()

  // Refresh `now` every 60s so the chip label updates
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Auto-close on route navigation
  useEffect(() => {
    setPopoverOpen(false)
  }, [location.pathname])

  // Click-outside dismiss
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  // Keyboard: ⌘\ to toggle, Escape to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Escape closes the popover
      if (e.key === 'Escape' && popoverOpen) {
        e.preventDefault()
        setPopoverOpen(false)
        return
      }

      // ⌘\ (Ctrl+\ on non-mac) toggles the popover
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        // Don't fire while typing in an input
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement)?.isContentEditable) {
          return
        }
        e.preventDefault()
        setPopoverOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [popoverOpen])

  // Derived: today's events, next event, current event
  const { nextEvent, currentEvent } = useMemo(() => {
    const nowMs = now.getTime()
    const today = new Date(now)

    const todayEvents = calendarEvents
      .filter((e) => {
        if (dismissedEventIds.has(e.id)) return false
        const d = parseEventDate(e.startTime)
        return !isNaN(d.getTime()) && isSameDay(d, today)
      })
      .sort((a, b) => parseEventDate(a.startTime).getTime() - parseEventDate(b.startTime).getTime())

    let current: CalendarEvent | null = null
    let next: CalendarEvent | null = null

    for (const e of todayEvents) {
      const startMs = parseEventDate(e.startTime).getTime()
      const endMs = parseEventDate(e.endTime).getTime()

      if (startMs <= nowMs && endMs > nowMs && !current) {
        current = e
      } else if (startMs > nowMs && !next) {
        next = e
      }

      if (current && next) break
    }

    return { nextEvent: next, currentEvent: current }
  }, [calendarEvents, dismissedEventIds, now])

  const chip = formatChipLabel(now, nextEvent, currentEvent)

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={`${styles.chip} ${popoverOpen ? styles.chipOpen : ''}`}
        onClick={() => setPopoverOpen((v) => !v)}
        aria-expanded={popoverOpen}
        aria-label="Calendar"
      >
        <Calendar className={styles.chipIcon} size={13} strokeWidth={1.5} />
        <span className={styles.chipDate}>{chip.dateLabel}</span>

        <span className={styles.chipDivider} />

        {chip.state === 'now' && (
          <>
            <span className={styles.chipNowLabel}>{chip.nextLabel}</span>
            <span className={styles.chipNowTitle}>{chip.nextTime}</span>
            <span className={`${styles.chipDot} ${styles.chipDotPulse}`} />
          </>
        )}

        {chip.state === 'next' && (
          <>
            <span className={styles.chipNextLabel}>{chip.nextLabel}</span>
            <span className={styles.chipTime}>{chip.nextTime}</span>
            {chip.hasDot && <span className={styles.chipDot} />}
          </>
        )}

        {chip.state === 'empty' && (
          <span className={styles.chipEmpty}>No events today</span>
        )}
      </button>

      {popoverOpen && (
        <div className={styles.popover}>
          <MiniCalendar
            calendarConnected={calendarConnected}
            dismissedEventIds={dismissedEventIds}
            storeEvents={calendarEvents}
            onRecordEvent={handleRecordEvent}
            onPrepareEvent={handlePrepareEvent}
            onDismissEvent={handleDismissEvent}
            onClickMeeting={handleClickMeeting}
          />

          <div className={styles.popoverFooter}>
            <button
              className={styles.footerLink}
              onClick={() => {
                setPopoverOpen(false)
                navigate('/meetings')
              }}
            >
              Open full calendar →
            </button>
            <span className={styles.footerHint}>⌘\</span>
          </div>
        </div>
      )}
    </div>
  )
}
