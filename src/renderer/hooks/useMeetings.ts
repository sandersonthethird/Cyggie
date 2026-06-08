import { useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { Meeting, MeetingBucket, MeetingListFilter, MeetingStatus } from '../../shared/types/meeting'
import type { CompanyEntityType, CompanyPipelineStage } from '../../shared/types/company'
import type { CalendarEvent } from '../../shared/types/calendar'
import { api } from '../api'
import { ipcCache } from '../api/ipcCache'
import { useRemoteApply } from '../api/useRemoteApply'

// ── Helpers (exported for testing) ──────────────────────────────────────────

export function classifyBucket(meeting: Meeting, now: Date): Exclude<MeetingBucket, 'all'> {
  const meetingDate = new Date(meeting.date)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const in7Days = new Date(today)
  in7Days.setDate(in7Days.getDate() + 7)

  const meetingDay = new Date(meetingDate.getFullYear(), meetingDate.getMonth(), meetingDate.getDate())

  if (meetingDay.getTime() === today.getTime()) return 'today'
  if (meetingDay >= tomorrow && meetingDay < in7Days) return 'upcoming'
  if (meetingDay < today) return 'past'
  // Future beyond 7 days — treat as upcoming
  return 'upcoming'
}

export function isUnreviewed(meeting: Meeting, now: Date): boolean {
  if (meeting.status === 'summarized') return false
  // Future 'scheduled' = hasn't happened yet, not "unreviewed". Past 'scheduled'
  // = notified-but-not-recorded; user may want to add notes after the fact.
  if (meeting.status === 'scheduled' && new Date(meeting.date) > now) return false
  return true
}

export function isLive(meeting: Meeting, now: Date): boolean {
  const start = new Date(meeting.date).getTime()
  if (!meeting.durationSeconds) return false
  const end = start + meeting.durationSeconds * 1000
  const nowMs = now.getTime()
  return nowMs >= start && nowMs < end
}

export function calendarEventToMeeting(event: CalendarEvent): Meeting {
  const startMs = new Date(event.startTime).getTime()
  const endMs = new Date(event.endTime).getTime()
  const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000)) || null

  return {
    id: `cal-${event.id}`,
    title: event.title,
    date: event.startTime,
    durationSeconds,
    calendarEventId: event.id,
    meetingPlatform: event.platform,
    meetingUrl: event.meetingUrl,
    transcriptPath: null,
    summaryPath: null,
    summary: null,
    recordingPath: null,
    transcriptDriveId: null,
    summaryDriveId: null,
    notes: null,
    transcriptSegments: null,
    templateId: null,
    speakerCount: 0,
    speakerMap: {},
    speakerContactMap: {},
    attendees: event.attendees,
    attendeeEmails: event.attendeeEmails,
    selfName: null,
    transcriptProvider: null,
    meSpeakerIndex: null,
    companies: null,
    dismissedCompanies: null,
    chatMessages: null,
    status: 'scheduled',
    isGroupEvent: false,
    isGroupEventUserSet: false,
    createdAt: event.startTime,
    updatedAt: event.startTime,
    company: null,
  }
}

/** Sort day groups: today → tomorrow → future days (ascending) → past days (most recent first) */
export function sortDayGroups(groups: [string, Meeting[]][], now: Date): [string, Meeting[]][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return [...groups].sort((a, b) => {
    const dateA = new Date(a[1][0].date)
    const dateB = new Date(b[1][0].date)
    const dayA = new Date(dateA.getFullYear(), dateA.getMonth(), dateA.getDate())
    const dayB = new Date(dateB.getFullYear(), dateB.getMonth(), dateB.getDate())
    const isPastA = dayA < today
    const isPastB = dayB < today

    // Future/today before past
    if (!isPastA && isPastB) return -1
    if (isPastA && !isPastB) return 1
    // Within future: ascending (today first, then tomorrow, etc.)
    if (!isPastA && !isPastB) return dayA.getTime() - dayB.getTime()
    // Within past: descending (most recent first)
    return dayB.getTime() - dayA.getTime()
  })
}

export function groupByDate(meetings: Meeting[]): [string, Meeting[]][] {
  const groups = new Map<string, Meeting[]>()
  for (const m of meetings) {
    const d = new Date(m.date)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const group = groups.get(key)
    if (group) group.push(m)
    else groups.set(key, [m])
  }
  // Sort meetings within each day ascending by time
  for (const [, items] of groups) {
    items.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  }
  return Array.from(groups.entries())
}

export function matchesSearch(meeting: Meeting, query: string): boolean {
  const q = query.toLowerCase()
  if (meeting.title.toLowerCase().includes(q)) return true
  if (meeting.company?.name.toLowerCase().includes(q)) return true
  if (meeting.attendees?.some(a => a.toLowerCase().includes(q))) return true
  if (meeting.companies?.some(c => c.toLowerCase().includes(q))) return true
  const speakers = Object.values(meeting.speakerMap)
  if (speakers.some(s => s.toLowerCase().includes(q))) return true
  return false
}

// ── Counts ──────────────────────────────────────────────────────────────────

export interface MeetingCounts {
  all: number
  today: number
  upcoming: number
  past: number
  unreviewed: number
  byStage: Partial<Record<CompanyPipelineStage, number>>
}

export function computeCounts(meetings: Meeting[], now: Date): MeetingCounts {
  const counts: MeetingCounts = {
    all: meetings.length,
    today: 0,
    upcoming: 0,
    past: 0,
    unreviewed: 0,
    byStage: {},
  }

  for (const m of meetings) {
    const bucket = classifyBucket(m, now)
    counts[bucket]++
    if (isUnreviewed(m, now)) counts.unreviewed++
    if (m.company?.stage) {
      counts.byStage[m.company.stage] = (counts.byStage[m.company.stage] ?? 0) + 1
    }
  }
  return counts
}

// ── Hook ────────────────────────────────────────────────────────────────────

interface UseMeetingsOptions {
  bucket?: MeetingBucket
  stage?: CompanyPipelineStage
  searchQuery?: string
  dateFrom?: string
  dateTo?: string
  entityTypes?: Set<CompanyEntityType>
  statuses?: Set<MeetingStatus>
}

export function useMeetings(options?: UseMeetingsOptions) {
  const meetings = useAppStore((s) => s.meetings)
  const setMeetings = useAppStore((s) => s.setMeetings)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)

  const fetchMeetings = useCallback(
    async (filter?: MeetingListFilter) => {
      const result = await ipcCache.get<Meeting[]>(
        IPC_CHANNELS.MEETING_LIST,
        filter ?? null,
        () => api.invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, filter),
      )
      setMeetings(result)
    },
    [setMeetings]
  )

  const deleteMeeting = useCallback(
    async (id: string) => {
      await api.invoke(IPC_CHANNELS.MEETING_DELETE, id)
      await fetchMeetings()
    },
    [fetchMeetings]
  )

  useEffect(() => {
    fetchMeetings()
  }, [fetchMeetings])

  // 2026-05-24 — refetch when sync-pull applies remote changes. Without
  // this, mobile-created/updated meetings don't appear on the desktop
  // list until the 30s ipcCache TTL expires.
  useRemoteApply(IPC_CHANNELS.MEETINGS_REMOTE_APPLIED, () => {
    void fetchMeetings()
  })

  // Merge calendar events as synthetic meetings (dedup by calendarEventId)
  const allMeetings = useMemo(() => {
    if (!calendarConnected || !calendarEvents.length) return meetings

    const existingCalendarIds = new Set(
      meetings.filter(m => m.calendarEventId).map(m => m.calendarEventId!)
    )
    const syntheticMeetings = calendarEvents
      .filter(e => !existingCalendarIds.has(e.id))
      .map(calendarEventToMeeting)

    return [...meetings, ...syntheticMeetings]
  }, [meetings, calendarEvents, calendarConnected])

  // Compute counts from all meetings (before filtering)
  const now = useMemo(() => new Date(), []) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => computeCounts(allMeetings, now), [allMeetings, now])

  // Apply filters
  const filtered = useMemo(() => {
    let result = allMeetings
    const bucket = options?.bucket
    const stage = options?.stage
    const search = options?.searchQuery?.trim()
    const dateFrom = options?.dateFrom
    const dateTo = options?.dateTo
    const entityTypes = options?.entityTypes
    const statuses = options?.statuses

    if (bucket && bucket !== 'all') {
      if (bucket === 'unreviewed') {
        result = result.filter(m => isUnreviewed(m, now))
      } else {
        result = result.filter(m => classifyBucket(m, now) === bucket)
      }
    }

    if (stage) {
      result = result.filter(m => m.company?.stage === stage)
    }

    if (dateFrom) {
      result = result.filter(m => m.date >= dateFrom)
    }

    if (dateTo) {
      // Add a day so dateTo is inclusive (meeting at 2026-04-23T14:00 matches dateTo=2026-04-23)
      const dateToEnd = dateTo + 'T23:59:59'
      result = result.filter(m => m.date <= dateToEnd)
    }

    if (entityTypes && entityTypes.size > 0) {
      result = result.filter(m => m.company?.entityType != null && entityTypes.has(m.company.entityType))
    }

    if (statuses && statuses.size > 0) {
      result = result.filter(m => statuses.has(m.status))
    }

    if (search) {
      result = result.filter(m => matchesSearch(m, search))
    }

    return result
  }, [allMeetings, options?.bucket, options?.stage, options?.searchQuery, options?.dateFrom, options?.dateTo, options?.entityTypes, options?.statuses, now])

  // Group by date and sort day groups
  const groupedMeetings = useMemo(() => {
    const groups = groupByDate(filtered)
    return sortDayGroups(groups, now)
  }, [filtered, now])

  return {
    meetings: allMeetings,
    filtered,
    groupedMeetings,
    counts,
    fetchMeetings,
    deleteMeeting,
  }
}
