import type { NormalizedTranscriptResult, NormalizedWord } from '../transcription/types'
import type { TranscriptSegment, TranscriptWord } from '../../shared/types/recording'

/**
 * Channel mode is always 'diarization' now. The recording path downmixes
 * stereo capture to mono before sending to the streaming client, so neither
 * provider sees per-channel audio. The 'detecting' and 'multichannel'
 * states + the auto-detection state machine were removed 2026-05-28 when
 * the live picker rolled out — multichannel mode caused the Zoom-bleed
 * doubling bug and we always send mono now.
 *
 * `getChannelMode()` is preserved (returns 'diarization' always) so existing
 * status-broadcast callers in RecordingSession don't need to change.
 */
type ChannelMode = 'diarization'

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
  private expectedSpeakerCount: number | null = null
  private consecutiveSuppressedSwitches = 0
  private suppressedSwitchTargetSpeaker: number | null = null
  private totalSuppressedSwitches = 0

  private readonly channelMode: ChannelMode = 'diarization'

  constructor() {
    // no-op
  }

  setExpectedSpeakerCount(expectedCount?: number): void {
    if (typeof expectedCount !== 'number' || !Number.isFinite(expectedCount) || expectedCount <= 0) {
      this.expectedSpeakerCount = null
      return
    }
    this.expectedSpeakerCount = Math.max(1, Math.floor(expectedCount))
  }

  /**
   * Legacy no-op. Used to commit the assembler to diarization mode early
   * before the auto-detection threshold was reached. Now always-diarization,
   * so callers can safely keep calling this without effect.
   */
  setSystemAudioUnavailable(): void {
    // intentional no-op (always-diarization mode)
  }

  getChannelMode(): ChannelMode {
    return this.channelMode
  }

  getDiagnostics(): {
    channelMode: ChannelMode
    speakerCount: number
    totalSegments: number
    totalSuppressedSwitches: number
  } {
    return {
      channelMode: this.channelMode,
      speakerCount: this.knownSpeakers.size,
      totalSegments: this.finalizedSegments.length,
      totalSuppressedSwitches: this.totalSuppressedSwitches
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
    const normalizedSegments = this.normalizeToExpectedSpeakerCount(stabilizedSegments)

    if (result.isFinal) {
      for (const seg of normalizedSegments) {
        this.finalizedSegments.push(seg)
        this.knownSpeakers.add(seg.speaker)
      }
      this.currentInterim = null
    } else {
      this.currentInterim = normalizedSegments[normalizedSegments.length - 1] || null
      for (const seg of normalizedSegments) {
        this.knownSpeakers.add(seg.speaker)
      }
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
        current.words.push(tw)
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
            `from=${activeSpeaker} to=${seg.speaker} words=${seg.words.length} ` +
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
    const wordCount = seg.words.length
    const durationSeconds = Math.max(seg.endTime - seg.startTime, 0)
    if (wordCount === 0) return false

    const avgSpeakerConfidence = seg.words.reduce((sum, word) => {
      const conf = Number.isFinite(word.speakerConfidence) ? word.speakerConfidence : 0
      return sum + conf
    }, 0) / wordCount

    const hasEnoughSpeech =
      wordCount >= SPEAKER_SWITCH_MIN_WORDS || durationSeconds >= SPEAKER_SWITCH_MIN_DURATION_SECONDS

    return hasEnoughSpeech && avgSpeakerConfidence >= SPEAKER_SWITCH_MIN_CONFIDENCE
  }

  private normalizeToExpectedSpeakerCount(segments: TranscriptSegment[]): TranscriptSegment[] {
    const expectedCount = this.expectedSpeakerCount
    if (!expectedCount || expectedCount <= 0 || segments.length === 0) return segments

    let fallbackSpeaker = this.currentInterim?.speaker
      ?? this.finalizedSegments[this.finalizedSegments.length - 1]?.speaker
    const normalized: TranscriptSegment[] = []

    for (const seg of segments) {
      if (seg.speaker >= 0 && seg.speaker < expectedCount) {
        normalized.push(seg)
        fallbackSpeaker = seg.speaker
        continue
      }

      const safeFallback = typeof fallbackSpeaker === 'number'
        ? Math.max(0, Math.min(fallbackSpeaker, expectedCount - 1))
        : 0

      if (DEBUG_TRANSCRIPTION) {
        console.log(
          '[TranscriptAssembler] Remapping out-of-range speaker',
          `speaker=${seg.speaker} -> ${safeFallback} expectedCount=${expectedCount}`
        )
      }

      normalized.push(this.reassignSegmentSpeaker(seg, safeFallback))
      fallbackSpeaker = safeFallback
    }

    return this.mergeAdjacentSegments(normalized)
  }

  private reassignSegmentSpeaker(seg: TranscriptSegment, speaker: number): TranscriptSegment {
    return {
      ...seg,
      speaker,
      words: seg.words.map((word) => ({
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
        prev.words.push(...seg.words)
      } else {
        merged.push({
          ...seg,
          words: [...seg.words]
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
      if (segA.words.length < 2) continue

      // Count trailing low-confidence words in segA
      let moveCount = 0
      for (let w = segA.words.length - 1; w >= 1; w--) {
        if (segA.words[w].speakerConfidence < 0.4) {
          moveCount++
        } else {
          break
        }
      }

      if (moveCount === 0) continue

      // Move trailing words from segA to front of segB
      const movedWords = segA.words.splice(segA.words.length - moveCount)
      for (const w of movedWords) {
        w.speaker = segB.speaker
      }
      segB.words.unshift(...movedWords)

      // Rebuild text and times
      segA.text = segA.words.map((w) => w.punctuatedWord).join(' ')
      segA.endTime = segA.words[segA.words.length - 1].end
      segB.text = segB.words.map((w) => w.punctuatedWord).join(' ')
      segB.startTime = segB.words[0].start
    }

    // --- Pass 2: Merge micro-segments ---
    const merged: TranscriptSegment[] = []
    for (const seg of this.finalizedSegments) {
      const avgConf =
        seg.words.length > 0
          ? seg.words.reduce((sum, w) => sum + w.speakerConfidence, 0) / seg.words.length
          : 0

      if (seg.words.length < 3 && avgConf < 0.4 && merged.length > 0) {
        const prev = merged[merged.length - 1]
        for (const w of seg.words) {
          w.speaker = prev.speaker
        }
        prev.words.push(...seg.words)
        prev.text += ' ' + seg.words.map((w) => w.punctuatedWord).join(' ')
        prev.endTime = seg.words[seg.words.length - 1].end
      } else {
        merged.push(seg)
      }
    }

    this.finalizedSegments = merged
  }

  /**
   * Collapse adjacent segments that already share the same speaker.
   *
   * Historically this method ALSO merged "phantom" speaker segments
   * (Deepgram speaker index >= expectedCount) into the previous segment,
   * rewriting their speaker to match. The 2026-05-27 transcription-eval
   * surfaced what the original comment already warned about: that merge
   * systematically glues the user's brief interjections onto whoever was
   * just speaking ("my text got appended to the other person's text").
   * The rationale was already documented for the multichannel branch but
   * was never extended to single-channel — and after the
   * 2026-05-27 always-mono Deepgram fix, single-channel is now every call.
   *
   * The phantom-merge is therefore disabled. Phantom speakers stay at
   * (or near) their original indices and surface via buildSpeakerMap as
   * "Speaker N+1" etc., which the user can relabel in MeetingDetail
   * post-hoc. Cosmetic downside (a 2-person meeting may show 3-4 speakers)
   * is preferred over content-correctness downside (wrong attribution).
   *
   * expectedCount is used as a sanity cap: any speaker index strictly
   * greater than expectedCount is clamped to exactly expectedCount, so
   * over-diarization can't sprawl into "Speaker 3, 4, 5, 6, ..." labels.
   * All phantoms unify into a single "Speaker N+1" bucket where N is the
   * known-participant count.
   */
  consolidateSpeakers(expectedCount: number): void {
    if (this.finalizedSegments.length === 0) return

    // Sanity cap: clamp any over-diarized speaker index to exactly
    // expectedCount. The canonical phantom bucket sits at index
    // expectedCount (one above the highest known participant) and
    // surfaces via buildSpeakerMap as "Speaker N+1". This intentionally
    // does NOT merge phantoms into the previous real segment — that
    // merge was the root cause of the "my text got appended to the
    // other person's text" bug.
    if (expectedCount > 0) {
      for (const seg of this.finalizedSegments) {
        if (seg.speaker > expectedCount) {
          seg.speaker = expectedCount
          for (const w of seg.words) w.speaker = expectedCount
        }
      }
    }

    // Collapse adjacent segments that already share the same speaker. This
    // is purely cosmetic: Deepgram occasionally emits two consecutive
    // segments for the same speaker (e.g. on a pause), and joining them
    // makes the transcript read more naturally. After the cap above,
    // multiple consecutive phantom segments also unify into one block.
    const collapsed: TranscriptSegment[] = []
    for (const seg of this.finalizedSegments) {
      const prev = collapsed[collapsed.length - 1]
      if (prev && prev.speaker === seg.speaker) {
        prev.text += ' ' + seg.text
        prev.endTime = seg.endTime
        prev.words.push(...seg.words)
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
    this.activeChannels.clear()
    this.timeOffset = 0
    this.channelMode = 'detecting'
    this.channel0FinalCount = 0
    this.expectedSpeakerCount = null
    this.consecutiveSuppressedSwitches = 0
    this.suppressedSwitchTargetSpeaker = null
    this.totalSuppressedSwitches = 0
  }
}
