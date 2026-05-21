// =============================================================================
// agent.ts — outbox drain agent for the mobile sync subsystem.
//
// Triggers (in app code):
//   • app foreground            — AppState 'active' transition
//   • network online             — NetInfo isConnected toggle
//   • periodic                   — setInterval(30s) while focused
//   • explicit (after enqueue)   — call drainNow() to attempt immediately
//
// SINGLE-FLIGHT (plan-eng-review 2A)
//   The four triggers race on cold launch — app focuses, network connects,
//   and a queued PATCH fires the in-flight setter all within one tick. A
//   module-level `isDraining` mutex collapses concurrent calls into one
//   logical drain pass. The flag is cleared in `finally` so a thrown
//   exception can't permanently lock the agent out.
//
// PER-ENTRY OUTCOME
//   2xx       → removeById; if 200 returned a MeetingDetail, merge its
//               lamport into the local clock (server might have advanced
//               from another device) and call onApplied for cache update.
//   409       → conflict — discard our entry; the agent fires
//               onConflict({ meetingId, server }) so the UI can show the
//               NotesConflictModal with the server's authoritative state.
//   400 / 404 → permanent — DLQ + Sentry-style log (we can't fix it by
//               retrying).
//   5xx / net → bumpRetry; reschedule via decideNextRetryDelay.
//   >= MAX    → DLQ.
//
// DESIGN: keep ALL network calls + DOM-style globals INJECTED so vitest
// can drive this module without React Native's runtime.
// =============================================================================

import {
  loadAll,
  removeById,
  bumpRetry,
  moveToDLQ,
  type OutboxEntry,
} from './outbox'
import { merge as mergeClock } from './clock'
import { decideNextRetryDelay, shouldDeadLetter } from './retry'

// ─── Injection hooks (set by app code at boot) ─────────────────────────────

/**
 * PATCH executor — the real impl uses `api.patch` from lib/api/client.ts
 * (which handles JWT + 401 refresh transparently). Injected so unit
 * tests can drive specific status codes without standing up fetch.
 */
export interface PatchResult {
  status: number
  /** Parsed JSON body when present. */
  body?: unknown
}

export type PatchExecutor = (
  url: string,
  body: { notes: string | null; lamport: string },
) => Promise<PatchResult>

let patchExecutor: PatchExecutor | null = null

export function configureSyncAgent(opts: {
  patch: PatchExecutor
  onApplied?: (meetingId: string, body: unknown) => void
  onConflict?: (event: { meetingId: string; server: unknown }) => void
  onDLQ?: (entry: OutboxEntry, reason: string) => void
}): void {
  patchExecutor = opts.patch
  onApplied = opts.onApplied ?? null
  onConflict = opts.onConflict ?? null
  onDLQ = opts.onDLQ ?? null
}

let onApplied: ((meetingId: string, body: unknown) => void) | null = null
let onConflict:
  | ((event: { meetingId: string; server: unknown }) => void)
  | null = null
let onDLQ: ((entry: OutboxEntry, reason: string) => void) | null = null

// ─── Single-flight mutex ───────────────────────────────────────────────────

let isDraining = false

export interface DrainSummary {
  attempted: number
  applied: number
  conflicts: number
  retries: number
  deadLetters: number
  /** Set when drainNow() short-circuited because another drain was active. */
  skippedConcurrent?: true
}

export async function drainNow(): Promise<DrainSummary> {
  if (isDraining) {
    return {
      attempted: 0,
      applied: 0,
      conflicts: 0,
      retries: 0,
      deadLetters: 0,
      skippedConcurrent: true,
    }
  }
  if (!patchExecutor) {
    // Agent not configured yet — silently no-op. App-boot path calls
    // configureSyncAgent before the user can possibly enqueue.
    return { attempted: 0, applied: 0, conflicts: 0, retries: 0, deadLetters: 0 }
  }
  isDraining = true
  const summary: DrainSummary = {
    attempted: 0,
    applied: 0,
    conflicts: 0,
    retries: 0,
    deadLetters: 0,
  }
  try {
    const entries = loadAll()
    for (const entry of entries) {
      summary.attempted += 1
      const outcome = await processEntry(entry)
      switch (outcome.kind) {
        case 'applied':
          summary.applied += 1
          break
        case 'conflict':
          summary.conflicts += 1
          break
        case 'retry':
          summary.retries += 1
          break
        case 'dlq':
          summary.deadLetters += 1
          break
      }
    }
  } finally {
    isDraining = false
  }
  return summary
}

type ProcessOutcome =
  | { kind: 'applied' }
  | { kind: 'conflict' }
  | { kind: 'retry' }
  | { kind: 'dlq' }

async function processEntry(entry: OutboxEntry): Promise<ProcessOutcome> {
  if (entry.op !== 'meeting.notes.update') {
    // Unknown op — DLQ; shouldn't happen for V1.
    moveToDLQ(entry.id)
    onDLQ?.(entry, 'unknown_op')
    return { kind: 'dlq' }
  }

  let result: PatchResult
  try {
    result = await patchExecutor!(
      `/meetings/${encodeURIComponent(entry.resourceId)}`,
      entry.payload,
    )
  } catch (err) {
    // Network failure — bump retries or DLQ if exhausted.
    const message = err instanceof Error ? err.message : String(err)
    return handleTransient(entry, message)
  }

  if (result.status >= 200 && result.status < 300) {
    removeById(entry.id)
    // Server may have advanced lamport from another device — merge.
    const serverLamport =
      typeof result.body === 'object' &&
      result.body !== null &&
      'lamport' in result.body &&
      typeof (result.body as { lamport: unknown }).lamport === 'string'
        ? (result.body as { lamport: string }).lamport
        : null
    if (serverLamport) mergeClock(serverLamport)
    onApplied?.(entry.resourceId, result.body)
    return { kind: 'applied' }
  }

  if (result.status === 409) {
    // Stale lamport — discard the loser, surface the server state to UI.
    removeById(entry.id)
    onConflict?.({ meetingId: entry.resourceId, server: result.body })
    return { kind: 'conflict' }
  }

  if (result.status === 400 || result.status === 404) {
    // Permanent — DLQ.
    moveToDLQ(entry.id)
    onDLQ?.(entry, `http_${result.status}`)
    return { kind: 'dlq' }
  }

  // 5xx / 408 / other transient — retry.
  return handleTransient(entry, `http_${result.status}`)
}

function handleTransient(entry: OutboxEntry, reason: string): ProcessOutcome {
  const nextRetries = entry.retries + 1
  if (shouldDeadLetter(nextRetries)) {
    moveToDLQ(entry.id)
    onDLQ?.(entry, `max_retries_${reason}`)
    return { kind: 'dlq' }
  }
  bumpRetry(entry.id, reason)
  return { kind: 'retry' }
}

/**
 * Suggest a delay (ms) until the next drain attempt for the most
 * recently-retried entry, given the current queue. App code may use
 * this to schedule a one-off setTimeout instead of (or in addition to)
 * the 30s periodic.
 */
export function nextRetryDelayMs(): number | null {
  const entries = loadAll()
  if (entries.length === 0) return null
  const maxRetries = entries.reduce((m, e) => Math.max(m, e.retries), 0)
  return decideNextRetryDelay(maxRetries)
}

/** Test-only — clear the in-flight latch (vitest doesn't share module state
 *  across files, but a hung drain inside a single test would block siblings). */
export function __resetForTest(): void {
  isDraining = false
  patchExecutor = null
  onApplied = null
  onConflict = null
  onDLQ = null
}
