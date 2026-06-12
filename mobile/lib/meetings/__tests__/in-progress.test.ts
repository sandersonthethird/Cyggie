import { describe, expect, it } from 'vitest'
import {
  MEETING_DETAIL_POLL_MS,
  isMeetingInProgress,
  meetingDetailRefetchInterval,
} from '../in-progress'

describe('isMeetingInProgress', () => {
  it('is true while recording / transcribing', () => {
    expect(isMeetingInProgress('recording')).toBe(true)
    expect(isMeetingInProgress('transcribing')).toBe(true)
  })

  it('is false for terminal / unknown statuses and nullish', () => {
    for (const s of ['transcribed', 'empty', 'error', 'summarized', 'scheduled']) {
      expect(isMeetingInProgress(s)).toBe(false)
    }
    expect(isMeetingInProgress(null)).toBe(false)
    expect(isMeetingInProgress(undefined)).toBe(false)
  })
})

describe('meetingDetailRefetchInterval', () => {
  it('polls every 10s while in-progress', () => {
    expect(meetingDetailRefetchInterval('recording')).toBe(MEETING_DETAIL_POLL_MS)
    expect(meetingDetailRefetchInterval('transcribing')).toBe(MEETING_DETAIL_POLL_MS)
  })

  it('stops polling (false) once terminal', () => {
    expect(meetingDetailRefetchInterval('transcribed')).toBe(false)
    expect(meetingDetailRefetchInterval('empty')).toBe(false)
    expect(meetingDetailRefetchInterval('error')).toBe(false)
    expect(meetingDetailRefetchInterval(undefined)).toBe(false)
  })
})
