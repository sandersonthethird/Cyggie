// Characterization tests for the speaker-map + proper-noun-correction
// helpers that get extracted from RecordingSession.ts:700-738. Written
// before refactoring the inline copy so we can verify the refactor
// preserves behavior.

import { describe, it, expect } from 'vitest'
import {
  buildSpeakerMap,
  correctTranscriptMarkdown,
} from '@cyggie/services/recording/normalize-segments'

describe('buildSpeakerMap', () => {
  describe('multichannel mode', () => {
    it('labels speaker 0 with calendarSelfName and 1+ with attendees in order', () => {
      const map = buildSpeakerMap([0, 1], {
        channelMode: 'multichannel',
        calendarSelfName: 'Sandy Cass',
        calendarAttendees: ['Alice Smith'],
      })
      expect(map).toEqual({ 0: 'Sandy Cass', 1: 'Alice Smith' })
    })

    it('falls back to "You" when calendarSelfName is null but attendees exist', () => {
      const map = buildSpeakerMap([0, 1], {
        channelMode: 'multichannel',
        calendarSelfName: null,
        calendarAttendees: ['Alice Smith'],
      })
      expect(map).toEqual({ 0: 'You', 1: 'Alice Smith' })
    })

    it('uses "Speaker N" for indices beyond the known names', () => {
      const map = buildSpeakerMap([0, 1, 2, 3], {
        channelMode: 'multichannel',
        calendarSelfName: 'Sandy Cass',
        calendarAttendees: ['Alice Smith'],
      })
      expect(map).toEqual({
        0: 'Sandy Cass',
        1: 'Alice Smith',
        2: 'Speaker 3',
        3: 'Speaker 4',
      })
    })

    it('uses "Speaker N" for all speakers when there is no calendar context', () => {
      const map = buildSpeakerMap([0, 1, 2], {
        channelMode: 'multichannel',
        calendarSelfName: null,
        calendarAttendees: [],
      })
      expect(map).toEqual({ 0: 'Speaker 1', 1: 'Speaker 2', 2: 'Speaker 3' })
    })
  })

  describe('diarization mode', () => {
    it('always uses "Speaker N" labels regardless of calendar context', () => {
      const map = buildSpeakerMap([0, 1, 2], {
        channelMode: 'diarization',
        calendarSelfName: 'Sandy Cass',
        calendarAttendees: ['Alice Smith', 'Bob Jones'],
      })
      expect(map).toEqual({ 0: 'Speaker 1', 1: 'Speaker 2', 2: 'Speaker 3' })
    })
  })

  describe('detecting mode', () => {
    it('treats detecting like diarization (generic labels)', () => {
      const map = buildSpeakerMap([0, 1], {
        channelMode: 'detecting',
        calendarSelfName: 'Sandy Cass',
        calendarAttendees: ['Alice Smith'],
      })
      expect(map).toEqual({ 0: 'Speaker 1', 1: 'Speaker 2' })
    })
  })

  it('returns empty map for no speakers', () => {
    const map = buildSpeakerMap([], {
      channelMode: 'multichannel',
      calendarSelfName: 'Sandy Cass',
      calendarAttendees: [],
    })
    expect(map).toEqual({})
  })

  it('handles non-sequential speaker IDs', () => {
    const map = buildSpeakerMap([0, 3], {
      channelMode: 'multichannel',
      calendarSelfName: 'Sandy Cass',
      calendarAttendees: ['Alice Smith'],
    })
    // Index 3 falls past the known-names array → generic label.
    expect(map).toEqual({ 0: 'Sandy Cass', 3: 'Speaker 4' })
  })
})

describe('correctTranscriptMarkdown', () => {
  it('returns input unchanged when crmNames is empty', () => {
    const md = '**Speaker 1** [00:00]\nHello world'
    expect(correctTranscriptMarkdown(md, [])).toBe(md)
  })

  it('does not modify speaker header lines (avoids mangling timestamps)', () => {
    // Use a single-word name that COULD match "Speaker" via fuzzy compare.
    // The header guard must prevent that.
    const md = '**Speaker 1** [00:00]'
    const result = correctTranscriptMarkdown(md, ['Speakr Industries'])
    expect(result).toBe(md)
  })

  it('leaves a single-word near-miss below the strict threshold unchanged', () => {
    // SINGLE_WORD_THRESHOLD is 0.97 (raised from 0.92 in c5b8cfe to cut false
    // positives). jaroWinkler('tobius','tobias') ≈ 0.933 < 0.97, so a one-letter
    // single-word misspelling is intentionally NOT auto-corrected.
    const md = 'Tobius confirmed the term sheet.'
    const result = correctTranscriptMarkdown(md, ['Tobias'])
    expect(result).toBe('Tobius confirmed the term sheet.')
  })

  it('handles multi-line transcripts, only correcting body lines', () => {
    const md = [
      '**Speaker 1** [00:00]',
      'We met with Redd Swan Ventures today.',
      '**Speaker 2** [00:05]',
      'Hello',
    ].join('\n')
    const result = correctTranscriptMarkdown(md, ['Red Swan Ventures'])
    const lines = result.split('\n')
    expect(lines[0]).toBe('**Speaker 1** [00:00]')
    expect(lines[1]).toBe('We met with Red Swan Ventures today.')
    expect(lines[2]).toBe('**Speaker 2** [00:05]')
    expect(lines[3]).toBe('Hello')
  })

  it('treats a line that starts with ** but lacks "** [" as a body line, not a header', () => {
    // The guard is specifically `startsWith('**') && includes('** [')` — both
    // conditions must hold. A line that opens with ** but is just emphasis
    // text (no bracketed timestamp) is treated as body content.
    // Use a multi-word correction (threshold 0.90) so the assertion exercises
    // the header-guard (body line gets corrected) independent of the strict
    // single-word threshold: 'Redd Swan Ventures' → 'Red Swan Ventures'.
    const md = '**bold note** Redd Swan Ventures spoke.'
    const result = correctTranscriptMarkdown(md, ['Red Swan Ventures'])
    expect(result).toContain('Red Swan Ventures')
  })

  it('returns input unchanged when input is empty', () => {
    expect(correctTranscriptMarkdown('', ['Sandy Cass'])).toBe('')
  })

  it('protects the user self-name from a similar CRM contact name (Sandy/Andy)', () => {
    // End-to-end: speaker header preserved verbatim, body line containing
    // "Sandy" stays as "Sandy" even though CRM has the colliding "Andy".
    // Mirrors the production crmNames assembly post-fix:
    //   contacts + companies + meeting.selfName + meeting.attendees
    const md = [
      '**Speaker 1** [00:00]',
      'Sandy raised the term sheet.',
    ].join('\n')
    const result = correctTranscriptMarkdown(md, ['Andy', 'Sandy Cass'])
    const lines = result.split('\n')
    expect(lines[0]).toBe('**Speaker 1** [00:00]')
    expect(lines[1]).toBe('Sandy raised the term sheet.')
  })
})
