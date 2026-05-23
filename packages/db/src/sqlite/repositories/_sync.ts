import type Database from 'better-sqlite3'
import { OWNED_TABLES_BY_NAME } from '../../sync/owned-tables'
import {
  appendOutboxRowWithSpec,
  currentSyncContext,
  popSyncContext,
  pushSyncContext,
  type SyncContext,
} from '../sync-wrapper'
import { nextLamport } from '../../sync/sync-clock'

// =============================================================================
// _sync.ts — `withSync` higher-order helper applied at the repository barrel.
//
// Wraps a repo write function in a SQLite transaction that:
//   1. Mints a per-transaction lamport via `sync-clock`.
//   2. Pushes a SyncContext (userId + deviceId + lamport) so cascading
//      writes inside `fn` can call `appendOutboxRow` directly.
//   3. Runs `fn(...args)` synchronously (better-sqlite3 transactions are sync).
//   4. Emits ONE outbox entry for the primary table (extracted from
//      `args + result + preDelete`).
//   5. In dev/test: asserts at least one outbox row was emitted in the
//      transaction before commit. Catches writes that forget to register.
//
// The barrel (`packages/db/src/sqlite/repositories/index.ts`) re-exports
// every repo function wrapped with `withSync`. Reads pass through unwrapped.
//
// DESIGN NOTE — explicit emission vs auto-detection:
// An earlier plan used `update_hook` to auto-derive outbox entries for
// every row touched in a transaction. better-sqlite3 doesn't expose that
// SQLite C-API hook, so we settled on explicit emission. Cascading multi-
// table writes call `appendOutboxRow(db, …)` directly from inside the
// inner fn for the secondary rows; the wrapper handles the primary one.
// The drift defense becomes a weaker invariant ("≥1 emission per txn") +
// test coverage on the multi-table call sites.
// =============================================================================

export type WriteOp = 'insert' | 'update' | 'delete'

/**
 * App-bootstrap-configured accessors. Set once at desktop startup after
 * auth hydrates. The wrapper reads them on every call so callers don't
 * have to thread userId/deviceId through every repo function.
 */
export interface SyncGlobals {
  getDb: () => Database.Database
  getUserId: () => string | null
  getDeviceId: () => string | null
}

let configured: SyncGlobals | null = null

export function configureSyncGlobals(globals: SyncGlobals): void {
  configured = globals
}

/**
 * Test seam: clear configured globals so a fresh test can set its own.
 */
export function _resetSyncGlobalsForTesting(): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('_resetSyncGlobalsForTesting is test-only')
  }
  configured = null
}

export interface WithSyncOpts<TArgs extends readonly unknown[], TResult> {
  /** Owned-table name being mutated by the primary write. */
  table: string
  /** Type of mutation. */
  op: WriteOp
  /**
   * Returns the row state to put in the outbox payload. Defaults:
   *   • insert/update: the function's return value (must be a row object)
   *   • delete: the `preDelete` snapshot
   *
   * Override when fn returns something other than the row (e.g. a count
   * or a wrapper object), or when the row needs reshaping.
   */
  extractRow?: (
    state: EmitState<TArgs, TResult>,
  ) => Record<string, unknown> | null
  /**
   * For deletes: function that SELECTs the row before the inner fn runs.
   * Result is passed to `extractRow` via state.preDelete and is the default
   * payload if `extractRow` isn't supplied.
   */
  captureBeforeDelete?: (
    db: Database.Database,
    args: TArgs,
  ) => Record<string, unknown> | null
  /**
   * For updates on tables with `largeColumns` declared: function that
   * SELECTs the row before the inner fn runs. The wrapper compares each
   * `largeColumns` value pre vs post and OMITS unchanged values from
   * the outbox payload (T38 — payload trimming).
   *
   * Must return the row in the same shape as the inner fn's return value
   * (same key naming, same nested object/array shapes) so the diff is
   * apples-to-apples. Conventionally: `(_db, [id]) => rawRepo.getX(id)`.
   *
   * No-op without `OwnedTableSpec.largeColumns`. Declaring this without
   * `largeColumns` just costs a wasted SELECT.
   */
  captureBeforeUpdate?: (
    db: Database.Database,
    args: TArgs,
  ) => Record<string, unknown> | null
}

export interface EmitState<TArgs, TResult> {
  args: TArgs
  result: TResult
  preDelete: Record<string, unknown> | null
}

/**
 * Wraps `fn` in a sync-emitting transaction. Returns a function with the
 * same signature; existing call sites work without change.
 */
export function withSync<
  TArgs extends readonly unknown[],
  TResult,
>(
  fn: (...args: TArgs) => TResult,
  opts: WithSyncOpts<TArgs, TResult>,
): (...args: TArgs) => TResult {
  const spec = OWNED_TABLES_BY_NAME.get(opts.table)
  if (!spec) {
    throw new Error(
      `[sync] withSync: '${opts.table}' is not in OWNED_TABLES. ` +
        `Add it to packages/db/src/sync/owned-tables.ts first.`,
    )
  }

  return (...args: TArgs): TResult => {
    if (!configured) {
      throw new Error(
        `[sync] withSync(${opts.table}) called before configureSyncGlobals(). ` +
          `Desktop main must call this once during bootstrap after auth hydrates.`,
      )
    }
    const userId = configured.getUserId()
    const deviceId = configured.getDeviceId()
    if (!userId || !deviceId) {
      // No auth → nothing to sync. Run the inner function directly so the
      // user can still operate offline / pre-login (e.g. signup flow). Skip
      // outbox emission entirely. This path is exercised by the auth/firms
      // route tests.
      return fn(...args)
    }
    const db = configured.getDb()

    // The transaction wraps everything: capture-pre-delete + inner fn +
    // outbox emit. Atomicity guarantee — if anything throws, the data row
    // changes AND the outbox row roll back together.
    const txn = db.transaction((): TResult => {
      const lamport = nextLamport(db, deviceId)
      const ctx: SyncContext = {
        userId,
        deviceId,
        lamport,
        emittedCount: 0,
      }
      const prev = pushSyncContext(ctx)
      try {
        // For deletes, capture the row state before fn deletes it.
        let preDelete: Record<string, unknown> | null = null
        if (opts.op === 'delete' && opts.captureBeforeDelete) {
          preDelete = opts.captureBeforeDelete(db, args)
        }

        // T38: for updates on tables with large columns, snapshot the row
        // BEFORE the inner fn runs so we can diff and trim unchanged
        // large columns out of the outbox payload.
        let preUpdate: Record<string, unknown> | null = null
        if (
          opts.op === 'update' &&
          opts.captureBeforeUpdate &&
          spec.largeColumns &&
          spec.largeColumns.length > 0
        ) {
          preUpdate = opts.captureBeforeUpdate(db, args)
        }

        const result = fn(...args)

        // Emit the primary outbox row.
        const defaultRow: Record<string, unknown> | null =
          opts.op === 'delete'
            ? preDelete
            : (result as Record<string, unknown> | null)
        const rawRow = opts.extractRow
          ? opts.extractRow({ args, result, preDelete })
          : defaultRow

        // Apply large-column trimming for updates with a pre-state.
        const row =
          opts.op === 'update' &&
          rawRow != null &&
          preUpdate != null &&
          spec.largeColumns &&
          spec.largeColumns.length > 0
            ? trimUnchangedLargeColumns(rawRow, preUpdate, spec.largeColumns)
            : rawRow

        if (row != null && typeof row === 'object') {
          appendOutboxRowWithSpec(db, spec, opts.op, row)
        } else {
          // If we can't emit a primary row (e.g. fn returned null because
          // the target row didn't exist), don't push a bogus outbox entry.
          // This is the only path where emittedCount can stay 0 legitimately
          // — caller usually treats fn returning null as a no-op, so skipping
          // outbox emission matches that semantics.
        }

        // Dev-only invariant: caller didn't forget the wrapper.
        // If fn ran AND made changes but no outbox row was emitted, drift.
        if (
          process.env['NODE_ENV'] !== 'production' &&
          ctx.emittedCount === 0 &&
          row != null
        ) {
          throw new Error(
            `[sync] withSync(${opts.table}) completed with no outbox emission`,
          )
        }

        return result
      } finally {
        popSyncContext(prev)
      }
    })

    return txn()
  }
}

/**
 * Re-export for repo files that need to read the active context (e.g. to
 * stamp deviceId / userId onto an inner row).
 */
export { currentSyncContext }

/**
 * T38: returns a shallow copy of `row` with any key in `largeColumns`
 * whose value is JSON-equal to its pre-update counterpart deleted.
 *
 * Equality uses `JSON.stringify` on both sides — fine for the JSON-y
 * payloads we trim (arrays of segments, message lists, markdown strings).
 * Both sides must come from the same source shape (the repo's getX) so
 * key order and nested shapes line up.
 *
 * If a large column is missing on either side, treat it as changed and
 * keep it — conservative choice that errs toward over-sending rather
 * than silently dropping a real edit.
 *
 * Exported for test access.
 */
export function trimUnchangedLargeColumns(
  row: Record<string, unknown>,
  preUpdate: Record<string, unknown>,
  largeColumns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const col of largeColumns) {
    if (!(col in out) || !(col in preUpdate)) continue
    if (JSON.stringify(out[col]) === JSON.stringify(preUpdate[col])) {
      delete out[col]
    }
  }
  return out
}
