import type Database from 'better-sqlite3'

// =============================================================================
// sync-clock.ts — process-local Lamport counter for the SyncAgent.
//
// Each call to `nextLamport()` returns a string greater than every value
// returned previously in this process AND greater than every value
// persisted in `sync_state.last_pushed_lamport`. Two invariants:
//
//   1. Monotonic across writes: `next > prev` even within the same ms
//      (Date.now() resolution).
//   2. Monotonic across process restarts: on first call after launch we
//      seed from `sync_state.last_pushed_lamport` so we never regress.
//
// Stored as TEXT (numeric content) because the outbox uses TEXT throughout
// — matches the Postgres-side `lamport TEXT` definition.
// =============================================================================

let memo: bigint | null = null

/**
 * Returns the next lamport tick as a stringified BigInt. Caller stamps it
 * into the wrapped row + every outbox emission in the same transaction.
 *
 * Uses BigInt internally so we can compare against persisted TEXT values
 * (which may be larger than Number.MAX_SAFE_INTEGER after many years of use).
 */
export function nextLamport(db: Database.Database, deviceId: string): string {
  // Seed memo from persisted state on first call. Cheap (single row lookup).
  if (memo == null) {
    const row = db
      .prepare(`SELECT last_pushed_lamport FROM sync_state WHERE device_id = ?`)
      .get(deviceId) as { last_pushed_lamport: string } | undefined
    const persisted = row ? BigInt(row.last_pushed_lamport) : 0n
    memo = persisted
  }
  const now = BigInt(Date.now())
  // max(memo, now) + 1 — guarantees strict-monotonic AND keeps us close to
  // wall clock so different devices interleave reasonably under LWW.
  const next = (memo > now ? memo : now) + 1n
  memo = next
  return next.toString()
}

/**
 * Persists the high-water mark to `sync_state` after a successful batch
 * push. Called by the SyncAgent post-ack. Idempotent — upserts.
 */
export function persistLastPushedLamport(
  db: Database.Database,
  deviceId: string,
  userId: string,
  lamport: string,
): void {
  db.prepare(
    `INSERT INTO sync_state (device_id, user_id, last_pushed_lamport, last_seen_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(device_id) DO UPDATE SET
       last_pushed_lamport = excluded.last_pushed_lamport,
       last_seen_at = datetime('now')`,
  ).run(deviceId, userId, lamport)
}

/**
 * Test hook: reset the in-memory memo so a fresh process can be simulated.
 * NEVER call from production code.
 */
export function _resetLamportMemoForTesting(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('_resetLamportMemoForTesting is test-only')
  }
  memo = null
}
