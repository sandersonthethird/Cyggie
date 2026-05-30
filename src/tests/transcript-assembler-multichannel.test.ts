// TranscriptAssembler tests — diarization + multichannel.
//
// 2026-05-30 (Part 2f of the cheeky-treasure plan): multichannel + cross-
// channel dedup re-enabled. Phantom-bucket clamp removed; the render-
// time bubble view now collapses non-me speakers into "them". Tests for
// the old clamp behavior are gone; new tests cover the dedup pass.

import { describe, it, expect } from 'vitest'
import { TranscriptAssembler, isDuplicateOf } from '@main/deepgram/transcript-assembler'
import type { NormalizedTranscriptResult, NormalizedWord } from '@main/transcription/types'
import type { TranscriptSegment, TranscriptWord } from '../shared/types/recording'

// Helpers ────────────────────────────────────────────────────────────────────

function word(
  text: string,
  start: number,
  end: number,
  speaker: number,
  speakerConfidence: number,
  confidence = 0.95,
): NormalizedWord {
  return {
    word: text,
    start,
    end,
    confidence,
    speaker,
    speakerConfidence,
    punctuatedWord: text,
  }
}

function result(
  channelIndex: number,
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
    channelIndex,
  }
}

function seg(
  speaker: number,
  text: string,
  startTime: number,
  endTime: number,
  wordConf = 0.9,
): TranscriptSegment {
  const tokens = text.split(/\s+/).filter(Boolean)
  const step = tokens.length > 0 ? (endTime - startTime) / tokens.length : 0
  const words: TranscriptWord[] = tokens.map((t, i) => ({
    word: t,
    start: startTime + i * step,
    end: startTime + (i + 1) * step,
    confidence: wordConf,
    speaker,
    speakerConfidence: 0.95,
    punctuatedWord: t,
  }))
  return { speaker, text, startTime, endTime, isFinal: true, words }
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

  it('consolidateSpeakers preserves over-diarized speaker indices (no clamp)', () => {
    // Phantom-bucket clamp removed 2026-05-30 (Part 2f / Part 3 of the
    // cheeky-treasure plan). Out-of-range Deepgram speaker indices are
    // collapsed at render time by the me/them bubble view instead of
    // here, so the assembler now passes them through unchanged.
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
    expect(segs.find((s) => s.speaker === 0)?.text).toContain('Hello there friend')
    expect(segs.find((s) => s.speaker === 1)?.text).toContain('hi back again')
    expect(segs.find((s) => s.speaker === 5)?.text).toContain('strange overflow here')
    expect(segs.find((s) => s.speaker === 7)?.text).toContain('more overflow words')
  })

  it('consolidateSpeakers still collapses adjacent same-speaker segments', () => {
    const a = new TranscriptAssembler()
    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0, 0.95),
        word('there', 0.3, 0.6, 0, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('how', 0.7, 1.0, 0, 0.95),
        word('are', 1.0, 1.2, 0, 0.95),
        word('you', 1.2, 1.4, 0, 0.95),
      ]),
    )
    // Speaker switch needs ≥2 words and high speaker-confidence to be
    // accepted by stabilizeSpeakerSwitches (otherwise it gets suppressed
    // and reassigned back to speaker 0).
    a.addResult(
      result(0, [
        word('Hi', 2.0, 2.3, 1, 0.95),
        word('back', 2.3, 2.6, 1, 0.95),
      ]),
    )
    a.finalize()
    a.consolidateSpeakers(0)

    const segs = a.getFinalizedSegments()
    expect(segs).toHaveLength(2)
    expect(segs[0].speaker).toBe(0)
    expect(segs[0].text).toBe('Hello there how are you')
    expect(segs[1].speaker).toBe(1)
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

// Cross-channel dedup (Part 2f) ──────────────────────────────────────────────

describe('TranscriptAssembler — cross-channel dedup', () => {
  it('drops the lower-confidence copy when same utterance arrives on both channels', () => {
    // Channel 1 (system) hears the remote at 0.95; channel 0 (mic) picks up
    // the bleed copy at 0.60. The mic copy should be dropped.
    const a = new TranscriptAssembler()
    a.addResult(
      result(1, [
        word('Thanks', 0.0, 0.3, 0, 0.95, 0.95),
        word('for', 0.3, 0.5, 0, 0.95, 0.95),
        word('joining', 0.5, 0.9, 0, 0.95, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('Thanks', 0.05, 0.35, 0, 0.95, 0.60),
        word('for', 0.35, 0.55, 0, 0.95, 0.60),
        word('joining', 0.55, 0.95, 0, 0.95, 0.60),
      ]),
    )

    const segs = a.getFinalizedSegments()
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toContain('Thanks for joining')
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
  })

  it('keeps both copies when the text differs (simultaneous distinct speech)', () => {
    // Both speakers talking at once but saying different things — no
    // overlap-drop should fire.
    const a = new TranscriptAssembler()
    a.addResult(
      result(1, [
        word('Of', 0.0, 0.2, 0, 0.95, 0.95),
        word('course', 0.2, 0.5, 0, 0.95, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('Sounds', 0.0, 0.3, 0, 0.95, 0.95),
        word('right', 0.3, 0.5, 0, 0.95, 0.95),
      ]),
    )

    const segs = a.getFinalizedSegments()
    expect(segs).toHaveLength(2)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(0)
  })

  it('still catches duplicates when the bleed copy is time-shifted by ~100ms', () => {
    // Acoustic bleed has a small propagation delay (mic picks up the
    // speaker output a few hundred ms after system loopback). The dedup
    // pass must tolerate the time shift — IoU stays > 0.5 across the
    // overlap and text similarity > 0.95.
    const a = new TranscriptAssembler()
    a.addResult(
      result(1, [
        word('We', 0.0, 0.2, 0, 0.95, 0.95),
        word('had', 0.2, 0.4, 0, 0.95, 0.95),
        word('two', 0.4, 0.6, 0, 0.95, 0.95),
        word('issues', 0.6, 1.0, 0, 0.95, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('We', 0.1, 0.3, 0, 0.95, 0.55),
        word('had', 0.3, 0.5, 0, 0.95, 0.55),
        word('two', 0.5, 0.7, 0, 0.95, 0.55),
        word('issues', 0.7, 1.1, 0, 0.95, 0.55),
      ]),
    )

    expect(a.getFinalizedSegments()).toHaveLength(1)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
  })

  it('does NOT dedup when the second copy falls outside the 2s buffer window', () => {
    // Identical text on both channels, but the second arrival's audio
    // time is far enough past the buffered entry that pruneRecentBuffers
    // has dropped it. No dedup — both kept.
    const a = new TranscriptAssembler()
    a.addResult(
      result(1, [
        word('Thanks', 0.0, 0.3, 0, 0.95, 0.95),
        word('for', 0.3, 0.5, 0, 0.95, 0.95),
        word('joining', 0.5, 0.9, 0, 0.95, 0.95),
      ]),
    )
    a.addResult(
      result(0, [
        word('Thanks', 5.0, 5.3, 0, 0.95, 0.95),
        word('for', 5.3, 5.5, 0, 0.95, 0.95),
        word('joining', 5.5, 5.9, 0, 0.95, 0.95),
      ]),
    )
    expect(a.getFinalizedSegments()).toHaveLength(2)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(0)
  })

  it('tiebreak keeps channel 1 (system) when confidence is equal', () => {
    const a = new TranscriptAssembler()
    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0, 0.95, 0.80),
        word('there', 0.3, 0.6, 0, 0.95, 0.80),
      ]),
    )
    a.addResult(
      result(1, [
        word('Hello', 0.0, 0.3, 0, 0.95, 0.80),
        word('there', 0.3, 0.6, 0, 0.95, 0.80),
      ]),
    )

    const segs = a.getFinalizedSegments()
    expect(segs).toHaveLength(1)
    // Channel 1 wins on equal-confidence tiebreak — verified via diagnostics.
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
    expect(a.getChannelMode()).toBe('multichannel')
  })

  it('confidence-zero floor: still drops one copy and never keeps both', () => {
    const a = new TranscriptAssembler()
    a.addResult(
      result(1, [word('Hi', 0.0, 0.3, 0, 0.95, 0)]),
    )
    a.addResult(
      result(0, [word('Hi', 0.0, 0.3, 0, 0.95, 0)]),
    )

    // Even with zero confidence on both sides, dedup must drop one — the
    // floor protects the tiebreak from being a no-op when conf is 0/0.
    expect(a.getFinalizedSegments()).toHaveLength(1)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
  })

  it('higher-confidence new copy excises the previously-finalized lower-confidence one', () => {
    const a = new TranscriptAssembler()
    a.addResult(
      result(0, [
        word('Thanks', 0.0, 0.3, 0, 0.95, 0.30),
        word('for', 0.3, 0.5, 0, 0.95, 0.30),
        word('joining', 0.5, 0.9, 0, 0.95, 0.30),
      ]),
    )
    expect(a.getFinalizedSegments()).toHaveLength(1)

    // Channel 1 copy lands later with HIGHER confidence — the channel 0
    // bleed should be retroactively excised.
    a.addResult(
      result(1, [
        word('Thanks', 0.0, 0.3, 0, 0.95, 0.95),
        word('for', 0.3, 0.5, 0, 0.95, 0.95),
        word('joining', 0.5, 0.9, 0, 0.95, 0.95),
      ]),
    )

    const segs = a.getFinalizedSegments()
    expect(segs).toHaveLength(1)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
  })
})

// isDuplicateOf predicate ────────────────────────────────────────────────────

describe('isDuplicateOf', () => {
  it('returns true for near-identical text with strong time overlap', () => {
    const a = seg(0, 'Thanks for joining the call today', 0.0, 1.5)
    const b = seg(0, 'thanks for joining the call today!', 0.1, 1.6)
    expect(isDuplicateOf(a, b)).toBe(true)
  })

  it('returns false when time overlap is below 0.5 IoU', () => {
    const a = seg(0, 'Thanks for joining', 0.0, 1.0)
    const b = seg(0, 'Thanks for joining', 3.0, 4.0)
    expect(isDuplicateOf(a, b)).toBe(false)
  })

  it('returns false when text similarity below 0.95', () => {
    const a = seg(0, 'Thanks for joining the call today', 0.0, 1.5)
    const b = seg(0, 'I appreciate you all coming to this thing', 0.1, 1.6)
    expect(isDuplicateOf(a, b)).toBe(false)
  })

  it('compares only the first 100 chars (long-text guard)', () => {
    const long = 'a'.repeat(200)
    const a = seg(0, long + ' tail one', 0.0, 1.5)
    const b = seg(0, long + ' tail two completely different', 0.1, 1.6)
    // First 100 chars are identical — the divergent tail is ignored.
    expect(isDuplicateOf(a, b)).toBe(true)
  })
})
