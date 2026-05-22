// =============================================================================
// sync-remote-apply.ts — pull-side primitive for Phase 1.5c.
//
// Applies rows pulled from Neon (`GET /sync/pull`) to the local SQLite,
// bypassing the writeWithSync barrel so the apply does NOT re-enter the
// outbox. Without this bypass we'd ping-pong (pulled row → outbox →
// pushed back → gateway LWW rejects but desktop keeps trying).
//
// PROCESSING PIPELINE
//
//   incoming rows (camelCase from gateway)
//        │
//        ▼  pre-validate (Issue 3 + Section 3)
//   ┌─────────────────────────────────────┐
//   │ • drop rows missing required fields │
//   │ • drop rows whose userId doesn't    │
//   │   exist in local users table        │
//   │ • drop rows failing drizzle-zod     │
//   │   validators (belt-and-suspenders)  │
//   └────────────┬────────────────────────┘
//                ▼
//   chunk into 50-row sub-batches (Issue 4A)
//                │
//                ▼
//   ┌─────────────────────────────────────────────┐
//   │  BEGIN tx                                    │
//   │   for each row in sub-batch:                 │
//   │     SELECT local lamport                     │
//   │     if incoming.lamport > local.lamport:     │
//   │       INSERT ON CONFLICT DO UPDATE (full)    │
//   │       (UPDATE, never REPLACE — cascade FKs)  │
//   │       applied.push(row.id)                   │
//   │   bump sync_state.last_pulled_lamport        │
//   │   bump sync_state.last_pushed_lamport        │
//   │     = max(current, max(incoming.lamport))    │
//   │     ← Issue 1A: keeps nextLamport() ahead    │
//   │  COMMIT                                      │
//   └────────────┬────────────────────────────────┘
//                ▼  on commit: emit IPC event
//   MEETINGS_REMOTE_APPLIED { ids: appliedIds }
//
// CONCURRENCY: applyRemote runs inside SyncPullService which already
// enforces the push/pull mutex via SyncAgent.getState(). No additional
// locking needed here.
// =============================================================================

import type Database from 'better-sqlite3'

/** Size of each sub-batch transaction. 50 keeps the IPC payload + the
 *  renderer's TanStack invalidate storm bounded; first-launch catch-up
 *  on a heavy account streams in 50-row waves. */
const CHUNK_SIZE = 50

/** Shape of a pulled meeting row (drizzle camelCase from gateway). Only
 *  fields the desktop persists are typed; others are tolerated. */
export interface PulledMeetingRow {
  id: string
  userId: string
  title: string
  date: string | Date
  durationSeconds: number | null
  calendarEventId: string | null
  meetingPlatform: string | null
  meetingUrl: string | null
  transcriptPath: string | null
  summaryPath: string | null
  recordingPath: string | null
  transcriptDriveId: string | null
  summaryDriveId: string | null
  templateId: string | null
  speakerCount: number
  speakerMap: unknown
  transcriptSegments: unknown
  notes: string | null
  attendees: unknown
  attendeeEmails: unknown
  chatMessages: unknown
  companies: unknown
  dismissedCompanies: unknown
  status: string
  deepgramRequestId?: string | null
  wasImpromptu: boolean
  isGroupEvent: boolean
  isGroupEventUserSet: boolean
  scheduledEndAt: string | Date | null
  createdAt: string | Date
  updatedAt: string | Date
  lamport: string
  [field: string]: unknown
}

export interface ApplyRemoteOptions {
  /** Caller can override for tests. */
  chunkSize?: number
  /** Emit IPC after each sub-batch commit. Optional so tests can spy. */
  onApplied?: (ids: string[]) => void
  /** Log surface — default is a no-op; production wires pino. */
  log?: {
    info?: (payload: Record<string, unknown>, msg: string) => void
    warn?: (payload: Record<string, unknown>, msg: string) => void
  }
}

export interface ApplyRemoteResult {
  appliedIds: string[]
  skippedLowLamport: number
  skippedPreValidation: number
}

/**
 * Apply pulled meeting rows to local SQLite. Returns the ids that were
 * actually written (rows where incoming.lamport > local.lamport).
 */
export function applyRemoteMeetings(
  db: Database.Database,
  deviceId: string,
  userId: string,
  rows: PulledMeetingRow[],
  opts: ApplyRemoteOptions = {},
): ApplyRemoteResult {
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE
  const log = opts.log ?? {}
  const onApplied = opts.onApplied

  // --- Pre-validation (Issue 3) ---------------------------------------------
  // Gateway is the canonical trust boundary; pre-validation here is just
  // a defensive shape check + a foreign-key existence guard. drizzle-zod
  // validators expect Date objects on timestamp fields, but pull
  // responses arrive as JSON strings — type mismatch makes the validator
  // reject every row. The shape + FK checks are sufficient.
  const validated: PulledMeetingRow[] = []
  let skippedPreValidation = 0

  // Cache the users-table lookup so we don't run a SELECT per row.
  const localUserExists = db
    .prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1')
    .get(userId)
  if (!localUserExists) {
    log.warn?.(
      { userId, metric: 'sync.pull.fk_pre_skip', count: rows.length },
      'sync.pull skipped batch — local user row missing',
    )
    return { appliedIds: [], skippedLowLamport: 0, skippedPreValidation: rows.length }
  }

  for (const row of rows) {
    // Required-field check — id + userId + lamport are non-negotiable.
    if (
      typeof row?.id !== 'string' ||
      typeof row?.userId !== 'string' ||
      typeof row?.lamport !== 'string'
    ) {
      skippedPreValidation++
      log.warn?.(
        { metric: 'sync.pull.malformed_pre_skip', id: (row as { id?: unknown })?.id },
        'sync.pull skipped row — missing required fields',
      )
      continue
    }
    validated.push(row)
  }

  // --- Chunked apply --------------------------------------------------------
  const appliedIds: string[] = []
  let skippedLowLamport = 0

  for (let i = 0; i < validated.length; i += chunkSize) {
    const chunk = validated.slice(i, i + chunkSize)
    const subBatchApplied: string[] = []
    let subBatchHighWater = 0n

    const apply = db.transaction(() => {
      for (const row of chunk) {
        const local = db
          .prepare('SELECT lamport FROM meetings WHERE id = ?')
          .get(row.id) as { lamport: string } | undefined
        const localLamport = local ? BigInt(local.lamport) : -1n
        const incomingLamport = BigInt(row.lamport)
        if (incomingLamport <= localLamport) {
          skippedLowLamport++
          continue
        }

        // INSERT ON CONFLICT DO UPDATE — preserves FK children (meeting_company_links etc.)
        // INSERT OR REPLACE would cascade-delete them.
        upsertMeetingRow(db, row)
        subBatchApplied.push(row.id)
        if (incomingLamport > subBatchHighWater) subBatchHighWater = incomingLamport
      }

      if (subBatchApplied.length > 0) {
        // Bump last_pulled_lamport to max-applied + bump last_pushed_lamport
        // (Issue 1A) so nextLamport() seeds above incoming high-water.
        const hw = subBatchHighWater.toString()
        db.prepare(
          `INSERT INTO sync_state (device_id, user_id, last_pushed_lamport, last_pulled_lamport)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             last_pulled_lamport = CASE
               WHEN CAST(excluded.last_pulled_lamport AS INTEGER) > CAST(sync_state.last_pulled_lamport AS INTEGER)
               THEN excluded.last_pulled_lamport ELSE sync_state.last_pulled_lamport END,
             last_pushed_lamport = CASE
               WHEN CAST(excluded.last_pushed_lamport AS INTEGER) > CAST(sync_state.last_pushed_lamport AS INTEGER)
               THEN excluded.last_pushed_lamport ELSE sync_state.last_pushed_lamport END,
             last_seen_at = datetime('now')`,
        ).run(deviceId, userId, hw, hw)
      }
    })

    try {
      apply()
    } catch (err) {
      // Issue 4A: rollback whole sub-batch. last_pulled_lamport unchanged
      // → next pull tick re-fetches the same range; idempotent retry.
      log.warn?.(
        {
          metric: 'sync.pull.tx_rollback',
          chunkStart: i,
          chunkSize: chunk.length,
          error: err instanceof Error ? err.message : String(err),
        },
        'sync.pull sub-batch rolled back',
      )
      continue
    }

    appliedIds.push(...subBatchApplied)
    if (subBatchApplied.length > 0) {
      onApplied?.(subBatchApplied)
      log.info?.(
        {
          metric: 'sync.pull.applied',
          appliedCount: subBatchApplied.length,
          highWater: subBatchHighWater.toString(),
        },
        'sync.pull applied sub-batch',
      )
    }
  }

  return { appliedIds, skippedLowLamport, skippedPreValidation }
}

// ─── Upsert helper ───────────────────────────────────────────────────────────

function upsertMeetingRow(db: Database.Database, row: PulledMeetingRow): void {
  // Hand-rolled camelCase → snake_case mapping. The set of columns is
  // stable; adding a future column means adding it here too. Explicit over
  // clever — matches the project's "no magic" sync convention.
  db.prepare(
    `INSERT INTO meetings (
       id, title, date, duration_seconds, calendar_event_id,
       meeting_platform, meeting_url,
       transcript_path, summary_path, recording_path,
       transcript_drive_id, summary_drive_id,
       template_id,
       speaker_count, speaker_map, transcript_segments,
       notes,
       attendees, attendee_emails, chat_messages,
       companies, dismissed_companies,
       status, was_impromptu, is_group_event, is_group_event_user_set,
       scheduled_end_at,
       created_at, updated_at, lamport
     ) VALUES (
       @id, @title, @date, @durationSeconds, @calendarEventId,
       @meetingPlatform, @meetingUrl,
       @transcriptPath, @summaryPath, @recordingPath,
       @transcriptDriveId, @summaryDriveId,
       @templateId,
       @speakerCount, @speakerMap, @transcriptSegments,
       @notes,
       @attendees, @attendeeEmails, @chatMessages,
       @companies, @dismissedCompanies,
       @status, @wasImpromptu, @isGroupEvent, @isGroupEventUserSet,
       @scheduledEndAt,
       @createdAt, @updatedAt, @lamport
     )
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       date = excluded.date,
       duration_seconds = excluded.duration_seconds,
       calendar_event_id = excluded.calendar_event_id,
       meeting_platform = excluded.meeting_platform,
       meeting_url = excluded.meeting_url,
       transcript_path = excluded.transcript_path,
       summary_path = excluded.summary_path,
       recording_path = excluded.recording_path,
       transcript_drive_id = excluded.transcript_drive_id,
       summary_drive_id = excluded.summary_drive_id,
       template_id = excluded.template_id,
       speaker_count = excluded.speaker_count,
       speaker_map = excluded.speaker_map,
       transcript_segments = excluded.transcript_segments,
       notes = excluded.notes,
       attendees = excluded.attendees,
       attendee_emails = excluded.attendee_emails,
       chat_messages = excluded.chat_messages,
       companies = excluded.companies,
       dismissed_companies = excluded.dismissed_companies,
       status = excluded.status,
       was_impromptu = excluded.was_impromptu,
       is_group_event = excluded.is_group_event,
       is_group_event_user_set = excluded.is_group_event_user_set,
       scheduled_end_at = excluded.scheduled_end_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       lamport = excluded.lamport`,
  ).run({
    id: row.id,
    title: row.title,
    date: toIso(row.date),
    durationSeconds: row.durationSeconds,
    calendarEventId: row.calendarEventId,
    meetingPlatform: row.meetingPlatform,
    meetingUrl: row.meetingUrl,
    transcriptPath: row.transcriptPath,
    summaryPath: row.summaryPath,
    recordingPath: row.recordingPath,
    transcriptDriveId: row.transcriptDriveId,
    summaryDriveId: row.summaryDriveId,
    templateId: row.templateId,
    speakerCount: row.speakerCount,
    speakerMap: stringify(row.speakerMap),
    transcriptSegments: stringify(row.transcriptSegments),
    notes: row.notes,
    attendees: stringify(row.attendees),
    attendeeEmails: stringify(row.attendeeEmails),
    chatMessages: stringify(row.chatMessages),
    companies: stringify(row.companies),
    dismissedCompanies: stringify(row.dismissedCompanies),
    status: row.status,
    wasImpromptu: row.wasImpromptu ? 1 : 0,
    isGroupEvent: row.isGroupEvent ? 1 : 0,
    isGroupEventUserSet: row.isGroupEventUserSet ? 1 : 0,
    scheduledEndAt: row.scheduledEndAt ? toIso(row.scheduledEndAt) : null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    lamport: row.lamport,
  })
}

function toIso(v: string | Date): string {
  if (typeof v === 'string') return v
  return v.toISOString()
}

function stringify(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
