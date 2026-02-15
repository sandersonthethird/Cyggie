import type { TranscriptResult, DeepgramWord } from './types'
import type { TranscriptSegment, TranscriptWord } from '../../shared/types/recording'

export class TranscriptAssembler {
  private finalizedSegments: TranscriptSegment[] = []
  private currentInterim: TranscriptSegment | null = null
  private knownSpeakers = new Set<number>()
  private timeOffset = 0
  private isMultichannel: boolean
  private activeChannels = new Set<number>()

  constructor(multichannel: boolean = false) {
    this.isMultichannel = multichannel
  }

  setMultichannel(enabled: boolean): void {
    this.isMultichannel = enabled
  }

  addResult(result: TranscriptResult): void {
    if (!result.text.trim()) return

    // Diagnostic: log speaker confidence values for tuning
    if (result.isFinal && result.words.length > 0) {
      const confValues = result.words.map((w) => w.speaker_confidence?.toFixed(2) ?? 'N/A')
      const speakers = result.words.map((w) => w.speaker)
      console.log(
        `[TranscriptAssembler] ch=${result.channelIndex} speakers=[${[...new Set(speakers)]}] ` +
          `confidence=[${confValues.join(',')}] text="${result.text.substring(0, 60)}..."`
      )
    }

    this.activeChannels.add(result.channelIndex)

    const useMultichannel = this.isMultichannel
    const words = useMultichannel
      ? this.remapSpeakers(result.words, result.channelIndex)
      : result.words

    const segments = this.groupWordsBySpeaker(words)

    if (result.isFinal) {
      for (const seg of segments) {
        if (useMultichannel) {
          this.insertChronologically(seg)
        } else {
          this.finalizedSegments.push(seg)
        }
        this.knownSpeakers.add(seg.speaker)
      }
      this.currentInterim = null
    } else {
      // Only update interim display
      this.currentInterim = segments[segments.length - 1] || null
      for (const seg of segments) {
        this.knownSpeakers.add(seg.speaker)
      }
    }
  }

  /**
   * Remap speaker IDs based on audio channel.
   * Channel 0 (mic) = always speaker 0 (local user).
   * Channel 1 (system) = Deepgram's speaker IDs offset by +1.
   */
  private remapSpeakers(words: DeepgramWord[], channelIndex: number): DeepgramWord[] {
    return words.map((w) => {
      if (channelIndex === 0) {
        return { ...w, speaker: 0, speaker_confidence: 1.0 }
      } else {
        return { ...w, speaker: (w.speaker ?? 0) + 1 }
      }
    })
  }

  /**
   * Insert a segment into finalizedSegments in chronological order.
   * Multichannel results from channels 0 and 1 may arrive interleaved.
   * Merges with adjacent same-speaker segments when close in time.
   */
  private insertChronologically(seg: TranscriptSegment): void {
    // Fast path: segment is after the last one (most common)
    if (this.finalizedSegments.length === 0) {
      this.finalizedSegments.push(seg)
      return
    }

    const last = this.finalizedSegments[this.finalizedSegments.length - 1]
    if (seg.startTime >= last.startTime) {
      // Merge with previous if same speaker and close in time
      if (last.speaker === seg.speaker && seg.startTime - last.endTime < 2.0) {
        last.text += ' ' + seg.text
        last.endTime = seg.endTime
        last.words.push(...seg.words)
        return
      }
      this.finalizedSegments.push(seg)
      return
    }

    // Slow path: binary search for insertion point
    let lo = 0
    let hi = this.finalizedSegments.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.finalizedSegments[mid].startTime < seg.startTime) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    this.finalizedSegments.splice(lo, 0, seg)
  }

  private groupWordsBySpeaker(words: DeepgramWord[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = []
    let current: TranscriptSegment | null = null

    for (const word of words) {
      const tw: TranscriptWord = {
        word: word.word,
        start: word.start + this.timeOffset,
        end: word.end + this.timeOffset,
        confidence: word.confidence,
        speaker: word.speaker,
        speakerConfidence: word.speaker_confidence,
        punctuatedWord: word.punctuated_word
      }

      if (!current || current.speaker !== word.speaker) {
        if (current) segments.push(current)
        current = {
          speaker: word.speaker,
          text: word.punctuated_word,
          startTime: word.start + this.timeOffset,
          endTime: word.end + this.timeOffset,
          isFinal: true,
          words: [tw]
        }
      } else {
        current.text += ' ' + word.punctuated_word
        current.endTime = word.end + this.timeOffset
        current.words.push(tw)
      }
    }

    if (current) segments.push(current)
    return segments
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
   * Merge phantom speaker segments into adjacent real speakers.
   * Deepgram's max_speakers is only a hint — it still creates extra speakers.
   * When we know the real participant count from the calendar, reassign all
   * segments from phantom speakers (index >= expectedCount) to the previous
   * real speaker.
   */
  consolidateSpeakers(expectedCount: number): void {
    if (expectedCount <= 0 || this.finalizedSegments.length === 0) return

    const merged: TranscriptSegment[] = []

    for (const seg of this.finalizedSegments) {
      if (seg.speaker >= expectedCount) {
        if (merged.length > 0) {
          // Merge into the previous segment
          const prev = merged[merged.length - 1]
          prev.text += ' ' + seg.text
          prev.endTime = seg.endTime
          prev.words.push(
            ...seg.words.map((w) => ({ ...w, speaker: prev.speaker }))
          )
        } else {
          // No previous segment yet — assign to speaker 0
          merged.push({
            ...seg,
            speaker: 0,
            words: seg.words.map((w) => ({ ...w, speaker: 0 }))
          })
        }
      } else {
        merged.push(seg)
      }
    }

    // Collapse adjacent segments that now share the same speaker
    const collapsed: TranscriptSegment[] = []
    for (const seg of merged) {
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

    // Rebuild knownSpeakers from consolidated segments
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
    return [...this.finalizedSegments]
  }

  reset(): void {
    this.finalizedSegments = []
    this.currentInterim = null
    this.knownSpeakers.clear()
    this.activeChannels.clear()
    this.timeOffset = 0
  }
}
