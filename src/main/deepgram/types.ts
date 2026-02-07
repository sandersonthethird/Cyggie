export interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  speaker: number
  speaker_confidence: number
  punctuated_word: string
}

export interface DeepgramAlternative {
  transcript: string
  confidence: number
  words: DeepgramWord[]
}

export interface DeepgramChannel {
  alternatives: DeepgramAlternative[]
}

export interface DeepgramResult {
  type: string
  channel_index: number[]
  duration: number
  start: number
  is_final: boolean
  speech_final: boolean
  channel: DeepgramChannel
}

export interface TranscriptResult {
  text: string
  words: DeepgramWord[]
  isFinal: boolean
  speechFinal: boolean
  start: number
  duration: number
}

export interface DeepgramConfig {
  apiKey: string
  model?: string
  language?: string
  sampleRate?: number
  channels?: number
  encoding?: string
}
