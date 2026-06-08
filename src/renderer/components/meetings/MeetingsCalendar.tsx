import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  isSameMonth,
  isSameDay,
  isToday,
  format,
} from 'date-fns'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { Meeting } from '../../../shared/types/meeting'
import type { CompanyPipelineStage, CompanyEntityType } from '../../../shared/types/company'
import { IPC_CHANNELS } from '../../../shared/constants/channels'
import { api } from '../../api'
import styles from './MeetingsCalendar.module.css'

// ── Color coding ──────────────────────────────────────────────────────────────

// Pipeline stage colors (solid left-border bar + tinted background)
const STAGE_COLORS: Record<CompanyPipelineStage, string> = {
  screening: '#A855F7',     // purple
  diligence: '#3B82F6',     // blue
  decision: '#22C55E',      // green
  documentation: '#F59E0B', // amber
  portfolio: '#14B8A6',     // teal
  pass: '#9CA3AF',          // gray
}

// Entity type colors (when company has no pipeline stage)
const ENTITY_COLORS: Partial<Record<CompanyEntityType, string>> = {
  portfolio: '#22C55E',  // green
  lp: '#F97316',         // orange
  vc_fund: '#6366F1',    // indigo
  customer: '#0EA5E9',   // sky
  partner: '#A855F7',    // purple
  vendor: '#F59E0B',     // amber
}

const DEFAULT_COLOR = '#9CA3AF' // gray — no company or unknown type

function getMeetingColor(meeting: Meeting): string {
  if (!meeting.company) return DEFAULT_COLOR
  // Pipeline stage takes priority
  if (meeting.company.stage) return STAGE_COLORS[meeting.company.stage] ?? DEFAULT_COLOR
  // Fall back to entity type
  if (meeting.company.entityType) return ENTITY_COLORS[meeting.company.entityType] ?? DEFAULT_COLOR
  return DEFAULT_COLOR
}

// Legend items: pipeline stages + key entity types
const LEGEND_ITEMS = [
  { label: 'Screening', color: STAGE_COLORS.screening },
  { label: 'Diligence', color: STAGE_COLORS.diligence },
  { label: 'Decision', color: STAGE_COLORS.decision },
  { label: 'Closed', color: STAGE_COLORS.documentation },
  { label: 'LP', color: ENTITY_COLORS.lp! },
  { label: 'Other', color: DEFAULT_COLOR },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

type CalendarView = 'month' | 'week'

const DAY_HEADERS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Component ─────────────────────────────────────────────────────────────────

interface MeetingsCalendarProps {
  meetings: Meeting[]
}

export function MeetingsCalendar({ meetings }: MeetingsCalendarProps) {
  const navigate = useNavigate()
  const [viewedMonth, setViewedMonth] = useState(() => startOfMonth(new Date()))
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date())
  const [calView, setCalView] = useState<CalendarView>('month')

  // Compute grid days based on view mode
  const days = useMemo(() => {
    if (calView === 'week') {
      const weekStart = startOfWeek(viewedMonth, { weekStartsOn: 0 })
      const weekEnd = endOfWeek(viewedMonth, { weekStartsOn: 0 })
      return eachDayOfInterval({ start: weekStart, end: weekEnd })
    }
    const monthStart = startOfMonth(viewedMonth)
    const monthEnd = endOfMonth(viewedMonth)
    const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 })
    const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 })
    return eachDayOfInterval({ start: gridStart, end: gridEnd })
  }, [viewedMonth, calView])

  // Group meetings by date key
  const meetingsByDate = useMemo(() => {
    const map = new Map<string, Meeting[]>()
    for (const m of meetings) {
      const key = toDateKey(new Date(m.date))
      const existing = map.get(key)
      if (existing) existing.push(m)
      else map.set(key, [m])
    }
    for (const [, items] of map) {
      items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    }
    return map
  }, [meetings])

  // Navigation
  const handlePrev = useCallback(() => {
    setViewedMonth(m => calView === 'week' ? subWeeks(m, 1) : subMonths(m, 1))
  }, [calView])

  const handleNext = useCallback(() => {
    setViewedMonth(m => calView === 'week' ? addWeeks(m, 1) : addMonths(m, 1))
  }, [calView])

  const handleToday = useCallback(() => {
    setViewedMonth(calView === 'week' ? new Date() : startOfMonth(new Date()))
    setSelectedDate(new Date())
  }, [calView])

  const handleClickMeeting = useCallback(async (meeting: Meeting) => {
    if (meeting.id.startsWith('cal-')) {
      // Materialize the synthetic calendar row into a real meeting before routing.
      if (!meeting.calendarEventId) return
      try {
        const prepared = await api.invoke<Meeting>(
          IPC_CHANNELS.MEETING_PREPARE,
          meeting.calendarEventId,
          meeting.title,
          meeting.date,
          meeting.meetingPlatform || undefined,
          meeting.meetingUrl || undefined,
          meeting.attendees || undefined,
          meeting.attendeeEmails || undefined,
        )
        navigate(`/meeting/${prepared.id}`)
      } catch (err) {
        console.error('Failed to open calendar meeting:', err)
      }
      return
    }
    navigate(`/meeting/${meeting.id}`)
  }, [navigate])

  // Selected day meetings
  const selectedDayMeetings = useMemo(() => {
    if (!selectedDate) return []
    const key = format(selectedDate, 'yyyy-MM-dd')
    return meetingsByDate.get(key) ?? []
  }, [selectedDate, meetingsByDate])

  // Header label
  const headerLabel = calView === 'week'
    ? `${format(days[0], 'MMM d')} – ${format(days[6], 'MMM d, yyyy')}`
    : format(viewedMonth, 'MMMM yyyy')

  // Max meetings to show per cell (more in week view since cells are taller)
  const maxPreview = calView === 'week' ? 8 : 4

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.arrowBtn} onClick={handlePrev} title="Previous">
            <ChevronLeft size={16} />
          </button>
          <button className={styles.arrowBtn} onClick={handleNext} title="Next">
            <ChevronRight size={16} />
          </button>
          <h2 className={styles.monthLabel}>{headerLabel}</h2>
          <button className={styles.todayBtn} onClick={handleToday}>Today</button>
        </div>

        <div className={styles.headerRight}>
          {/* Legend */}
          <div className={styles.legend}>
            {LEGEND_ITEMS.map(({ label, color }) => (
              <span key={label} className={styles.legendItem}>
                <span className={styles.legendDot} style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>

          {/* Week / Month toggle */}
          <div className={styles.viewToggle}>
            <button
              className={`${styles.viewToggleBtn} ${calView === 'week' ? styles.viewToggleActive : ''}`}
              onClick={() => { setCalView('week'); setViewedMonth(new Date()) }}
            >
              Week
            </button>
            <button
              className={`${styles.viewToggleBtn} ${calView === 'month' ? styles.viewToggleActive : ''}`}
              onClick={() => { setCalView('month'); setViewedMonth(m => startOfMonth(m)) }}
            >
              Month
            </button>
          </div>
        </div>
      </div>

      {/* Calendar grid — headers + cells in one grid for alignment */}
      <div className={`${styles.grid} ${calView === 'week' ? styles.gridWeek : ''}`}>
        {DAY_HEADERS.map((d) => (
          <div key={d} className={styles.dayHeader}>{d}</div>
        ))}

        {days.map((day) => {
          const inMonth = calView === 'week' || isSameMonth(day, viewedMonth)
          const today = isToday(day)
          const selected = selectedDate ? isSameDay(day, selectedDate) : false
          const key = format(day, 'yyyy-MM-dd')
          const dayMeetings = meetingsByDate.get(key) ?? []
          const count = dayMeetings.length

          return (
            <button
              key={day.toISOString()}
              className={[
                styles.dayCell,
                !inMonth && styles.outsideMonth,
                today && styles.today,
                selected && styles.selected,
              ].filter(Boolean).join(' ')}
              onClick={() => setSelectedDate(day)}
            >
              <span className={styles.dayNumber}>
                {/* Show month prefix on first day or if day is 1 */}
                {(day.getDate() === 1 || day === days[0]) && calView === 'month'
                  ? format(day, 'MMM d')
                  : format(day, 'd')}
              </span>
              {count > 0 && inMonth && (
                <div className={styles.meetingPreviews}>
                  {dayMeetings.slice(0, maxPreview).map((m) => (
                    <div
                      key={m.id}
                      className={styles.meetingPreview}
                      style={{ borderLeftColor: getMeetingColor(m) }}
                      onClick={(e) => { e.stopPropagation(); handleClickMeeting(m) }}
                      role="link"
                    >
                      <span className={styles.previewTime}>{formatTime(m.date)}</span>
                      <span className={styles.previewTitle}>{m.title}</span>
                    </div>
                  ))}
                  {count > maxPreview && (
                    <span className={styles.moreCount}>+{count - maxPreview} more</span>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>

      {/* Selected day meetings — below calendar */}
      {selectedDate && selectedDayMeetings.length > 0 && (
        <div className={styles.dayDetail}>
          <div className={styles.dayDetailHeader}>
            <span className={styles.dayDetailDate}>
              {format(selectedDate, 'EEEE, MMMM d')}
            </span>
            <span className={styles.dayDetailCount}>
              {selectedDayMeetings.length === 1
                ? '1 meeting'
                : `${selectedDayMeetings.length} meetings`}
            </span>
          </div>
          <div className={styles.dayDetailList}>
            {selectedDayMeetings.map((meeting) => (
              <div
                key={meeting.id}
                className={styles.dayDetailItem}
                style={{ borderLeftColor: getMeetingColor(meeting) }}
                onClick={() => handleClickMeeting(meeting)}
                role="button"
                tabIndex={0}
              >
                <div className={styles.dayDetailTime}>{formatTime(meeting.date)}</div>
                <div className={styles.dayDetailInfo}>
                  <div className={styles.dayDetailTitle}>{meeting.title}</div>
                  {meeting.company && (
                    <div className={styles.dayDetailCompany}>
                      {meeting.company.domain && (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(meeting.company.domain)}&sz=16`}
                          alt=""
                          className={styles.companyLogo}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      {meeting.company.name}
                      {meeting.company.stage && (
                        <span
                          className={styles.stageBadge}
                          style={{ background: getMeetingColor(meeting), color: '#fff' }}
                        >
                          {meeting.company.stage}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
