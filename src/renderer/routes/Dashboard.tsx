import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Video, MapPin, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '../stores/app.store'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CalendarEvent } from '../../shared/types/calendar'
import type {
  CompanySummary,
  CompanyPriority,
  CompanyRound,
  CompanyPipelineStage
} from '../../shared/types/company'
import { DEFAULT_ACTIVITY_FILTER } from '../../shared/types/dashboard'
import type {
  DashboardActivityFilter,
  DashboardActivityItem,
  DashboardData
} from '../../shared/types/dashboard'
import type { Meeting } from '../../shared/types/meeting'
import type { TaskListItem } from '../../shared/types/task'
import styles from './Dashboard.module.css'
import { api } from '../api'

// ─── Date helpers ──────────────────────────────────────────────────────────────

function isWithinWeek(value: string, base: Date): boolean {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  const start = new Date(base)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return date >= start && date < end
}

function formatDateHeading(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })
}

function groupCalendarEventsByDate(events: CalendarEvent[]): [string, CalendarEvent[]][] {
  const groups = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const heading = formatDateHeading(event.startTime)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(event)
    } else {
      groups.set(heading, [event])
    }
  }
  return Array.from(groups.entries())
}

function eventStillActive(event: CalendarEvent, now: Date): boolean {
  const end = new Date(event.endTime).getTime()
  if (Number.isFinite(end)) return end > now.getTime()
  const start = new Date(event.startTime).getTime()
  return Number.isFinite(start) && start > now.getTime()
}

function isToday(event: CalendarEvent): boolean {
  const today = new Date()
  const start = new Date(event.startTime)
  return start.toDateString() === today.toDateString()
}

// ─── Formatters ────────────────────────────────────────────────────────────────

const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
]

const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

function formatRound(value: CompanyRound | null): string {
  if (!value) return ''
  return ROUNDS.find((r) => r.value === value)?.label || value
}

function formatStage(value: CompanyPipelineStage | null): string {
  if (!value) return ''
  return STAGES.find((s) => s.value === value)?.label || value
}

function formatOccurrence(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function daysSinceCreated(dateStr: string): number {
  const created = new Date(dateStr).getTime()
  if (Number.isNaN(created)) return 0
  return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)))
}

// ─── Icons & tags ──────────────────────────────────────────────────────────────

const ACTIVITY_ICONS: Record<string, string> = {
  meeting: '\u{1F4C5}',
  email: '\u2709',
  note: '\u270E'
}

function platformIcon(platform: string): React.ReactNode {
  const name = platform.toLowerCase()
  if (name.includes('zoom') || name.includes('meet') || name.includes('teams')) {
    return <Video size={11} strokeWidth={1.5} />
  }
  return <MapPin size={11} strokeWidth={1.5} />
}

// Consolidated priority → tag mapping (replaces two separate functions)
const PRIORITY_TAG_MAP: Record<CompanyPriority, { label: string; className: string }> = {
  high:         { label: 'HIGH INTENT',  className: styles.tagHighIntent },
  further_work: { label: 'FURTHER WORK', className: styles.tagFurtherWork },
  monitor:      { label: 'STEADY',       className: styles.tagSteady },
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const dismissEvent = useAppStore((s) => s.dismissEvent)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [pipelineCompanies, setPipelineCompanies] = useState<CompanySummary[]>([])
  const [openTasks, setOpenTasks] = useState<TaskListItem[]>([])
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const [activityFilter, setActivityFilter] = useState<DashboardActivityFilter>(DEFAULT_ACTIVITY_FILTER)
  const [filterOpen, setFilterOpen] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const [dragInfo, setDragInfo] = useState<{
    companyId: string
    fromStage: CompanyPipelineStage
  } | null>(null)
  const [dragOverStage, setDragOverStage] = useState<CompanyPipelineStage | null>(null)

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!newMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [newMenuOpen])

  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [filterOpen])

  const visibleEvents = useMemo(
    () => calendarEvents.filter((event) => !dismissedEventIds.has(event.id)),
    [calendarEvents, dismissedEventIds]
  )

  const scheduleEvents = useMemo(
    () => visibleEvents
      .filter((event) => isWithinWeek(event.startTime, now) && eventStillActive(event, now))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [visibleEvents, now]
  )

  const groupedSchedule = useMemo(
    () => groupCalendarEventsByDate(scheduleEvents),
    [scheduleEvents]
  )

  const todayCount = useMemo(
    () => scheduleEvents.filter(isToday).length,
    [scheduleEvents]
  )

  // First future event gets the crimson "next" dot
  const nextEventId = useMemo(
    () => scheduleEvents.find(e => new Date(e.startTime) > now)?.id,
    [scheduleEvents, now]
  )

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [result, pipelineData, tasks] = await Promise.all([
        api.invoke<DashboardData>(IPC_CHANNELS.DASHBOARD_GET),
        api.invoke<CompanySummary[]>(IPC_CHANNELS.PIPELINE_LIST),
        api.invoke<TaskListItem[]>(IPC_CHANNELS.TASK_LIST, {
          status: ['open', 'in_progress'],
          limit: 5
        })
      ])
      setData(result)
      setActivityFilter(result.activityFilter)
      setPipelineCompanies(pipelineData)
      setOpenTasks(tasks)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const saveAndReloadFilter = useCallback(async (next: DashboardActivityFilter) => {
    setActivityFilter(next)
    setFilterOpen(false)
    try {
      await api.invoke(IPC_CHANNELS.SETTINGS_SET, 'dashboardActivityFilter', JSON.stringify(next))
      void loadDashboard()
    } catch {
      setActivityFilter(activityFilter)
      setFilterOpen(true)
    }
  }, [loadDashboard, activityFilter])

  const handleRecord = useCallback(async (event?: CalendarEvent) => {
    try {
      const result = await api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
        IPC_CHANNELS.RECORDING_START,
        event?.title,
        event?.id
      )
      startRecording(result.meetingId, result.meetingPlatform)
      navigate(`/meeting/${result.meetingId}`)
    } catch (err) {
      setError(String(err))
    }
  }, [navigate, startRecording])

  const handleQuickNote = useCallback(async () => {
    try {
      const meeting = await api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      setError(String(err))
    }
  }, [navigate])

  const handlePrepareFromCalendar = useCallback(async (event: CalendarEvent) => {
    try {
      const meeting = await api.invoke<Meeting>(
        IPC_CHANNELS.MEETING_PREPARE,
        event.id,
        event.title,
        event.startTime,
        event.platform || undefined,
        event.meetingUrl || undefined,
        event.attendees,
        event.attendeeEmails
      )
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      setError(String(err))
    }
  }, [navigate])

  const handleDismissEvent = useCallback((event: CalendarEvent) => {
    dismissEvent(event.id)
  }, [dismissEvent])

  const openActivity = useCallback((item: DashboardActivityItem) => {
    if (item.referenceType === 'meeting') {
      navigate(`/meeting/${item.referenceId}`)
      return
    }
    if (item.companyId) {
      navigate(`/company/${item.companyId}?tab=timeline`)
      return
    }
    navigate('/companies')
  }, [navigate])

  return (
    <div className={styles.page}>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className={styles.header}>
        <div>
          <h1 className={styles.pageTitle}>Dashboard</h1>
          <p className={styles.pageSubtitle}>
            Focus on what matters.
            {todayCount > 0 && ` You have ${todayCount} meeting${todayCount > 1 ? 's' : ''} today.`}
          </p>
        </div>
        <div className={styles.newMenuContainer} ref={newMenuRef}>
          <button
            className={styles.newRecordBtn}
            onClick={() => setNewMenuOpen((v) => !v)}
          >
            + New Record
          </button>
          {newMenuOpen && (
            <div className={styles.newMenuDropdown}>
              <button
                className={styles.newMenuItem}
                onClick={() => { setNewMenuOpen(false); void handleQuickNote() }}
              >
                Meeting
              </button>
              <button
                className={styles.newMenuItem}
                onClick={() => { setNewMenuOpen(false); navigate('/companies?new=1') }}
              >
                Company
              </button>
              <button
                className={styles.newMenuItem}
                onClick={() => { setNewMenuOpen(false); navigate('/contacts?new=1') }}
              >
                Contact
              </button>
              <button
                className={styles.newMenuItem}
                onClick={() => { setNewMenuOpen(false); navigate('/tasks') }}
              >
                Task
              </button>
            </div>
          )}
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      {/* ── Two-column body ─────────────────────────────────────────── */}
      <div className={styles.body}>

        {/* LEFT: Schedule / Timeline */}
        <section className={styles.scheduleCol}>
          <div className={styles.colHeader}>
            <span className={styles.sectionLabel}>SCHEDULE</span>
            <span className={styles.todayBadge}>TODAY</span>
          </div>

          <div className={styles.scheduleScroll}>
          {!calendarConnected && (
            <p className={styles.emptyMeta}>
              Connect Google Calendar in Settings to see your schedule.
            </p>
          )}

          {calendarConnected && scheduleEvents.length === 0 && (
            <p className={styles.emptyMeta}>No upcoming meetings this week.</p>
          )}

          {groupedSchedule.map(([heading, events]) => (
            <div key={heading} className={styles.timelineGroup}>
              {heading !== 'Today' && (
                <div className={styles.timelineDateLabel}>{heading}</div>
              )}
              {events.map((event, i) => {
                const isNext = event.id === nextEventId
                const timeStr = `${formatOccurrence(event.startTime)} — ${formatOccurrence(event.endTime)}`
                const attendeeCount = event.attendees?.length ?? 0
                return (
                  <button
                    key={event.id}
                    className={`${styles.timelineItem} ${isNext ? styles.timelineItemNext : ''}`}
                    onClick={() => void handlePrepareFromCalendar(event)}
                  >
                    <div className={styles.timelineDot} />
                    {i < events.length - 1 && <div className={styles.timelineLine} />}
                    <div className={styles.timelineContent}>
                      <span className={styles.timelineTime}>{timeStr}</span>
                      <span className={styles.timelineTitle}>{event.title}</span>
                      {(event.platform || attendeeCount > 0) && (
                        <span className={styles.timelineMeta}>
                          {event.platform && (
                            <span className={styles.timelinePlatformIcon}>
                              {platformIcon(event.platform)}
                            </span>
                          )}
                          {event.platform && ' '}
                          {attendeeCount > 0 && `${attendeeCount} participant${attendeeCount > 1 ? 's' : ''}`}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
          </div>
        </section>

        {/* RIGHT: Pipeline + Touches + Tasks */}
        <div className={styles.rightCol}>

          {/* Pipeline Overview — Kanban */}
          <section className={styles.pipelineSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>PIPELINE OVERVIEW</span>
              <button className={styles.viewAllBtn} onClick={() => navigate('/pipeline')}>
                View Pipeline
              </button>
            </div>
            <div className={styles.kanbanRow}>
              {STAGES.map(({ value: stage }) => {
                const companies = pipelineCompanies.filter(c => c.pipelineStage === stage)
                const isDragTarget = dragOverStage === stage && dragInfo?.fromStage !== stage
                return (
                  <div
                    key={stage}
                    className={`${styles.kanbanCol}${isDragTarget ? ` ${styles.kanbanColDragOver}` : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setDragOverStage(stage) }}
                    onDragLeave={() => setDragOverStage(null)}
                    onDrop={async (e) => {
                      e.preventDefault()
                      if (!dragInfo || dragInfo.fromStage === stage) {
                        setDragInfo(null)
                        setDragOverStage(null)
                        return
                      }
                      const { companyId, fromStage } = dragInfo
                      setDragInfo(null)
                      setDragOverStage(null)
                      setPipelineCompanies(prev =>
                        prev.map(c => c.id === companyId ? { ...c, pipelineStage: stage } : c)
                      )
                      try {
                        await api.invoke(IPC_CHANNELS.COMPANY_UPDATE, companyId, { pipelineStage: stage })
                      } catch (err) {
                        console.error('[Dashboard] Failed to update pipeline stage:', err)
                        setPipelineCompanies(prev =>
                          prev.map(c => c.id === companyId ? { ...c, pipelineStage: fromStage } : c)
                        )
                      }
                    }}
                  >
                    <div className={styles.kanbanColHeader}>
                      <span>{formatStage(stage).toUpperCase()}</span>
                      <span className={styles.kanbanCount}>{companies.length}</span>
                    </div>
                    {companies.length === 0 && (
                      <div className={styles.kanbanEmpty}>No deals</div>
                    )}
                    {companies.slice(0, 3).map(company => {
                      const tag = company.priority ? PRIORITY_TAG_MAP[company.priority] : null
                      const moneyStr = company.raiseSize ? `$${company.raiseSize}M` : null
                      const roundStr = formatRound(company.round)
                      const meta = [moneyStr, roundStr].filter(Boolean).join(' · ')
                      return (
                        <button
                          key={company.id}
                          className={styles.dealCard}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move'
                            setDragInfo({ companyId: company.id, fromStage: stage })
                          }}
                          onDragEnd={() => { setDragInfo(null); setDragOverStage(null) }}
                          onClick={() => navigate(`/company/${company.id}`)}
                        >
                          <span className={styles.dealName}>{company.canonicalName}</span>
                          {meta && <span className={styles.dealMeta}>{meta}</span>}
                          {tag && (
                            <span className={`${styles.statusTag} ${tag.className}`}>
                              {tag.label}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </section>

          {/* Recent Touches */}
          <section className={styles.touchesSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>RECENT TOUCHES</span>
              <div className={styles.filterContainer} ref={filterRef}>
                <button
                  className={`${styles.filterBtn} ${filterOpen ? styles.filterBtnActive : ''}`}
                  onClick={() => setFilterOpen(v => !v)}
                  title="Filter activity"
                >
                  <SlidersHorizontal size={12} strokeWidth={2} />
                </button>
                {filterOpen && (
                  <div className={styles.filterDropdown}>
                    <div className={styles.filterSection}>
                      <span className={styles.filterLabel}>SHOW</span>
                      <div className={styles.filterRow}>
                        {(['meeting', 'email'] as const).map(type => {
                          const active = activityFilter.types.includes(type)
                          return (
                            <button
                              key={type}
                              className={`${styles.filterChip} ${active ? styles.filterChipActive : ''}`}
                              onClick={() => {
                                const next = active
                                  ? activityFilter.types.filter(t => t !== type)
                                  : [...activityFilter.types, type]
                                if (next.length === 0) return
                                void saveAndReloadFilter({ ...activityFilter, types: next as DashboardActivityFilter['types'] })
                              }}
                            >
                              {type === 'meeting' ? 'Meetings' : 'Emails'}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    {activityFilter.types.includes('email') && (
                      <div className={styles.filterSection}>
                        <span className={styles.filterLabel}>EMAILS FROM</span>
                        {([
                          { value: 'qualified', label: 'Qualified', desc: 'Portfolio, Prospect, Investors, Founders, LPs' },
                          { value: 'all',       label: 'Everyone',  desc: 'All synced email' },
                        ] as const).map(opt => (
                          <button
                            key={opt.value}
                            className={`${styles.filterOption} ${activityFilter.emailCompanyFilter === opt.value ? styles.filterOptionActive : ''}`}
                            onClick={() => void saveAndReloadFilter({ ...activityFilter, emailCompanyFilter: opt.value })}
                          >
                            <span className={styles.filterOptionLabel}>{opt.label}</span>
                            <span className={styles.filterOptionDesc}>{opt.desc}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button className={styles.viewAllBtn} onClick={() => navigate('/meetings')}>
                View All Activity
              </button>
            </div>
            <div className={styles.touchesScroll}>
            {(data?.recentActivity || []).slice(0, 5).map(item => (
              <button
                key={item.id}
                className={styles.touchRow}
                onClick={() => openActivity(item)}
              >
                <span className={styles.touchIcon}>
                  {item.companyDomain ? (
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.companyDomain)}&sz=32`}
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                  ) : (
                    ACTIVITY_ICONS[item.type] || '·'
                  )}
                </span>
                <div className={styles.touchContent}>
                  <span className={styles.touchTitle}>{item.title}</span>
                  <span className={styles.touchMeta}>
                    {[item.companyName, formatOccurrence(item.occurredAt)].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </button>
            ))}
            {(!data || data.recentActivity.length === 0) && (
              <p className={styles.emptyMeta}>No recent activity.</p>
            )}
            </div>
          </section>

          {/* Open Tasks strip */}
          <section className={styles.tasksSection}>
            <div className={styles.sectionHeader}>
              <span className={styles.sectionLabel}>OPEN TASKS</span>
              <button className={styles.viewAllBtn} onClick={() => navigate('/tasks')}>
                View All
              </button>
            </div>
            <div className={styles.tasksScroll}>
            {openTasks.slice(0, 3).map(task => (
              <button
                key={task.id}
                className={styles.taskRow}
                onClick={() => navigate('/tasks')}
              >
                <span className={styles.touchIcon}>
                  {task.companyDomain
                    ? <img src={`https://www.google.com/s2/favicons?domain=${task.companyDomain}&sz=32`} alt="" />
                    : (task.title?.[0] ?? '·').toUpperCase()
                  }
                </span>
                <span className={styles.taskTitle}>{task.title}</span>
                <span className={styles.taskMeta}>
                  {[
                    task.companyName || task.meetingTitle || '',
                    `${daysSinceCreated(task.createdAt)}d`
                  ].filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
            {openTasks.length === 0 && (
              <p className={styles.emptyMeta}>No open tasks.</p>
            )}
            </div>
          </section>

        </div>
      </div>


    </div>
  )
}
