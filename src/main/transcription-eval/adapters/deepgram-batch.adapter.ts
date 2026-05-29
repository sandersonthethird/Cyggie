// EVAL-FEATURE: Deepgram batch (prerecorded) adapter.
//
// Uses the same /v1/listen endpoint the gateway uses for mobile audio, with
// the same nova-3 + multichannel + diarize + keyterms configuration the live
// streaming client uses. Including Deepgram-batch in the eval lets us
// compare live-vs-batch WER on the same audio in addition to comparing
// providers — useful since the mobile path is batch-only.
//
// Uses the shared utterance→segment mapper at
// @cyggie/services/recording/deepgram-mapping.ts so this adapter and the
// gateway can never drift.

import { readFile } from 'fs/promises'
import { createClient } from '@deepgram/sdk'
import {
  mapDeepgramUtterancesToSegments,
  type DeepgramBatchResult,
} from '@cyggie/services/recording/deepgram-mapping'
import { segmentsToText, type TranscribeOpts, type TranscribeResult, type TranscriptionProvider } from './types'

// VERIFY: Deepgram nova-3 pricing as of 2026-05-27. Update if the rate card moves.
const COST_PER_MINUTE_USD = 0.0043

export class DeepgramBatchAdapter implements TranscriptionProvider {
  readonly id = 'deepgram_batch' as const
  readonly displayName = 'Deepgram nova-3 (batch)'

  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new Error('Deepgram API key is required')
  }

  async transcribe(audioPath: string, opts: TranscribeOpts): Promise<TranscribeResult> {
    const startedAt = Date.now()
    const client = createClient(this.apiKey)
    const buffer = await readFile(audioPath)

    // Stay consistent with the live streaming path (RecordingSession sends
    // mono audio to Deepgram, channels=1). multichannel: true against a
    // stereo AAC file would double-transcribe when the remote speaker
    // bleeds across channels via the local mic — exactly the issue the
    // 2026-05-27 live-streaming fix solved. Use multichannel: false here
    // so Deepgram merges the stereo file internally and diarizes by voice.
    const { result, error } = await client.listen.prerecorded.transcribeFile(buffer, {
      model: 'nova-3',
      diarize: true,
      multichannel: false,
      smart_format: true,
      utterances: true,
      punctuate: true,
      keyterm: opts.keyterms && opts.keyterms.length > 0 ? opts.keyterms : undefined,
    })

    if (error) throw new Error(`Deepgram error: ${error.message ?? String(error)}`)
    if (!result) throw new Error('Deepgram returned no result')

    const payload = result as unknown as DeepgramBatchResult
    const segments = mapDeepgramUtterancesToSegments(payload)
    const audioDurationSeconds = payload.metadata?.duration ?? null
    const estimatedCostUsd =
      audioDurationSeconds !== null ? (audioDurationSeconds / 60) * COST_PER_MINUTE_USD : null

    return {
      segments,
      text: segmentsToText(segments),
      requestId: payload.metadata?.request_id ?? null,
      audioDurationSeconds,
      latencyMs: Date.now() - startedAt,
      estimatedCostUsd,
      diarization: 'diarization',
      model: 'nova-3',
    }
  }
}
