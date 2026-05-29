// EVAL-FEATURE: AssemblyAI Universal-3 adapter.
//
// Three-step async pipeline:
//   1. POST /v2/upload — streams the audio file, returns an upload_url
//   2. POST /v2/transcript — kicks off transcription with universal model
//      + speaker_labels + word_boost (vocabulary biasing from keyterms)
//   3. Poll GET /v2/transcript/:id with 3s → 30s backoff until status is
//      'completed' or 'error'
//
// VERIFY: confirm `speech_model: 'best'` is the right knob for Universal-3
// specifically (their docs occasionally rename the slug). If a future release
// exposes 'universal-3' as a literal, swap it here.

import { readFile } from 'fs/promises'
import type {
  TranscribeOpts,
  TranscribeResult,
  TranscriptionProvider,
} from './types'
import type { TranscriptSegment } from '@shared/types/recording'

const BASE = 'https://api.assemblyai.com'
const POLL_INITIAL_MS = 3000
const POLL_MAX_MS = 30000

// VERIFY: AssemblyAI Universal-3 rate card. Placeholder at $0.0042/min.
const COST_PER_MINUTE_USD = 0.0042

interface AssemblyTranscriptJob {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  text?: string
  error?: string
  audio_duration?: number
  utterances?: Array<{
    speaker: string
    text: string
    start: number
    end: number
  }>
}

function speakerLetterToIndex(letter: string): number {
  if (!letter) return 0
  const code = letter.toUpperCase().charCodeAt(0)
  return Math.max(0, code - 65)
}

export class AssemblyAiAdapter implements TranscriptionProvider {
  readonly id = 'assemblyai_universal3' as const
  readonly displayName = 'AssemblyAI Universal-3'

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('AssemblyAI API key is required')
  }

  async transcribe(audioPath: string, opts: TranscribeOpts): Promise<TranscribeResult> {
    const startedAt = Date.now()
    const headers = { authorization: this.apiKey }

    // 1. Upload
    const audioBytes = await readFile(audioPath)
    const uploadResp = await fetch(`${BASE}/v2/upload`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: audioBytes,
      signal: opts.signal,
    })
    if (!uploadResp.ok) {
      throw new Error(`AssemblyAI upload HTTP ${uploadResp.status}`)
    }
    const upload = (await uploadResp.json()) as { upload_url: string }

    // 2. Kick off transcription
    // VERIFY 2026-05-27: AssemblyAI renamed `speech_model` → `speech_models`
    // and the value is now an array. Confirmed by their HTTP 400 error
    // ("speech_model is deprecated. Use \"speech_models\" instead").
    const submitBody: Record<string, unknown> = {
      audio_url: upload.upload_url,
      speech_models: ['universal'],
      speaker_labels: true,
      punctuate: true,
    }
    if (opts.keyterms && opts.keyterms.length > 0) {
      submitBody['word_boost'] = opts.keyterms
    }
    const submitResp = await fetch(`${BASE}/v2/transcript`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(submitBody),
      signal: opts.signal,
    })
    if (!submitResp.ok) {
      const body = await submitResp.text().catch(() => '')
      throw new Error(
        `AssemblyAI submit HTTP ${submitResp.status}: ${body.slice(0, 500)}`,
      )
    }
    const submitted = (await submitResp.json()) as AssemblyTranscriptJob
    const transcriptId = submitted.id

    // 3. Poll
    let backoff = POLL_INITIAL_MS
    while (true) {
      if (opts.signal?.aborted) throw new Error('AssemblyAI transcription aborted')
      await new Promise<void>((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(POLL_MAX_MS, backoff * 1.5)

      const statusResp = await fetch(`${BASE}/v2/transcript/${transcriptId}`, {
        headers,
        signal: opts.signal,
      })
      if (!statusResp.ok) {
        throw new Error(`AssemblyAI poll HTTP ${statusResp.status}`)
      }
      const job = (await statusResp.json()) as AssemblyTranscriptJob
      if (job.status === 'completed') {
        const segments: TranscriptSegment[] = (job.utterances ?? []).map((u) => ({
          speaker: speakerLetterToIndex(u.speaker),
          text: u.text,
          // AssemblyAI returns ms; canonical shape expects seconds.
          startTime: u.start / 1000,
          endTime: u.end / 1000,
          isFinal: true,
        }))
        const text = (job.text ?? segments.map((s) => s.text).join(' ')).trim()
        const audioDurationSeconds = typeof job.audio_duration === 'number' ? job.audio_duration : null
        const estimatedCostUsd =
          audioDurationSeconds !== null
            ? (audioDurationSeconds / 60) * COST_PER_MINUTE_USD
            : null
        return {
          segments,
          text,
          requestId: transcriptId,
          audioDurationSeconds,
          latencyMs: Date.now() - startedAt,
          estimatedCostUsd,
          diarization: 'diarization',
          model: 'universal-3',
        }
      }
      if (job.status === 'error') {
        throw new Error(`AssemblyAI transcription failed: ${job.error ?? 'unknown'}`)
      }
      // else 'queued' | 'processing' — keep polling.
    }
  }
}
