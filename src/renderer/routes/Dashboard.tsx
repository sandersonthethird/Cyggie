import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  DashboardActivityItem,
  DashboardActivityType,
  DashboardData
} from '../../shared/types/dashboard'
import { DEFAULT_ACTIVITY_FILTER } from '../../shared/types/dashboard'
import type { Meeting } from '../../shared/types/meeting'
import type { TaskListItem, TaskSummaryStats } from '../../shared/types/task'
import CalendarBadge from '../components/meetings/CalendarBadge'
import ChatInterface from '../components/chat/ChatInterface'
import MultiSelectFilter from '../components/common/MultiSelectFilter'
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

function eventStillActive(event: CalendarEvent, now: Date): boolean {
  const end = new Date(event.endTime).getTime()
  if (Number.isFinite(end)) return end > now.getTime()
  const start = new Date(event.startTime).getTime()
  return Number.isFinite(start) && start > now.getTime()
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

function daysSinceCreated(dateStr: string): number {
  const created = new Date(dateStr).getTime()
  if (Number.isNaN(created)) return 0
  return Math.max(0, Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)))
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

type DashboardTab = 'pipeline' | 'tasks' | 'activity' | 'attention'

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
  const [activeTab, setActiveTab] = useState<DashboardTab>('pipeline')
  const [activityConfigOpen, setActivityConfigOpen] = useState(false)
  const [activityFilter, setActivityFilter] = useState<DashboardActivityFilter>(DEFAULT_ACTIVITY_FILTER)
  const [pipelineCompanies, setPipelineCompanies] = useState<CompanySummary[]>([])
  const [taskStats, setTaskStats] = useState<TaskSummaryStats | null>(null)
  const [recentTasks, setRecentTasks] = useState<TaskListItem[]>([])
  const [expandedActivityId, setExpandedActivityId] = useState<string | null>(null)
  const [dismissedStaleIds, setDismissedStaleIds] = useState<Set<string>>(new Set())
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const [pipelineFilterStages, setPipelineFilterStages] = useState<Set<CompanyPipelineStage>>(
    new Set<CompanyPipelineStage>(['screening', 'diligence', 'decision', 'documentation'])
  )
  const [pipelineFilterPriorities, setPipelineFilterPriorities] = useState<Set<CompanyPriority>>(new Set())
  const [pipelineFilterRounds, setPipelineFilterRounds] = useState<Set<CompanyRound>>(new Set())

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
      const [result, pipelineData, stats, tasks] = await Promise.all([
        window.api.invoke<DashboardData>(IPC_CHANNELS.DASHBOARD_GET),
        window.api.invoke<CompanySummary[]>(IPC_CHANNELS.PIPELINE_LIST),
        window.api.invoke<TaskSummaryStats>(IPC_CHANNELS.TASK_SUMMARY_STATS),
        window.api.invoke<TaskListItem[]>(IPC_CHANNELS.TASK_LIST, {
          status: ['open', 'in_progress'],
          limit: 5
        })
      ])
      setData(result)
      setPipelineCompanies(pipelineData)
      setTaskStats(stats)
      setRecentTasks(tasks)
      if (result.activityFilter) {
        setActivityFilter(result.activityFilter)
      }
      try {
        const raw = await window.api.invoke<string | null>(IPC_CHANNELS.SETTINGS_GET, 'dashboardDismissedStale')
        if (raw) setDismissedStaleIds(new Set(JSON.parse(raw) as string[]))
      } catch { /* ignore */ }
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

  useEffect(() => {
    if (activeTab !== 'activity') {
      setActivityConfigOpen(false)
    }
  }, [activeTab])

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
    if (item.type === 'email') {
      setExpandedActivityId((prev) => (prev === item.id ? null : item.id))
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

  const dismissStaleCompany = useCallback((companyId: string) => {
    setDismissedStaleIds((prev) => {
      const next = new Set(prev)
      next.add(companyId)
      void window.api.invoke(IPC_CHANNELS.SETTINGS_SET, 'dashboardDismissedStale', JSON.stringify([...next]))
      return next
    })
  }, [])

  const filteredPipelineCompanies = useMemo(() => {
    let result = pipelineCompanies
    if (pipelineFilterStages.size > 0) result = result.filter((c) => c.pipelineStage != null && pipelineFilterStages.has(c.pipelineStage))
    if (pipelineFilterPriorities.size > 0) result = result.filter((c) => c.priority != null && pipelineFilterPriorities.has(c.priority))
    if (pipelineFilterRounds.size > 0) result = result.filter((c) => c.round != null && pipelineFilterRounds.has(c.round))
    return result
  }, [pipelineCompanies, pipelineFilterStages, pipelineFilterPriorities, pipelineFilterRounds])

  if (loading && !data) {
    return <div className={styles.page}>Loading dashboard...</div>
  }

  const visibleStaleCompanies = (data?.needsAttention.staleCompanies || [])
    .filter((company) => !dismissedStaleIds.has(company.companyId))
  const stalledCompanies = data?.needsAttention.stalledCompanies || []
  const openTaskCount = (taskStats?.openCount || 0) + (taskStats?.inProgressCount || 0)

  const tabCounts: Record<DashboardTab, number> = {
    pipeline: pipelineCompanies.length,
    tasks: openTaskCount,
    activity: data?.recentActivity.length || 0,
    attention: visibleStaleCompanies.length + stalledCompanies.length
  }

  return (
    <div className={styles.page}>
      <div className={styles.quickActions}>
        <div className={styles.newMenuContainer} ref={newMenuRef}>
          <button
            className={styles.secondaryButton}
            onClick={() => setNewMenuOpen((v) => !v)}
          >
            + New
          </button>
          {newMenuOpen && (
            <div className={styles.newMenuDropdown}>
              <button
                className={styles.newMenuItem}
                onClick={() => { setNewMenuOpen(false); void handleQuickNote() }}
              >
                Note
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

      <section className={styles.tabsSection}>
        <div className={styles.tabRow}>
          {([
            ['pipeline', 'Pipeline'],
            ['tasks', 'Tasks'],
            ['activity', 'Recent Activity'],
            ['attention', 'Needs Attention']
          ] as [DashboardTab, string][]).map(([tab, label]) => (
            <button
              key={tab}
              className={`${styles.tab} ${activeTab === tab ? styles.activeTab : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              <span>{label}</span>
              {tabCounts[tab] > 0 && (
                <span className={styles.tabCount}>{tabCounts[tab]}</span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'pipeline' && (
          <div className={styles.tabPanel}>
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
              <div className={styles.pipelineFilterBar}>
                <MultiSelectFilter
                  options={STAGES}
                  selected={pipelineFilterStages}
                  onChange={setPipelineFilterStages}
                  allLabel="All Stages"
                />
                <MultiSelectFilter
                  options={PRIORITIES}
                  selected={pipelineFilterPriorities}
                  onChange={setPipelineFilterPriorities}
                  allLabel="All Priorities"
                />
                <MultiSelectFilter
                  options={ROUNDS}
                  selected={pipelineFilterRounds}
                  onChange={setPipelineFilterRounds}
                  allLabel="All Rounds"
                />
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
                    {filteredPipelineCompanies.map((company) => (
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
                          {company.description || '-'}
                        </td>
                      </tr>
                    ))}
                    {filteredPipelineCompanies.length === 0 && (
                      <tr>
                        <td colSpan={7} className={styles.empty}>
                          No companies match the current filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <p className={styles.empty}>No companies in pipeline yet.</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'tasks' && (
          <div className={styles.tabPanel}>
            <div className={styles.summaryList}>
              {taskStats && (taskStats.overdueCount > 0 || taskStats.dueThisWeek > 0) && (
                <div className={styles.taskStatsRow}>
                  {taskStats.overdueCount > 0 && (
                    <span className={styles.taskStatOverdue}>{taskStats.overdueCount} overdue</span>
                  )}
                  {taskStats.dueThisWeek > 0 && (
                    <span className={styles.taskStatDue}>{taskStats.dueThisWeek} due this week</span>
                  )}
                </div>
              )}
              {recentTasks.map((task) => (
                <button
                  key={task.id}
                  className={styles.summaryRow}
                  onClick={() => navigate('/tasks')}
                >
                  <span className={styles.summaryTitleGroup}>
                    {task.companyDomain && (
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(task.companyDomain)}&sz=32`}
                        alt=""
                        className={styles.itemCompanyIcon}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    <span className={styles.activityTitle}>{task.title}</span>
                  </span>
                  <span className={styles.activityMeta}>
                    {[task.companyName || task.meetingTitle || '', `${daysSinceCreated(task.createdAt)}d`].filter(Boolean).join(' · ')}
                  </span>
                </button>
              ))}
              {recentTasks.length === 0 && (
                <p className={styles.empty}>No open tasks.</p>
              )}
              {recentTasks.length > 0 && (
                <button className={styles.showMoreBtn} onClick={() => navigate('/tasks')}>
                  View all tasks
                </button>
              )}
            </div>
          </div>
        )}

        {activeTab === 'activity' && (
          <div className={styles.tabPanel}>
            <div className={styles.tabToolbar}>
              <button
                className={styles.configureButton}
                onClick={() => setActivityConfigOpen((v) => !v)}
              >
                {activityConfigOpen ? 'Done' : 'Configure'}
              </button>
            </div>
            {activityConfigOpen && (
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
            <div className={styles.activityList}>
              {groupActivityByDate((data?.recentActivity || []).slice(0, 12)).map(([heading, items]) => (
                <div key={heading} className={styles.activityDateGroup}>
                  <div className={styles.activityDateHeader}>{heading}</div>
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className={`${styles.activityItemWrapper} ${expandedActivityId === item.id ? styles.activityItemExpanded : ''}`}
                    >
                      <button
                        className={styles.activityRow}
                        onClick={() => openActivity(item)}
                      >
                        {item.companyDomain && item.companyId && (
                          <img
                            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(item.companyDomain)}&sz=32`}
                            alt=""
                            className={styles.activityCompanyIcon}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                            onClick={(e) => { e.stopPropagation(); navigate(`/company/${item.companyId}`) }}
                          />
                        )}
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
                      {expandedActivityId === item.id && item.type === 'email' && (
                        <div className={styles.activityEmailBody}>
                          {item.bodyText || item.snippet || '-'}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {data && data.recentActivity.length === 0 && (
                <p className={styles.empty}>No activity yet.</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'attention' && (
          <div className={styles.tabPanel}>
            <div className={styles.summaryList}>
              {visibleStaleCompanies.length > 0 && (
                <h3 className={styles.subTitle}>Stale Relationships</h3>
              )}
              {visibleStaleCompanies.slice(0, 8).map((company) => (
                <div key={company.companyId} className={styles.attentionRowWrapper}>
                  <button
                    className={styles.summaryRow}
                    onClick={() => openAttentionCompany(company.companyId)}
                  >
                    <span className={styles.summaryTitleGroup}>
                      {company.companyDomain && (
                        <img
                          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.companyDomain)}&sz=32`}
                          alt=""
                          className={styles.itemCompanyIcon}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      )}
                      <span className={styles.activityTitle}>{company.companyName}</span>
                    </span>
                    <span className={styles.activityMeta}>{company.daysSinceTouch}d ago</span>
                  </button>
                  <button
                    className={styles.dismissBtn}
                    onClick={() => dismissStaleCompany(company.companyId)}
                    title="Dismiss"
                  >
                    &times;
                  </button>
                </div>
              ))}
              {stalledCompanies.length > 0 && (
                <h3 className={styles.subTitle}>Stalled Pipeline</h3>
              )}
              {stalledCompanies.slice(0, 8).map((company) => (
                <button
                  key={company.companyId}
                  className={styles.summaryRow}
                  onClick={() => openAttentionCompany(company.companyId)}
                >
                  <span className={styles.summaryTitleGroup}>
                    {company.companyDomain && (
                      <img
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(company.companyDomain)}&sz=32`}
                        alt=""
                        className={styles.itemCompanyIcon}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                    )}
                    <span className={styles.activityTitle}>
                      {company.companyName} · {company.pipelineStage.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                    </span>
                  </span>
                  <span className={styles.activityMeta}>{company.daysSinceTouch}d ago</span>
                </button>
              ))}
              {data && visibleStaleCompanies.length === 0 && stalledCompanies.length === 0 && (
                <p className={styles.empty}>No items need attention.</p>
              )}
            </div>
          </div>
        )}
      </section>

      <div className={styles.chatSection}>
        <ChatInterface compact />
      </div>
    </div>
  )
}
