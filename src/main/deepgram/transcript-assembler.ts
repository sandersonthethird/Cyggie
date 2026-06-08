import type { NormalizedTranscriptResult, NormalizedWord } from '../transcription/types'
import type { TranscriptSegment, TranscriptWord } from '../../shared/types/recording'
import { jaroWinkler } from '../utils/jaroWinkler'

/**
 * Channel mode reflects the live capture topology, not a state machine:
 *   - 'diarization' — single mono stream; Deepgram/AssemblyAI infer
 *     speakers from the audio itself. The default for every AssemblyAI
 *     session and Deepgram sessions where the user has not enabled
 *     `separateMicAndSystemTranscription`.
 *   - 'multichannel' — Deepgram only, two streams (mic = channel 0,
 *     system loopback = channel 1). Mic always maps to "me"; the
 *     transcript-assembler runs a cross-channel dedup pass to drop
 *     bleed doublings (the same remote utterance picked up on both
 *     channels via speaker reflection into the mic).
 *
 * The 2026-05-28 always-mono regression — and its earlier 2026-05-27
 * revert of the original multichannel attempt — happened because the
 * first multichannel landing shipped without bleed-aware dedup. The
 * current iteration re-enables multichannel behind a default-off setting
 * and pairs it with NLMS AEC in the worklet + cross-channel dedup here.
 *
 * `getChannelMode()` returns whichever mode the assembler is operating in;
 * default is 'diarization' until a channelIndex > 0 finalized result is
 * seen, at which point we lock to 'multichannel'.
 */
export type ChannelMode = 'diarization' | 'multichannel'

// Cross-channel dedup tunables (Part 2f of the cheeky-treasure plan).
const DEDUP_WINDOW_SECONDS = 2.0
const DEDUP_TIME_IOU_MIN = 0.5
const DEDUP_TEXT_SIMILARITY_MIN = 0.95
const DEDUP_TEXT_PREFIX_CHARS = 100
const DEDUP_CONFIDENCE_FLOOR = 0.001

interface RecentEntry {
  seg: TranscriptSegment
  conf: number
  channelIndex: number
}

const DEBUG_TRANSCRIPTION =
  process.env['NODE_ENV'] === 'development' && process.env['GORP_DEBUG_TRANSCRIPTION'] === '1'
const SPEAKER_SWITCH_MIN_WORDS = 2
const SPEAKER_SWITCH_MIN_DURATION_SECONDS = 0.5
const SPEAKER_SWITCH_MIN_CONFIDENCE = 0.15
const SPEAKER_SWITCH_CASCADE_LIMIT = 3

/**
 * Default speaker confidence when the provider doesn't supply one (e.g.
 * AssemblyAI Universal-Streaming, which doesn't emit per-word confidence).
 * Treating absent as 1.0 means correctSpeakerBoundaries Pass 1 and Pass 2
 * become no-ops for that provider — we trust the provider's speaker labels
 * rather than trying to second-guess them with a confidence heuristic that
 * doesn't apply.
 */
const DEFAULT_SPEAKER_CONFIDENCE = 1.0

export class TranscriptAssembler {
  private finalizedSegments: TranscriptSegment[] = []
  private currentInterim: TranscriptSegment | null = null
  private knownSpeakers = new Set<number>()
  private timeOffset = 0
  private consecutiveSuppressedSwitches = 0
  private suppressedSwitchTargetSpeaker: number | null = null
  private totalSuppressedSwitches = 0
  private dedupDroppedCount = 0

  private channelMode: ChannelMode = 'diarization'
  // Per-channel rolling buffer of recent finalized utterances, used by
  // the cross-channel dedup pass to spot bleed doublings.
  private readonly recentByChannel = new Map<number, RecentEntry[]>()

  constructor() {
    // no-op
  }

  /**
   * Legacy no-op kept so existing RecordingSession callers don't need to
   * change. With the me/them redesign there is no expected-speaker-count
   * gate — out-of-range Deepgram speaker indices are simply rendered as
   * "them" by the bubble view, and the phantom-bucket clamp that used to
   * unify them at finalize has been removed.
   */
  setExpectedSpeakerCount(_expectedCount?: number): void {
    // intentional no-op
  }

  /**
   * Legacy no-op. The old auto-detection state machine used this to
   * commit the assembler to diarization mode early. Channel mode is now
   * driven by per-result channelIndex; no commit needed.
   */
  setSystemAudioUnavailable(): void {
    // intentional no-op
  }

  getChannelMode(): ChannelMode {
    return this.channelMode
  }

  getDiagnostics(): {
    channelMode: ChannelMode
    speakerCount: number
    totalSegments: number
    totalSuppressedSwitches: number
    dedupDroppedCount: number
  } {
    return {
      channelMode: this.channelMode,
      speakerCount: this.knownSpeakers.size,
      totalSegments: this.finalizedSegments.length,
      totalSuppressedSwitches: this.totalSuppressedSwitches,
      dedupDroppedCount: this.dedupDroppedCount,
    }
  }

  addResult(result: NormalizedTranscriptResult): void {
    if (!result.text.trim()) return

    if (DEBUG_TRANSCRIPTION && result.isFinal && result.words.length > 0) {
      const confValues = result.words.map((w) => w.speakerConfidence?.toFixed(2) ?? 'N/A')
      const speakers = result.words.map((w) => w.speaker)
      console.log(
        `[TranscriptAssembler] speakers=[${[...new Set(speakers)]}] ` +
          `confidence=[${confValues.join(',')}] text="${result.text.substring(0, 60)}..."`,
      )
    }

    const segments = this.groupWordsBySpeaker(result.words)
    if (segments.length === 0) {
      const fallback = this.buildTextOnlySegment(result)
      if (fallback) {
        segments.push(fallback)
      }
    }
    const stabilizedSegments = this.stabilizeSpeakerSwitches(segments)

    if (result.channelIndex > 0) this.channelMode = 'multichannel'

    // Multichannel speaker tagging: in stereo Deepgram sessions each
    // channel runs its own independent diarization, so word.speaker=0
    // on channel 0 and word.speaker=0 on channel 1 mean two DIFFERENT
    // people. Collapse to the channel index so the me/them bubble view
    // ("speaker === meSpeakerIndex → me, anything else → them") gets
    // the right partition. Within-channel sub-diarization is dropped
    // intentionally; the me/them model only needs the 2-party split.
    if (this.channelMode === 'multichannel') {
      for (const seg of stabilizedSegments) {
        if (seg.speaker !== result.channelIndex) {
          seg.speaker = result.channelIndex
          for (const w of seg.words ?? []) w.speaker = result.channelIndex
        }
      }
    }

    if (result.isFinal) {
      this.pruneRecentBuffers(result.start + this.timeOffset)
      for (const seg of stabilizedSegments) {
        if (this.tryDropAsDuplicate(seg, result.channelIndex)) {
          continue
        }
        this.finalizedSegments.push(seg)
        this.knownSpeakers.add(seg.speaker)
        this.rememberRecent(seg, result.channelIndex)
      }
      this.currentInterim = null
    } else {
      this.currentInterim = stabilizedSegments[stabilizedSegments.length - 1] || null
      for (const seg of stabilizedSegments) {
        this.knownSpeakers.add(seg.speaker)
      }
    }
  }

  /**
   * Cross-channel dedup: when running multichannel and the same remote
   * utterance was picked up on both the mic (via speaker bleed) and the
   * system loopback, Deepgram emits two near-identical finalized
   * utterances. Drop the lower-confidence copy.
   *
   * Match rule: `isDuplicateOf` — time IoU >= 0.5, jaroWinkler >= 0.95
   * on the first 100 chars (lowercased, punctuation stripped). Tiebreak
   * on equal confidence keeps the system channel (1) over the mic (0)
   * because the system channel is the higher-SNR copy of the remote.
   *
   * Returns true if the incoming segment should be dropped. When the
   * incoming segment wins over a previously-finalized duplicate, the
   * old copy is excised from finalizedSegments and the buffer here.
   */
  private tryDropAsDuplicate(seg: TranscriptSegment, channelIndex: number): boolean {
    if (this.recentByChannel.size === 0) return false
    const newConf = avgWordConfidence(seg)

    for (const [otherChannel, entries] of this.recentByChannel) {
      if (otherChannel === channelIndex) continue
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = entries[i]
        if (!isDuplicateOf(seg, candidate.seg)) continue

        const newFloor = Math.max(newConf, DEDUP_CONFIDENCE_FLOOR)
        const oldFloor = Math.max(candidate.conf, DEDUP_CONFIDENCE_FLOOR)
        const keepOld =
          oldFloor > newFloor ||
          (oldFloor === newFloor && otherChannel > channelIndex)

        // Either side wins — count one drop either way.
        this.dedupDroppedCount++

        if (keepOld) {
          return true
        }
        // New copy wins: excise the old one from finalized output + buffer.
        entries.splice(i, 1)
        const idx = this.finalizedSegments.indexOf(candidate.seg)
        if (idx >= 0) this.finalizedSegments.splice(idx, 1)
        return false
      }
    }
    return false
  }

  private rememberRecent(seg: TranscriptSegment, channelIndex: number): void {
    const list = this.recentByChannel.get(channelIndex) ?? []
    list.push({ seg, conf: avgWordConfidence(seg), channelIndex })
    this.recentByChannel.set(channelIndex, list)
  }

  private pruneRecentBuffers(nowSeconds: number): void {
    const cutoff = nowSeconds - DEDUP_WINDOW_SECONDS
    for (const list of this.recentByChannel.values()) {
      let i = 0
      while (i < list.length && list[i].seg.endTime < cutoff) i++
      if (i > 0) list.splice(0, i)
    }
  }

  private groupWordsBySpeaker(words: NormalizedWord[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = []
    let current: TranscriptSegment | null = null

    for (const word of words) {
      const speakerConfidence = word.speakerConfidence ?? DEFAULT_SPEAKER_CONFIDENCE
      const tw: TranscriptWord = {
        word: word.word,
        start: word.start + this.timeOffset,
        end: word.end + this.timeOffset,
        confidence: word.confidence,
        speaker: word.speaker,
        speakerConfidence,
        punctuatedWord: word.punctuatedWord,
      }

      if (!current || current.speaker !== word.speaker) {
        if (current) segments.push(current)
        current = {
          speaker: word.speaker,
          text: word.punctuatedWord,
          startTime: word.start + this.timeOffset,
          endTime: word.end + this.timeOffset,
          isFinal: true,
          words: [tw],
        }
      } else {
        current.text += ' ' + word.punctuatedWord
        current.endTime = word.end + this.timeOffset
        ;(current.words ??= []).push(tw)
      }
    }

    if (current) segments.push(current)
    return segments
  }

  private stabilizeSpeakerSwitches(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length === 0) return segments

    const previousSpeaker = this.currentInterim?.speaker
      ?? this.finalizedSegments[this.finalizedSegments.length - 1]?.speaker

    if (typeof previousSpeaker !== 'number') return segments

    let activeSpeaker = previousSpeaker
    const stabilized: TranscriptSegment[] = []

    for (const seg of segments) {
      if (seg.speaker === activeSpeaker) {
        this.consecutiveSuppressedSwitches = 0
        this.suppressedSwitchTargetSpeaker = null
        stabilized.push(seg)
      } else if (this.shouldAcceptSpeakerSwitch(seg)) {
        stabilized.push(seg)
        activeSpeaker = seg.speaker
        this.consecutiveSuppressedSwitches = 0
        this.suppressedSwitchTargetSpeaker = null
      } else if (
        this.consecutiveSuppressedSwitches >= SPEAKER_SWITCH_CASCADE_LIMIT &&
        seg.speaker === this.suppressedSwitchTargetSpeaker
      ) {
        // Anti-cascade: Deepgram has consistently identified a different speaker
        // N times in a row but each segment was too short/low-confidence.
        // Accept the switch to prevent snowballing into a single-speaker transcript.
        if (DEBUG_TRANSCRIPTION) {
          console.log(
            '[TranscriptAssembler] Anti-cascade: accepting speaker switch after',
            `${this.consecutiveSuppressedSwitches} consecutive suppressions`,
            `from=${activeSpeaker} to=${seg.speaker}`
          )
        }
        stabilized.push(seg)
        activeSpeaker = seg.speaker
        this.consecutiveSuppressedSwitches = 0
        this.suppressedSwitchTargetSpeaker = null
      } else {
        if (DEBUG_TRANSCRIPTION) {
          console.log(
            '[TranscriptAssembler] Suppressing low-evidence speaker switch',
            `from=${activeSpeaker} to=${seg.speaker} words=${seg.words?.length ?? 0} ` +
              `duration=${(seg.endTime - seg.startTime).toFixed(2)}s`
          )
        }
        if (seg.speaker === this.suppressedSwitchTargetSpeaker) {
          this.consecutiveSuppressedSwitches++
        } else {
          this.consecutiveSuppressedSwitches = 1
          this.suppressedSwitchTargetSpeaker = seg.speaker
        }
        this.totalSuppressedSwitches++
        stabilized.push(this.reassignSegmentSpeaker(seg, activeSpeaker))
      }
    }

    return this.mergeAdjacentSegments(stabilized)
  }

  private shouldAcceptSpeakerSwitch(seg: TranscriptSegment): boolean {
    const words = seg.words ?? []
    const wordCount = words.length
    const durationSeconds = Math.max(seg.endTime - seg.startTime, 0)
    if (wordCount === 0) return false

    const avgSpeakerConfidence = words.reduce((sum, word) => {
      const conf = Number.isFinite(word.speakerConfidence) ? word.speakerConfidence : 0
      return sum + conf
    }, 0) / wordCount

    const hasEnoughSpeech =
      wordCount >= SPEAKER_SWITCH_MIN_WORDS || durationSeconds >= SPEAKER_SWITCH_MIN_DURATION_SECONDS

    return hasEnoughSpeech && avgSpeakerConfidence >= SPEAKER_SWITCH_MIN_CONFIDENCE
  }

  private reassignSegmentSpeaker(seg: TranscriptSegment, speaker: number): TranscriptSegment {
    return {
      ...seg,
      speaker,
      words: (seg.words ?? []).map((word) => ({
        ...word,
        speaker
      }))
    }
  }

  private mergeAdjacentSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
    if (segments.length <= 1) return segments

    const merged: TranscriptSegment[] = []
    for (const seg of segments) {
      const prev = merged[merged.length - 1]
      if (prev && prev.speaker === seg.speaker) {
        prev.text += ' ' + seg.text
        prev.endTime = seg.endTime
        ;(prev.words ??= []).push(...(seg.words ?? []))
      } else {
        merged.push({
          ...seg,
          words: [...(seg.words ?? [])]
        })
      }
    }
    return merged
  }

  private inferFallbackSpeaker(): number {
    if (this.currentInterim) return this.currentInterim.speaker
    const lastFinalized = this.finalizedSegments[this.finalizedSegments.length - 1]
    if (lastFinalized) return lastFinalized.speaker
    return 0
  }

  private buildTextOnlySegment(result: NormalizedTranscriptResult): TranscriptSegment | null {
    const cleanedText = result.text.trim()
    if (!cleanedText) return null

    const speaker = this.inferFallbackSpeaker()
    const startTime = result.start + this.timeOffset
    const duration = Math.max(result.duration, 0.05)
    const endTime = startTime + duration
    const fallbackWord: TranscriptWord = {
      word: cleanedText,
      start: startTime,
      end: endTime,
      confidence: 0.8,
      speaker,
      speakerConfidence: 1,
      punctuatedWord: cleanedText
    }

    return {
      speaker,
      text: cleanedText,
      startTime,
      endTime,
      isFinal: true,
      words: [fallbackWord]
    }
  }

  getDisplaySegments(): TranscriptSegment[] {
    const segments = [...this.finalizedSegments]
    if (this.currentInterim) {
      segments.push({ ...this.currentInterim, isFinal: false })
    }
    return segments
  }

  getFinalizedSegments(): TranscriptSegment[] {
    return [...this.finalizedSegments]
  }

  getInterimSegment(): TranscriptSegment | null {
    return this.currentInterim
  }

  getSpeakerCount(): number {
    return this.knownSpeakers.size
  }

  /**
   * Returns the set of speaker IDs that actually appear in the finalized segments.
   * Use this after post-processing to build an accurate speaker map.
   */
  getFinalizedSpeakerIds(): Set<number> {
    const ids = new Set<number>()
    for (const seg of this.finalizedSegments) {
      ids.add(seg.speaker)
    }
    return ids
  }

  getFullText(): string {
    return this.finalizedSegments.map((s) => s.text).join(' ')
  }

  toMarkdown(speakerMap: Record<number, string> = {}): string {
    let md = ''
    let lastSpeaker = -1

    for (const seg of this.finalizedSegments) {
      const speaker = speakerMap[seg.speaker] || `Speaker ${seg.speaker + 1}`
      const timestamp = this.formatTimestamp(seg.startTime)

      if (seg.speaker !== lastSpeaker) {
        if (md) md += '\n'
        md += `**${speaker}** [${timestamp}]\n`
        lastSpeaker = seg.speaker
      }

      md += `${seg.text}\n`
    }

    return md
  }

  private formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    }
    return `${m}:${String(s).padStart(2, '0')}`
  }

  /**
   * Restore previously saved segments for append-to-existing recording.
   * Sets timeOffset so new segments continue after the last restored segment.
   */
  restoreSegments(segments: TranscriptSegment[]): void {
    this.finalizedSegments = [...segments]
    for (const seg of segments) {
      this.knownSpeakers.add(seg.speaker)
    }
    if (segments.length > 0) {
      const lastEnd = segments[segments.length - 1].endTime
      this.timeOffset = lastEnd
    }
  }

  /**
   * Correct speaker boundaries by examining word-level confidence at segment edges.
   * Pass 1: If trailing words of segment A have low confidence and segment B
   *   has a different speaker, move those words to segment B.
   * Pass 2: Merge micro-segments (< 3 words, low avg confidence) into adjacent segments.
   *
   * No-op for providers that don't supply per-word speaker confidence
   * (notably AssemblyAI Universal-Streaming). Default-1.0 confidence from
   * those providers means the < 0.4 threshold is never crossed → nothing
   * moves → algorithm is effectively skipped, which is the right answer:
   * trust the provider's speaker labels rather than second-guess them with
   * a heuristic that doesn't apply.
   */
  correctSpeakerBoundaries(): void {
    if (this.finalizedSegments.length < 2) return

    // --- Pass 1: Tail correction ---
    for (let i = 0; i < this.finalizedSegments.length - 1; i++) {
      const segA = this.finalizedSegments[i]
      const segB = this.finalizedSegments[i + 1]

      if (segA.speaker === segB.speaker) continue
      // Word-level metadata is stripped at the persistence boundary
      // (getSerializableState); tail correction is a no-op without it.
      const segAWords = segA.words
      const segBWords = segB.words
      if (!segAWords || !segBWords) continue
      if (segAWords.length < 2) continue

      // Count trailing low-confidence words in segA
      let moveCount = 0
      for (let w = segAWords.length - 1; w >= 1; w--) {
        const segAWord = segAWords[w]
        if (segAWord && segAWord.speakerConfidence < 0.4) {
          moveCount++
        } else {
          break
        }
      }

      if (moveCount === 0) continue

      // Move trailing words from segA to front of segB
      const movedWords = segAWords.splice(segAWords.length - moveCount)
      for (const w of movedWords) {
        w.speaker = segB.speaker
      }
      segBWords.unshift(...movedWords)

      // Rebuild text and times
      segA.text = segAWords.map((w) => w.punctuatedWord).join(' ')
      const segALast = segAWords[segAWords.length - 1]
      if (segALast) segA.endTime = segALast.end
      segB.text = segBWords.map((w) => w.punctuatedWord).join(' ')
      const segBFirst = segBWords[0]
      if (segBFirst) segB.startTime = segBFirst.start
    }

    // --- Pass 2: Merge micro-segments ---
    const merged: TranscriptSegment[] = []
    for (const seg of this.finalizedSegments) {
      const segWords = seg.words
      const avgConf =
        segWords && segWords.length > 0
          ? segWords.reduce((sum, w) => sum + w.speakerConfidence, 0) / segWords.length
          : 0

      const prev = merged[merged.length - 1]
      if (segWords && segWords.length < 3 && avgConf < 0.4 && prev) {
        for (const w of segWords) {
          w.speaker = prev.speaker
        }
        ;(prev.words ??= []).push(...segWords)
        prev.text += ' ' + segWords.map((w) => w.punctuatedWord).join(' ')
        const segLast = segWords[segWords.length - 1]
        if (segLast) prev.endTime = segLast.end
      } else {
        merged.push(seg)
      }
    }

    this.finalizedSegments = merged
  }

  /**
   * Collapse adjacent segments that already share the same speaker. Purely
   * cosmetic: Deepgram occasionally emits two consecutive segments for the
   * same speaker (e.g. on a pause) and joining them makes the transcript
   * read more naturally.
   *
   * Historically this method ALSO clamped any over-diarized speaker index
   * (`speaker > expectedCount`) to a single phantom bucket — a partial fix
   * for the "3 speaker chips in a 2-attendee meeting" complaint. That
   * clamp is gone as of the me/them redesign (Part 3 of the
   * cheeky-treasure plan): the render-time bubble view collapses every
   * non-me speaker into "them" regardless of Deepgram index, so phantom
   * indices no longer sprawl into the UI.
   *
   * `expectedCount` is accepted but ignored; kept in the signature so
   * RecordingSession's existing call site doesn't need to change.
   */
  consolidateSpeakers(_expectedCount: number): void {
    if (this.finalizedSegments.length === 0) return

    const collapsed: TranscriptSegment[] = []
    for (const seg of this.finalizedSegments) {
      const prev = collapsed[collapsed.length - 1]
      if (prev && prev.speaker === seg.speaker) {
        prev.text += ' ' + seg.text
        prev.endTime = seg.endTime
        ;(prev.words ??= []).push(...(seg.words ?? []))
      } else {
        collapsed.push(seg)
      }
    }

    this.finalizedSegments = collapsed

    this.knownSpeakers.clear()
    for (const seg of this.finalizedSegments) {
      this.knownSpeakers.add(seg.speaker)
    }
  }

  /**
   * Finalize any pending interim segment. Call this before saving
   * to ensure the last words aren't lost.
   */
  finalize(): void {
    if (this.currentInterim) {
      this.finalizedSegments.push({ ...this.currentInterim, isFinal: true })
      this.currentInterim = null
    }
  }

  getSerializableState(): TranscriptSegment[] {
    // T39 (2026-05-23) — strip per-word metadata at persistence boundary.
    // Live assembly needs `words` for re-segmentation, but persisting them
    // bloats each meeting row to 1-4 MB (mostly per-word timing JSON),
    // which broke desktop→Neon sync. Read consumers (transcript display,
    // chat context-builders, FTS) only need utterance-level text + timing.
    return this.finalizedSegments.map((s) => ({
      speaker: s.speaker,
      text: s.text,
      startTime: s.startTime,
      endTime: s.endTime,
      isFinal: s.isFinal,
    }))
  }

  reset(): void {
    this.finalizedSegments = []
    this.currentInterim = null
    this.knownSpeakers.clear()
    this.timeOffset = 0
    this.channelMode = 'diarization'
    this.consecutiveSuppressedSwitches = 0
    this.suppressedSwitchTargetSpeaker = null
    this.totalSuppressedSwitches = 0
    this.dedupDroppedCount = 0
    this.recentByChannel.clear()
  }
}

// Module-level helpers (pure) ────────────────────────────────────────────────

function avgWordConfidence(seg: TranscriptSegment): number {
  const words = seg.words ?? []
  if (words.length === 0) return 0
  let sum = 0
  for (const w of words) sum += Number.isFinite(w.confidence) ? w.confidence : 0
  return sum / words.length
}

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEDUP_TEXT_PREFIX_CHARS)
}

function timeIoU(a: TranscriptSegment, b: TranscriptSegment): number {
  const overlap = Math.max(0, Math.min(a.endTime, b.endTime) - Math.max(a.startTime, b.startTime))
  if (overlap <= 0) return 0
  const union = Math.max(a.endTime, b.endTime) - Math.min(a.startTime, b.startTime)
  return union > 0 ? overlap / union : 0
}

export function isDuplicateOf(a: TranscriptSegment, b: TranscriptSegment): boolean {
  if (timeIoU(a, b) < DEDUP_TIME_IOU_MIN) return false
  const aText = normalizeForDedup(a.text)
  const bText = normalizeForDedup(b.text)
  if (aText.length === 0 || bText.length === 0) return false
  return jaroWinkler(aText, bText) >= DEDUP_TEXT_SIMILARITY_MIN
}
