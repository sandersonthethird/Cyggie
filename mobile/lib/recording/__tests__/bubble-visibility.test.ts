import { describe, expect, it } from 'vitest'
import { shouldShowRecordingBubble } from '../bubble-visibility'

describe('shouldShowRecordingBubble', () => {
  const id = 'mtg123'

  it('shows while recording, with an active meeting, off that meeting view', () => {
    expect(
      shouldShowRecordingBubble({ status: 'recording', activeMeetingId: id, pathname: '/(tabs)/companies' }),
    ).toBe(true)
  })

  it('hides on the active meeting view (the in-view banner covers it)', () => {
    expect(
      shouldShowRecordingBubble({ status: 'recording', activeMeetingId: id, pathname: `/meetings/${id}` }),
    ).toBe(false)
  })

  it('hides when not recording (uploading/transcribing/idle) — vanishes on Stop', () => {
    for (const status of ['idle', 'uploading', 'transcribing', 'done', 'error']) {
      expect(
        shouldShowRecordingBubble({ status, activeMeetingId: id, pathname: '/(tabs)/calendar' }),
      ).toBe(false)
    }
  })

  it('hides when there is no active meeting', () => {
    expect(
      shouldShowRecordingBubble({ status: 'recording', activeMeetingId: null, pathname: '/(tabs)/calendar' }),
    ).toBe(false)
  })

  it('shows on a DIFFERENT meeting view', () => {
    expect(
      shouldShowRecordingBubble({ status: 'recording', activeMeetingId: id, pathname: '/meetings/other' }),
    ).toBe(true)
  })
})
