export interface TranscriptWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker: number
  speakerConfidence: number
  punctuatedWord: string
}

export interface TranscriptSegment {
  speaker: number
  text: string
  startTime: number
  endTime: number
  isFinal: boolean
  /**
   * Per-word timing + confidence metadata. PRESENT during live assembly
   * (the TranscriptAssembler needs words for its re-segmentation logic);
   * ABSENT after persistence (getSerializableState strips it, T39
   * 2026-05-23 — meeting rows were averaging 1 MB and topping out at
   * 4 MB because of this column, which broke desktop→Neon sync). Read
   * code must treat this as optional.
   */
  words?: TranscriptWord[]
}

export interface RecordingStatus {
  isRecording: boolean
  isPaused: boolean
  meetingId: string | null
  startTime: number | null
  durationSeconds: number
  speakerCount: number
  channelMode?: 'detecting' | 'multichannel' | 'diarization'
}
