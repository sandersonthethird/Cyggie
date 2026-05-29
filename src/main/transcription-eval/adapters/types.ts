// TranscriptionProvider interface — implemented by each candidate
// provider's adapter (Deepgram batch, AssemblyAI Universal-3). The eval
// service iterates over a list of these and persists the result to
// transcription_evaluations.
//
// IMPORTANT: Adapter implementations MUST NOT import Electron-specific
// modules (`electron`, `safeStorage`, etc.). The eval CLI imports them
// directly from a plain Node entry point.
//
// Voxtral was removed 2026-05-28 after eval evidence showed two
// disqualifying failure modes: a 16,384-token context limit (unusable
// for meetings >~22min) and degenerate output loops at the end of long
// clips. If you're considering re-adding it, verify both have been fixed.

import type { TranscriptSegment } from '@shared/types/recording'

export type EvalProvider = 'deepgram_batch' | 'assemblyai_universal3'

export interface TranscribeOpts {
  /** Optional vocabulary biasing (calendar attendees + meeting title). */
  keyterms?: string[]
  /** Expected speaker count, when known from calendar metadata. */
  maxSpeakers?: number
  /** Cancel a long-running poll. */
  signal?: AbortSignal
}

export interface TranscribeResult {
  segments: TranscriptSegment[]
  /** Flat plain text (no speaker prefixes) — used for the CLI's side-by-side view. */
  text: string
  /** Provider's request/job identifier — null when the provider doesn't return one. */
  requestId: string | null
  /** Provider-reported audio duration; null when not returned. */
  audioDurationSeconds: number | null
  /** Wall-clock from request start to result-in-hand. */
  latencyMs: number
  /** Best-effort, computed locally from published rate cards. */
  estimatedCostUsd: number | null
  /**
   * Speaker-labelling fidelity the provider supports. Useful for the
   * eval report so we don't claim apples-to-apples comparison on a
   * provider that has no diarization at all.
   */
  diarization: 'multichannel' | 'diarization' | 'none'
  /** Model identifier reported by the provider (e.g. 'nova-3'). */
  model: string
}

export interface TranscriptionProvider {
  readonly id: EvalProvider
  readonly displayName: string
  /**
   * @throws if no API key is configured for this provider, or on
   *   network / 4xx / 5xx errors. The eval service catches the throw
   *   and writes a 'failed' row with the error message.
   */
  transcribe(audioPath: string, opts: TranscribeOpts): Promise<TranscribeResult>
}

/** Helper: derive a flat text dump from segments (no speaker prefixes). */
export function segmentsToText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
}
