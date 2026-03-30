import { describe, it, expect } from 'vitest'
import { resolveRecordingCalendarEventId } from '../main/ipc/recording.ipc'

const mockMeeting = { id: 'meeting-1' }

describe('resolveRecordingCalendarEventId', () => {
  it('returns calendarEventId when no prior meeting found', () => {
    expect(resolveRecordingCalendarEventId(null, false, 'cal-123')).toBe('cal-123')
  })

  it('returns null when recent prior meeting exists (prevents back-to-back duplicate)', () => {
    // e.g. SC/CT meeting already transcribed same day — new recording must not claim same ID
    expect(resolveRecordingCalendarEventId(mockMeeting, true, 'cal-123')).toBeNull()
  })

  it('returns calendarEventId when prior meeting is NOT recent (recurring event)', () => {
    // Old occurrence (>24h) of a recurring event — today's recording should link to today's event
    expect(resolveRecordingCalendarEventId(mockMeeting, false, 'cal-123')).toBe('cal-123')
  })

  it('returns null when calendarEventId is null regardless', () => {
    expect(resolveRecordingCalendarEventId(null, false, null)).toBeNull()
  })
})
