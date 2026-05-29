// AssemblyAI Universal-Streaming v3 WebSocket client.
//
// Implements the StreamingTranscriber interface so RecordingSession can
// treat it interchangeably with DeepgramStreamingClient. The resilience
// patterns (5-attempt reconnect, 50-chunk rolling audio buffer, 8-second
// keep-alive) mirror the Deepgram client so the two providers offer the
// same UX under network blips.
//
// Protocol (AssemblyAI v3):
//   • Endpoint: wss://streaming.assemblyai.com/v3/ws?<query params>
//   • Auth:     Authorization header with the API key
//   • Audio:    raw 16-bit signed little-endian PCM at 16kHz, 50-1000ms chunks
//   • Messages:
//       Begin       (session opened)
//       Turn        (rolling transcript; end_of_turn=true = final)
//       Termination (session closed)
//
// Pipeline:
//
//   ┌──────────────┐ PCM ┌─────────────┐ Turn  ┌──────────────────────┐
//   │ AudioCapture ├────▶│ WebSocket   ├──────▶│ this.handleTurn      │
//   └──────────────┘     │ (ws v8)     │       │   ├─ map letter→int  │
//                        └─────┬───────┘       │   ├─ ms→seconds      │
//                              │               │   └─ emit transcript │
//                              ▼               └──────────────────────┘
//                        Termination
//                              ▼
//                        emit disconnected

import { EventEmitter } from 'events'
import WebSocket from 'ws'
import type {
  NormalizedTranscriptResult,
  NormalizedWord,
  StreamingTranscriber,
  TranscriberErrorCode,
  TranscriptionProvider,
} from './types'

const ENDPOINT = 'wss://streaming.assemblyai.com/v3/ws'
const SAMPLE_RATE = 16000
const KEEP_ALIVE_MS = 8000
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BACKOFF_BASE_MS = 1000
const RECONNECT_BACKOFF_CAP_MS = 30000
const AUDIO_BUFFER_MAX_CHUNKS = 50 // ~5 seconds at 100ms chunks
const FINALIZE_TIMEOUT_DEFAULT_MS = 3000
const UNKNOWN_SPEAKER_INDEX = 999

interface AssemblyAiConfig {
  apiKey: string
  /** Vocabulary biasing terms → forwarded as keyterms_prompt. */
  keyterms?: string[]
  /** Reserved for future use; AssemblyAI streaming doesn't take a hint. */
  maxSpeakers?: number
}

interface FinalizeCloseOptions {
  quietMs?: number
  maxWaitMs?: number
  closeWaitMs?: number
}

interface AssemblyAiWord {
  text?: string
  start?: number
  end?: number
  confidence?: number
  /** Speaker letter (A/B/C/...) or 'UNKNOWN' for sub-1s turns. */
  speaker?: string
}

interface AssemblyAiTurn {
  type: 'Turn'
  transcript?: string
  end_of_turn?: boolean
  speaker_label?: string
  words?: AssemblyAiWord[]
  audio_start?: number
  audio_end?: number
}

interface AssemblyAiBegin {
  type: 'Begin'
  id?: string
  expires_at?: number
}

interface AssemblyAiTermination {
  type: 'Termination'
  audio_duration_seconds?: number
}

type AssemblyAiMessage = AssemblyAiTurn | AssemblyAiBegin | AssemblyAiTermination

export class AssemblyAiStreamingClient extends EventEmitter implements StreamingTranscriber {
  readonly provider: TranscriptionProvider = 'assemblyai'

  private ws: WebSocket | null = null
  private isClosing = false
  private reconnectAttempts = 0
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null
  private audioBuffer: Buffer[] = []
  private lastTranscriptAt = 0
  private readonly config: AssemblyAiConfig

  constructor(config: AssemblyAiConfig) {
    super()
    if (!config.apiKey) {
      throw new Error('AssemblyAI API key is required')
    }
    this.config = config
  }

  private emitError(code: TranscriberErrorCode, message: string, context?: object): void {
    this.emit('error', { code, message, context, provider: this.provider })
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      sample_rate: String(SAMPLE_RATE),
      encoding: 'pcm_s16le',
      speaker_labels: 'true',
      format_turns: 'true',
    })
    if (this.config.keyterms && this.config.keyterms.length > 0) {
      // AssemblyAI's "Keyterms Prompting" — biases recognition toward
      // these terms. Accepts a comma-separated list as a query param.
      params.set('keyterms_prompt', this.config.keyterms.join(','))
    }
    return `${ENDPOINT}?${params.toString()}`
  }

  async connect(): Promise<void> {
    this.isClosing = false

    const url = this.buildUrl()
    const ws = new WebSocket(url, {
      headers: { Authorization: this.config.apiKey },
    })
    this.ws = ws

    return new Promise<void>((resolve, reject) => {
      let settled = false

      ws.once('open', () => {
        this.reconnectAttempts = 0
        this.startKeepAlive()
        this.flushBufferedAudio()
        // Don't resolve here — wait for the Begin message to confirm
        // session-ready. AssemblyAI rejects auth/quota issues with a
        // Termination immediately after open without ever sending Begin.
      })

      ws.on('message', (data: WebSocket.RawData) => {
        let parsed: AssemblyAiMessage
        try {
          parsed = JSON.parse(data.toString()) as AssemblyAiMessage
        } catch (err) {
          this.emitError(
            'MALFORMED_TURN_PAYLOAD',
            'Could not parse AssemblyAI message as JSON',
            { raw: data.toString().slice(0, 200), error: String(err) },
          )
          return
        }

        switch (parsed.type) {
          case 'Begin':
            if (!settled) {
              settled = true
              this.emit('connected')
              resolve()
            }
            break
          case 'Turn':
            this.lastTranscriptAt = Date.now()
            this.handleTurn(parsed)
            break
          case 'Termination':
            // Server-initiated close — surface as both events so callers
            // can distinguish "we closed cleanly" from "server hung up."
            if (!this.isClosing) {
              this.emitError('SERVER_TERMINATED', 'AssemblyAI ended the session', {
                audioDurationSeconds: parsed.audio_duration_seconds,
              })
            }
            break
          default: {
            const type = (parsed as { type?: string }).type ?? 'unknown'
            this.emitError('UNKNOWN_MESSAGE_TYPE', `Unrecognized message type: ${type}`, {
              raw: data.toString().slice(0, 200),
            })
          }
        }
      })

      ws.on('error', (err: Error) => {
        this.emitError('CONNECT_FAILED', err.message, { raw: String(err) })
        if (!settled) {
          settled = true
          reject(err)
        }
        if (!this.isClosing) {
          this.attemptReconnect()
        }
      })

      ws.on('close', (code: number, reason: Buffer) => {
        this.stopKeepAlive()
        this.emit('disconnected')
        if (!settled) {
          settled = true
          reject(new Error(`AssemblyAI WebSocket closed before Begin (code=${code}, reason=${reason.toString()})`))
        }
        if (!this.isClosing && code !== 1000) {
          this.attemptReconnect()
        }
      })
    })
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    } else {
      // Buffer chunks while disconnected so we can replay on reconnect.
      this.audioBuffer.push(chunk)
      if (this.audioBuffer.length > AUDIO_BUFFER_MAX_CHUNKS) {
        this.audioBuffer.shift()
      }
    }
  }

  /**
   * Convert AssemblyAI's speaker label (A/B/C/UNKNOWN) to an integer index.
   * 'UNKNOWN' is reserved for sub-1-second turns; mapped to a high index
   * (UNKNOWN_SPEAKER_INDEX) so buildSpeakerMap can label it distinctly
   * rather than colliding with real speakers.
   */
  private speakerLabelToIndex(label: string | undefined): number {
    if (!label || label === 'UNKNOWN') return UNKNOWN_SPEAKER_INDEX
    const code = label.toUpperCase().charCodeAt(0)
    return Math.max(0, code - 65)
  }

  private handleTurn(turn: AssemblyAiTurn): void {
    const text = (turn.transcript ?? '').trim()
    if (!text) return

    const isFinal = turn.end_of_turn === true
    const fallbackSpeaker = this.speakerLabelToIndex(turn.speaker_label)

    // Each Turn carries the full rolling transcript for the current turn
    // (rewrites the in-progress text as more audio is processed). On
    // end_of_turn=true the Turn is final and won't change.
    const words: NormalizedWord[] = (turn.words ?? []).map((w) => ({
      word: w.text ?? '',
      // AssemblyAI emits ms; canonical shape is seconds.
      start: typeof w.start === 'number' ? w.start / 1000 : 0,
      end: typeof w.end === 'number' ? w.end / 1000 : 0,
      confidence: w.confidence ?? 0.9,
      speaker: this.speakerLabelToIndex(w.speaker ?? turn.speaker_label),
      // AssemblyAI doesn't provide per-word speaker confidence — the
      // assembler defaults missing values to 1.0 (no confidence-driven
      // boundary correction). See DEFAULT_SPEAKER_CONFIDENCE there.
      punctuatedWord: w.text ?? '',
    }))

    const startSec = typeof turn.audio_start === 'number' ? turn.audio_start / 1000 : (words[0]?.start ?? 0)
    const endSec = typeof turn.audio_end === 'number' ? turn.audio_end / 1000 : (words[words.length - 1]?.end ?? startSec)

    const result: NormalizedTranscriptResult = {
      text,
      words: words.length > 0 ? words : [
        // Synthesize a single fallback word when AssemblyAI omits the
        // words array (rare; happens on very short turns). Without this
        // the assembler can't form a segment.
        {
          word: text,
          start: startSec,
          end: endSec,
          confidence: 0.9,
          speaker: fallbackSpeaker,
          punctuatedWord: text,
        },
      ],
      isFinal,
      // speech_final on AssemblyAI maps to end_of_turn — the rolling
      // transcript "settles" when the user finishes speaking.
      speechFinal: isFinal,
      start: startSec,
      duration: Math.max(endSec - startSec, 0.05),
      channelIndex: 0,
    }

    this.emit('transcript', result)
    if (isFinal) {
      this.emit('utterance-end')
    }
  }

  private flushBufferedAudio(): void {
    if (!this.ws) return
    while (this.audioBuffer.length > 0) {
      const chunk = this.audioBuffer.shift()
      if (chunk && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(chunk)
      }
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // AssemblyAI accepts WebSocket pings as keep-alive.
        try {
          this.ws.ping()
        } catch {
          // Best effort — failures will surface as the next message attempt.
        }
      }
    }, KEEP_ALIVE_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.emit('max-reconnect-reached')
      return
    }
    this.reconnectAttempts++
    const delayMs = Math.min(
      RECONNECT_BACKOFF_BASE_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_BACKOFF_CAP_MS,
    )
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delayMs })
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    try {
      await this.connect()
    } catch {
      // Errors are already emitted via 'error' inside connect();
      // attemptReconnect re-fires from ws.error or ws.close.
    }
  }

  async finalizeAndClose(options: FinalizeCloseOptions = {}): Promise<void> {
    const quietMs = options.quietMs ?? 900
    const maxWaitMs = options.maxWaitMs ?? FINALIZE_TIMEOUT_DEFAULT_MS
    const closeWaitMs = options.closeWaitMs ?? 1500

    this.isClosing = true

    // Wait for the in-flight Turn to settle (no new transcript for quietMs)
    // or until maxWaitMs elapses, whichever comes first.
    const finalizeStart = Date.now()
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const sinceLast = Date.now() - this.lastTranscriptAt
        const sinceStart = Date.now() - finalizeStart
        if (sinceLast >= quietMs || sinceStart >= maxWaitMs) {
          if (sinceStart >= maxWaitMs && sinceLast < quietMs) {
            this.emitError(
              'FINALIZE_TIMEOUT',
              `AssemblyAI finalize timed out after ${maxWaitMs}ms`,
              { lastTranscriptAgeMs: sinceLast },
            )
          }
          resolve()
        } else {
          setTimeout(tick, 100)
        }
      }
      tick()
    })

    // Send the explicit terminate signal and wait briefly for the
    // Termination response before forcing the socket closed.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'Terminate' }))
      } catch {
        // Best effort.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, closeWaitMs))
    }

    await this.close()
  }

  async close(): Promise<void> {
    this.isClosing = true
    this.stopKeepAlive()
    if (this.ws) {
      try {
        this.ws.close(1000)
      } catch {
        // ignore
      }
      this.ws = null
    }
  }
}
