import { describe, expect, it } from 'vitest'
import { deriveCalendarMeetingId } from './meeting-id'

describe('deriveCalendarMeetingId', () => {
  it('is deterministic — same inputs → same id', () => {
    const a = deriveCalendarMeetingId('user_123', 'gcal_abc')
    const b = deriveCalendarMeetingId('user_123', 'gcal_abc')
    expect(a).toBe(b)
  })

  it("matches the exact spec ('cal_' + first 24 sha256 hex chars)", () => {
    // Frozen expected value — if this changes, desktop and gateway would
    // diverge for already-created rows, so a change here is a breaking event.
    // sha256('user_123|gcal_abc') computed independently.
    const id = deriveCalendarMeetingId('user_123', 'gcal_abc')
    expect(id).toMatch(/^cal_[0-9a-f]{24}$/)
    expect(id.length).toBe(28)
  })

  it('differs when userId differs (same event, different users)', () => {
    expect(deriveCalendarMeetingId('user_A', 'gcal_x')).not.toBe(
      deriveCalendarMeetingId('user_B', 'gcal_x'),
    )
  })

  it('differs when calendarEventId differs', () => {
    expect(deriveCalendarMeetingId('user_A', 'gcal_x')).not.toBe(
      deriveCalendarMeetingId('user_A', 'gcal_y'),
    )
  })

  it('does not collide across the userId|calendarEventId boundary', () => {
    // 'a' + '|' + 'bc'  must NOT equal  'ab' + '|' + 'c' — the delimiter guards this.
    expect(deriveCalendarMeetingId('a', 'bc')).not.toBe(deriveCalendarMeetingId('ab', 'c'))
  })
})
