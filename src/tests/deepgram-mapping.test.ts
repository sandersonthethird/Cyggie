// Characterization tests for the Deepgram utterance → TranscriptSegment
// mapping. Written before extracting the inline copy from
// api-gateway/src/recording/transcribe-job.ts so the refactor can be
// verified against this same suite.

import { describe, it, expect } from 'vitest'
import {
  mapDeepgramUtterancesToSegments,
  buildGenericSpeakerMap,
  type DeepgramBatchResult,
} from '@cyggie/services/recording/deepgram-mapping'

function makeBatchResult(utterances: unknown[]): DeepgramBatchResult {
  return {
    results: {
      channels: [],
      utterances: utterances as DeepgramBatchResult['results']['utterances'],
    },
  }
}

describe('mapDeepgramUtterancesToSegments', () => {
  it('maps a single utterance to the canonical segment shape', () => {
    const payload = makeBatchResult([
      {
        speaker: 0,
        transcript: 'Hello world',
        start: 0,
        end: 1.5,
        confidence: 0.99,
        channel: 0,
        words: [],
      },
    ])

    expect(mapDeepgramUtterancesToSegments(payload)).toEqual([
      {
        speaker: 0,
        text: 'Hello world',
        startTime: 0,
        endTime: 1.5,
        isFinal: true,
      },
    ])
  })

  it('returns empty array when utterances is missing', () => {
    const payload: DeepgramBatchResult = { results: { channels: [] } }
    expect(mapDeepgramUtterancesToSegments(payload)).toEqual([])
  })

  it('returns empty array when utterances is empty', () => {
    expect(mapDeepgramUtterancesToSegments(makeBatchResult([]))).toEqual([])
  })

  it('skips utterances missing speaker, transcript, start, or end', () => {
    const payload = makeBatchResult([
      { transcript: 'no speaker', start: 0, end: 1 },
      { speaker: 0, start: 0, end: 1 }, // no transcript
      { speaker: 0, transcript: 'no start', end: 1 },
      { speaker: 0, transcript: 'no end', start: 0 },
      { speaker: 1, transcript: 'good', start: 0, end: 1 },
    ])
    const out = mapDeepgramUtterancesToSegments(payload)
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('good')
  })

  it('preserves utterance ordering', () => {
    const payload = makeBatchResult([
      { speaker: 0, transcript: 'first', start: 0, end: 1 },
      { speaker: 1, transcript: 'second', start: 1, end: 2 },
      { speaker: 0, transcript: 'third', start: 2, end: 3 },
    ])
    expect(mapDeepgramUtterancesToSegments(payload).map((s) => s.text)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('always marks segments isFinal=true (batch results are final by definition)', () => {
    const payload = makeBatchResult([
      { speaker: 0, transcript: 'a', start: 0, end: 1 },
      { speaker: 1, transcript: 'b', start: 1, end: 2 },
    ])
    for (const seg of mapDeepgramUtterancesToSegments(payload)) {
      expect(seg.isFinal).toBe(true)
    }
  })

  it('handles non-zero start times and preserves them as-is', () => {
    const payload = makeBatchResult([
      { speaker: 2, transcript: 'mid-meeting', start: 423.7, end: 425.2 },
    ])
    const out = mapDeepgramUtterancesToSegments(payload)
    expect(out[0].startTime).toBe(423.7)
    expect(out[0].endTime).toBe(425.2)
  })
})

describe('buildGenericSpeakerMap', () => {
  it('returns empty map for no utterances', () => {
    expect(buildGenericSpeakerMap(makeBatchResult([]))).toEqual({})
  })

  it('labels speakers as Speaker 1, 2, 3 (1-indexed)', () => {
    const payload = makeBatchResult([
      { speaker: 0, transcript: 'a', start: 0, end: 1 },
      { speaker: 1, transcript: 'b', start: 1, end: 2 },
      { speaker: 2, transcript: 'c', start: 2, end: 3 },
    ])
    expect(buildGenericSpeakerMap(payload)).toEqual({
      0: 'Speaker 1',
      1: 'Speaker 2',
      2: 'Speaker 3',
    })
  })

  it('deduplicates repeated speakers', () => {
    const payload = makeBatchResult([
      { speaker: 0, transcript: 'a', start: 0, end: 1 },
      { speaker: 0, transcript: 'b', start: 1, end: 2 },
      { speaker: 1, transcript: 'c', start: 2, end: 3 },
      { speaker: 0, transcript: 'd', start: 3, end: 4 },
    ])
    expect(buildGenericSpeakerMap(payload)).toEqual({
      0: 'Speaker 1',
      1: 'Speaker 2',
    })
  })

  it('ignores utterances without a numeric speaker', () => {
    const payload = makeBatchResult([
      { transcript: 'no speaker', start: 0, end: 1 },
      { speaker: 0, transcript: 'a', start: 0, end: 1 },
    ])
    expect(buildGenericSpeakerMap(payload)).toEqual({ 0: 'Speaker 1' })
  })

  it('handles missing utterances field gracefully', () => {
    const payload: DeepgramBatchResult = { results: { channels: [] } }
    expect(buildGenericSpeakerMap(payload)).toEqual({})
  })
})
