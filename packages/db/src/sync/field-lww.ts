// =============================================================================
// field-lww.ts — the ONE field-level last-write-wins merge decision, shared by
// both sides of the sync boundary:
//
//   • gateway  (api-gateway/src/routes/sync.ts) — Postgres / node-pg
//   • desktop  (src/main/services/sync-remote-apply.ts) — SQLite / better-sqlite3
//
// Both runtimes call `mergeFieldLww` to decide WHICH columns win; each then
// builds its own UPSERT from the returned winners. Keeping the decision in one
// pure function is the primary guard against the two implementations diverging
// (divergence here = silent data loss). The golden-vector test runs the same
// vectors through both real call sites and asserts identical results.
//
// WHY field-level: whole-row LWW clobbers a teammate's concurrent edit to a
// DIFFERENT column. Field-level LWW keeps both — only edits to the SAME column
// race, and the later one wins.
//
//   per column c:
//     incomingClock(c) = incoming.fieldLamports[c]  ?? incoming.rowLamport
//     storedClock(c)   = existing.fieldLamports[c]   ?? existing.rowLamport
//     c wins  ⇔  incomingClock(c) > storedClock(c)        (tie → existing keeps it)
//
//   ┌── existing row ──┐        ┌── incoming write ──┐
//   │ arr      @5      │        │ arr      @5 (unsent)│   arr:  5 == 5 → existing
//   │ priority @5      │        │ priority @9         │   prio: 9 >  5 → INCOMING wins
//   │ stage    @7      │        │ (stage not in write)│   stage: untouched
//   └──────────────────┘        └─────────────────────┘
//        ⇒ winners = [priority];  mergedFieldLamports = {arr:5, priority:9, stage:7}
//        ⇒ newRowLamport = max(7, 9) = 9   (must bump so the pull cursor re-sends)
//
// CRITICAL: clocks are TEXT lamports compared as BigInt — "10" < "9" lexically,
// so never compare as strings. Keys are camelCase property names matching the
// outbox payload + `largeColumns` convention (NOT snake_case column names), so a
// lookup against the payload always hits.
//
// GRANULARITY: column-level. A JSON/array column is one clock — concurrent edits
// to different elements of the same array keep only the later writer's whole
// array (deferred: per-element CRDT merge).
// =============================================================================

/** A column-name → lamport map. camelCase keys, TEXT lamport values. */
export type FieldLamports = Record<string, string>

export interface MergeFieldLwwInput {
  /** Parsed field_lamports of the row already stored (null/{} ⇒ none yet). */
  existingFieldLamports: FieldLamports | null
  /** Stored row-level lamport — the fallback clock for any unmapped column. */
  existingRowLamport: string
  /** Parsed field_lamports carried by the incoming write (null ⇒ none). */
  incomingFieldLamports: FieldLamports | null
  /** Incoming row-level lamport — fallback clock for unmapped incoming columns. */
  incomingRowLamport: string
  /**
   * ALL camelCase data columns carried by the incoming (whole-row) payload —
   * exclude PK columns, `lamport`, and `field_lamports` itself.
   *
   * IMPORTANT: this is the full payload, NOT the changed set. When the write
   * carries a `field_lamports` map, only the map's keys (the columns this write
   * actually changed) are eligible to win — an unchanged column present in the
   * whole-row payload must NOT compete, or it would clobber a teammate's newer
   * value at the (stale) row lamport. When there is NO map (old/whole-row
   * client), every payload column is eligible at the row lamport (whole-row LWW).
   */
  incomingColumns: readonly string[]
  /**
   * True when no row is stored yet — every incoming column wins (clean insert).
   * When true, `existingFieldLamports`/`existingRowLamport` are ignored.
   */
  isInsert: boolean
}

export interface MergeFieldLwwResult {
  /** camelCase columns whose incoming value should be written. */
  winners: string[]
  /** field_lamports to persist on the row (existing ∪ winners' new clocks). */
  mergedFieldLamports: FieldLamports
  /** Row-level lamport to persist: max(existing, incoming). */
  newRowLamport: string
}

/** Safe BigInt parse — non-numeric/garbage lamports degrade to 0n, not a throw. */
function toBig(lamport: string | undefined | null): bigint {
  if (lamport == null) return 0n
  try {
    return BigInt(lamport)
  } catch {
    return 0n
  }
}

function maxLamport(a: string, b: string): string {
  return toBig(a) >= toBig(b) ? a : b
}

/**
 * Decide the field-level merge. Pure — no SQL, no I/O. Callers parse the stored
 * & incoming `field_lamports` JSON first (see `parseFieldLamports`) and build
 * their own UPSERT from `winners` + `mergedFieldLamports` + `newRowLamport`.
 */
export function mergeFieldLww(input: MergeFieldLwwInput): MergeFieldLwwResult {
  const incomingMap = input.incomingFieldLamports ?? {}
  const incomingRow = input.incomingRowLamport

  const incomingClock = (col: string): string => incomingMap[col] ?? incomingRow

  // Clean insert: every incoming column wins; stamp each at its incoming clock.
  if (input.isInsert) {
    const merged: FieldLamports = {}
    for (const col of input.incomingColumns) merged[col] = incomingClock(col)
    return {
      winners: [...input.incomingColumns],
      mergedFieldLamports: merged,
      newRowLamport: incomingRow,
    }
  }

  // DENSIFY-ON-WRITE invariant. The stored field_lamports must carry a clock for
  // EVERY column before we raise the row lamport — otherwise an unmapped column
  // would later fall back to the (now-bumped) row lamport and lose a race it
  // never participated in. Concretely: A edits `arr` (row lamport → 12); if
  // `notes` stays unmapped it inherits 12, so B's concurrent `notes` edit @9
  // would be silently dropped. By pinning every payload column to its true
  // baseline on each write, an untouched field keeps its real (older) clock and
  // a genuine concurrent edit to it wins. Maps are dense after the first write;
  // the `?? existingRow` fallback then only fires on a migrated (NULL-map) row's
  // first write — where existingRow IS the correct baseline — or a brand-new
  // schema column.

  const existingMap = input.existingFieldLamports ?? {}
  const existingRow = input.existingRowLamport
  const storedClock = (col: string): string => existingMap[col] ?? existingRow

  // Eligible-to-win set:
  //   • map present  → only the columns this write changed (the map's keys).
  //   • map absent   → every payload column (old/whole-row client, row clock).
  const eligible =
    input.incomingFieldLamports != null
      ? Object.keys(input.incomingFieldLamports)
      : input.incomingColumns

  // Start the merged map from everything already on the row so unmapped /
  // untouched columns keep their clocks.
  const merged: FieldLamports = { ...existingMap }
  const winners: string[] = []

  for (const col of eligible) {
    if (toBig(incomingClock(col)) > toBig(storedClock(col))) {
      winners.push(col)
      merged[col] = incomingClock(col)
    }
  }

  // Densify: pin every payload column that still lacks a clock to its current
  // baseline, BEFORE the row lamport rises below.
  for (const col of input.incomingColumns) {
    if (!(col in merged)) merged[col] = storedClock(col)
  }

  return {
    winners,
    mergedFieldLamports: merged,
    newRowLamport: maxLamport(existingRow, incomingRow),
  }
}

/**
 * Parse a stored/incoming `field_lamports` value into a FieldLamports map.
 * Returns null on ANY malformation (missing, non-JSON, non-object, wrong value
 * types). Callers treat null as "no per-field clocks" ⇒ the merge falls back to
 * the row-level lamport for every column (whole-row LWW for that one write).
 * This is the 2A degrade-and-warn policy: never throw, never block sync.
 */
export function parseFieldLamports(
  raw: string | Record<string, unknown> | null | undefined,
): FieldLamports | null {
  if (raw == null) return null
  let obj: unknown
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  } else {
    obj = raw
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const out: FieldLamports = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== 'string') return null
    out[k] = v
  }
  return out
}
