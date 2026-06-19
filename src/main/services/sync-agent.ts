import type Database from 'better-sqlite3'
import { persistLastPushedLamport } from '@cyggie/db/sync/sync-clock'

// =============================================================================
// sync-agent.ts — desktop daemon that drains the local outbox to Neon.
//
// State machine (mirrors the comment in packages/db/src/schema/sync.ts):
//
//   ┌─────────┐  outbox has rows  ┌───────────┐  POST /sync/push   ┌──────────────┐
//   │  IDLE   ├──────────────────▶│ FLUSHING  ├───────────────────▶│ ACK_PENDING  │
//   └────┬────┘                   └─────┬─────┘                    └──────┬───────┘
//        ▲                              │ error                            │ apply acks
//        │ on-tick (every 5s)          ▼                                  ▼
//        │ on-startup                  back to IDLE w/ backoff       update sync_state
//        │ on-write-trigger            (exponential)                 delete acked rows
//        └────────────────────────────────────────────────────────────────┘
//
// Drain semantics:
//   • Pulls up to BATCH_SIZE rows from outbox where status='pending'.
//   • Coalesces multiple entries for the same (table, row_id, op) to the
//     latest only — saves redundant gateway round-trips during edit-heavy
//     sessions.
//   • Marks rows status='failed' + attempts++ on 422 (validation reject).
//   • Promotes to status='dead' at MAX_ATTEMPTS so they stop blocking the
//     queue. Surfaced to the user via SYNC_STATUS IPC.
//
// Auth (injected): the desktop currently has no OAuth flow of its own (mobile
// does). The agent takes a `getAccessToken` callback so the auth implementation
// can plug in later. While that's unwired, the agent still drains via
// transactions and can be unit-tested with a mocked transport.
// =============================================================================

// Hard ceiling — the agent never pulls more than this per drain pass.
// T38 made this adaptive: on 413 the agent halves the active size and
// persists the new ceiling to `sync_state.safe_batch_size`. Combined
// with payload trimming in `withSync` (large JSONB columns dropped from
// UPDATE outbox rows when unchanged), 200 is comfortable at single-firm
// scale; the adaptive halver covers pathological cases where a hot
// meeting accumulates a multi-MB transcript_segments diff inside one
// batch window.
const BATCH_SIZE_CEILING = 200
// Floor when halving — below this we stop shrinking and let the
// agent's regular failure path (rejected/dead) handle the row. A
// single row that overflows 10 MB after trimming is pathological and
// almost certainly indicates an upstream bug (e.g. a transcript that
// should be chunked).
const BATCH_SIZE_FLOOR = 1
// After this many consecutive successful flushes that drained a full
// batch (i.e. there were >= currentBatchSize rows pending), the agent
// tries doubling its batch size back toward the ceiling. Slow growth
// prevents oscillation around the real safe size.
const BATCH_GROWTH_SUCCESS_THRESHOLD = 10
const TICK_INTERVAL_MS = 5_000
const MAX_ATTEMPTS = 5
const BACKOFF_INITIAL_MS = 2_000
const BACKOFF_MAX_MS = 60_000

/**
 * Thrown by `SyncTransport.push` when the gateway returns 413
 * (FST_ERR_CTP_BODY_TOO_LARGE). The agent catches this specifically
 * and halves its current batch size for the retry, distinguishing
 * "payload was too big" from generic 4xx (which mark rows as rejected).
 */
export class PayloadTooLargeError extends Error {
  constructor(message = 'payload too large') {
    super(message)
    this.name = 'PayloadTooLargeError'
  }
}

interface OutboxEntry {
  id: number
  user_id: string
  device_id: string
  table_name: string
  row_id: string
  op: 'insert' | 'update' | 'delete'
  payload: string
  lamport: string
  attempts: number
}

export interface PushBatchEntry {
  outboxId: number
  table: string
  rowId: string
  op: 'insert' | 'update' | 'delete'
  payload: unknown // parsed JSON of outbox.payload
  lamport: string
}

export interface PushBatchResponse {
  acked: number[] // outboxIds successfully applied
  rejected: Array<{ outboxId: number; reason: string }>
  conflicts: Array<{ outboxId: number; reason: string }> // logged but counted as success
}

export interface SyncTransport {
  /**
   * POST /sync/push { deviceId, batch }. Returns parsed response or throws
   * for network/5xx errors (which the agent treats as retryable). 4xx
   * errors should be surfaced via the response's `rejected` array — they
   * don't throw.
   */
  push(params: {
    deviceId: string
    batch: PushBatchEntry[]
  }): Promise<PushBatchResponse>
}

export interface SyncAgentConfig {
  db: Database.Database
  /** Returns the local user_id, or null if not signed in. */
  getUserId: () => string | null
  /** Returns the per-app device_id. */
  getDeviceId: () => string
  /**
   * Returns a fresh access token, or null if auth isn't ready / required
   * refresh failed. Agent pauses with PAUSED_NO_AUTH status until a token
   * is available.
   */
  getAccessToken: () => Promise<string | null>
  /**
   * Transport for the HTTP POST. Injected so tests can pass a mock and
   * the desktop can replace the real implementation when auth lands.
   */
  transport: SyncTransport
  /** Wall-clock + setInterval injectable for tests. */
  clock?: {
    setInterval: (cb: () => void, ms: number) => ReturnType<typeof setInterval>
    clearInterval: (h: ReturnType<typeof setInterval>) => void
    now: () => number
  }
  /** Test seam: smaller batches in tests. */
  batchSize?: number
  /** Test seam: faster ticks in tests. */
  tickIntervalMs?: number
  /** Reports state changes for tray icon / IPC. Optional. */
  onStateChange?: (snapshot: SyncStateSnapshot) => void
}

export type SyncState =
  | 'idle'
  | 'flushing'
  | 'ack_pending'
  | 'backing_off'
  | 'paused_no_auth'
  | 'paused_cap_reached'

export interface SyncStateSnapshot {
  state: SyncState
  pendingCount: number
  failedCount: number
  deadCount: number
  lastFlushAt: number | null
  lastError: string | null
  nextRetryAt: number | null
}

export class SyncAgent {
  private cfg: SyncAgentConfig
  private state: SyncState = 'idle'
  private tickHandle: ReturnType<typeof setInterval> | null = null
  private running = false
  private flushInFlight: Promise<void> | null = null
  private backoffMs = BACKOFF_INITIAL_MS
  private lastFlushAt: number | null = null
  private lastError: string | null = null
  private nextRetryAt: number | null = null
  /**
   * T38 — adaptive batch size. Initialized from `sync_state.safe_batch_size`
   * (NULL → ceiling). Halved on 413, persisted on change. Grows back
   * toward the ceiling after sustained full-batch successes.
   */
  private currentBatchSize: number
  private consecutiveFullBatchSuccesses = 0

  constructor(cfg: SyncAgentConfig) {
    this.cfg = cfg
    this.currentBatchSize = this.loadPersistedBatchSize() ?? this.maxBatchSize()
  }

  private maxBatchSize(): number {
    // Test seam: `cfg.batchSize` clamps the ceiling. Production uses
    // BATCH_SIZE_CEILING.
    return this.cfg.batchSize ?? BATCH_SIZE_CEILING
  }

  private loadPersistedBatchSize(): number | null {
    const deviceId = this.cfg.getDeviceId()
    const row = this.cfg.db
      .prepare(
        `SELECT safe_batch_size FROM sync_state WHERE device_id = ?`,
      )
      .get(deviceId) as { safe_batch_size: number | null } | undefined
    const v = row?.safe_batch_size
    if (v == null || v <= 0) return null
    // Clamp to the compiled ceiling — a stale persisted value larger
    // than the current ceiling shouldn't override the code's intent.
    return Math.min(v, this.maxBatchSize())
  }

  private persistBatchSize(size: number): void {
    const deviceId = this.cfg.getDeviceId()
    const userId = this.cfg.getUserId()
    if (!userId) return // no auth → can't write user-scoped row
    this.cfg.db
      .prepare(
        `INSERT INTO sync_state (device_id, user_id, safe_batch_size)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET safe_batch_size = excluded.safe_batch_size`,
      )
      .run(deviceId, userId, size)
  }

  /**
   * Halve the current batch size in response to a 413 from the gateway.
   * Floors at BATCH_SIZE_FLOOR. Persists the new size. Resets the
   * growth counter so we don't grow back until we've validated the
   * smaller size at least N successful flushes in a row.
   */
  private shrinkBatchSize(): void {
    const next = Math.max(
      BATCH_SIZE_FLOOR,
      Math.floor(this.currentBatchSize / 2),
    )
    if (next === this.currentBatchSize) return
    this.currentBatchSize = next
    this.consecutiveFullBatchSuccesses = 0
    this.persistBatchSize(next)
  }

  /**
   * Grow toward the ceiling after sustained success. Doubles the
   * current size, clamped to the ceiling. Persists the new size.
   * Caller decides when growth is warranted (typically: a streak of
   * full-batch flushes succeeded, meaning we have evidence the bigger
   * size would have worked).
   */
  private growBatchSize(): void {
    const ceiling = this.maxBatchSize()
    if (this.currentBatchSize >= ceiling) return
    const next = Math.min(ceiling, this.currentBatchSize * 2)
    if (next === this.currentBatchSize) return
    this.currentBatchSize = next
    this.consecutiveFullBatchSuccesses = 0
    this.persistBatchSize(next)
  }

  /** Starts the periodic tick + does an immediate drain attempt. */
  start(): void {
    if (this.running) return
    this.running = true
    const { setInterval: si } = this.clock()
    this.tickHandle = si(() => {
      void this.flushOnce().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err)
      })
    }, this.cfg.tickIntervalMs ?? TICK_INTERVAL_MS)
    // Fire one immediately so a fresh start doesn't wait the full interval.
    void this.flushOnce().catch(() => undefined)
  }

  stop(): void {
    this.running = false
    if (this.tickHandle != null) {
      this.clock().clearInterval(this.tickHandle)
      this.tickHandle = null
    }
  }

  /** External trigger — called after every write to drain ASAP. */
  triggerFlush(): void {
    if (!this.running) return
    void this.flushOnce().catch(() => undefined)
  }

  /** Manual: re-attempts failed + dead-letter rows by resetting their status.
   *  Includes 'failed' (not just 'dead') so a fixed gateway can re-drive rows
   *  that haven't yet exhausted MAX_ATTEMPTS. */
  retryDeadLetters(): number {
    const result = this.cfg.db
      .prepare(`UPDATE outbox SET status = 'pending', attempts = 0, last_error = NULL WHERE status IN ('failed', 'dead')`)
      .run()
    return result.changes
  }

  /**
   * Returns the agent's current internal state. Phase 1.5c (SyncPullService)
   * reads this at the top of each pull tick to enforce the push/pull mutex
   * (drops the tick when state !== 'idle' so the two never overlap).
   * Public read of a snapshot value — no mutation, no race.
   */
  getState(): SyncState {
    return this.state
  }

  snapshot(): SyncStateSnapshot {
    const counts = this.cfg.db
      .prepare(
        `SELECT
           sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
           sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           sum(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
         FROM outbox`,
      )
      .get() as { pending: number | null; failed: number | null; dead: number | null }
    return {
      state: this.state,
      pendingCount: counts.pending ?? 0,
      failedCount: counts.failed ?? 0,
      deadCount: counts.dead ?? 0,
      lastFlushAt: this.lastFlushAt,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
    }
  }

  // -- internals --------------------------------------------------------------

  private clock(): NonNullable<SyncAgentConfig['clock']> {
    return (
      this.cfg.clock ?? {
        setInterval: setInterval,
        clearInterval: clearInterval,
        now: Date.now,
      }
    )
  }

  private setState(state: SyncState): void {
    if (this.state === state) return
    this.state = state
    this.cfg.onStateChange?.(this.snapshot())
  }

  private async flushOnce(): Promise<void> {
    // Single-flight: don't allow concurrent flushes; later calls coalesce
    // onto the in-flight one.
    if (this.flushInFlight) return this.flushInFlight
    if (!this.running) return
    if (this.nextRetryAt != null && this.clock().now() < this.nextRetryAt) {
      this.setState('backing_off')
      return
    }
    this.flushInFlight = this.doFlush().finally(() => {
      this.flushInFlight = null
    })
    return this.flushInFlight
  }

  private async doFlush(): Promise<void> {
    const batchSize = this.currentBatchSize
    const rows = this.cfg.db
      .prepare(
        `SELECT id, user_id, device_id, table_name, row_id, op, payload, lamport, attempts
         FROM outbox WHERE status = 'pending'
         ORDER BY id ASC LIMIT ?`,
      )
      .all(batchSize) as OutboxEntry[]

    if (rows.length === 0) {
      this.setState('idle')
      this.lastError = null
      return
    }

    // Coalesce: keep only the latest entry per (table, row_id, op). Earlier
    // entries that get coalesced are marked acked (so they're removed from
    // outbox alongside the latest after gateway ack).
    const { kept, coalesced } = coalesceBatch(rows)

    const token = await this.cfg.getAccessToken()
    if (token == null) {
      this.setState('paused_no_auth')
      this.lastError = 'No access token'
      return
    }

    this.setState('flushing')

    const batch: PushBatchEntry[] = kept.map((r) => ({
      outboxId: r.id,
      table: r.table_name,
      rowId: r.row_id,
      op: r.op,
      payload: parsePayload(r.payload),
      lamport: r.lamport,
    }))

    let response: PushBatchResponse
    try {
      this.setState('ack_pending')
      response = await this.cfg.transport.push({
        deviceId: this.cfg.getDeviceId(),
        batch,
      })
    } catch (err) {
      // T38: a 413 means the batch payload exceeded the gateway's body
      // limit. Halve currentBatchSize, persist, and retry on the next
      // tick (or immediately via the post-flush re-fire below). Do NOT
      // mark rows as failed — they're still pending; the next pass will
      // pull a smaller subset.
      if (err instanceof PayloadTooLargeError) {
        const prev = this.currentBatchSize
        this.shrinkBatchSize()
        this.lastError = `payload too large: batch ${prev} → ${this.currentBatchSize}`
        // If we were already at the floor, the same row will trip 413
        // again. Back off to avoid a tight retry loop on a pathological
        // row that overflows even at size 1.
        if (prev === this.currentBatchSize) {
          this.scheduleBackoff()
        } else {
          // Re-fire with the smaller size. Chain onto the wrapping
          // flushInFlight's `.finally` so the re-fire's flushOnce()
          // sees the in-flight handle CLEARED — otherwise it would
          // short-circuit onto the still-set current promise and be a
          // no-op (the clear happens in a `.finally` attached in
          // flushOnce; ours runs after because it's attached later).
          this.setState('idle')
          this.scheduleRefire()
        }
        return
      }
      // Network / 5xx — exponential backoff and retry.
      this.lastError = err instanceof Error ? err.message : String(err)
      this.scheduleBackoff()
      return
    }

    // Apply acks/rejects atomically.
    this.applyResponse(response, kept, coalesced)
    this.backoffMs = BACKOFF_INITIAL_MS
    this.nextRetryAt = null
    this.lastFlushAt = this.clock().now()
    this.lastError = null
    this.setState('idle')

    // T38: track full-batch successes. When the queue is deep enough
    // that we drain a full batch each pass AND we're below the ceiling,
    // a streak of successes is evidence the previously-discovered
    // ceiling is too conservative — try growing back.
    if (
      rows.length >= batchSize &&
      this.currentBatchSize < this.maxBatchSize()
    ) {
      this.consecutiveFullBatchSuccesses++
      if (
        this.consecutiveFullBatchSuccesses >= BATCH_GROWTH_SUCCESS_THRESHOLD
      ) {
        this.growBatchSize()
      }
    } else {
      this.consecutiveFullBatchSuccesses = 0
    }

    // Persist lamport high-water mark.
    const maxLamport = batch.reduce<bigint>((acc, e) => {
      const v = BigInt(e.lamport)
      return v > acc ? v : acc
    }, 0n)
    if (maxLamport > 0n) {
      const userId = this.cfg.getUserId()
      if (userId) {
        persistLastPushedLamport(
          this.cfg.db,
          this.cfg.getDeviceId(),
          userId,
          maxLamport.toString(),
        )
      }
    }

    // If we drained a full batch, immediately try again — more work
    // likely queued behind it. Same chaining-via-`finally` trick as the
    // 413 retry above so the re-fire actually starts a new flush
    // instead of attaching to the still-settling one.
    if (rows.length >= batchSize) {
      this.scheduleRefire()
    }
  }

  private applyResponse(
    response: PushBatchResponse,
    kept: OutboxEntry[],
    coalesced: OutboxEntry[],
  ): void {
    const ackedSet = new Set(response.acked)
    const rejectedById = new Map(
      response.rejected.map((r) => [r.outboxId, r.reason]),
    )
    const conflictSet = new Set(response.conflicts.map((c) => c.outboxId))

    const tx = this.cfg.db.transaction(() => {
      const deleteStmt = this.cfg.db.prepare(`DELETE FROM outbox WHERE id = ?`)
      const failStmt = this.cfg.db.prepare(
        `UPDATE outbox SET status = ?, attempts = attempts + 1, last_error = ? WHERE id = ?`,
      )

      for (const row of kept) {
        if (ackedSet.has(row.id)) {
          deleteStmt.run(row.id)
          continue
        }
        if (conflictSet.has(row.id)) {
          // Conflicts are logged-but-applied per the LWW spec. Treat as ack.
          deleteStmt.run(row.id)
          continue
        }
        const reason = rejectedById.get(row.id)
        if (reason != null) {
          const newAttempts = row.attempts + 1
          const nextStatus = newAttempts >= MAX_ATTEMPTS ? 'dead' : 'failed'
          failStmt.run(nextStatus, reason, row.id)
          continue
        }
        // No ack and no rejection — server didn't address this id. Leave as
        // pending; will retry next tick. Should not happen in practice.
      }
      // Coalesced rows are subsumed by the kept latest. If that latest got
      // acked, delete them too.
      for (const c of coalesced) {
        deleteStmt.run(c.id)
      }
    })
    tx()
  }

  private scheduleBackoff(): void {
    this.nextRetryAt = this.clock().now() + this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.setState('backing_off')
  }

  /**
   * Queue an immediate re-fire to drain whatever's left in the outbox.
   * Chains onto the currently-in-flight flush's `.finally` so the
   * existing in-flight handle is cleared before our flushOnce() runs;
   * a bare `void this.flushOnce()` would short-circuit onto the
   * still-set in-flight promise and be a no-op.
   */
  private scheduleRefire(): void {
    const inflight = this.flushInFlight
    if (inflight == null) {
      // No flush in progress — safe to fire directly.
      void this.flushOnce().catch(() => undefined)
      return
    }
    void inflight.finally(() => {
      // running flag may have flipped during the in-flight flush
      // (stop() called); flushOnce checks this anyway, so we don't.
      void this.flushOnce().catch(() => undefined)
    })
  }
}

// -- helpers ------------------------------------------------------------------

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Drain coalescing: collapse multiple outbox entries for the same
 * (table, row_id, op) tuple to only the latest. The earlier ones get
 * deleted alongside the latest after gateway ack (their changes are
 * superseded).
 *
 * Exported so tests can exercise it directly without standing up an agent.
 */
export function coalesceBatch(rows: OutboxEntry[]): {
  kept: OutboxEntry[]
  coalesced: OutboxEntry[]
} {
  // For each (table, row_id) keep the LAST entry (highest outbox id) in
  // each contiguous run of same-op entries. Different ops (insert vs delete)
  // do NOT coalesce — both events matter.
  //
  // Iterate descending so the first occurrence we keep is the latest.
  const kept: OutboxEntry[] = []
  const coalesced: OutboxEntry[] = []
  const seen = new Set<string>() // table|row_id|op
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!
    const key = `${r.table_name}|${r.row_id}|${r.op}`
    if (seen.has(key)) {
      coalesced.push(r)
    } else {
      seen.add(key)
      kept.push(r)
    }
  }
  // Reverse kept so we preserve ascending order for the gateway (FK
  // dependency: earlier outbox.id ≈ earlier write).
  kept.reverse()
  return { kept, coalesced }
}
