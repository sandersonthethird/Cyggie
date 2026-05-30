import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../shared/types/recording'
import {
  type LoudnessSample,
  findMeSpeakerByName,
  resolveMeSpeakerIndex,
} from '../shared/transcript/me-them-resolver'

function seg(speaker: number, startTime: number, endTime: number): TranscriptSegment {
  return { speaker, text: '', startTime, endTime, isFinal: true }
}

function loud(tStart: number, tEnd: number, micDb: number, sysDb: number): LoudnessSample {
  return { tStart, tEnd, micDb, sysDb }
}

describe('resolveMeSpeakerIndex', () => {
  it('multichannel mode always returns 0', () => {
    const segments = [seg(0, 0, 1), seg(1, 1, 2), seg(2, 2, 3)]
    expect(resolveMeSpeakerIndex({ segments, loudness: null, channelMode: 'multichannel' })).toBe(0)
  })

  it('returns null on empty segments', () => {
    expect(resolveMeSpeakerIndex({ segments: [], loudness: null, channelMode: 'mono' })).toBeNull()
  })

  it('mono+loudness: picks speaker with highest mic-dominance', () => {
    // Speaker 0 talks 0-1s with mic energy >> sys (mic-dominant).
    // Speaker 1 talks 1-2s with sys energy >> mic (sys-dominant — remote voice).
    const segments = [seg(0, 0, 1), seg(1, 1, 2)]
    const loudness = [loud(0, 1, -20, -50), loud(1, 2, -50, -20)]
    expect(resolveMeSpeakerIndex({ segments, loudness, channelMode: 'mono' })).toBe(0)
  })

  it('mono+loudness: returns the loudness winner even when other speaker talks more', () => {
    // Speaker 1 talks more total seconds but is sys-dominant; speaker 0 is mic-dominant.
    const segments = [seg(0, 0, 1), seg(1, 1, 5)]
    const loudness = [loud(0, 1, -10, -60), loud(1, 5, -60, -10)]
    expect(resolveMeSpeakerIndex({ segments, loudness, channelMode: 'mono' })).toBe(0)
  })

  it('mono+loudness: ambiguous (within 1 dB) falls through to most-talkative', () => {
    // Both speakers show ~identical mic/sys dominance.
    const segments = [seg(0, 0, 1), seg(1, 1, 5)]
    const loudness = [loud(0, 1, -20, -20), loud(1, 5, -20, -20.5)]
    expect(resolveMeSpeakerIndex({ segments, loudness, channelMode: 'mono' })).toBe(1)
  })

  it('mono-only fallback: most-talkative wins', () => {
    const segments = [seg(0, 0, 1), seg(1, 1, 5)]
    expect(resolveMeSpeakerIndex({ segments, loudness: null, channelMode: 'mono' })).toBe(1)
  })

  it('mono-only fallback: ties broken by lowest index', () => {
    const segments = [seg(0, 0, 2), seg(1, 2, 4), seg(2, 4, 6)]
    expect(resolveMeSpeakerIndex({ segments, loudness: null, channelMode: 'mono' })).toBe(0)
  })

  it('mono+loudness: missing loudness coverage falls through to most-talkative', () => {
    // Loudness samples don't cover any segment time range.
    const segments = [seg(0, 10, 11), seg(1, 11, 15)]
    const loudness = [loud(0, 1, -20, -50)]
    expect(resolveMeSpeakerIndex({ segments, loudness, channelMode: 'mono' })).toBe(1)
  })
})

describe('findMeSpeakerByName', () => {
  it('matches single-token selfName against single-token label', () => {
    expect(findMeSpeakerByName({ 0: 'Sandy', 1: 'Ricardo' }, 'Sandy')).toBe(0)
  })

  it('matches single-token selfName against multi-token label (token-set subset)', () => {
    expect(findMeSpeakerByName({ 0: 'Sandy Cass', 1: 'Ricardo' }, 'Sandy')).toBe(0)
  })

  it('multi-token selfName requires ALL tokens present in label tokens', () => {
    // "Cass" not present in any label → null.
    expect(findMeSpeakerByName({ 0: 'Sandy', 1: 'Ricardo' }, 'Sandy Cass')).toBeNull()
  })

  it('regression guard: "Sandy" does NOT match a speaker labelled "Andy"', () => {
    expect(findMeSpeakerByName({ 0: 'Andy', 1: 'Sandy' }, 'Sandy')).toBe(1)
  })

  it('email-form label does not produce a name token match', () => {
    expect(findMeSpeakerByName({ 0: 'sandy.cass@gmail.com', 1: 'Ricardo' }, 'Sandy')).toBeNull()
  })

  it('null calendarSelfName returns null', () => {
    expect(findMeSpeakerByName({ 0: 'Sandy', 1: 'Ricardo' }, null)).toBeNull()
  })

  it('empty speakerMap returns null', () => {
    expect(findMeSpeakerByName({}, 'Sandy')).toBeNull()
  })

  it('ambiguous match (multiple speakers match) returns null', () => {
    // Both labels contain "sandy" token; resolver should refuse to guess.
    expect(findMeSpeakerByName({ 0: 'Sandy', 1: 'Sandy Cass' }, 'Sandy')).toBeNull()
  })

  it('case-insensitive', () => {
    expect(findMeSpeakerByName({ 0: 'SANDY', 1: 'Ricardo' }, 'sandy')).toBe(0)
  })
})
