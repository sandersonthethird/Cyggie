import { EventEmitter } from 'events'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import type { DeepgramConfig, TranscriptResult, DeepgramWord } from './types'
// import { DEFAULT_DEEPGRAM_KEYWORDS } from '../../shared/constants/deepgram-keywords'

export class DeepgramStreamingClient extends EventEmitter {
  private connection: ReturnType<ReturnType<typeof createClient>['listen']['live']> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null
  private audioBuffer: Buffer[] = []
  private isClosing = false
  private config: Required<DeepgramConfig>

  constructor(config: DeepgramConfig) {
    super()
    this.config = {
      apiKey: config.apiKey,
      model: config.model || 'nova-3',
      language: config.language || 'en',
      sampleRate: config.sampleRate || 16000,
      channels: config.channels || 1,
      encoding: config.encoding || 'linear16'
    }
  }

  async connect(): Promise<void> {
    this.isClosing = false
    const client = createClient(this.config.apiKey)

    this.connection = client.listen.live({
      model: this.config.model,
      language: this.config.language,
      smart_format: true,
      diarize: true,
      interim_results: true,
      utterance_end_ms: 1500,
      endpointing: 300,
      // keywords: DEFAULT_DEEPGRAM_KEYWORDS,  // Disabled - may cause connection issues
      encoding: this.config.encoding as 'linear16',
      sample_rate: this.config.sampleRate,
      channels: this.config.channels
    })

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      this.reconnectAttempts = 0
      this.startKeepAlive()
      this.flushBufferedAudio()
      this.emit('connected')
    })

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
      this.handleTranscriptResult(data)
    })

    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.emit('utterance-end')
    })

    this.connection.on(LiveTranscriptionEvents.Error, (error: unknown) => {
      // Extract meaningful error message from various error types
      let errorMessage: string
      if (error instanceof Error) {
        errorMessage = error.message
      } else if (typeof error === 'object' && error !== null) {
        // Handle ErrorEvent or similar objects
        const err = error as { message?: string; error?: string; reason?: string }
        errorMessage = err.message || err.error || err.reason || JSON.stringify(error)
      } else {
        errorMessage = String(error)
      }
      console.error('[Deepgram] WebSocket error:', errorMessage, error)
      this.emit('error', errorMessage)
      if (!this.isClosing) {
        this.attemptReconnect()
      }
    })

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      this.stopKeepAlive()
      this.emit('disconnected')
    })
  }

  sendAudio(chunk: Buffer): void {
    if (this.connection && this.connection.getReadyState() === 1) {
      this.connection.send(chunk)
    } else {
      this.audioBuffer.push(chunk)
      // Rolling buffer - keep last ~5 seconds at 100ms chunks
      if (this.audioBuffer.length > 50) {
        this.audioBuffer.shift()
      }
    }
  }

  private handleTranscriptResult(data: unknown): void {
    const result = data as {
      is_final: boolean
      speech_final: boolean
      start: number
      duration: number
      channel: {
        alternatives: Array<{
          transcript: string
          words: DeepgramWord[]
        }>
      }
    }

    const alternative = result.channel?.alternatives?.[0]
    if (!alternative || !alternative.transcript.trim()) return

    const transcriptResult: TranscriptResult = {
      text: alternative.transcript,
      words: (alternative.words || []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
        speaker: w.speaker ?? 0,
        speaker_confidence: w.speaker_confidence ?? 0,
        punctuated_word: w.punctuated_word || w.word
      })),
      isFinal: result.is_final,
      speechFinal: result.speech_final,
      start: result.start,
      duration: result.duration
    }

    this.emit('transcript', transcriptResult)
  }

  private flushBufferedAudio(): void {
    while (this.audioBuffer.length > 0) {
      const chunk = this.audioBuffer.shift()
      if (chunk && this.connection && this.connection.getReadyState() === 1) {
        this.connection.send(chunk)
      }
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveInterval = setInterval(() => {
      if (this.connection && this.connection.getReadyState() === 1) {
        this.connection.keepAlive()
      }
    }, 8000)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.isClosing) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('max-reconnect-reached')
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay })

    await new Promise((resolve) => setTimeout(resolve, delay))
    if (!this.isClosing) {
      await this.connect()
    }
  }

  async close(): Promise<void> {
    this.isClosing = true
    this.stopKeepAlive()
    this.audioBuffer = []
    if (this.connection) {
      this.connection.requestClose()
      this.connection = null
    }
  }
}
