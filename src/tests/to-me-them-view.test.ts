import { describe, expect, it } from 'vitest'
import type { TranscriptSegment } from '../shared/types/recording'
import {
  buildTranscriptItems,
  formatBubbleTimestamp,
  resolveMeIndexForRender,
} from '../renderer/transcript/to-me-them-view'

function seg(speaker: number, text: string, startTime: number, endTime: number): TranscriptSegment {
  return { speaker, text, startTime, endTime, isFinal: true }
}

describe('resolveMeIndexForRender', () => {
  it('uses explicit meSpeakerIndex when present', () => {
    const out = resolveMeIndexForRender({
      segments: [seg(0, 'a', 0, 1), seg(1, 'b', 1, 2)],
      speakerMap: { 0: 'Sandy', 1: 'Ricardo' },
      meSpeakerIndex: 1,
      calendarSelfName: 'Sandy',
    })
    expect(out).toBe(1)
  })

  it('falls back to name match when meSpeakerIndex is null', () => {
    const out = resolveMeIndexForRender({
      segments: [seg(0, 'a', 0, 1), seg(1, 'b', 1, 2)],
      speakerMap: { 0: 'Andy', 1: 'Sandy' },
      meSpeakerIndex: null,
      calendarSelfName: 'Sandy',
    })
    expect(out).toBe(1)
  })

  it('falls back to most-talkative when neither explicit nor name match', () => {
    const out = resolveMeIndexForRender({
      segments: [seg(0, 'a', 0, 1), seg(1, 'b', 1, 5)],
      speakerMap: { 0: 'Speaker 1', 1: 'Speaker 2' },
      meSpeakerIndex: null,
      calendarSelfName: null,
    })
    expect(out).toBe(1)
  })

  it('returns null for empty segments', () => {
    const out = resolveMeIndexForRender({
      segments: [],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: 'Sandy',
    })
    expect(out).toBeNull()
  })
})

describe('buildTranscriptItems', () => {
  it('always emits a starting 00:00 timestamp', () => {
    const { items } = buildTranscriptItems({
      segments: [seg(0, 'hi', 0, 1)],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    expect(items[0]).toEqual({ kind: 'timestamp', key: 't-0', time: 0 })
  })

  it('merges adjacent same-speaker segments into one bubble', () => {
    const { items } = buildTranscriptItems({
      segments: [seg(0, 'hi', 0, 0.5), seg(0, 'there', 0.6, 1.0)],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const bubbles = items.filter((i) => i.kind === 'bubble')
    expect(bubbles).toHaveLength(1)
    expect(bubbles[0].segments).toHaveLength(2)
    expect(bubbles[0].side).toBe('me')
  })

  it('inserts a timestamp between bubbles when silence gap > 5s', () => {
    const { items } = buildTranscriptItems({
      segments: [seg(0, 'hi', 0, 1), seg(1, 'hello', 8, 9)],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const timestampTimes = items
      .filter((i): i is { kind: 'timestamp'; key: string; time: number } => i.kind === 'timestamp')
      .map((t) => t.time)
    expect(timestampTimes).toEqual([0, 8])
  })

  it('does NOT insert a timestamp between bubbles when gap <= 5s', () => {
    const { items } = buildTranscriptItems({
      segments: [seg(0, 'hi', 0, 1), seg(1, 'hello', 2, 3)],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const timestamps = items.filter((i) => i.kind === 'timestamp')
    expect(timestamps).toHaveLength(1) // only the 00:00 starter
  })

  it('inserts a timestamp every 2 minutes when no natural gap occurs', () => {
    const segs: TranscriptSegment[] = []
    for (let t = 0; t < 300; t += 3) {
      segs.push(seg(t % 2, 'word', t, t + 2))
    }
    const { items } = buildTranscriptItems({
      segments: segs,
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const timestamps = items.filter((i) => i.kind === 'timestamp')
    // Expect at least the 0 marker plus markers around the 120s and 240s
    // boundaries — exact count depends on which segment crosses the
    // boundary, but >= 3 is the structural guarantee.
    expect(timestamps.length).toBeGreaterThanOrEqual(3)
  })

  it('different speakers in a tight window produce separate bubbles, no timestamp', () => {
    const { items } = buildTranscriptItems({
      segments: [
        seg(0, 'hi', 0, 1),
        seg(1, 'oh hello', 1.2, 2.0),
        seg(0, 'good to see you', 2.1, 3.0),
      ],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const bubbles = items.filter((i) => i.kind === 'bubble')
    expect(bubbles).toHaveLength(3)
    expect(bubbles[0].side).toBe('me')
    expect(bubbles[1].side).toBe('them')
    expect(bubbles[2].side).toBe('me')
    const timestamps = items.filter((i) => i.kind === 'timestamp')
    expect(timestamps).toHaveLength(1) // only 00:00
  })

  it('collapses all non-me speakers (including phantoms) into the "them" side', () => {
    // Yesterday-Ricardo fixture: 3 raw speaker indices, but the bubble
    // view collapses indices 1 and 2 ("Ricardo" + a phantom "Speaker 3")
    // into a single visual stream on the left.
    const { items, meIndex } = buildTranscriptItems({
      segments: [
        seg(0, 'Hi Ricardo', 0, 1),
        seg(1, 'Hello', 1.5, 2),
        seg(2, 'phantom mumble', 2.3, 2.8),
        seg(1, 'so anyway', 3, 4),
      ],
      speakerMap: { 0: 'Sandy', 1: 'Ricardo', 2: 'Speaker 3' },
      meSpeakerIndex: null,
      calendarSelfName: 'Sandy',
    })
    expect(meIndex).toBe(0)
    const bubbles = items.filter((i) => i.kind === 'bubble') as Array<{
      side: 'me' | 'them'
      segments: TranscriptSegment[]
    }>
    // 1 me bubble, then a merged them bubble (segments from indices 1, 2, 1).
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].side).toBe('me')
    expect(bubbles[1].side).toBe('them')
    expect(bubbles[1].segments).toHaveLength(3)
  })

  it('out-of-order input is sorted by startTime before bubbling', () => {
    const { items } = buildTranscriptItems({
      segments: [seg(0, 'second', 5, 6), seg(1, 'first', 0, 1)],
      speakerMap: {},
      meSpeakerIndex: 0,
      calendarSelfName: null,
    })
    const bubbles = items.filter((i) => i.kind === 'bubble') as Array<{
      side: 'me' | 'them'
      startTime: number
    }>
    expect(bubbles[0].startTime).toBe(0)
    expect(bubbles[1].startTime).toBe(5)
  })
})

describe('formatBubbleTimestamp', () => {
  it('formats < 1 hour as mm:ss', () => {
    expect(formatBubbleTimestamp(0)).toBe('00:00')
    expect(formatBubbleTimestamp(65)).toBe('01:05')
    expect(formatBubbleTimestamp(120)).toBe('02:00')
  })

  it('formats >= 1 hour as h:mm:ss', () => {
    expect(formatBubbleTimestamp(3661)).toBe('1:01:01')
  })

  it('floors fractional seconds', () => {
    expect(formatBubbleTimestamp(59.9)).toBe('00:59')
  })
})
