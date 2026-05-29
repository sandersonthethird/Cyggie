// EVAL-FEATURE: CRUD for transcription_evaluations.
//
// This table holds the output of running alternate transcription providers
// against meeting audio for offline comparison. Not part of the sync surface.
// See ./migration.ts for the schema.

import { randomUUID } from 'crypto'
import { getDatabase } from '@cyggie/db/sqlite/connection'
import type { TranscriptSegment } from '@shared/types/recording'

export type EvalStatus = 'pending' | 'success' | 'failed'

export interface TranscriptionEvaluation {
  id: string
  meetingId: string
  provider: string
  model: string | null
  audioPath: string
  segments: TranscriptSegment[]
  transcriptText: string
  requestId: string | null
  durationMs: number | null
  audioDurationSeconds: number | null
  estimatedCostUsd: number | null
  errorMessage: string | null
  status: EvalStatus
  createdAt: string
}

interface RawRow {
  id: string
  meeting_id: string
  provider: string
  model: string | null
  audio_path: string
  segments_json: string
  transcript_text: string
  request_id: string | null
  duration_ms: number | null
  audio_duration_seconds: number | null
  estimated_cost_usd: number | null
  error_message: string | null
  status: string
  created_at: string
}

function rowToRecord(row: RawRow): TranscriptionEvaluation {
  let segments: TranscriptSegment[] = []
  try {
    segments = JSON.parse(row.segments_json) as TranscriptSegment[]
  } catch {
    // Defensive: corrupt JSON → empty segments. Caller can still see status/error.
    segments = []
  }
  return {
    id: row.id,
    meetingId: row.meeting_id,
    provider: row.provider,
    model: row.model,
    audioPath: row.audio_path,
    segments,
    transcriptText: row.transcript_text,
    requestId: row.request_id,
    durationMs: row.duration_ms,
    audioDurationSeconds: row.audio_duration_seconds,
    estimatedCostUsd: row.estimated_cost_usd,
    errorMessage: row.error_message,
    status: row.status as EvalStatus,
    createdAt: row.created_at,
  }
}

export interface CreatePendingArgs {
  meetingId: string
  provider: string
  audioPath: string
}

/** Insert a row in 'pending' state and return the generated id. */
export function createPendingEvaluation(args: CreatePendingArgs): string {
  const id = randomUUID()
  const db = getDatabase()
  db.prepare(
    `INSERT INTO transcription_evaluations
       (id, meeting_id, provider, audio_path, segments_json, transcript_text, status)
     VALUES (?, ?, ?, ?, '[]', '', 'pending')`,
  ).run(id, args.meetingId, args.provider, args.audioPath)
  return id
}

export interface MarkSuccessArgs {
  id: string
  model: string | null
  segments: TranscriptSegment[]
  transcriptText: string
  requestId: string | null
  durationMs: number
  audioDurationSeconds: number | null
  estimatedCostUsd: number | null
}

export function markEvaluationSuccess(args: MarkSuccessArgs): void {
  const db = getDatabase()
  db.prepare(
    `UPDATE transcription_evaluations
       SET status = 'success',
           model = ?,
           segments_json = ?,
           transcript_text = ?,
           request_id = ?,
           duration_ms = ?,
           audio_duration_seconds = ?,
           estimated_cost_usd = ?,
           error_message = NULL
     WHERE id = ?`,
  ).run(
    args.model,
    JSON.stringify(args.segments),
    args.transcriptText,
    args.requestId,
    args.durationMs,
    args.audioDurationSeconds,
    args.estimatedCostUsd,
    args.id,
  )
}

export function markEvaluationFailed(id: string, errorMessage: string): void {
  const db = getDatabase()
  db.prepare(
    `UPDATE transcription_evaluations
       SET status = 'failed', error_message = ?
     WHERE id = ?`,
  ).run(errorMessage, id)
}

export function listEvaluationsForMeeting(meetingId: string): TranscriptionEvaluation[] {
  const db = getDatabase()
  const rows = db
    .prepare(
      `SELECT * FROM transcription_evaluations
        WHERE meeting_id = ?
        ORDER BY created_at DESC`,
    )
    .all(meetingId) as RawRow[]
  return rows.map(rowToRecord)
}

export function getEvaluationById(id: string): TranscriptionEvaluation | null {
  const db = getDatabase()
  const row = db
    .prepare(`SELECT * FROM transcription_evaluations WHERE id = ?`)
    .get(id) as RawRow | undefined
  return row ? rowToRecord(row) : null
}

/**
 * Mark every row that's been stuck in 'pending' for longer than the cutoff
 * as 'failed' with a synthetic error message. Called from boot-cleanup
 * (the user closed the app mid-eval; on next launch we surface the failure
 * instead of leaving rows in a perma-pending state).
 */
export function markStalePendingAsFailed(olderThanMinutes: number): number {
  const db = getDatabase()
  const info = db
    .prepare(
      `UPDATE transcription_evaluations
         SET status = 'failed', error_message = 'app_closed'
       WHERE status = 'pending'
         AND created_at < datetime('now', ?)`,
    )
    .run(`-${olderThanMinutes} minutes`)
  return info.changes
}
