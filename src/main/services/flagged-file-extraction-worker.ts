import {
  getPendingExtractionRows,
  updateFlaggedFileExtraction,
  type FlaggedFileRow,
} from '@cyggie/db/sqlite/repositories'
import { readLocalFile } from '../storage/file-manager'
import { getCurrentUserId } from '../security/current-user'

// =============================================================================
// flagged-file-extraction-worker.ts — Phase 3 durable extraction queue.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │ State machine                                                │
//   │   ┌────────┐    notify() OR boot                             │
//   │   │ idle   │ ─────────────────┐                              │
//   │   └────┬───┘                   ▼                              │
//   │        │            ┌───────────────────┐                     │
//   │        │            │ draining          │                     │
//   │        │            │  SELECT pending   │                     │
//   │        │            │  for each:        │                     │
//   │        │            │    UPDATE→extract │                     │
//   │        │            │    readLocalFile  │                     │
//   │        │            │    UPDATE→done/   │                     │
//   │        │            │           failed  │                     │
//   │        │            └────────┬──────────┘                     │
//   │        │                     │ queue empty                    │
//   │        └─────────────────────┘                                │
//   └─────────────────────────────────────────────────────────────┘
//
// Boot recovery: any row stuck at 'extracting' from a prior process is
// reset to 'pending' before draining (next loop picks it up). Concurrency:
// 1 row at a time — PDFs/Drive exports are CPU/network-bound and serial
// avoids Drive-API quota hammering. Tunable later if throughput matters.
//
// All state transitions go through the sync-wrapped
// `updateFlaggedFileExtraction` so the gateway sees pending → extracting
// → done/failed timeline. T38 trim-on-update + `largeColumns:
// ['extractedText']` keep the status-transition payloads small.
//
// Backfill: pre-Phase-3 rows have NULL user_id. The worker stamps
// getCurrentUserId() on the first transition for any row that needs it
// — single-user-per-device makes this safe.
// =============================================================================

interface WorkerState {
  running: boolean
  rescanRequested: boolean
}

const state: WorkerState = {
  running: false,
  rescanRequested: false,
}

/**
 * Kick the worker. Call after a successful flag/refresh write. Idempotent:
 * if the worker is already draining, just sets a flag so it re-scans after
 * the current row finishes (covers the race where a new flag arrives while
 * the worker is processing).
 */
export function notifyPending(): void {
  if (state.running) {
    state.rescanRequested = true
    return
  }
  void drain()
}

/**
 * One-shot boot recovery + initial drain. Called once from main bootstrap
 * after migrations + auth hydrate. Resets stuck 'extracting' rows to
 * 'pending' (last-run crash recovery) then drains the queue.
 */
export function startExtractionWorker(): void {
  // No explicit reset step needed — getPendingExtractionRows already
  // returns rows in either 'pending' or 'extracting'; the per-row UPDATE
  // below flips them to 'extracting' fresh. If the prior process died
  // mid-row, status was 'extracting' and we just pick up where it left
  // off (re-extract). Idempotent.
  void drain()
}

async function drain(): Promise<void> {
  if (state.running) return
  state.running = true
  try {
    while (true) {
      state.rescanRequested = false
      const rows = getPendingExtractionRows()
      if (rows.length === 0) {
        // Nothing left. Check rescan-requested one more time in case a
        // notify() raced with the empty SELECT.
        if (!state.rescanRequested) break
        continue
      }
      for (const row of rows) {
        await processRow(row)
      }
    }
  } finally {
    state.running = false
  }
}

async function processRow(row: FlaggedFileRow): Promise<void> {
  // Backfill user_id for pre-Phase-3 rows (column was nullable in
  // migration 104). Single-user-per-device — safe to infer.
  const ensureUserIdPatch =
    row.userId == null ? { userId: getCurrentUserId() } : {}

  // Transition to 'extracting' so concurrent workers/UI see live state.
  try {
    updateFlaggedFileExtraction(row.id, {
      extractionStatus: 'extracting',
      ...ensureUserIdPatch,
    })
  } catch (err) {
    // If the row was unflagged (DELETEd) between SELECT and UPDATE, the
    // wrapper returns null and the dev-mode assertion fires. Either way:
    // skip this row, continue.
    console.warn(`[extraction-worker] could not transition row ${row.id} to extracting`, err)
    return
  }

  let extractedText: string | null = null
  let error: string | null = null
  try {
    extractedText = await readLocalFile(row.fileId, row.mimeType ?? undefined)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }

  // null text + no thrown error = file existed but had no extractable
  // content (e.g. PDF with only images, encrypted, etc.). Distinguish
  // from a true failure so the UI can show "no text found" vs error.
  if (extractedText === null && error === null) {
    error = 'No extractable text found in this file'
  }

  if (error !== null) {
    try {
      updateFlaggedFileExtraction(row.id, {
        extractionStatus: 'failed',
        extractionError: error.slice(0, 500),
        extractedAt: new Date().toISOString(),
      })
    } catch (e) {
      console.warn(`[extraction-worker] could not mark row ${row.id} as failed`, e)
    }
    return
  }

  try {
    updateFlaggedFileExtraction(row.id, {
      extractionStatus: 'done',
      extractedText,
      extractedTextChars: extractedText!.length,
      extractedAt: new Date().toISOString(),
      // drive_version stays NULL for v1 — no etag/modifyTime tracking yet
      // (planned for a future iteration). For now, ↻ refresh is the manual
      // invalidation mechanism.
    })
  } catch (e) {
    console.warn(`[extraction-worker] could not mark row ${row.id} as done`, e)
  }
}

// Test hooks — only used by the worker unit tests.
export const __test = {
  resetState(): void {
    state.running = false
    state.rescanRequested = false
  },
  isRunning(): boolean {
    return state.running
  },
}
