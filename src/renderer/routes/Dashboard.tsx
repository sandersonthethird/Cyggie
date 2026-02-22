import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '../stores/app.store'
import { useRecordingStore } from '../stores/recording.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { CalendarEvent } from '../../shared/types/calendar'
import type { DashboardCalendarCompanyContext, DashboardData } from '../../shared/types/dashboard'
import type { Meeting } from '../../shared/types/meeting'
import styles from './Dashboard.module.css'

function isSameDay(value: string, base: Date): boolean {
  const date = new Date(value)
  return (
    date.getFullYear() === base.getFullYear()
    && date.getMonth() === base.getMonth()
    && date.getDate() === base.getDate()
  )
}

function isWithinWeek(value: string, base: Date): boolean {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  const start = new Date(base)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 7)
  return date >= start && date < end
}

function formatRelativeTime(value: string | null): string {
  if (!value) return 'No touchpoint yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'No touchpoint yet'
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'Touched today'
  if (days === 1) return 'Touched yesterday'
  return `Touched ${days}d ago`
}

function formatOccurrence(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function weekdayLabel(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleDateString(undefined, { weekday: 'short' })
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
  const [calendarContext, setCalendarContext] = useState<Record<string, DashboardCalendarCompanyContext>>({})

  const now = useMemo(() => new Date(), [])
  const visibleEvents = useMemo(
    () => calendarEvents.filter((event) => !dismissedEventIds.has(event.id)),
    [calendarEvents, dismissedEventIds]
  )
  const todayEvents = useMemo(
    () => visibleEvents.filter((event) => isSameDay(event.startTime, now)),
    [visibleEvents, now]
  )
  const weekEvents = useMemo(
    () => visibleEvents
      .filter((event) => isWithinWeek(event.startTime, now) && !isSameDay(event.startTime, now))
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [visibleEvents, now]
  )
  const weekBuckets = useMemo(() => {
    const counts = new Map<string, number>()
    weekEvents.forEach((event) => {
      const key = weekdayLabel(event.startTime)
      counts.set(key, (counts.get(key) || 0) + 1)
    })
    return [...counts.entries()].map(([day, count]) => ({ day, count }))
  }, [weekEvents])

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.invoke<DashboardData>(IPC_CHANNELS.DASHBOARD_GET)
      setData(result)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCalendarContext = useCallback(async (events: CalendarEvent[]) => {
    if (events.length === 0) {
      setCalendarContext({})
      return
    }
    try {
      const result = await window.api.invoke<DashboardCalendarCompanyContext[]>(
        IPC_CHANNELS.DASHBOARD_ENRICH_CALENDAR,
        events.map((event) => ({ id: event.id, attendeeEmails: event.attendeeEmails }))
      )
      const next: Record<string, DashboardCalendarCompanyContext> = {}
      result.forEach((item) => {
        next[item.eventId] = item
      })
      setCalendarContext(next)
    } catch {
      setCalendarContext({})
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    if (!calendarConnected) {
      setCalendarContext({})
      return
    }
    void loadCalendarContext(visibleEvents)
  }, [calendarConnected, loadCalendarContext, visibleEvents])

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

  const handlePrep = useCallback(async (event: CalendarEvent) => {
    const context = calendarContext[event.id]
    if (context?.companyId) {
      navigate(`/company/${context.companyId}`)
      return
    }
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
  }, [calendarContext, navigate])

  const handleQuickNote = useCallback(async () => {
    try {
      const meeting = await window.api.invoke<Meeting>(IPC_CHANNELS.MEETING_CREATE)
      navigate(`/meeting/${meeting.id}`)
    } catch (err) {
      setError(String(err))
    }
  }, [navigate])

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
      <div className={styles.headerRow}>
        <h1 className={styles.title}>Dashboard</h1>
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
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Today&apos;s Schedule</h2>
        {!calendarConnected && (
          <p className={styles.empty}>Connect Google Calendar in Settings to see meeting schedule.</p>
        )}
        {calendarConnected && todayEvents.length === 0 && (
          <p className={styles.empty}>No meetings scheduled for today.</p>
        )}
        <div className={styles.eventList}>
          {todayEvents.map((event) => {
            const context = calendarContext[event.id]
            return (
              <div className={styles.eventCard} key={event.id}>
                <div className={styles.eventMain}>
                  <div className={styles.eventTitleRow}>
                    <span className={styles.eventTime}>
                      {new Date(event.startTime).toLocaleTimeString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </span>
                    <span className={styles.eventTitle}>{event.title}</span>
                  </div>
                  <div className={styles.eventMeta}>
                    {context
                      ? [
                          context.companyName,
                          context.entityType,
                          context.activeDealStage ? `Stage: ${context.activeDealStage}` : null,
                          `${context.meetingCount} meetings`,
                          formatRelativeTime(context.lastTouchpoint)
                        ].filter(Boolean).join(' · ')
                      : 'No linked company context yet'}
                  </div>
                </div>
                <div className={styles.eventActions}>
                  <button className={styles.secondaryButton} onClick={() => void handlePrep(event)}>
                    Prep
                  </button>
                  <button className={styles.primaryButton} onClick={() => void handleRecord(event)}>
                    Record
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        {weekBuckets.length > 0 && (
          <div className={styles.weekSummary}>
            {weekBuckets.map((bucket) => (
              <span key={bucket.day}>
                {bucket.day}: {bucket.count} meeting{bucket.count === 1 ? '' : 's'}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className={styles.grid}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Pipeline Summary</h2>
          <div className={styles.summaryList}>
            {(data?.pipelineSummary || []).map((stage) => (
              <button
                key={stage.stageId}
                className={styles.summaryRow}
                onClick={() => navigate('/pipeline')}
              >
                <span>{stage.label}</span>
                <strong>{stage.count}</strong>
              </button>
            ))}
            {data && data.pipelineSummary.length === 0 && (
              <p className={styles.empty}>No deals yet. Create one from Pipeline.</p>
            )}
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Recent Activity</h2>
          <div className={styles.activityList}>
            {(data?.recentActivity || []).slice(0, 12).map((item) => (
              <button
                key={item.id}
                className={styles.activityRow}
                onClick={() => openActivity(item)}
              >
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
        </section>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Needs Attention</h2>
        <div className={styles.attentionGrid}>
          <div>
            <h3 className={styles.subTitle}>Stale Relationships</h3>
            {(data?.needsAttention.staleCompanies || []).slice(0, 8).map((company) => (
              <button
                key={company.companyId}
                className={styles.attentionRow}
                onClick={() => openAttentionCompany(company.companyId)}
              >
                <span>{company.companyName}</span>
                <span>{company.daysSinceTouch}d</span>
              </button>
            ))}
            {data && data.needsAttention.staleCompanies.length === 0 && (
              <p className={styles.empty}>No stale companies.</p>
            )}
          </div>
          <div>
            <h3 className={styles.subTitle}>Stuck Deals</h3>
            {(data?.needsAttention.stuckDeals || []).slice(0, 8).map((deal) => (
              <button
                key={deal.dealId}
                className={styles.attentionRow}
                onClick={() => openAttentionCompany(deal.companyId)}
              >
                <span>{deal.companyName} · {deal.stageLabel}</span>
                <span>{deal.stageDurationDays}d</span>
              </button>
            ))}
            {data && data.needsAttention.stuckDeals.length === 0 && (
              <p className={styles.empty}>No stuck deals.</p>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
