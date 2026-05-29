// TranscriptAssembler tests post live-picker refactor (2026-05-28).
//
// Multichannel mode + auto-detection were removed when the live picker
// rolled out — the recording path now always sends mono audio, so the
// assembler only operates in diarization mode. Tests that asserted
// multichannel-specific behavior have been removed; the remaining tests
// cover the diarization-mode behavior that's now the only path.

import { describe, it, expect } from 'vitest'
import { TranscriptAssembler } from '@main/deepgram/transcript-assembler'
import type { NormalizedTranscriptResult, NormalizedWord } from '@main/transcription/types'

// Helpers ────────────────────────────────────────────────────────────────────

function word(
  text: string,
  start: number,
  end: number,
  speaker: number,
  speakerConfidence: number,
): NormalizedWord {
  return {
    word: text,
    start,
    end,
    confidence: 0.95,
    speaker,
    speakerConfidence,
    punctuatedWord: text,
  }
}

/**
 * Build a NormalizedTranscriptResult. The channelIndex parameter is kept
 * for source compatibility with prior test cases but is ignored — every
 * result is single-channel (channelIndex: 0) now.
 */
function result(
  _channelIndex: number,
  words: NormalizedWord[],
  isFinal = true,
): NormalizedTranscriptResult {
  const text = words.map((w) => w.punctuatedWord).join(' ')
  const start = words[0]?.start ?? 0
  const end = words[words.length - 1]?.end ?? 0
  return {
    text,
    words,
    isFinal,
    speechFinal: isFinal,
    start,
    duration: Math.max(end - start, 0.05),
    channelIndex: 0,
  }
}

// Diarization-mode behaviors (the only mode now) ─────────────────────────────

describe('TranscriptAssembler — diarization-mode post-processing', () => {
  it('correctSpeakerBoundaries moves low-confidence trailing words to the next segment', () => {
    const a = new TranscriptAssembler()

    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0, 0.95),
        word('there', 0.3, 0.6, 0, 0.95),
        word('um', 0.6, 0.8, 0, 0.1), // low-conf trailing word
      ]),
    )
    a.addResult(result(0, [word('hi', 1.0, 1.3, 1, 0.9), word('back', 1.3, 1.6, 1, 0.9)]))

    a.finalize()
    a.correctSpeakerBoundaries()

    const segs = a.getFinalizedSegments()
    const speaker0 = segs.find((s) => s.speaker === 0)
    expect(speaker0?.text).not.toContain('um') // moved to speaker 1
    const speaker1 = segs.find((s) => s.speaker === 1)
    expect(speaker1?.text).toContain('um')
  })

  it('caps over-diarized speaker indices at expectedCount (no Speaker 5/6/7 sprawl)', () => {
    // Deepgram occasionally over-diarizes — emitting speakers 3, 4, 5, 6
    // even when only two people are on the call. The cap unifies all
    // over-diarized indices into a single "Speaker N+1" bucket.
    const a = new TranscriptAssembler()

    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0, 0.95),
        word('there', 0.3, 0.6, 0, 0.95),
        word('friend', 0.6, 0.9, 0, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('hi', 1.0, 1.3, 1, 0.95),
        word('back', 1.3, 1.6, 1, 0.95),
        word('again', 1.6, 1.9, 1, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('strange', 2.0, 2.3, 5, 0.95),
        word('overflow', 2.3, 2.6, 5, 0.95),
        word('here', 2.6, 2.9, 5, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('more', 3.0, 3.3, 7, 0.95),
        word('overflow', 3.3, 3.6, 7, 0.95),
        word('words', 3.6, 3.9, 7, 0.95),
      ]),
    )

    a.finalize()
    a.consolidateSpeakers(2)

    const segs = a.getFinalizedSegments()
    for (const seg of segs) {
      expect(seg.speaker).toBeLessThanOrEqual(2)
    }

    const phantomBucket = segs.filter((s) => s.speaker === 2)
    expect(phantomBucket.length).toBe(1)
    expect(phantomBucket[0].text).toContain('strange overflow here')
    expect(phantomBucket[0].text).toContain('more overflow words')

    expect(segs.find((s) => s.speaker === 0)?.text).toContain('Hello there friend')
    expect(segs.find((s) => s.speaker === 1)?.text).toContain('hi back again')
  })

  it('consolidateSpeakers leaves phantom speakers as their own segments', () => {
    // Behavior change (2026-05-27): consolidateSpeakers no longer merges
    // phantom speakers into the previous segment in diarization mode. That
    // merge was the root cause of the user-reported "my brief responses
    // get appended to the other participant's transcript" bug.
    const a = new TranscriptAssembler()

    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0, 0.95),
        word('there', 0.3, 0.6, 0, 0.95),
        word('friend', 0.6, 0.9, 0, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('hi', 1.0, 1.3, 1, 0.95),
        word('back', 1.3, 1.6, 1, 0.95),
        word('again', 1.6, 1.9, 1, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('extra', 2.0, 2.3, 2, 0.95),
        word('phantom', 2.3, 2.6, 2, 0.95),
        word('words', 2.6, 2.9, 2, 0.95),
      ]),
    )

    a.finalize()
    a.consolidateSpeakers(2)

    const segs = a.getFinalizedSegments()
    const phantom = segs.find((s) => s.speaker === 2)
    expect(phantom).toBeDefined()
    expect(phantom?.text).toContain('phantom')

    const speaker1 = segs.find((s) => s.speaker === 1)
    expect(speaker1?.text).not.toContain('phantom')
  })

  it('handles missing speakerConfidence by treating it as high confidence (AssemblyAI parity)', () => {
    // AssemblyAI Universal-Streaming doesn't emit per-word speaker
    // confidence. Default-to-1.0 means correctSpeakerBoundaries Pass 1
    // (which moves words with confidence < 0.4) becomes a no-op — we
    // trust the provider's speaker labels.
    const a = new TranscriptAssembler()

    // Words with undefined speakerConfidence (AssemblyAI-style payload).
    const wordsA: NormalizedWord[] = [
      { word: 'Hello', start: 0, end: 0.3, confidence: 0.95, speaker: 0, punctuatedWord: 'Hello' },
      { word: 'there', start: 0.3, end: 0.6, confidence: 0.95, speaker: 0, punctuatedWord: 'there' },
    ]
    const wordsB: NormalizedWord[] = [
      { word: 'hi', start: 1.0, end: 1.3, confidence: 0.95, speaker: 1, punctuatedWord: 'hi' },
      { word: 'back', start: 1.3, end: 1.6, confidence: 0.95, speaker: 1, punctuatedWord: 'back' },
    ]

    a.addResult(result(0, wordsA))
    a.addResult(result(0, wordsB))
    a.finalize()
    a.correctSpeakerBoundaries()

    const segs = a.getFinalizedSegments()
    // No words moved between speakers because confidence defaulted to 1.0.
    expect(segs.find((s) => s.speaker === 0)?.text).toBe('Hello there')
    expect(segs.find((s) => s.speaker === 1)?.text).toBe('hi back')
  })
})
