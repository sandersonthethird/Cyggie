import type Database from 'better-sqlite3'
import { encodeRowId } from '../sync/encode-row-id'
import {
  OWNED_TABLES_BY_NAME,
  isOwnedTable,
  type OwnedTableSpec,
} from '../sync/owned-tables'

// =============================================================================
// sync-wrapper.ts — outbox-emission primitive for the SyncAgent.
//
// Two responsibilities:
//   1. `appendOutboxRow(db, ctx)` — inserts one row into the SQLite outbox.
//      Called by `withSync()` for the primary table, and by repository
//      functions directly for any secondary tables they mutate inside the
//      same transaction (cascades).
//
//   2. Per-transaction context (`SyncContext`) tracking — exposes a
//      `currentSyncContext()` accessor that lets repo helpers (and the
//      dev-mode bypass assertion) detect whether they're running inside an
//      active wrapped transaction.
//
// DESIGN NOTE: an earlier draft of this file planned to subscribe to
// better-sqlite3's update_hook and auto-derive outbox entries for every row
// touched in a wrapped transaction. The hook isn't exposed by better-sqlite3
// — only the underlying SQLite C API has it. So this implementation uses
// explicit emission: callers tell us what they touched. Drift defense
// downgrades to a dev-mode assertion ("at least one outbox row was emitted
// before commit") plus code review + tests.
// =============================================================================

export interface SyncContext {
  /** Device that initiated the write — propagates to outbox.device_id. */
  deviceId: string
  /** User who owns the write — propagates to outbox.user_id. */
  userId: string
  /**
   * Per-transaction lamport. The wrapper bumps this once via `sync-clock.ts`
   * before the inner function runs; every outbox row in the transaction
   * shares the same lamport (they happened atomically).
   */
  lamport: string
  /**
   * Counter incremented by appendOutboxRow; used by `withSync` to assert
   * at least one outbox emission happened before commit.
   */
  emittedCount: number
}

let activeContext: SyncContext | null = null

/**
 * Returns the active SyncContext if currently inside a `withSync()`
 * transaction, else null. Used by:
 *
 *   • Repository helpers that need to know the user_id / device_id / lamport
 *     for the in-flight write (e.g. to stamp them onto the row being saved).
 *   • The dev-mode runtime assertion (`assertInsideSyncTransaction`) that
 *     guards against direct calls to raw repo writes.
 */
export function currentSyncContext(): SyncContext | null {
  return activeContext
}

/**
 * Asserts we're inside a wrapped transaction. Compiled-out in production
 * builds via `process.env.NODE_ENV !== 'production'` so the call site has
 * zero overhead at runtime. Throws in dev and test so the bypass surfaces
 * loudly during local development and CI.
 */
export function assertInsideSyncTransaction(callerName: string): void {
  if (process.env['NODE_ENV'] === 'production') return
  if (activeContext == null) {
    throw new Error(
      `[sync] ${callerName} called outside an active withSync() transaction. ` +
        `Production code must import from '@cyggie/db/sqlite/repositories' (the ` +
        `barrel) so writes flow through the outbox. Tests under __tests__/ may ` +
        `import the raw repo; if you see this in a test, wrap the call in withSync().`,
    )
  }
}

/**
 * Sets the active context for the duration of a callback. Caller (only
 * `withSync()`) is responsible for restoring the previous context in a
 * finally block. Returns the prior context so it can be restored.
 */
export function pushSyncContext(ctx: SyncContext): SyncContext | null {
  const prev = activeContext
  activeContext = ctx
  return prev
}

export function popSyncContext(prev: SyncContext | null): void {
  activeContext = prev
}

/**
 * Inserts one row into the local SQLite outbox.
 *
 * MUST be called inside an active `withSync()` transaction — the wrapper
 * binds outbox.user_id, .device_id, .lamport from the SyncContext, so
 * calling this outside a transaction has no source of those values and
 * throws.
 *
 * `payload` is the JS-side row state (the wrapper JSON.stringifies it for
 * the TEXT column). For deletes, pass the pre-delete row state so the
 * gateway can audit / propagate.
 */
export interface OutboxEmission {
  /** Owned table name. Must be in `OWNED_TABLES`. */
  table: string
  /** 'insert' | 'update' | 'delete' */
  op: 'insert' | 'update' | 'delete'
  /**
   * The row state. For inserts/updates: the new row. For deletes: the
   * pre-delete row (the wrapped function is responsible for SELECTing it
   * before the DELETE statement).
   */
  row: Record<string, unknown>
}

export function appendOutboxRow(
  db: Database.Database,
  emission: OutboxEmission,
): void {
  const ctx = activeContext
  if (ctx == null) {
    throw new Error(
      `[sync] appendOutboxRow(${emission.table}) called outside an active withSync() transaction`,
    )
  }
  const spec = OWNED_TABLES_BY_NAME.get(emission.table)
  if (!spec) {
    throw new Error(
      `[sync] appendOutboxRow: '${emission.table}' is not in OWNED_TABLES`,
    )
  }
  const rowId = encodeRowId(spec, emission.row)
  db.prepare(
    `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.userId,
    ctx.deviceId,
    emission.table,
    rowId,
    emission.op,
    JSON.stringify(emission.row),
    ctx.lamport,
  )
  ctx.emittedCount++
}

/**
 * Convenience: same as `appendOutboxRow` but accepts a spec directly
 * (skips the registry lookup). Used by the higher-order `withSync` helper
 * which already has the spec resolved.
 */
export function appendOutboxRowWithSpec(
  db: Database.Database,
  spec: OwnedTableSpec,
  op: OutboxEmission['op'],
  row: Record<string, unknown>,
): void {
  appendOutboxRow(db, { table: spec.table, op, row })
}

/**
 * For tests + the dev assertion: confirm a table is in the owned registry.
 * Re-exported here so callers can `import { isOwnedTable } from './sync-wrapper'`
 * instead of reaching all the way into `../sync/owned-tables`.
 */
export { isOwnedTable }
