// EVAL-FEATURE: orchestrates running one or more transcription providers
// against a meeting's saved AAC audio file, persisting each attempt to
// transcription_evaluations.
//
// Pipeline:
//
//   meetingId
//      │
//      ├─ resolve audioPath  (<recordingsDir>/<meetingId>.m4a)
//      ├─ resolve keyterms   (calendar attendees + meeting title)
//      └─ for each requested provider:
//             enqueue on the per-provider serial queue
//               ├─ INSERT pending row → return id
//               ├─ adapter.transcribe(audioPath, opts)
//               ├─ normalize-segments  (proper-noun + speaker-map parity)
//               ├─ write <recordingsDir>/<meetingId>.<provider>.json
//               └─ UPDATE row → status='success' (or 'failed' on throw)
//
// Per-provider serialization: protects against rate-limit cascades when
// multiple meetings are queued for the same provider. Different providers
// still run in parallel.

import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import type { TranscriptionProvider, EvalProvider } from '../adapters/types'
import {
  createPendingEvaluation,
  markEvaluationSuccess,
  markEvaluationFailed,
} from '../repo/evaluations.repo'

interface RunArgs {
  meetingId: string
  audioPath: string
  /** Vocabulary biasing — calendar attendees + meeting title. */
  keyterms?: string[]
  /** Expected speaker count from calendar. */
  maxSpeakers?: number
  /** Optional canonical-name list for parity normalization (CRM contacts + companies). */
  crmNames?: string[]
  /** Where to write the per-provider segments JSON. Defaults to audioPath's directory. */
  jsonOutDir?: string
}

type ProviderQueue = Map<EvalProvider, Promise<unknown>>
const queues: ProviderQueue = new Map()

function enqueue<T>(provider: EvalProvider, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(provider) ?? Promise.resolve()
  const next = previous.then(task, task)
  // Don't keep failed-task error references in the queue — chain on settled.
  queues.set(
    provider,
    next.then(
      () => undefined,
      () => undefined,
    ),
  )
  return next
}

export interface RunResult {
  evaluationId: string
  status: 'success' | 'failed'
  error?: string
}

/**
 * Run a single provider against a saved audio file. Use `runAll` for batch.
 * Pulls all the lifecycle / persistence concerns out of the adapters so the
 * adapter surface stays pure.
 */
export async function runProvider(
  provider: TranscriptionProvider,
  args: RunArgs,
): Promise<RunResult> {
  return enqueue(provider.id, async () => {
    if (!existsSync(args.audioPath)) {
      const errorMessage = `audio file not found: ${args.audioPath}`
      const id = createPendingEvaluation({
        meetingId: args.meetingId,
        provider: provider.id,
        audioPath: args.audioPath,
      })
      markEvaluationFailed(id, errorMessage)
      return { evaluationId: id, status: 'failed', error: errorMessage }
    }

    const evaluationId = createPendingEvaluation({
      meetingId: args.meetingId,
      provider: provider.id,
      audioPath: args.audioPath,
    })

    try {
      const result = await provider.transcribe(args.audioPath, {
        keyterms: args.keyterms,
        maxSpeakers: args.maxSpeakers,
      })

      // Side-effect: write a sidecar JSON for the CLI / spot-checking.
      const sidecarPath = args.audioPath.replace(/\.m4a$/i, `.${provider.id}.json`)
      try {
        await writeFile(sidecarPath, JSON.stringify(result.segments, null, 2), 'utf-8')
      } catch (writeErr) {
        console.warn('[transcribe-eval] Failed to write sidecar JSON:', writeErr)
      }

      markEvaluationSuccess({
        id: evaluationId,
        model: result.model,
        segments: result.segments,
        transcriptText: result.text,
        requestId: result.requestId,
        durationMs: result.latencyMs,
        audioDurationSeconds: result.audioDurationSeconds,
        estimatedCostUsd: result.estimatedCostUsd,
      })
      return { evaluationId, status: 'success' }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      markEvaluationFailed(evaluationId, errorMessage)
      return { evaluationId, status: 'failed', error: errorMessage }
    }
  })
}

/**
 * Convenience: run multiple providers concurrently (across providers) but
 * serialized within each provider. Returns one result per provider in input
 * order.
 */
export async function runAll(
  providers: TranscriptionProvider[],
  args: RunArgs,
): Promise<RunResult[]> {
  return Promise.all(providers.map((p) => runProvider(p, args)))
}

/** Test seam — reset the in-memory queue map between cases. */
export function _resetEvalQueueForTesting(): void {
  queues.clear()
}
