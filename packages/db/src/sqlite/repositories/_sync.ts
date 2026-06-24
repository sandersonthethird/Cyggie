import type Database from 'better-sqlite3'
import { OWNED_TABLES_BY_NAME, type OwnedTableSpec } from '../../sync/owned-tables'
import {
  appendOutboxRowWithSpec,
  currentSyncContext,
  popSyncContext,
  pushSyncContext,
  type SyncContext,
} from '../sync-wrapper'
import { nextLamport } from '../../sync/sync-clock'
import { mergeFieldLww, parseFieldLamports } from '../../sync/field-lww'
import { encodeRowId } from '../../sync/encode-row-id'

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

        // Snapshot the row BEFORE the inner fn runs when we need a pre-state:
        //   • T38 large-column trimming (tables with `largeColumns`), OR
        //   • field-LWW (`spec.fieldLww`) — the bare pre-row is diffed against
        //     the bare post-row to compute the changed-column set + the
        //     densify baseline. For field-LWW the barrel's `captureBeforeUpdate`
        //     returns the BARE snake-case row (cheap single SELECT, 3A).
        const needsPreUpdate =
          opts.op === 'update' &&
          opts.captureBeforeUpdate != null &&
          (spec.fieldLww === true ||
            (spec.largeColumns != null && spec.largeColumns.length > 0))
        let preUpdate: Record<string, unknown> | null = null
        if (needsPreUpdate) {
          preUpdate = opts.captureBeforeUpdate!(db, args)
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

        // Field-LWW: stamp `field_lamports` + `lamport` on the local row and
        // attach the (sparse, changed-only) field_lamports map to the outbox
        // payload so the gateway can merge per-column. See stampFieldLww.
        // Returns null for a no-op UPDATE (no column changed) — an intentional
        // non-emission: we skip the lamport/field_lamports write AND the outbox
        // row so merely re-saving current values produces no sync churn (and no
        // cross-device re-apply echo).
        const isFieldLwwWrite =
          spec.fieldLww === true &&
          row != null &&
          typeof row === 'object' &&
          (opts.op === 'insert' || opts.op === 'update')
        const emitRow = isFieldLwwWrite
          ? stampFieldLww(db, spec, opts.op, row as Record<string, unknown>, preUpdate, lamport)
          : row
        const intentionalNoop = isFieldLwwWrite && emitRow == null

        if (emitRow != null && typeof emitRow === 'object') {
          appendOutboxRowWithSpec(db, spec, opts.op, emitRow)
        } else {
          // If we can't emit a primary row (e.g. fn returned null because
          // the target row didn't exist, OR a field-LWW no-op update), don't
          // push a bogus outbox entry. These are the legitimate paths where
          // emittedCount stays 0.
        }

        // Dev-only invariant: caller didn't forget the wrapper.
        // If fn ran AND made changes but no outbox row was emitted, drift.
        // A field-LWW no-op (intentionalNoop) is exempt — it legitimately
        // emits nothing even though `row` is non-null.
        if (
          process.env['NODE_ENV'] !== 'production' &&
          ctx.emittedCount === 0 &&
          row != null &&
          !intentionalNoop
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
 * Establish a sync context for a BATCH of writes that don't map to a single
 * primary entity row (e.g. `syncContactsFromAttendees` upserts N contacts +
 * contact_emails). Unlike `withSync`, it emits no primary row and makes no
 * "exactly one emission" assertion — the inner `fn` is responsible for calling
 * `appendOutboxRow` for each owned-table row it touches.
 *
 * Reuses withSync's machinery: opens a single transaction, mints the lamport,
 * pushes the SyncContext (so `currentSyncContext()` / `appendOutboxRow` work),
 * and pops it on exit. Offline (no userId/deviceId) → runs `fn` directly with
 * NO emission, exactly like withSync (the pre-login / signup path). Nested-safe:
 * push/pop saves+restores the previous context and nested better-sqlite3
 * transactions act as savepoints, so calling this inside an active withSync is
 * harmless (it just reuses a fresh nested txn + its own lamport).
 */
export function runInSyncBatch<T>(fn: () => T): T {
  // Unlike withSync (which is only ever invoked via the barrel, post-bootstrap),
  // runInSyncBatch wraps repo-level batch helpers that also run in contexts
  // without sync configured (early startup, unit tests). Treat "not configured"
  // and "no auth" the same: run fn directly with no emission. There is nothing
  // to sync to in either case.
  const userId = configured?.getUserId() ?? null
  const deviceId = configured?.getDeviceId() ?? null
  if (!configured || !userId || !deviceId) {
    return fn()
  }
  const db = configured.getDb()
  const txn = db.transaction((): T => {
    const lamport = nextLamport(db, deviceId)
    const ctx: SyncContext = { userId, deviceId, lamport, emittedCount: 0 }
    const prev = pushSyncContext(ctx)
    try {
      return fn()
    } finally {
      popSyncContext(prev)
    }
  })
  return txn()
}

// Columns that are sync metadata, never tracked as field-LWW data columns.
const FIELD_LWW_META_COLS = new Set(['lamport', 'field_lamports'])

/**
 * Bare-row SELECT (all columns, snake_case) of an owned table by primary key.
 * Cheap single-row read used for the field-LWW pre/post diff (3A) — NOT the
 * enriched repo getX.
 */
function selectBareRow(
  db: Database.Database,
  spec: { table: string; primaryKey: readonly string[] },
  pk: Record<string, unknown>,
): Record<string, unknown> | null {
  const where = spec.primaryKey.map((c) => `"${c}" = ?`).join(' AND ')
  const vals = spec.primaryKey.map((c) => pk[c])
  const r = db
    .prepare(`SELECT * FROM ${spec.table} WHERE ${where} LIMIT 1`)
    .get(...vals) as Record<string, unknown> | undefined
  return r ?? null
}

/**
 * Field-LWW write stamp. For a `fieldLww` table's insert/update:
 *   1. Reads the bare post-write row and (for updates) diffs it against the
 *      bare pre-write snapshot → the changed-column set.
 *   2. Writes the row's `lamport` (= this txn's lamport) and a DENSIFIED
 *      `field_lamports` map to the LOCAL row, so a later local edit measures
 *      against correct per-field baselines and the desktop pull-apply can merge.
 *   3. Returns the outbox payload with a SPARSE `fieldLamports` map (changed
 *      columns only) attached — the gateway needs only the changed set to know
 *      which columns are eligible to win; it densifies its own stored copy.
 *
 * Local densified map vs wire sparse map are intentionally different (see
 * field-lww.ts). Keys are snake_case column names (the bare row's native
 * casing); the top-level `fieldLamports` key is camelCase so it round-trips the
 * gateway's snake↔camel mapping into the `field_lamports` column.
 */
function stampFieldLww(
  db: Database.Database,
  spec: OwnedTableSpec,
  op: WriteOp,
  payloadRow: Record<string, unknown>,
  preUpdate: Record<string, unknown> | null,
  lamport: string,
): Record<string, unknown> | null {
  // PK value(s) come from the emitted payload row (always carries the PK).
  const pk: Record<string, unknown> = {}
  for (const col of spec.primaryKey) pk[col] = payloadRow[col]

  const afterBare = selectBareRow(db, spec, pk)
  if (afterBare == null) {
    // Row vanished (deleted concurrently in the same txn) — nothing to stamp.
    return payloadRow
  }

  const isInsert = op === 'insert'
  const dataCols = Object.keys(afterBare).filter(
    (c) => !FIELD_LWW_META_COLS.has(c) && !spec.primaryKey.includes(c),
  )

  // Changed-column set. Insert ⇒ every data column is new. Update ⇒ diff the
  // bare pre/post rows (excluding meta/PK).
  const changed = isInsert
    ? dataCols
    : diffChangedColumns(preUpdate ?? {}, afterBare).filter(
        (c) => !FIELD_LWW_META_COLS.has(c) && !spec.primaryKey.includes(c),
      )

  // No-op UPDATE — no data column changed (e.g. updateCompany skipped the write
  // because the caller re-sent current values). Don't bump lamport/field_lamports
  // and signal the wrapper to emit no outbox row (returns null). Inserts always
  // have changed columns, so they never take this path.
  if (!isInsert && changed.length === 0) {
    return null
  }

  // Sparse wire map — only the columns this write changed, at this lamport.
  const wireMap: Record<string, string> = {}
  for (const c of changed) wireMap[c] = lamport

  // Densified local map: reuse the SAME merge the gateway/pull use so the local
  // stored clocks match what a remote would compute.
  const { mergedFieldLamports } = mergeFieldLww({
    existingFieldLamports: isInsert
      ? null
      : parseFieldLamports(preUpdate?.['field_lamports'] as string | null),
    existingRowLamport: (preUpdate?.['lamport'] as string) ?? '0',
    incomingFieldLamports: wireMap,
    incomingRowLamport: lamport,
    incomingColumns: dataCols,
    isInsert,
  })

  // Stamp the local row (org-company.repo does NOT self-stamp lamport).
  const where = spec.primaryKey.map((c) => `"${c}" = ?`).join(' AND ')
  db.prepare(
    `UPDATE ${spec.table} SET lamport = ?, field_lamports = ? WHERE ${where}`,
  ).run(lamport, JSON.stringify(mergedFieldLamports), ...spec.primaryKey.map((c) => pk[c]))

  // Attach the sparse map to the outbox payload (camelCase top-level key).
  return { ...payloadRow, fieldLamports: wireMap, lamport }
}

/**
 * Whole-row-LWW write stamp. For a non-`fieldLww` owned table insert/update,
 * stamp the LOCAL row's `lamport` (= this txn's lamport) so it stops sitting at
 * `lamport='0'` until a pull echo heals it. Simpler than `stampFieldLww`: no
 * `field_lamports` map, no no-op detection (whole-row LWW always emits).
 *
 * INVARIANT: only ever called inside an active sync transaction (same txn as the
 * matching `appendOutboxRow`) so stamp + emit are atomic. A stamped-but-unemitted
 * row would be invisible to the `lamport='0'` backfill selectors and stranded.
 *
 * PK read via `spec.primaryKey` (snake_case) — every emit row carries snake-case
 * PK keys (encodeRowId requires them). Defensive: if a PK value is missing we
 * skip the stamp rather than UPDATE the whole table.
 *
 * NOTE: this helper is currently used by the cascade engine below. Wiring it into
 * `withSync`'s primary whole-row emit path (the flicker fix for every wrapped
 * whole-row write) is Task 2 of the sync-hardening batch — intentionally not done
 * here to keep this change scoped to the cascade work.
 */
function stampWholeRowLww(
  db: Database.Database,
  spec: OwnedTableSpec,
  row: Record<string, unknown>,
  lamport: string,
): void {
  const vals = spec.primaryKey.map((c) => row[c])
  if (vals.some((v) => v == null)) return
  const where = spec.primaryKey.map((c) => `"${c}" = ?`).join(' AND ')
  db.prepare(`UPDATE ${spec.table} SET lamport = ? WHERE ${where}`).run(lamport, ...vals)
}

// =============================================================================
// Cascade snapshot-diff — auto-emit outbox rows for multi-table writes.
//
// better-sqlite3 exposes no update_hook, so we can't auto-discover the rows an
// inner fn touched. Instead the caller DECLARES the owned-table scopes an
// operation may touch; we snapshot those scoped rows before/after the fn, diff
// by primary key, and emit insert/update/delete for each change — routing
// field-LWW rows through `stampFieldLww` (sparse map + local stamp) and
// whole-row rows through `stampWholeRowLww` + `appendOutboxRow`.
//
//   declare scopes ─▶ PRE snapshot ─▶ fn() ─▶ POST snapshot ─▶ diff by PK ─▶ emit
//                       (bounded)              (bounded)        (3A col-wise)
//
// Payloads are the bare snake_case `SELECT *` rows — the canonical outbox shape
// (the gateway documents "desktop emits SQL column names"; the existing manual
// emitters like syncMeetingCompanyLinks do exactly this).
// =============================================================================

/**
 * An owned-table scope an operation may touch. `where`+`params` bound the rows
 * so the pre/post snapshot stays small (per-entity, not whole-table).
 */
export interface CascadeScope {
  table: string
  where: string
  params: readonly unknown[]
}

type ScopeSnapshot = Map<string, Record<string, unknown>> // encodeRowId -> bare row

function snapshotScope(
  db: Database.Database,
  spec: OwnedTableSpec,
  scope: CascadeScope,
): ScopeSnapshot {
  const rows = db
    .prepare(`SELECT * FROM ${scope.table} WHERE ${scope.where}`)
    .all(...scope.params) as Array<Record<string, unknown>>
  const map: ScopeSnapshot = new Map()
  for (const r of rows) map.set(encodeRowId(spec, r), r)
  return map
}

/**
 * Emit one cascade row, routing by spec. Field-LWW insert/update delegates to
 * `stampFieldLww` (which stamps the local row + returns the sparse-map payload,
 * or null on a no-op — already pre-filtered for updates). Whole-row insert/update
 * stamps the local lamport then emits the bare row. Deletes emit the pre-row.
 */
function emitCascadeRow(
  db: Database.Database,
  spec: OwnedTableSpec,
  op: WriteOp,
  row: Record<string, unknown>,
  preRow: Record<string, unknown> | null,
  lamport: string,
): void {
  if (op !== 'delete' && spec.fieldLww === true) {
    const emit = stampFieldLww(db, spec, op, row, preRow, lamport)
    if (emit != null) appendOutboxRowWithSpec(db, spec, op, emit)
    return
  }
  if (op !== 'delete') stampWholeRowLww(db, spec, row, lamport)
  appendOutboxRowWithSpec(db, spec, op, row)
}

function emitScopeDiff(
  db: Database.Database,
  spec: OwnedTableSpec,
  pre: ScopeSnapshot,
  post: ScopeSnapshot,
  lamport: string,
): void {
  // inserts + updates
  for (const [pk, postRow] of post) {
    const preRow = pre.get(pk)
    if (preRow == null) {
      emitCascadeRow(db, spec, 'insert', postRow, null, lamport)
      continue
    }
    // 3A: column-wise compare of data columns (skip meta + PK). Empty ⇒ no-op.
    const changed = diffChangedColumns(preRow, postRow).filter(
      (c) => !FIELD_LWW_META_COLS.has(c) && !spec.primaryKey.includes(c),
    )
    if (changed.length > 0) emitCascadeRow(db, spec, 'update', postRow, preRow, lamport)
  }
  // deletes
  for (const [pk, preRow] of pre) {
    if (!post.has(pk)) emitCascadeRow(db, spec, 'delete', preRow, null, lamport)
  }
}

/**
 * Like `runInSyncBatch`, but auto-emits outbox rows for every change the inner
 * `fn` makes within the DECLARED `scopes` (via the snapshot-diff above). The fn
 * does raw owned-table writes; it must NOT also call `appendOutboxRow` for a
 * declared table (that would double-emit). `runInSyncBatch` is the zero-scope
 * case of this.
 *
 * Per-entity granularity (2A): callers loop and wrap EACH entity's writes so the
 * snapshot stays O(one entity). Offline (no auth) → runs `fn` directly, no emit.
 * Nested-safe (savepoint + saved/restored context), same as `runInSyncBatch`.
 */
export function runInSyncBatchWithCascade<T>(
  scopes: readonly CascadeScope[],
  fn: () => T,
): T {
  const userId = configured?.getUserId() ?? null
  const deviceId = configured?.getDeviceId() ?? null
  if (!configured || !userId || !deviceId) {
    return fn()
  }
  const resolved = scopes.map((scope) => {
    const spec = OWNED_TABLES_BY_NAME.get(scope.table)
    if (!spec) {
      throw new Error(
        `[sync] runInSyncBatchWithCascade: '${scope.table}' is not in OWNED_TABLES`,
      )
    }
    return { spec, scope }
  })
  const db = configured.getDb()
  const txn = db.transaction((): T => {
    const lamport = nextLamport(db, deviceId)
    const ctx: SyncContext = { userId, deviceId, lamport, emittedCount: 0 }
    const prev = pushSyncContext(ctx)
    try {
      const pre = resolved.map(({ spec, scope }) => snapshotScope(db, spec, scope))
      const result = fn()
      resolved.forEach(({ spec, scope }, i) => {
        const post = snapshotScope(db, spec, scope)
        emitScopeDiff(db, spec, pre[i]!, post, lamport)
      })
      return result
    } finally {
      popSyncContext(prev)
    }
  })
  return txn()
}

/**
 * Dev-only guard (1A+6A): wraps the OUTER boundary of a multi-entity bulk op and
 * throws if it wrote to an owned table that is neither in `declaredTables` (the
 * union of every per-entity cascade scope) nor in `allowList` (tables we
 * intentionally leave backfill-covered, e.g. email_contact_links / tasks). This
 * is what actually closes the "owned write silently skips the outbox" class — a
 * forgotten scope throws loudly in dev instead of stranding rows.
 *
 * Cheap structural signature: COUNT(*) + MAX(rowid) per owned table, once before
 * and once after the whole op (O(#owned), not O(N×#owned)). Catches INSERT/DELETE
 * drift to undeclared tables; pure in-place UPDATEs to undeclared tables are not
 * caught by this signature (documented limit — a full content hash would be too
 * costly even in dev). Compiled out of production.
 */
export function withCascadeUnderDeclarationGuard(
  declaredTables: readonly string[],
  allowList: readonly string[],
  fn: () => void,
): void {
  if (process.env['NODE_ENV'] === 'production' || !configured) {
    fn()
    return
  }
  const db = configured.getDb()
  const declared = new Set([...declaredTables, ...allowList])
  const signature = (): Map<string, string> => {
    const m = new Map<string, string>()
    for (const [name] of OWNED_TABLES_BY_NAME) {
      const r = db
        .prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(rowid), 0) AS m FROM ${name}`)
        .get() as { c: number; m: number }
      m.set(name, `${r.c}:${r.m}`)
    }
    return m
  }
  const before = signature()
  fn()
  const after = signature()
  for (const [name, sig] of after) {
    if (before.get(name) !== sig && !declared.has(name)) {
      throw new Error(
        `[sync] cascade under-declared owned-table write: '${name}' changed ` +
          `but no scope (or allow-list entry) declared it`,
      )
    }
  }
}

/**
 * Re-export for repo files that need to read the active context (e.g. to
 * stamp deviceId / userId onto an inner row).
 */
export { currentSyncContext }

/** Exported for the cascade engine's reuse by repo barrels + tests. */
export { stampFieldLww, stampWholeRowLww }

/**
 * Returns true when `a` and `b` differ. Fast-path: identical primitives compare
 * directly (no allocation); only objects/arrays fall back to `JSON.stringify`
 * (which is order-sensitive but fine because both sides come from the same
 * source shape — the repo's getX / a bare row SELECT).
 */
function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a === b) return false
  const aObj = a !== null && typeof a === 'object'
  const bObj = b !== null && typeof b === 'object'
  if (!aObj && !bObj) return true // distinct primitives (a===b already false)
  return JSON.stringify(a) !== JSON.stringify(b)
}

/**
 * Returns the keys present in BOTH `before` and `after` whose values differ
 * (the changed-column set). A key missing on either side is treated as changed
 * and included — conservative (errs toward marking an edit rather than dropping
 * one). The single column-diff primitive shared by:
 *   • T38 large-column trimming (`trimUnchangedLargeColumns`)
 *   • field-LWW `field_lamports` computation (the wrapper, for `fieldLww` tables)
 *
 * Exported for test access.
 */
export function diffChangedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const changed: string[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const inBefore = key in before
    const inAfter = key in after
    if (!inBefore || !inAfter) {
      changed.push(key)
      continue
    }
    if (valuesDiffer(before[key], after[key])) changed.push(key)
  }
  return changed
}

/**
 * T38: returns a shallow copy of `row` with any key in `largeColumns`
 * whose value is JSON-equal to its pre-update counterpart deleted.
 *
 * Now expressed in terms of `diffChangedColumns` so the equality rule lives in
 * one place. A large column is dropped iff it is present on both sides and NOT
 * in the changed set. Missing on either side ⇒ changed ⇒ kept (conservative).
 *
 * Exported for test access.
 */
export function trimUnchangedLargeColumns(
  row: Record<string, unknown>,
  preUpdate: Record<string, unknown>,
  largeColumns: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  const changed = new Set(diffChangedColumns(preUpdate, row))
  for (const col of largeColumns) {
    if (!(col in out) || !(col in preUpdate)) continue
    if (!changed.has(col)) delete out[col]
  }
  return out
}
