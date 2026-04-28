import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Meeting } from '../shared/types/meeting'
import type { CalendarEvent } from '../shared/types/calendar'
import {
  classifyBucket,
  isUnreviewed,
  isLive,
  calendarEventToMeeting,
  groupByDate,
  sortDayGroups,
  matchesSearch,
  computeCounts,
} from '../renderer/hooks/useMeetings'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMeeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: 'test-1',
    title: 'Test Meeting',
    date: '2026-04-20T10:00:00Z',
    durationSeconds: 1800, // 30 min
    calendarEventId: null,
    meetingPlatform: null,
    meetingUrl: null,
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
    attendees: null,
    attendeeEmails: null,
    companies: null,
    chatMessages: null,
    status: 'summarized',
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T10:00:00Z',
    company: null,
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('classifyBucket', () => {
  it('classifies meeting on the same day as "today"', () => {
    const now = new Date('2026-04-20T14:00:00Z')
    const m = makeMeeting({ date: '2026-04-20T09:00:00Z' })
    expect(classifyBucket(m, now)).toBe('today')
  })

  it('classifies meeting tomorrow as "upcoming"', () => {
    const now = new Date('2026-04-20T14:00:00Z')
    const m = makeMeeting({ date: '2026-04-21T09:00:00Z' })
    expect(classifyBucket(m, now)).toBe('upcoming')
  })

  it('classifies meeting 6 days from now as "upcoming"', () => {
    const now = new Date('2026-04-20T14:00:00Z')
    const m = makeMeeting({ date: '2026-04-26T09:00:00Z' })
    expect(classifyBucket(m, now)).toBe('upcoming')
  })

  it('classifies meeting yesterday as "past"', () => {
    const now = new Date('2026-04-20T14:00:00Z')
    const m = makeMeeting({ date: '2026-04-19T09:00:00Z' })
    expect(classifyBucket(m, now)).toBe('past')
  })
})

describe('isUnreviewed', () => {
  it('returns false for summarized meetings', () => {
    expect(isUnreviewed(makeMeeting({ status: 'summarized' }))).toBe(false)
  })

  it('returns false for scheduled meetings', () => {
    expect(isUnreviewed(makeMeeting({ status: 'scheduled' }))).toBe(false)
  })

  it('returns true for transcribed meetings', () => {
    expect(isUnreviewed(makeMeeting({ status: 'transcribed' }))).toBe(true)
  })

  it('returns true for recording meetings', () => {
    expect(isUnreviewed(makeMeeting({ status: 'recording' }))).toBe(true)
  })
})

describe('isLive', () => {
  const now = new Date('2026-04-20T10:15:00Z')

  it('returns true during meeting', () => {
    const m = makeMeeting({ date: '2026-04-20T10:00:00Z', durationSeconds: 1800 })
    expect(isLive(m, now)).toBe(true)
  })

  it('returns true at exact start', () => {
    const m = makeMeeting({ date: '2026-04-20T10:15:00Z', durationSeconds: 1800 })
    expect(isLive(m, now)).toBe(true)
  })

  it('returns false at exact end', () => {
    const start = new Date(now.getTime() - 1800 * 1000).toISOString()
    const m = makeMeeting({ date: start, durationSeconds: 1800 })
    expect(isLive(m, now)).toBe(false)
  })

  it('returns false before meeting', () => {
    const m = makeMeeting({ date: '2026-04-20T11:00:00Z', durationSeconds: 1800 })
    expect(isLive(m, now)).toBe(false)
  })

  it('returns false after meeting', () => {
    const m = makeMeeting({ date: '2026-04-20T08:00:00Z', durationSeconds: 1800 })
    expect(isLive(m, now)).toBe(false)
  })

  it('returns false when durationSeconds is null', () => {
    const m = makeMeeting({ date: '2026-04-20T10:00:00Z', durationSeconds: null })
    expect(isLive(m, now)).toBe(false)
  })
})

describe('calendarEventToMeeting', () => {
  it('converts CalendarEvent to Meeting shape', () => {
    const event: CalendarEvent = {
      id: 'cal-123',
      title: 'Weekly Standup',
      startTime: '2026-04-21T10:00:00Z',
      endTime: '2026-04-21T10:30:00Z',
      selfName: 'Sandy',
      attendees: ['Alice', 'Bob'],
      attendeeEmails: ['alice@example.com', 'bob@example.com'],
      meetingUrl: 'https://zoom.us/123',
      platform: null,
      description: null,
    }

    const m = calendarEventToMeeting(event)
    expect(m.id).toBe('cal-cal-123')
    expect(m.title).toBe('Weekly Standup')
    expect(m.date).toBe('2026-04-21T10:00:00Z')
    expect(m.durationSeconds).toBe(1800)
    expect(m.calendarEventId).toBe('cal-123')
    expect(m.status).toBe('scheduled')
    expect(m.attendees).toEqual(['Alice', 'Bob'])
    expect(m.recordingPath).toBeNull()
    expect(m.summaryPath).toBeNull()
    expect(m.company).toBeNull()
  })
})

describe('groupByDate + sortDayGroups', () => {
  it('groups meetings by date and sorts today → future → past', () => {
    const now = new Date('2026-04-20T14:00:00Z')

    const meetings = [
      makeMeeting({ id: 'past', date: '2026-04-18T10:00:00Z' }),
      makeMeeting({ id: 'today', date: '2026-04-20T10:00:00Z' }),
      makeMeeting({ id: 'tomorrow', date: '2026-04-21T10:00:00Z' }),
      makeMeeting({ id: 'past2', date: '2026-04-17T10:00:00Z' }),
    ]

    const groups = groupByDate(meetings)
    const sorted = sortDayGroups(groups, now)
    const order = sorted.map(([, items]) => items[0].id)

    expect(order).toEqual(['today', 'tomorrow', 'past', 'past2'])
  })

  it('sorts meetings within a day ascending by time', () => {
    const meetings = [
      makeMeeting({ id: 'late', date: '2026-04-20T15:00:00Z' }),
      makeMeeting({ id: 'early', date: '2026-04-20T09:00:00Z' }),
      makeMeeting({ id: 'mid', date: '2026-04-20T12:00:00Z' }),
    ]

    const groups = groupByDate(meetings)
    const dayMeetings = groups[0][1]
    expect(dayMeetings.map(m => m.id)).toEqual(['early', 'mid', 'late'])
  })
})

describe('matchesSearch', () => {
  it('matches on title', () => {
    const m = makeMeeting({ title: 'Intro call with Acme Corp' })
    expect(matchesSearch(m, 'acme')).toBe(true)
  })

  it('matches on company name', () => {
    const m = makeMeeting({ company: { id: '1', name: 'Acme Corp', domain: null, stage: null, entityType: null } })
    expect(matchesSearch(m, 'acme')).toBe(true)
  })

  it('matches on attendee name', () => {
    const m = makeMeeting({ attendees: ['Alice Johnson', 'Bob Smith'] })
    expect(matchesSearch(m, 'alice')).toBe(true)
  })

  it('does not crash on regex special characters', () => {
    const m = makeMeeting({ title: 'Regular meeting' })
    expect(() => matchesSearch(m, '[test(')).not.toThrow()
    expect(matchesSearch(m, '[test(')).toBe(false)
  })

  it('returns false for non-matching query', () => {
    const m = makeMeeting({ title: 'Team standup' })
    expect(matchesSearch(m, 'xyz')).toBe(false)
  })
})

describe('computeCounts', () => {
  it('computes bucket and stage counts correctly', () => {
    const now = new Date('2026-04-20T14:00:00Z')
    const meetings = [
      makeMeeting({ id: '1', date: '2026-04-20T10:00:00Z', status: 'summarized', company: { id: 'c1', name: 'A', domain: null, stage: 'screening', entityType: null } }),
      makeMeeting({ id: '2', date: '2026-04-20T11:00:00Z', status: 'transcribed', company: { id: 'c2', name: 'B', domain: null, stage: 'screening', entityType: null } }),
      makeMeeting({ id: '3', date: '2026-04-19T10:00:00Z', status: 'summarized', company: { id: 'c3', name: 'C', domain: null, stage: 'diligence', entityType: null } }),
      makeMeeting({ id: '4', date: '2026-04-21T10:00:00Z', status: 'scheduled' }),
    ]

    const counts = computeCounts(meetings, now)
    expect(counts.all).toBe(4)
    expect(counts.today).toBe(2)
    expect(counts.past).toBe(1)
    expect(counts.upcoming).toBe(1)
    expect(counts.unreviewed).toBe(1) // only transcribed
    expect(counts.byStage.screening).toBe(2)
    expect(counts.byStage.diligence).toBe(1)
  })
})
