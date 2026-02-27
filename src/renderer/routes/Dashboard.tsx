import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import type {
  DashboardActivityFilter,
  DashboardActivityType,
  DashboardData
} from '../../shared/types/dashboard'
import { DEFAULT_ACTIVITY_FILTER } from '../../shared/types/dashboard'
import type { Meeting } from '../../shared/types/meeting'
import CalendarBadge from '../components/meetings/CalendarBadge'
import ChatInterface from '../components/chat/ChatInterface'
import styles from './Dashboard.module.css'

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

const STAGES: { value: CompanyPipelineStage; label: string }[] = [
  { value: 'screening', label: 'Screening' },
  { value: 'diligence', label: 'Diligence' },
  { value: 'decision', label: 'Decision' },
  { value: 'documentation', label: 'Documentation' },
  { value: 'pass', label: 'Pass' }
]

const PRIORITIES: { value: CompanyPriority; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'further_work', label: 'Further Work' },
  { value: 'monitor', label: 'Monitor' }
]

const ROUNDS: { value: CompanyRound; label: string }[] = [
  { value: 'pre_seed', label: 'Pre-Seed' },
  { value: 'seed', label: 'Seed' },
  { value: 'seed_extension', label: 'Seed Extension' },
  { value: 'series_a', label: 'Series A' },
  { value: 'series_b', label: 'Series B' }
]

function formatPriority(value: CompanyPriority | null): string {
  if (!value) return '-'
  return PRIORITIES.find((p) => p.value === value)?.label || value
}

function formatRound(value: CompanyRound | null): string {
  if (!value) return '-'
  return ROUNDS.find((r) => r.value === value)?.label || value
}

function formatStage(value: CompanyPipelineStage | null): string {
  if (!value) return '-'
  return STAGES.find((s) => s.value === value)?.label || value
}

function formatMoney(value: number | null): string {
  if (value == null) return '-'
  return `$${value}M`
}

function priorityClass(value: CompanyPriority | null): string {
  if (value === 'high') return styles.priorityHigh
  if (value === 'further_work') return styles.priorityFurtherWork
  if (value === 'monitor') return styles.priorityMonitor
  return ''
}

const ACTIVITY_ICONS: Record<string, string> = {
  meeting: '\u{1F4C5}',
  email: '\u2709',
  note: '\u270E'
}

function formatOccurrence(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

function groupActivityByDate(
  items: DashboardActivityItem[]
): [string, DashboardActivityItem[]][] {
  const groups = new Map<string, DashboardActivityItem[]>()
  for (const item of items) {
    const heading = formatDateHeading(item.occurredAt)
    const existing = groups.get(heading)
    if (existing) {
      existing.push(item)
    } else {
      groups.set(heading, [item])
    }
  }
  return Array.from(groups.entries())
}

export default function Dashboard() {
  const navigate = useNavigate()
  const startRecording = useRecordingStore((s) => s.startRecording)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)
  const dismissedEventIds = useAppStore((s) => s.dismissedEventIds)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [showAllSchedule, setShowAllSchedule] = useState(false)
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [attentionOpen, setAttentionOpen] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const [activityConfigOpen, setActivityConfigOpen] = useState(false)
  const [activityFilter, setActivityFilter] = useState<DashboardActivityFilter>(DEFAULT_ACTIVITY_FILTER)
  const [pipelineCompanies, setPipelineCompanies] = useState<CompanySummary[]>([])

  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  const visibleEvents = useMemo(
    () => calendarEvents.filter((event) => !dismissedEventIds.has(event.id)),
    [calendarEvents, dismissedEventIds]
  )
  const scheduleEvents = useMemo(
    () => visibleEvents
      .filter((event) => isWithinWeek(event.startTime, now) && new Date(event.startTime).getTime() > now.getTime())
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [visibleEvents, now]
  )
  const SCHEDULE_LIMIT = 5
  const truncatedScheduleEvents = useMemo(
    () => (showAllSchedule ? scheduleEvents : scheduleEvents.slice(0, SCHEDULE_LIMIT)),
    [scheduleEvents, showAllSchedule]
  )
  const groupedSchedule = useMemo(
    () => groupCalendarEventsByDate(truncatedScheduleEvents),
    [truncatedScheduleEvents]
  )
  const hasMoreSchedule = scheduleEvents.length > SCHEDULE_LIMIT

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [result, pipelineData] = await Promise.all([
        window.api.invoke<DashboardData>(IPC_CHANNELS.DASHBOARD_GET),
        window.api.invoke<CompanySummary[]>(IPC_CHANNELS.PIPELINE_LIST)
      ])
      setData(result)
      setPipelineCompanies(pipelineData)
      if (result.activityFilter) {
        setActivityFilter(result.activityFilter)
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const saveActivityFilter = useCallback(async (next: DashboardActivityFilter) => {
    setActivityFilter(next)
    try {
      await window.api.invoke(IPC_CHANNELS.SETTINGS_SET, 'dashboardActivityFilter', JSON.stringify(next))
      void loadDashboard()
    } catch (err) {
      setError(String(err))
    }
  }, [loadDashboard])

  const toggleActivityType = useCallback((type: DashboardActivityType) => {
    const next = { ...activityFilter }
    if (next.types.includes(type)) {
      next.types = next.types.filter((t) => t !== type)
    } else {
      next.types = [...next.types, type]
    }
    void saveActivityFilter(next)
  }, [activityFilter, saveActivityFilter])

  const toggleEmailCompanyFilter = useCallback((value: 'all' | 'pipeline_portfolio') => {
    void saveActivityFilter({ ...activityFilter, emailCompanyFilter: value })
  }, [activityFilter, saveActivityFilter])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  const handleRecord = useCallback(async (event?: CalendarEvent) => {
    try {
      const result = await window.api.invoke<{ meetingId: string; meetingPlatform: string | null }>(
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
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      setError(String(err))
    }
  }, [navigate])

  const dismissEvent = useAppStore((s) => s.dismissEvent)

  const handlePrepareFromCalendar = useCallback(async (event: CalendarEvent) => {
    try {
      const meeting = await window.api.invoke<Meeting>(
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

  const openActivity = useCallback((item: DashboardData['recentActivity'][number]) => {
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

  const openAttentionCompany = useCallback((companyId: string) => {
    navigate(`/company/${companyId}`)
  }, [navigate])

  if (loading && !data) {
    return <div className={styles.page}>Loading dashboard...</div>
  }

  return (
    <div className={styles.page}>
      <div className={styles.quickActions}>
        <button className={styles.secondaryButton} onClick={() => navigate('/companies?new=1')}>
          + Company
        </button>
        <button className={styles.secondaryButton} onClick={handleQuickNote}>
          + Note
        </button>
        <button className={styles.primaryButton} onClick={() => void handleRecord()}>
          + Record
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.scheduleSection}>
        <h2 className={styles.sectionTitle}>Schedule</h2>
        {!calendarConnected && (
          <p className={styles.empty}>Connect Google Calendar in Settings to see meeting schedule.</p>
        )}
        {calendarConnected && scheduleEvents.length === 0 && (
          <p className={styles.empty}>No upcoming meetings this week.</p>
        )}
        {groupedSchedule.map(([heading, events]) => (
          <div key={heading} className={styles.dateGroup}>
            <div className={styles.dateHeader}>{heading}</div>
            <div className={styles.eventRows}>
              {events.map((event) => (
                <CalendarBadge
                  key={event.id}
                  event={event}
                  onRecord={handleRecord}
                  onPrepare={handlePrepareFromCalendar}
                  onDismiss={handleDismissEvent}
                />
              ))}
            </div>
          </div>
        ))}
        {hasMoreSchedule && (
          <button
            className={styles.showMoreBtn}
            onClick={() => setShowAllSchedule((v) => !v)}
          >
            {showAllSchedule
              ? 'Show fewer'
              : `Show more (${scheduleEvents.length - SCHEDULE_LIMIT} more)`}
          </button>
        )}
      </section>

      <div className={styles.collapseGroup}>
        <div>
          <button
            className={styles.collapseToggle}
            onClick={() => setPipelineOpen((v) => !v)}
          >
            <span className={`${styles.chevron} ${pipelineOpen ? styles.chevronOpen : ''}`}>&#9656;</span>
            <span>Pipeline</span>
            {pipelineCompanies.length > 0 && (
              <span className={styles.toggleCount}>{pipelineCompanies.length}</span>
            )}
          </button>
          {pipelineOpen && (
            <div className={styles.pipelineTableWrapper}>
              <div className={styles.stageCounts}>
                {STAGES.map((stage) => {
                  const count = pipelineCompanies.filter((c) => c.pipelineStage === stage.value).length
                  return (
                    <div key={stage.value} className={styles.stageCountCard}>
                      <span className={styles.stageCountLabel}>{stage.label}</span>
                      <span className={styles.stageCountValue}>{count}</span>
                    </div>
                  )
                })}
              </div>
              {pipelineCompanies.length > 0 ? (
                <table className={styles.pipelineTable}>
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Stage</th>
                      <th>Priority</th>
                      <th>Round</th>
                      <th>Post Money</th>
                      <th>Raise</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pipelineCompanies.map((company) => (
                      <tr key={company.id}>
                        <td>
                          <button
                            className={styles.companyLink}
                            onClick={() => navigate(`/company/${company.id}`)}
                          >
                            {company.canonicalName}
                          </button>
                        </td>
                        <td>{formatStage(company.pipelineStage)}</td>
                        <td>
                          {company.priority ? (
                            <span className={`${styles.priorityBadge} ${priorityClass(company.priority)}`}>
                              {formatPriority(company.priority)}
                            </span>
                          ) : '-'}
                        </td>
                        <td>{formatRound(company.round)}</td>
                        <td>{formatMoney(company.postMoneyValuation)}</td>
                        <td>{formatMoney(company.raiseSize)}</td>
                        <td className={styles.descriptionCell}>
                          {(company.description || '').slice(0, 100) || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={styles.empty}>No companies in pipeline yet.</p>
              )}
            </div>
          )}
        </div>

        <div>
          <div className={styles.collapseHeader}>
            <button
              className={styles.collapseToggle}
              onClick={() => setActivityOpen((v) => !v)}
            >
              <span className={`${styles.chevron} ${activityOpen ? styles.chevronOpen : ''}`}>&#9656;</span>
              <span>Recent Activity</span>
              {(data?.recentActivity.length ?? 0) > 0 && (
                <span className={styles.toggleCount}>{data?.recentActivity.length}</span>
              )}
            </button>
            {activityOpen && (
              <button
                className={styles.configureButton}
                onClick={() => setActivityConfigOpen((v) => !v)}
              >
                {activityConfigOpen ? 'Done' : 'Configure'}
              </button>
            )}
          </div>
          {activityOpen && activityConfigOpen && (
            <div className={styles.activityConfig}>
              <div className={styles.configGroup}>
                <span className={styles.configLabel}>Show</span>
                {([
                  ['meeting', 'Meetings'],
                  ['email', 'Emails'],
                  ['note', 'Notes']
                ] as [DashboardActivityType, string][]).map(([type, label]) => (
                  <label key={type} className={styles.configCheckbox}>
                    <input
                      type="checkbox"
                      checked={activityFilter.types.includes(type)}
                      onChange={() => toggleActivityType(type)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {activityFilter.types.includes('email') && (
                <div className={styles.configGroup}>
                  <span className={styles.configLabel}>Emails from</span>
                  <label className={styles.configRadio}>
                    <input
                      type="radio"
                      name="emailFilter"
                      checked={activityFilter.emailCompanyFilter === 'pipeline_portfolio'}
                      onChange={() => toggleEmailCompanyFilter('pipeline_portfolio')}
                    />
                    Pipeline & Portfolio
                  </label>
                  <label className={styles.configRadio}>
                    <input
                      type="radio"
                      name="emailFilter"
                      checked={activityFilter.emailCompanyFilter === 'all'}
                      onChange={() => toggleEmailCompanyFilter('all')}
                    />
                    All companies
                  </label>
                </div>
              )}
            </div>
          )}
          {activityOpen && (
            <div className={styles.activityList}>
              {(data?.recentActivity || []).slice(0, 12).map((item) => (
                <button
                  key={item.id}
                  className={styles.activityRow}
                  onClick={() => openActivity(item)}
                >
                  <span
                    className={styles.activityIcon}
                    style={item.type === 'email' ? { fontSize: 20 } : undefined}
                  >
                    {ACTIVITY_ICONS[item.type] || ''}
                  </span>
                  <span className={styles.activityTitle}>{item.title}</span>
                  <span className={styles.activityMeta}>
                    {[item.companyName, formatOccurrence(item.occurredAt)].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
              {data && data.recentActivity.length === 0 && (
                <p className={styles.empty}>No activity yet.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.collapseGroup}>
        <div>
          <button
            className={styles.collapseToggle}
            onClick={() => setAttentionOpen((v) => !v)}
          >
            <span className={`${styles.chevron} ${attentionOpen ? styles.chevronOpen : ''}`}>&#9656;</span>
            <span>Needs Attention</span>
            {((data?.needsAttention.staleCompanies.length ?? 0) + (data?.needsAttention.stalledCompanies.length ?? 0)) > 0 && (
              <span className={styles.toggleCount}>
                {(data?.needsAttention.staleCompanies.length ?? 0) + (data?.needsAttention.stalledCompanies.length ?? 0)}
              </span>
            )}
          </button>
          {attentionOpen && (
            <div className={styles.summaryList}>
              {(data?.needsAttention.staleCompanies.length ?? 0) > 0 && (
                <h3 className={styles.subTitle}>Stale Relationships</h3>
              )}
              {(data?.needsAttention.staleCompanies || []).slice(0, 8).map((company) => (
                <button
                  key={company.companyId}
                  className={styles.summaryRow}
                  onClick={() => openAttentionCompany(company.companyId)}
                >
                  <span className={styles.activityTitle}>{company.companyName}</span>
                  <span className={styles.activityMeta}>{company.daysSinceTouch}d ago</span>
                </button>
              ))}
              {(data?.needsAttention.stalledCompanies.length ?? 0) > 0 && (
                <h3 className={styles.subTitle}>Stalled Pipeline</h3>
              )}
              {(data?.needsAttention.stalledCompanies || []).slice(0, 8).map((company) => (
                <button
                  key={company.companyId}
                  className={styles.summaryRow}
                  onClick={() => openAttentionCompany(company.companyId)}
                >
                  <span className={styles.activityTitle}>
                    {company.companyName} · {company.pipelineStage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  </span>
                  <span className={styles.activityMeta}>{company.daysSinceTouch}d ago</span>
                </button>
              ))}
              {data && data.needsAttention.staleCompanies.length === 0 && data.needsAttention.stalledCompanies.length === 0 && (
                <p className={styles.empty}>No items need attention.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
