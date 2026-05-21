// =============================================================================
// retry.ts — pure backoff + dead-letter helpers for the mobile outbox.
//
// Extracted into a pure module (no MMKV / no fetch) so unit tests don't
// drag the runtime into the test graph. Mirrors the poll-action.ts /
// mount-action.ts pattern used elsewhere in mobile/lib/recording.
// =============================================================================

/** Maximum retry attempts before an outbox entry moves to the DLQ. */
export const MAX_RETRIES = 10

/**
 * Exponential backoff schedule (ms). Indexed by retry count (0 = first
 * retry). Capped at the final value once retries >= length - 1.
 *
 *   retries=0  → 1s
 *   retries=1  → 2s
 *   retries=2  → 4s
 *   retries=3  → 16s
 *   retries>=4 → 60s (until DLQ)
 *
 * The 1→2→4→16→60 curve was chosen during plan-eng-review: aggressive
 * early retries (so a flapping connection self-heals quickly) then a
 * long ceiling (so a sustained outage doesn't hammer the gateway).
 */
const BACKOFF_MS = [1_000, 2_000, 4_000, 16_000, 60_000] as const

export function decideNextRetryDelay(retries: number): number {
  if (retries < 0) return BACKOFF_MS[0]
  if (retries >= BACKOFF_MS.length) return BACKOFF_MS[BACKOFF_MS.length - 1]
  return BACKOFF_MS[retries]
}

export function shouldDeadLetter(retries: number): boolean {
  return retries >= MAX_RETRIES
}
