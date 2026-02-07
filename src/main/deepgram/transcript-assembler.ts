import type { TranscriptResult, DeepgramWord } from './types'
import type { TranscriptSegment, TranscriptWord } from '../../shared/types/recording'

export class TranscriptAssembler {
  private finalizedSegments: TranscriptSegment[] = []
  private currentInterim: TranscriptSegment | null = null
  private knownSpeakers = new Set<number>()
  private timeOffset = 0

  addResult(result: TranscriptResult): void {
    if (!result.text.trim()) return

    const segments = this.groupWordsBySpeaker(result.words)

    if (result.isFinal) {
      for (const seg of segments) {
        this.finalizedSegments.push(seg)
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
    this.timeOffset = 0
  }
}
