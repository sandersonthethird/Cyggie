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
  words: TranscriptWord[]
}

export interface RecordingStatus {
  isRecording: boolean
  isPaused: boolean
  meetingId: string | null
  startTime: number | null
  durationSeconds: number
  speakerCount: number
}
