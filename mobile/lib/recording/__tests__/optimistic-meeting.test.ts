import { describe, expect, it } from 'vitest'
import { buildOptimisticMeeting, generateClientMeetingId } from '../optimistic-meeting'

describe('generateClientMeetingId', () => {
  it('produces a gateway-valid id (^[a-z0-9]{1,32}$)', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateClientMeetingId()
      expect(id).toMatch(/^[a-z0-9]{1,32}$/)
    }
  })

  it('is highly unlikely to collide across rapid calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(generateClientMeetingId())
    expect(ids.size).toBe(1000)
  })
})

describe('buildOptimisticMeeting', () => {
  it('builds a recording/impromptu MeetingDetail with empty content', () => {
    const m = buildOptimisticMeeting({ id: 'abc123', title: 'Impromptu' })
    expect(m.id).toBe('abc123')
    expect(m.title).toBe('Impromptu')
    expect(m.status).toBe('recording')
    expect(m.wasImpromptu).toBe(true)
    expect(m.lamport).toBe('0')
    expect(m.notes).toBeNull()
    expect(m.calendarEventId).toBeNull()
    expect(m.transcriptSegments).toEqual([])
    expect(m.linkedCompanies).toEqual([])
    expect(m.attendeeContacts).toEqual([])
    expect(m.hasTranscript).toBe(false)
  })

  it('honors a provided date', () => {
    const m = buildOptimisticMeeting({ id: 'x', title: 't', date: '2026-06-15T10:00:00.000Z' })
    expect(m.date).toBe('2026-06-15T10:00:00.000Z')
  })
})
