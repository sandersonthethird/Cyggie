// =============================================================================
// summary-backfill.service.ts — Item 4 of the mobile-summary-tab plan.
//
// One-time-ish backfill of the `meetings.summary` column from the
// historical markdown files at `summary_path`. Necessary because:
//
//   1. Item 2 ships a dual-write in the summarizer (file + column),
//      but only takes effect on FUTURE summarizations. Meetings
//      summarized before that change still have summary=NULL.
//   2. Mobile's Summary tab reads from the column (via the gateway),
//      not from disk, so without this backfill historical meetings
//      forever render "No summary yet" on the phone.
//
// Pipeline:
//
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ SELECT id, summary_path FROM meetings                           │
//   │   WHERE summary IS NULL AND summary_path IS NOT NULL            │
//   │                                                                  │
//   │ for each row:                                                    │
//   │   content = readSummary(row.summary_path)        ─null/empty─▶  │
//   │      │                                            missingFile++ │
//   │      ▼                                                           │
//   │   try updateMeeting(id, {summary: content}, userId)              │
//   │      │ (barrel-wrapped: withSync → outbox emission)              │
//   │      ▼                                                           │
//   │   ✓ updated++   ✗ skipped++ (caught, loop continues)             │
//   │                                                                  │
//   │ → SyncAgent drains outbox → Neon → mobile renders               │
//   └─────────────────────────────────────────────────────────────────┘
//
// Idempotent: the WHERE clause excludes rows whose `summary` is now
// populated, so re-runs after partial completion (e.g. SQLite lock
// blip on a single row) pick up only the remaining work. Steady state
// once everyone is backfilled: zero rows iterated.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'
// CLAUDE.md: production code imports owned-table writes from the
// barrel so they flow through withSync → outbox → Neon. Without this,
// the column would update locally but never sync — defeating the
// whole point of the backfill (mobile reads from Neon).
import { updateMeeting } from '@cyggie/db/sqlite/repositories'
import { readSummary } from '../storage/file-manager'

interface BackfillRow {
  id: string
  summary_path: string
  is_private: number | null
}

export interface BackfillSummariesResult {
  updated: number
  skipped: number
  missingFile: number
}

/**
 * Retry-tolerant wrapper around readSummary.
 *
 * macOS's readFileSync occasionally surfaces EINTR ("interrupted system
 * call") under load — a signal arrived while the syscall was blocked,
 * the kernel returns -1, and Node lifts it as an exception. POSIX
 * defines this as "retry-and-continue", not "back off", so an immediate
 * retry is correct. We try up to MAX_READ_ATTEMPTS before giving up.
 *
 * Other errors (ENOENT, EACCES, etc.) bubble immediately — they're
 * persistent and retrying won't change the outcome.
 *
 * Returns the same `string | null` shape as readSummary itself so the
 * caller doesn't need to know the retry happened.
 */
const MAX_READ_ATTEMPTS = 3
function readSummaryWithEintrRetry(
  path: string,
  meeting: { id: string; isPrivate?: boolean | null },
): string | null {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt++) {
    try {
      return readSummary(path, meeting)
    } catch (err) {
      const isEintr =
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'EINTR'
      if (!isEintr) throw err
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * Walk meetings with summary_path set but summary column null, read
 * each markdown file, write it into the column via the sync-wrapped
 * updateMeeting. Returns counters for the launch-log line.
 *
 * Early-returns when `userId` is null — the withSync wrapper short-
 * circuits without auth (no outbox emission), so writing the column
 * would update SQLite but never propagate to Neon → mobile, defeating
 * the backfill's purpose. Next launch with a hydrated user picks the
 * work back up (idempotent via WHERE clause).
 */
export function backfillMissingSummaries(
  userId: string | null,
): BackfillSummariesResult {
  if (!userId) {
    console.log('[summary-backfill] skipped: no user_id at launch')
    return { updated: 0, skipped: 0, missingFile: 0 }
  }

  const db = getDatabase()
  const rows = db
    .prepare(`
      SELECT id, summary_path, is_private
      FROM meetings
      WHERE summary IS NULL AND summary_path IS NOT NULL
    `)
    .all() as BackfillRow[]

  let updated = 0
  let skipped = 0
  let missingFile = 0

  for (const row of rows) {
    let content: string | null = null
    try {
      content = readSummaryWithEintrRetry(row.summary_path, { id: row.id, isPrivate: row.is_private === 1 })
    } catch (err) {
      console.warn(
        `[summary-backfill] readSummary failed after ${MAX_READ_ATTEMPTS} attempt(s) for meeting ${row.id}:`,
        err,
      )
      missingFile++
      continue
    }

    // Treat empty/whitespace-only files as missing — matches the
    // mobile null-only sentinel rule in decideSummaryDisplay and
    // avoids wasting an outbox emission on functionally-empty content.
    if (!content?.trim()) {
      missingFile++
      continue
    }

    try {
      updateMeeting(row.id, { summary: content }, userId)
      updated++
    } catch (err) {
      console.error(
        `[summary-backfill] updateMeeting failed for ${row.id}:`,
        err,
      )
      skipped++
    }
  }

  console.log(
    `[summary-backfill] updated=${updated} skipped=${skipped} missingFile=${missingFile}`,
  )
  return { updated, skipped, missingFile }
}

/**
 * Thin wrapper called from app.whenReady. Defers the actual work by
 * 2s so it doesn't compete with the SyncAgent's first tick (kicked
 * off inside bootstrapSync at index.ts) or block the UI from
 * rendering the calendar tab quickly. Mirrors the canonical
 * backfillAnthropicKeyOnLaunch pattern in gateway-credentials.ts.
 *
 * Fire-and-forget — there's nothing for the rest of startup to wait
 * on. Failures inside backfillMissingSummaries are logged + counted;
 * no exception propagates out of the setTimeout.
 */
export function backfillMissingSummariesOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      backfillMissingSummaries(userId)
    } catch (err) {
      // Defensive: the inner function already try/catches each row
      // individually. This catches anything outside the loop (e.g. a
      // SQLite connection failure on the initial SELECT).
      console.error('[summary-backfill] unexpected failure:', err)
    }
  }, 2000)
}
