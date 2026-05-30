// End-to-end integration test for the cheeky-treasure transcription
// pipeline. Wires the components built across Parts 2c-2f and 3a-3c
// together against synthetic stereo input — no Deepgram API call, no
// AudioWorklet harness. Validates the contract that they compose into
// the user-visible behavior the plan promised:
//
//   1. Multichannel input produces clean me/them attribution.
//   2. Bleed doublings get dropped by the cross-channel dedup pass.
//   3. The render-time bubble view yields a 2-stream layout with the
//      user on the right.
//
// The full live-Deepgram-against-fixture eval is tracked separately
// (blocked on TODOS:70 — the eval CLI's missing correctTranscriptMarkdown
// integration would bias the comparison).

import { describe, it, expect } from 'vitest'
import { TranscriptAssembler } from '../main/deepgram/transcript-assembler'
import type { NormalizedTranscriptResult, NormalizedWord } from '../main/transcription/types'
import { resolveMeSpeakerIndex } from '../shared/transcript/me-them-resolver'
import { buildTranscriptItems } from '../renderer/transcript/to-me-them-view'

function word(text: string, start: number, end: number, conf = 0.95, speaker = 0): NormalizedWord {
  return {
    word: text,
    start,
    end,
    confidence: conf,
    speaker,
    speakerConfidence: 0.95,
    punctuatedWord: text,
  }
}

function result(
  channelIndex: number,
  words: NormalizedWord[],
  isFinal = true,
): NormalizedTranscriptResult {
  const text = words.map((w) => w.punctuatedWord).join(' ')
  return {
    text,
    words,
    isFinal,
    speechFinal: isFinal,
    start: words[0]?.start ?? 0,
    duration: (words[words.length - 1]?.end ?? 0) - (words[0]?.start ?? 0),
    channelIndex,
  }
}

describe('cheeky-treasure end-to-end pipeline', () => {
  it('multichannel + bleed: dedup drops mic copies, resolver picks 0, bubbles split cleanly', () => {
    const a = new TranscriptAssembler()

    // System channel (1) — high confidence remote speech. Three turns.
    a.addResult(
      result(1, [
        word('Thanks', 0.0, 0.3, 0.95),
        word('for', 0.3, 0.5, 0.95),
        word('joining', 0.5, 0.9, 0.95),
        word('today', 0.9, 1.3, 0.95),
      ]),
    )
    // Mic bleed copy of the same utterance — lower confidence, slight time shift.
    a.addResult(
      result(0, [
        word('Thanks', 0.05, 0.35, 0.45),
        word('for', 0.35, 0.55, 0.45),
        word('joining', 0.55, 0.95, 0.45),
        word('today', 0.95, 1.35, 0.45),
      ]),
    )

    // Mic-only — user actually talking, no system counterpart.
    a.addResult(
      result(0, [
        word('Of', 2.0, 2.2, 0.96),
        word('course', 2.2, 2.5, 0.96),
        word('happy', 2.5, 2.8, 0.96),
        word('to', 2.8, 2.9, 0.96),
        word('be', 2.9, 3.0, 0.96),
        word('here', 3.0, 3.3, 0.96),
      ]),
    )

    // Another remote turn on system; mic doesn't pick it up (e.g. headphones).
    a.addResult(
      result(1, [
        word('We', 4.0, 4.2, 0.94),
        word('wanted', 4.2, 4.5, 0.94),
        word('to', 4.5, 4.6, 0.94),
        word('walk', 4.6, 4.8, 0.94),
        word('you', 4.8, 4.9, 0.94),
        word('through', 4.9, 5.2, 0.94),
        word('the', 5.2, 5.3, 0.94),
        word('deck', 5.3, 5.6, 0.94),
      ]),
    )

    // Dedup outcome: the bleed copy of the first remote turn is dropped.
    const segments = a.getFinalizedSegments()
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
    expect(segments).toHaveLength(3)

    // Resolver in multichannel mode trivially returns 0 (mic = me).
    const meIndex = resolveMeSpeakerIndex({
      segments,
      loudness: null,
      channelMode: 'multichannel',
    })
    expect(meIndex).toBe(0)

    // Bubble view produces a 3-bubble feed: them, me, them.
    const { items, meIndex: bubbleMe } = buildTranscriptItems({
      segments,
      speakerMap: { 0: 'Sandy', 1: 'Other' },
      meSpeakerIndex: meIndex,
      calendarSelfName: 'Sandy',
    })
    expect(bubbleMe).toBe(0)
    const bubbles = items.filter((i): i is Extract<typeof items[number], { kind: 'bubble' }> => i.kind === 'bubble')
    expect(bubbles).toHaveLength(3)
    expect(bubbles.map((b) => b.side)).toEqual(['them', 'me', 'them'])
  })

  it('mono + loudness: resolver picks the mic-dominant speaker, bubbles align', () => {
    const a = new TranscriptAssembler()

    // Mono path: every result on channelIndex 0 (the always-on channel
    // in single-stream sessions). Two distinct speakers, diarized.
    a.addResult(
      result(0, [
        word('Hi', 0.0, 0.2, 0.95, 0),
        word('Ricardo', 0.2, 0.7, 0.95, 0),
      ]),
    )
    a.addResult(
      result(0, [
        word('Hey', 1.0, 1.2, 0.95, 1),
        word('Sandy', 1.2, 1.7, 0.95, 1),
        word('good', 1.7, 2.0, 0.95, 1),
        word('to', 2.0, 2.1, 0.95, 1),
        word('see', 2.1, 2.3, 0.95, 1),
        word('you', 2.3, 2.5, 0.95, 1),
      ]),
    )

    const segments = a.getFinalizedSegments()
    // Loudness time series: speaker 0's window is mic-dominant; speaker 1's
    // window is sys-dominant (i.e. their voice came in via system loopback).
    const loudness = [
      { tStart: 0.0, tEnd: 1.0, micDb: -10, sysDb: -50 },
      { tStart: 1.0, tEnd: 2.5, micDb: -50, sysDb: -10 },
    ]

    const meIndex = resolveMeSpeakerIndex({
      segments,
      loudness,
      channelMode: 'mono',
    })
    expect(meIndex).toBe(0)

    const { items } = buildTranscriptItems({
      segments,
      speakerMap: { 0: 'Sandy', 1: 'Ricardo' },
      meSpeakerIndex: meIndex,
      calendarSelfName: 'Sandy',
    })
    const bubbles = items.filter((i): i is Extract<typeof items[number], { kind: 'bubble' }> => i.kind === 'bubble')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].side).toBe('me')
    expect(bubbles[1].side).toBe('them')
  })

  it('phantom-speaker collapse: 3 raw indices render as 2 bubble streams', () => {
    // Yesterday-Ricardo scenario: Deepgram over-diarized to 3 speakers
    // in a 2-attendee call. Phantom-bucket clamp removed (Part 2f);
    // bubble view collapses non-me indices into "them" regardless.
    const a = new TranscriptAssembler()
    a.addResult(
      result(0, [
        word('Hello', 0.0, 0.3, 0.95, 0),
        word('Ricardo', 0.3, 0.7, 0.95, 0),
      ]),
    )
    a.addResult(
      result(0, [
        word('Hi', 1.0, 1.2, 0.95, 1),
        word('Sandy', 1.2, 1.5, 0.95, 1),
      ]),
    )
    a.addResult(
      result(0, [
        word('mumble', 2.0, 2.4, 0.95, 2),
        word('mumble', 2.4, 2.6, 0.95, 2),
      ]),
    )
    a.addResult(
      result(0, [
        word('Anyway', 3.0, 3.4, 0.95, 1),
        word('lets', 3.4, 3.6, 0.95, 1),
        word('start', 3.6, 4.0, 0.95, 1),
      ]),
    )

    const segments = a.getFinalizedSegments()
    expect(new Set(segments.map((s) => s.speaker))).toEqual(new Set([0, 1, 2]))

    const { items } = buildTranscriptItems({
      segments,
      speakerMap: { 0: 'Sandy', 1: 'Ricardo', 2: 'Speaker 3' },
      meSpeakerIndex: null,
      calendarSelfName: 'Sandy',
    })
    const bubbles = items.filter((i): i is Extract<typeof items[number], { kind: 'bubble' }> => i.kind === 'bubble')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].side).toBe('me')
    expect(bubbles[1].side).toBe('them')
    // The "them" bubble merges speakers 1, 2, 1.
    expect(bubbles[1].segments).toHaveLength(3)
  })

  it('dedup tiebreak: equal confidence on both channels keeps the system copy', () => {
    const a = new TranscriptAssembler()
    a.addResult(
      result(0, [
        word('OK', 0.0, 0.3, 0.80),
        word('sounds', 0.3, 0.6, 0.80),
        word('good', 0.6, 0.9, 0.80),
      ]),
    )
    a.addResult(
      result(1, [
        word('OK', 0.0, 0.3, 0.80),
        word('sounds', 0.3, 0.6, 0.80),
        word('good', 0.6, 0.9, 0.80),
      ]),
    )
    expect(a.getFinalizedSegments()).toHaveLength(1)
    expect(a.getDiagnostics().dedupDroppedCount).toBe(1)
    // Multichannel mode locked in via the channelIndex > 0 signal.
    expect(a.getChannelMode()).toBe('multichannel')
  })
})
