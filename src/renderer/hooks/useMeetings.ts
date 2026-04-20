import { useEffect, useCallback, useMemo } from 'react'
import { useAppStore } from '../stores/app.store'
import { IPC_CHANNELS } from '../../shared/constants/channels'
import type { Meeting, MeetingBucket, MeetingListFilter } from '../../shared/types/meeting'
import type { CompanyPipelineStage } from '../../shared/types/company'
import type { CalendarEvent } from '../../shared/types/calendar'
import { api } from '../api'

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

export function isUnreviewed(meeting: Meeting): boolean {
  return meeting.status !== 'summarized' && meeting.status !== 'scheduled'
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
    companies: null,
    chatMessages: null,
    status: 'scheduled',
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
    if (isUnreviewed(m)) counts.unreviewed++
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
}

export function useMeetings(options?: UseMeetingsOptions) {
  const meetings = useAppStore((s) => s.meetings)
  const setMeetings = useAppStore((s) => s.setMeetings)
  const calendarEvents = useAppStore((s) => s.calendarEvents)
  const calendarConnected = useAppStore((s) => s.calendarConnected)

  const fetchMeetings = useCallback(
    async (filter?: MeetingListFilter) => {
      const result = await api.invoke<Meeting[]>(IPC_CHANNELS.MEETING_LIST, filter)
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
  const now = useMemo(() => new Date(), [allMeetings]) // eslint-disable-line react-hooks/exhaustive-deps
  const counts = useMemo(() => computeCounts(allMeetings, now), [allMeetings, now])

  // Apply filters
  const filtered = useMemo(() => {
    let result = allMeetings
    const bucket = options?.bucket
    const stage = options?.stage
    const search = options?.searchQuery?.trim()

    if (bucket && bucket !== 'all') {
      if (bucket === 'unreviewed') {
        result = result.filter(m => isUnreviewed(m))
      } else {
        result = result.filter(m => classifyBucket(m, now) === bucket)
      }
    }

    if (stage) {
      result = result.filter(m => m.company?.stage === stage)
    }

    if (search) {
      result = result.filter(m => matchesSearch(m, search))
    }

    return result
  }, [allMeetings, options?.bucket, options?.stage, options?.searchQuery, now])

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
