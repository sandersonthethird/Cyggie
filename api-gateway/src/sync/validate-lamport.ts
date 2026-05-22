// =============================================================================
// validate-lamport.ts — gateway-side ceiling check on incoming lamports.
//
// Both sync write paths (`POST /sync/push` and `PATCH /meetings/:id`) use
// client-sourced lamport with Last-Write-Wins compare. Without a ceiling
// check, a malicious or buggy client could send `BigInt.MAX` and
// permanently lock out all future writes (gateway LWW would reject every
// legitimate edit because incoming < BigInt.MAX). T8 in TODOS.md.
//
// CEILING DESIGN
//
// The lamport clock on both desktop and mobile seeds from `Date.now()`
// (see packages/db/src/sync/sync-clock.ts on desktop, mobile/lib/sync/
// clock.ts on mobile). A legitimate lamport is therefore close to the
// server's wall-clock ms timestamp. We allow a 5-minute skew window to
// tolerate client clock drift; anything beyond that is rejected as
// forged or pathologically clock-skewed.
//
// 5 minutes is comfortable: even an aggressive client typing 1000
// keystrokes/sec for an hour only advances lamport by ~3.6 million ms
// (which is still ≤ Date.now() because lamport = max(local, Date.now())
// per nextLamport's logic — it tracks wall clock, doesn't run ahead).
// The window is about clock-skew, not about activity volume.
// =============================================================================

const FIVE_MINUTES_MS = 5 * 60 * 1000

/**
 * Maximum tolerated skew between client's lamport and the server's wall
 * clock. Exported for tests + the rare admin/debug case that needs to
 * reason about the bound.
 */
export const MAX_LAMPORT_SKEW_MS = FIVE_MINUTES_MS

export type LamportValidation =
  | { valid: true; bigint: bigint }
  | { valid: false; reason: 'unparseable' | 'too_far_future' }

/**
 * Validates an incoming client lamport. Returns the parsed BigInt on
 * success, or an error reason. Callers reject 400 with a stable error
 * code on `valid: false`.
 *
 *   • 'unparseable' — incoming isn't a valid BigInt string
 *   • 'too_far_future' — incoming > Date.now() + MAX_LAMPORT_SKEW_MS
 *
 * Lamports in the PAST are not rejected here — that's a normal stale
 * write and the LWW compare further down will turn it into a 409.
 */
export function validateClientLamport(
  incoming: string,
  nowMs: number = Date.now(),
): LamportValidation {
  // BigInt('') returns 0n rather than throwing — guard explicitly so an
  // empty string can't slip through as a "valid" zero.
  if (incoming.length === 0) return { valid: false, reason: 'unparseable' }
  let n: bigint
  try {
    n = BigInt(incoming)
  } catch {
    return { valid: false, reason: 'unparseable' }
  }
  const ceiling = BigInt(nowMs + MAX_LAMPORT_SKEW_MS)
  if (n > ceiling) return { valid: false, reason: 'too_far_future' }
  return { valid: true, bigint: n }
}
