import { describe, it, expect } from 'vitest'
import { formatChipLabel } from '../renderer/components/layout/TitlebarDateChip'
import type { CalendarEvent } from '../shared/types/calendar'

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: '1',
    title: 'Standup',
    startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // +1h
    endTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // +2h
    selfName: null,
    attendees: [],
    attendeeEmails: [],
    meetingUrl: null,
    platform: null,
    description: null,
    ...overrides
  }
}

describe('formatChipLabel', () => {
  const now = new Date('2026-04-20T14:00:00')

  it('returns empty state when no events', () => {
    const result = formatChipLabel(now, null, null)
    expect(result.state).toBe('empty')
    expect(result.dateLabel).toBe('Mon, Apr 20')
    expect(result.hasDot).toBe(false)
  })

  it('returns "now" state when currently in a meeting', () => {
    const current = makeEvent({
      title: 'Standup',
      startTime: '2026-04-20T13:30:00',
      endTime: '2026-04-20T14:30:00'
    })
    const result = formatChipLabel(now, null, current)
    expect(result.state).toBe('now')
    expect(result.nextLabel).toBe('Now')
    expect(result.nextTime).toBe('Standup')
    expect(result.hasDot).toBe(true)
  })

  it('current event takes priority over next event', () => {
    const current = makeEvent({
      title: 'Standup',
      startTime: '2026-04-20T13:30:00',
      endTime: '2026-04-20T14:30:00'
    })
    const next = makeEvent({
      title: 'Retro',
      startTime: '2026-04-20T15:00:00',
      endTime: '2026-04-20T16:00:00'
    })
    const result = formatChipLabel(now, next, current)
    expect(result.state).toBe('now')
    expect(result.nextTime).toBe('Standup')
  })

  it('truncates long current event titles at 14 chars', () => {
    const current = makeEvent({
      title: 'Very Long Meeting Title That Overflows',
      startTime: '2026-04-20T13:30:00',
      endTime: '2026-04-20T14:30:00'
    })
    const result = formatChipLabel(now, null, current)
    expect(result.state).toBe('now')
    expect(result.nextTime).toBe('Very Long Meet…')
  })

  it('returns "next" state with dot when event within 2 hours', () => {
    const next = makeEvent({
      title: 'Retro',
      startTime: '2026-04-20T15:00:00', // +1h from now
      endTime: '2026-04-20T16:00:00'
    })
    const result = formatChipLabel(now, next, null)
    expect(result.state).toBe('next')
    expect(result.nextLabel).toBe('NEXT')
    expect(result.hasDot).toBe(true)
  })

  it('returns "next" state without dot when event > 2 hours away', () => {
    const next = makeEvent({
      title: 'Late Meeting',
      startTime: '2026-04-20T19:00:00', // +5h from now
      endTime: '2026-04-20T20:00:00'
    })
    const result = formatChipLabel(now, next, null)
    expect(result.state).toBe('next')
    expect(result.nextLabel).toBe('NEXT')
    expect(result.hasDot).toBe(false)
  })

  it('returns empty state for invalid startTime', () => {
    const next = makeEvent({
      startTime: 'garbage-date'
    })
    const result = formatChipLabel(now, next, null)
    expect(result.state).toBe('empty')
    expect(result.hasDot).toBe(false)
  })
})
