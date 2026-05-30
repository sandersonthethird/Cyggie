// Provider-agnostic live transcription interface + normalized event payload.
//
// Both DeepgramStreamingClient and AssemblyAiStreamingClient implement
// StreamingTranscriber so RecordingSession can swap providers without
// knowing which one is running.
//
// Event flow:
//   ┌─────────────┐  audio chunks  ┌────────────────────┐  Turn/Result  ┌──────────────────┐
//   │ AudioCapture├───────────────▶│ StreamingTranscriber├─emit────────▶│ TranscriptAssembler│
//   └─────────────┘                └────────────────────┘  events       └──────────────────┘
//
// Provider differences hidden behind the interface:
//   • Deepgram emits interim → final TranscriptResult events (text gets rewritten)
//   • AssemblyAI v3 emits immutable Turns (isFinal=true always)
//   • Both translate to the same normalized TranscriptResult shape

import type { EventEmitter } from 'events'

export type TranscriptionProvider = 'deepgram' | 'assemblyai'

/**
 * Normalized word-level metadata. The optional fields are populated when
 * the provider supplies them; consumers (e.g. TranscriptAssembler) must
 * treat them as best-effort.
 */
export interface NormalizedWord {
  word: string
  start: number
  end: number
  confidence: number
  /**
   * Speaker index (0-based). Deepgram: provider-assigned int.
   * AssemblyAI: letter A/B/C → 0/1/2; "UNKNOWN" → 999.
   */
  speaker: number
  /**
   * Per-word speaker confidence. Deepgram-only; AssemblyAI does not
   * provide this. Consumers must treat undefined as "high confidence"
   * (do not move/merge based on absence).
   */
  speakerConfidence?: number
  punctuatedWord: string
}

/**
 * Normalized transcript event payload. Both providers emit this shape
 * (mapped from their native event types). The TranscriptAssembler
 * consumes this and never knows which provider produced it.
 */
export interface NormalizedTranscriptResult {
  text: string
  words: NormalizedWord[]
  /**
   * Deepgram: matches the SDK's interim/final flag.
   * AssemblyAI v3: always true (Turns are immutable).
   */
  isFinal: boolean
  /**
   * Deepgram: matches SDK's speech_final. AssemblyAI: derived from
   * end_of_turn (true → speechFinal=true).
   */
  speechFinal: boolean
  /** Seconds from session start to event start. */
  start: number
  /** Event duration in seconds. */
  duration: number
  /**
   * Source channel index. In single-channel (mono) recordings — every
   * AssemblyAI session, and Deepgram sessions where the user has not
   * enabled `separateMicAndSystemTranscription` — this is always 0.
   * In Deepgram multichannel sessions (`channels=2`), the mic stream
   * emits 0 and the system loopback stream emits 1. Used by the
   * transcript-assembler's cross-channel dedup pass to drop bleed
   * doublings between the two streams.
   */
  channelIndex: number
  /** Set by the client's finalizeAndClose flow. */
  fromFinalize?: boolean
}

/** Config passed to the factory and forwarded to whichever client is built. */
export interface StreamingTranscriberConfig {
  apiKey: string
  /**
   * Vocabulary biasing terms. Both providers accept these:
   *   • Deepgram: passed as `keyterm` query param (nova-3 only)
   *   • AssemblyAI: passed as `keyterms_prompt` connection parameter
   * Each adapter translates to its native parameter name.
   */
  keyterms?: string[]
  /** Expected speaker count from calendar attendees + self. */
  maxSpeakers?: number
  /**
   * Audio channel count. 1 = mono (default; AssemblyAI always),
   * 2 = stereo (Deepgram multichannel — mic on ch 0, system loopback
   * on ch 1). Set via `resolveStreamConfig` in the recording session.
   * AssemblyAI ignores this; v3 streaming has no multichannel mode.
   */
  channels?: number
}

/**
 * Public surface every streaming transcription client implements. The
 * recording session treats clients as black boxes that emit
 * NormalizedTranscriptResult events; provider-specific protocol details
 * stay inside the client.
 *
 * Required emitted events:
 *   'connected'             — payload: none. Fired when WS open + ready for audio.
 *   'transcript'            — payload: NormalizedTranscriptResult.
 *   'utterance-end'         — payload: none. Fired when the provider signals a
 *                              speaker turn ended (Deepgram: UtteranceEnd msg;
 *                              AssemblyAI: Turn with end_of_turn=true).
 *   'error'                 — payload: { code: TranscriberErrorCode, message: string, context?: object }
 *   'disconnected'          — payload: none. Fired when WS closes (any reason).
 *   'reconnecting'          — payload: { attempt: number, delayMs: number }
 *   'max-reconnect-reached' — payload: none. Fired after final reconnect attempt failed.
 */
export interface StreamingTranscriber extends EventEmitter {
  readonly provider: TranscriptionProvider

  /** Open the WebSocket and prepare to receive audio. */
  connect(): Promise<void>

  /**
   * Send an audio chunk (raw PCM, 16-bit signed little-endian, 16 kHz).
   * Safe to call before connect() resolves — chunks are buffered and
   * flushed on connect.
   */
  sendAudio(chunk: Buffer): void

  /**
   * Wait for any in-flight transcripts, send the provider's finalize/end
   * signal, then close the WebSocket. quietMs = how long to wait for
   * silence before finalizing; maxWaitMs = hard cap.
   */
  finalizeAndClose(options?: { quietMs?: number; maxWaitMs?: number; closeWaitMs?: number }): Promise<void>

  /** Abrupt close. No finalize signal sent. */
  close(): Promise<void>
}

/**
 * Named error codes emitted by streaming clients. Each code corresponds to
 * a specific failure mode with documented handling. Adding a new code
 * requires updating both clients and the UI banner copy.
 */
export type TranscriberErrorCode =
  /** receive: JSON.parse failure on provider message */
  | 'MALFORMED_TURN_PAYLOAD'
  /** receive: provider sent a message type we don't recognize (warn-level) */
  | 'UNKNOWN_MESSAGE_TYPE'
  /** receive: provider closed the connection without our request */
  | 'SERVER_TERMINATED'
  /** finalizeAndClose: no final transcript arrived within the timeout */
  | 'FINALIZE_TIMEOUT'
  /** connect: API key missing or rejected */
  | 'MISSING_API_KEY'
  /** connect: WebSocket failed to open (network / DNS / TLS) */
  | 'CONNECT_FAILED'
  /** connect: provider returned 429 or similar throttling response */
  | 'RATE_LIMITED'
