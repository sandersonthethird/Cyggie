import { EventEmitter } from 'events'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import type { DeepgramConfig, DeepgramWord } from './types'
import type {
  NormalizedTranscriptResult,
  StreamingTranscriber,
  TranscriptionProvider,
  TranscriberErrorCode,
} from '../transcription/types'

interface FinalizeCloseOptions {
  quietMs?: number
  maxWaitMs?: number
  closeWaitMs?: number
}

/**
 * Extract the exact bytes of a Buffer as a standalone ArrayBuffer. Node
 * Buffers are views into a shared pool, so we slice on byteOffset/byteLength
 * to avoid sending the whole backing pool. Deepgram's `send` accepts
 * `string | ArrayBufferLike | Blob`, not Node's Buffer type directly.
 */
function toArrayBuffer(chunk: Buffer): ArrayBufferLike {
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
}

export class DeepgramStreamingClient extends EventEmitter implements StreamingTranscriber {
  readonly provider: TranscriptionProvider = 'deepgram'

  private emitError(code: TranscriberErrorCode, message: string, context?: object): void {
    this.emit('error', { code, message, context, provider: this.provider })
  }

  private connection: ReturnType<ReturnType<typeof createClient>['listen']['live']> | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null
  private audioBuffer: Buffer[] = []
  private isClosing = false
  private lastTranscriptAt = 0
  private warnedAboutKeytermModel = false
  private warnedAboutMissingChannelIndex = false
  private config: Required<Omit<DeepgramConfig, 'maxSpeakers'>> & Pick<DeepgramConfig, 'maxSpeakers'>
    & { keyterms: string[] }

  constructor(config: DeepgramConfig) {
    super()
    this.config = {
      apiKey: config.apiKey,
      model: config.model || 'nova-3',
      language: config.language || 'en',
      sampleRate: config.sampleRate || 16000,
      channels: config.channels || 1,
      encoding: config.encoding || 'linear16',
      maxSpeakers: config.maxSpeakers,
      keyterms: config.keyterms || []
    }
  }

  private buildLiveOptions(includeKeyterms: boolean): Record<string, unknown> {
    const supportsKeyterm = this.config.model.startsWith('nova-3')
    const keyterms = includeKeyterms && supportsKeyterm ? this.config.keyterms : []

    if (includeKeyterms && this.config.keyterms.length > 0 && !supportsKeyterm && !this.warnedAboutKeytermModel) {
      this.warnedAboutKeytermModel = true
      console.warn(
        `[Deepgram] keyterms were provided but model "${this.config.model}" does not support keyterms.`
      )
    }

    return {
      model: this.config.model,
      language: this.config.language,
      smart_format: true,
      diarize: true,
      ...(this.config.maxSpeakers ? { max_speakers: this.config.maxSpeakers } : {}),
      interim_results: true,
      utterance_end_ms: 1500,
      endpointing: 300,
      vad_events: true,
      ...(this.config.channels > 1 ? { multichannel: true } : {}),
      ...(keyterms.length > 0 ? { keyterm: keyterms } : {}),
      encoding: this.config.encoding as 'linear16',
      sample_rate: this.config.sampleRate,
      channels: this.config.channels
    }
  }

  async connect(): Promise<void> {
    this.isClosing = false
    const client = createClient(this.config.apiKey)
    try {
      this.connection = client.listen.live(this.buildLiveOptions(true))
    } catch (err) {
      // Defensive retry ladder for synchronous live() failures. Order:
      //   1) drop keyterms (some plans/models reject the `keyterm` param)
      //   2) drop multichannel (force channels=1; the caller must downmix)
      // Both layers log structured warnings; multichannel rejection also
      // emits a 'multichannel-rejected' event so RecordingSession can
      // banner the UI and stop sending stereo PCM.
      const couldRetryKeyterms = this.config.keyterms.length > 0
      const couldRetryMultichannel = this.config.channels > 1
      if (couldRetryKeyterms) {
        console.warn('[Deepgram] Failed to initialize with keyterms; retrying without keyterms:', err)
        try {
          this.connection = client.listen.live(this.buildLiveOptions(false))
        } catch (err2) {
          if (couldRetryMultichannel) {
            console.warn(
              '[Deepgram] live() rejected after keyterm drop; retrying with channels=1:',
              err2,
            )
            this.config.channels = 1
            this.emit('multichannel-rejected', {
              reason: err2 instanceof Error ? err2.message : String(err2),
            })
            this.connection = client.listen.live(this.buildLiveOptions(false))
          } else {
            throw err2
          }
        }
      } else if (couldRetryMultichannel) {
        console.warn('[Deepgram] live() rejected with multichannel; retrying with channels=1:', err)
        this.config.channels = 1
        this.emit('multichannel-rejected', {
          reason: err instanceof Error ? err.message : String(err),
        })
        this.connection = client.listen.live(this.buildLiveOptions(false))
      } else {
        throw err
      }
    }

    // Resolve connect() only when the WebSocket is actually open (or
    // reject on a connection-time error). The factory's bidirectional
    // fallback policy depends on connect() honestly reflecting whether
    // we're ready for audio; before this change, connect() resolved
    // synchronously and errors fired into a void.
    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      const onOpen = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const onErrorOnce = (err: unknown): void => {
        if (settled) return
        settled = true
        const message = err instanceof Error ? err.message : String(err)
        reject(new Error(`Deepgram connect failed: ${message}`))
      }
      this.connection!.once(LiveTranscriptionEvents.Open, onOpen)
      this.connection!.once(LiveTranscriptionEvents.Error, onErrorOnce)
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
      this.emitError('CONNECT_FAILED', errorMessage, { raw: String(error) })
      if (!this.isClosing) {
        this.attemptReconnect()
      }
    })

    this.connection.on(LiveTranscriptionEvents.Close, () => {
      this.stopKeepAlive()
      this.emit('disconnected')
    })

    await readyPromise
  }

  sendAudio(chunk: Buffer): void {
    if (this.connection && this.connection.getReadyState() === 1) {
      this.connection.send(toArrayBuffer(chunk))
    } else {
      this.audioBuffer.push(chunk)
      // Rolling buffer - keep last ~5 seconds at 100ms chunks
      if (this.audioBuffer.length > 50) {
        this.audioBuffer.shift()
      }
    }
  }

  private handleTranscriptResult(data: unknown): void {
    this.lastTranscriptAt = Date.now()
    const result = data as {
      is_final: boolean
      speech_final: boolean
      start: number
      duration: number
      from_finalize?: boolean
      channel_index: number[]
      channel: {
        alternatives: Array<{
          transcript: string
          words: DeepgramWord[]
        }>
      }
    }

    const alternative = result.channel?.alternatives?.[0]
    if (!alternative || !alternative.transcript.trim()) return

    // Deepgram emits `channel_index: [thisChannel, totalChannels]` on
    // every Results message. In multichannel mode the assembler relies
    // on the per-event channel attribution to run cross-channel dedup
    // (transcript-assembler.ts), so it MUST come from the SDK rather
    // than being hard-coded to 0.
    let channelIndex = 0
    if (Array.isArray(result.channel_index) && result.channel_index.length > 0) {
      channelIndex = result.channel_index[0]
    } else if (this.config.channels > 1 && !this.warnedAboutMissingChannelIndex) {
      // Once-per-session structured warn: a multichannel session that
      // started receiving channel_index-less events would corrupt dedup.
      this.warnedAboutMissingChannelIndex = true
      console.warn(
        '[Deepgram] Multichannel session received Results message without channel_index;',
        'falling back to channelIndex=0. Dedup pass will be skipped for these events.',
        { configuredChannels: this.config.channels },
      )
    }

    const transcriptResult: NormalizedTranscriptResult = {
      text: alternative.transcript,
      words: (alternative.words || []).map((w) => ({
        word: w.word,
        start: w.start,
        end: w.end,
        confidence: w.confidence,
        speaker: w.speaker ?? 0,
        speakerConfidence: w.speaker_confidence ?? 0,
        punctuatedWord: w.punctuated_word || w.word,
      })),
      isFinal: result.is_final,
      speechFinal: result.speech_final,
      start: result.start,
      duration: result.duration,
      channelIndex,
      fromFinalize: result.from_finalize,
    }

    this.emit('transcript', transcriptResult)
  }

  private flushBufferedAudio(): void {
    while (this.audioBuffer.length > 0) {
      const chunk = this.audioBuffer.shift()
      if (chunk && this.connection && this.connection.getReadyState() === 1) {
        this.connection.send(toArrayBuffer(chunk))
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

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async waitForTranscriptDrain(quietMs: number, maxWaitMs: number): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
      const sinceLastTranscript = Date.now() - this.lastTranscriptAt
      if (sinceLastTranscript >= quietMs) return
      await this.delay(Math.min(quietMs, 200))
    }
  }

  private async waitForDisconnected(timeoutMs: number): Promise<void> {
    if (!this.connection || this.connection.getReadyState() !== 1) return
    await new Promise<void>((resolve) => {
      const onDisconnected = () => {
        clearTimeout(timer)
        this.off('disconnected', onDisconnected)
        resolve()
      }
      const timer = setTimeout(() => {
        this.off('disconnected', onDisconnected)
        resolve()
      }, timeoutMs)
      this.on('disconnected', onDisconnected)
    })
  }

  async finalizeAndClose(options: FinalizeCloseOptions = {}): Promise<void> {
    const quietMs = options.quietMs ?? 900
    const maxWaitMs = options.maxWaitMs ?? 8000
    const closeWaitMs = options.closeWaitMs ?? 3000

    this.isClosing = true
    this.stopKeepAlive()

    const connection = this.connection
    if (!connection) {
      this.audioBuffer = []
      return
    }

    try {
      if (connection.getReadyState() === 1) {
        // Start a fresh quiet-window from finalize() so we don't close
        // immediately when the last transcript event was long ago.
        this.lastTranscriptAt = Date.now()
        connection.finalize()
        await this.waitForTranscriptDrain(quietMs, maxWaitMs)
        connection.requestClose()
        await this.waitForDisconnected(closeWaitMs)
      }
    } finally {
      this.connection = null
      this.audioBuffer = []
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
