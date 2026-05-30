import type { TranscriptSegment } from '../types/recording'

export type ChannelMode = 'multichannel' | 'mono'

/**
 * Short-time loudness sample emitted by the audio worklet (~10 Hz).
 * `micDb` / `sysDb` are dBFS for the mic and system channels over the
 * window [`tStart`, `tEnd`] in **seconds since recording start** — the
 * same time base as `TranscriptSegment.startTime` / `endTime`.
 */
export interface LoudnessSample {
  tStart: number
  tEnd: number
  micDb: number
  sysDb: number
}

export interface ResolveMeArgs {
  segments: TranscriptSegment[]
  loudness: LoudnessSample[] | null
  channelMode: ChannelMode
}

/**
 * Decide which Deepgram speaker index belongs to the recording user.
 *
 * Priority:
 *   1. Multichannel: channel 0 is the mic by construction → return 0.
 *   2. Mono + loudness: pick the speaker whose segments overlap with the
 *      highest mic-vs-sys dominance. If the top two are within 10% of
 *      each other on that metric, fall through (ambiguous).
 *   3. Mono fallback: most-talkative (highest total segment-seconds);
 *      ties broken by lowest index.
 *
 * Returns `null` only if `segments` is empty.
 */
export function resolveMeSpeakerIndex(args: ResolveMeArgs): number | null {
  const { segments, loudness, channelMode } = args
  if (segments.length === 0) return null

  if (channelMode === 'multichannel') return 0

  if (loudness && loudness.length > 0) {
    const fromLoudness = pickBySpeakerLoudness(segments, loudness)
    if (fromLoudness !== null) return fromLoudness
  }

  return pickMostTalkative(segments)
}

function pickBySpeakerLoudness(
  segments: TranscriptSegment[],
  loudness: LoudnessSample[],
): number | null {
  const dominanceBySpeaker = new Map<number, { sumDom: number; weight: number }>()

  for (const seg of segments) {
    const segDuration = Math.max(0, seg.endTime - seg.startTime)
    if (segDuration <= 0) continue
    const dominance = meanMicDominance(loudness, seg.startTime, seg.endTime)
    if (dominance === null) continue

    const prev = dominanceBySpeaker.get(seg.speaker) ?? { sumDom: 0, weight: 0 }
    prev.sumDom += dominance * segDuration
    prev.weight += segDuration
    dominanceBySpeaker.set(seg.speaker, prev)
  }

  if (dominanceBySpeaker.size === 0) return null

  const ranked = [...dominanceBySpeaker.entries()]
    .map(([speaker, { sumDom, weight }]) => ({ speaker, mean: sumDom / weight }))
    .sort((a, b) => b.mean - a.mean)

  if (ranked.length === 1) return ranked[0].speaker

  const [top, next] = ranked
  // Ambiguous if top is within 10% of next-highest (mic vs sys dBFS difference).
  // Use absolute scale relative to a 10 dB reference so values near 0 still
  // produce a meaningful comparison.
  const gap = Math.abs(top.mean - next.mean)
  if (gap < 1.0) return null

  return top.speaker
}

function meanMicDominance(
  loudness: LoudnessSample[],
  startTime: number,
  endTime: number,
): number | null {
  let weightedSum = 0
  let totalWeight = 0
  for (const sample of loudness) {
    const overlap = Math.min(sample.tEnd, endTime) - Math.max(sample.tStart, startTime)
    if (overlap <= 0) continue
    weightedSum += (sample.micDb - sample.sysDb) * overlap
    totalWeight += overlap
  }
  if (totalWeight <= 0) return null
  return weightedSum / totalWeight
}

function pickMostTalkative(segments: TranscriptSegment[]): number {
  const secondsBySpeaker = new Map<number, number>()
  for (const seg of segments) {
    const dur = Math.max(0, seg.endTime - seg.startTime)
    secondsBySpeaker.set(seg.speaker, (secondsBySpeaker.get(seg.speaker) ?? 0) + dur)
  }
  // Highest total seconds wins; ties broken by lowest index.
  let bestIdx = Number.POSITIVE_INFINITY
  let bestSec = -1
  for (const [idx, sec] of secondsBySpeaker) {
    if (sec > bestSec || (sec === bestSec && idx < bestIdx)) {
      bestSec = sec
      bestIdx = idx
    }
  }
  return bestIdx === Number.POSITIVE_INFINITY ? 0 : bestIdx
}

/**
 * Backward-compat helper for transcripts saved before `meSpeakerIndex`
 * landed: try to identify "me" by matching the calendar self-name against
 * the speaker labels.
 *
 * Rule: lowercase, split on whitespace; the speaker matches iff EVERY
 * token in `calendarSelfName` is present in that speaker's token set.
 * Strict — protects the Sandy→Andy regression: searching for "Sandy"
 * must not match a speaker labelled "Andy".
 *
 * Returns the matching speaker index, or `null` if no unique match
 * (zero matches, multiple matches, missing input, etc.).
 */
export function findMeSpeakerByName(
  speakerMap: Record<number, string>,
  calendarSelfName: string | null,
): number | null {
  if (!calendarSelfName) return null
  const selfTokens = tokenize(calendarSelfName)
  if (selfTokens.size === 0) return null

  const matches: number[] = []
  for (const [keyRaw, label] of Object.entries(speakerMap)) {
    const key = Number(keyRaw)
    if (!Number.isInteger(key)) continue
    const labelTokens = tokenize(label)
    if (labelTokens.size === 0) continue
    let allPresent = true
    for (const t of selfTokens) {
      if (!labelTokens.has(t)) {
        allPresent = false
        break
      }
    }
    if (allPresent) matches.push(key)
  }

  if (matches.length !== 1) return null
  return matches[0]
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  )
}
