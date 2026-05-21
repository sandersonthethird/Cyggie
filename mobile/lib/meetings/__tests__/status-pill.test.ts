// Unit tests for `decideStatusPill` — pure mapping from meeting.status
// string to the badge shape used by MeetingStatusPill. Verifies that the
// three "interesting" statuses get rendered as pills (with the right
// tone) and that everything else returns null (no pill).

import { describe, expect, it } from 'vitest'
import { decideStatusPill } from '../status-pill'

describe('decideStatusPill', () => {
  it('maps transcribing → info pill', () => {
    expect(decideStatusPill('transcribing')).toEqual({
      label: 'Transcribing…',
      tone: 'info',
    })
  })

  it("maps the server's brief 'recording' window to the same Transcribing… pill", () => {
    // calendar-list rendering can catch a meeting in the brief
    // upload-landed-but-not-yet-submitted-to-deepgram state. From the
    // user's POV that's still 'we have it, processing' — same pill.
    expect(decideStatusPill('recording')).toEqual({
      label: 'Transcribing…',
      tone: 'info',
    })
  })

  it('maps empty → warning pill', () => {
    expect(decideStatusPill('empty')).toEqual({
      label: 'No speech',
      tone: 'warning',
    })
  })

  it('maps error → error pill', () => {
    expect(decideStatusPill('error')).toEqual({
      label: 'Failed',
      tone: 'error',
    })
  })

  it.each(['transcribed', 'idle', 'done', 'unknown-status', ''])(
    'returns null (no pill) for status=%j',
    (status) => {
      expect(decideStatusPill(status)).toBeNull()
    },
  )

  it.each([null, undefined])('returns null for nullish status=%j', (status) => {
    expect(decideStatusPill(status)).toBeNull()
  })
})
