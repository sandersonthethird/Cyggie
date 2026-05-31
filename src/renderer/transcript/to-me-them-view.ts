import type { TranscriptSegment } from '../../shared/types/recording'
import { findMeSpeakerByName } from '../../shared/transcript/me-them-resolver'

export type Side = 'me' | 'them'

export interface BubbleItem {
  kind: 'bubble'
  /** Stable key derived from the first child segment's startTime. */
  key: string
  side: Side
  startTime: number
  endTime: number
  /** Original segments merged into this bubble (always same `side`). */
  segments: TranscriptSegment[]
}

export interface TimestampItem {
  kind: 'timestamp'
  key: string
  /** Seconds from recording start; the renderer formats. */
  time: number
}

export type TranscriptItem = BubbleItem | TimestampItem

export interface ToMeThemViewArgs {
  segments: TranscriptSegment[]
  speakerMap: Record<number, string>
  meSpeakerIndex: number | null
  calendarSelfName: string | null
}

/**
 * Render-time wrapper that collapses raw diarized segments into the
 * iMessage-style me/them bubble feed.
 *
 * Resolution order for "which speaker index is me":
 *   1. `meSpeakerIndex` (explicit — new recordings; or any recording the
 *      user has clicked Swap on).
 *   2. `findMeSpeakerByName(speakerMap, calendarSelfName)` — backward-
 *      compat heuristic for old transcripts where the user appears in
 *      the speaker map by name.
 *   3. Most-talkative (highest cumulative segment-seconds; ties broken
 *      by lowest index). The mono-resolver fallback.
 *
 * Returns `null` for `meIndex` only when the transcript is empty.
 */
export function resolveMeIndexForRender(args: ToMeThemViewArgs): number | null {
  if (args.segments.length === 0) return null
  if (typeof args.meSpeakerIndex === 'number') return args.meSpeakerIndex
  const fromName = findMeSpeakerByName(args.speakerMap, args.calendarSelfName)
  if (fromName !== null) return fromName
  return mostTalkative(args.segments)
}

function mostTalkative(segments: TranscriptSegment[]): number {
  const totals = new Map<number, number>()
  for (const seg of segments) {
    const dur = Math.max(0, seg.endTime - seg.startTime)
    totals.set(seg.speaker, (totals.get(seg.speaker) ?? 0) + dur)
  }
  let bestIdx = Number.POSITIVE_INFINITY
  let bestSec = -1
  for (const [idx, sec] of totals) {
    if (sec > bestSec || (sec === bestSec && idx < bestIdx)) {
      bestSec = sec
      bestIdx = idx
    }
  }
  return bestIdx === Number.POSITIVE_INFINITY ? 0 : bestIdx
}

/**
 * Build the bubble + timestamp item list for the virtualized list.
 *
 * Bubble rules:
 *   - Side: me-index → 'me' (right), everything else → 'them' (left).
 *   - Adjacent same-side segments merge into one bubble — Granola-style.
 *
 * Timestamp rules:
 *   - Always emitted at the very start of the transcript (time = 0).
 *   - Emitted between bubbles when the gap > `silenceGapSeconds` (default 5).
 *   - Emitted every `forceIntervalSeconds` (default 120) when no
 *     natural gap occurred in that window.
 */
export interface BuildItemsOpts {
  silenceGapSeconds?: number
  forceIntervalSeconds?: number
}

export function buildTranscriptItems(
  args: ToMeThemViewArgs,
  opts: BuildItemsOpts = {},
): { items: TranscriptItem[]; meIndex: number | null } {
  const silenceGap = opts.silenceGapSeconds ?? 5
  const forceInterval = opts.forceIntervalSeconds ?? 120
  const meIndex = resolveMeIndexForRender(args)
  const items: TranscriptItem[] = []
  if (args.segments.length === 0) return { items, meIndex }

  // Order segments by start time defensively — the Deepgram path returns
  // them in order, but the AssemblyAI v3 client emits turns asynchronously
  // and a stop/finalize race could land out-of-order finalized entries.
  const ordered = [...args.segments].sort((a, b) => a.startTime - b.startTime)

  // Initial timestamp at 00:00.
  items.push({ kind: 'timestamp', key: 't-0', time: 0 })

  let lastTimestampAt = 0
  let currentBubble: BubbleItem | null = null

  for (const seg of ordered) {
    const side: Side = seg.speaker === meIndex ? 'me' : 'them'

    if (currentBubble) {
      const gap = seg.startTime - currentBubble.endTime
      if (gap > silenceGap) {
        // Close the current bubble, emit a timestamp at the gap boundary.
        items.push(currentBubble)
        items.push({
          kind: 'timestamp',
          key: `t-gap-${seg.startTime.toFixed(2)}`,
          time: seg.startTime,
        })
        lastTimestampAt = seg.startTime
        currentBubble = null
      } else if (seg.startTime - lastTimestampAt >= forceInterval) {
        // Forced timestamp: close current bubble and start fresh.
        items.push(currentBubble)
        items.push({
          kind: 'timestamp',
          key: `t-interval-${seg.startTime.toFixed(2)}`,
          time: seg.startTime,
        })
        lastTimestampAt = seg.startTime
        currentBubble = null
      } else if (currentBubble.side !== side) {
        // Same time window, different speaker — close and start a new bubble.
        items.push(currentBubble)
        currentBubble = null
      }
    }

    if (!currentBubble) {
      currentBubble = {
        kind: 'bubble',
        key: `b-${seg.startTime.toFixed(2)}-${seg.speaker}`,
        side,
        startTime: seg.startTime,
        endTime: seg.endTime,
        segments: [seg],
      }
    } else {
      currentBubble.segments.push(seg)
      currentBubble.endTime = seg.endTime
    }
  }

  if (currentBubble) items.push(currentBubble)
  return { items, meIndex }
}

/**
 * Joined text + per-segment offsets used by the bubble view's find-in-page.
 *
 * The MeetingDetail find hook indexes a single string; bubbles render
 * per-segment. This helper produces the shared string (so match offsets are
 * consistent across the two callers) plus an identity-keyed offset map so
 * TranscriptBubbles can map a global match position back to a per-segment
 * range. Segments are sorted by startTime to match buildTranscriptItems.
 */
export function buildBubbleSearchIndex(segments: TranscriptSegment[]): {
  text: string
  offsetOf: Map<TranscriptSegment, number>
} {
  const ordered = [...segments].sort((a, b) => a.startTime - b.startTime)
  const offsetOf = new Map<TranscriptSegment, number>()
  const parts: string[] = []
  let offset = 0
  for (const seg of ordered) {
    offsetOf.set(seg, offset)
    parts.push(seg.text)
    offset += seg.text.length + 1
  }
  return { text: parts.join('\n'), offsetOf }
}

/**
 * Format a `seconds` value as `mm:ss` (or `h:mm:ss` past one hour) for
 * the centered timestamp markers between bubble runs.
 */
export function formatBubbleTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
