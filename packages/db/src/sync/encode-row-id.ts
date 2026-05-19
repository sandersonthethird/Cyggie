import { OWNED_TABLES_BY_NAME, type OwnedTableSpec } from './owned-tables'

// =============================================================================
// encode-row-id.ts — canonical row-identity encoding for the outbox.
//
// Most owned tables have a single-column `id` PK; a few (the join tables
// meeting_company_links, meeting_speaker_contact_links, meeting_speakers,
// and contact_emails) have composite PKs. The `outbox.row_id` column is a
// single TEXT — composite keys are encoded as deterministic JSON so the
// gateway can decode them by looking up the spec in `owned-tables.ts`.
//
// Two invariants the encoder enforces:
//   1. Key column order is canonical (read from OwnedTableSpec.primaryKey),
//      so the same logical row always produces the same row_id.
//   2. JSON.stringify object-key order in modern V8/Node is insertion order,
//      which matches our canonical key order. We never iterate Object.keys
//      on the raw row — only the spec.
//
// We deliberately don't base64 or hash the encoded id — the gateway needs
// to decode it to issue SQL like `WHERE meeting_id = $1 AND company_id = $2`.
// =============================================================================

/**
 * Encode a row's primary key as the canonical `outbox.row_id` string.
 *
 *   • Single-key tables → the raw column value coerced to string
 *     (e.g. `meetings` with id='abc123' → `"abc123"`).
 *   • Composite-key tables → JSON object with columns in spec order
 *     (e.g. `meeting_company_links` → `'{"meeting_id":"M1","company_id":"C1"}'`).
 *
 * Throws if any PK column is missing from the row (caught in dev by the
 * update_hook coverage assertion).
 */
export function encodeRowId(spec: OwnedTableSpec, row: Record<string, unknown>): string {
  if (spec.primaryKey.length === 1) {
    const col = spec.primaryKey[0]!
    const v = row[col]
    if (v == null) {
      throw new Error(
        `encodeRowId: missing primary key column '${col}' on table '${spec.table}'`,
      )
    }
    return String(v)
  }
  // Composite. Build the object in canonical spec order so JSON.stringify
  // emits a stable string.
  const out: Record<string, unknown> = {}
  for (const col of spec.primaryKey) {
    const v = row[col]
    if (v == null) {
      throw new Error(
        `encodeRowId: missing primary key column '${col}' on table '${spec.table}'`,
      )
    }
    out[col] = v
  }
  return JSON.stringify(out)
}

/**
 * Decode `outbox.row_id` back into the column-keyed PK map. Gateway uses this
 * to build a parameterized WHERE clause. Single-key tables return
 * `{ [pkCol]: rawString }`; composite tables JSON-parse.
 */
export function decodeRowId(
  spec: OwnedTableSpec,
  rowId: string,
): Record<string, unknown> {
  if (spec.primaryKey.length === 1) {
    return { [spec.primaryKey[0]!]: rowId }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rowId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `decodeRowId: ${spec.table} expected composite-key JSON, got ${rowId.slice(0, 40)} (${msg})`,
    )
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `decodeRowId: ${spec.table} expected object, got ${typeof parsed}`,
    )
  }
  const obj = parsed as Record<string, unknown>
  // Defensive: confirm every declared PK column is present.
  for (const col of spec.primaryKey) {
    if (!(col in obj)) {
      throw new Error(
        `decodeRowId: ${spec.table} missing PK column '${col}' in ${rowId.slice(0, 40)}`,
      )
    }
  }
  return obj
}

/**
 * Convenience: encode by table name (instead of spec). Throws if the table
 * isn't in the owned registry — that means the caller is trying to sync
 * something they shouldn't.
 */
export function encodeRowIdByTable(
  tableName: string,
  row: Record<string, unknown>,
): string {
  const spec = OWNED_TABLES_BY_NAME.get(tableName)
  if (!spec) {
    throw new Error(`encodeRowIdByTable: '${tableName}' is not in OWNED_TABLES`)
  }
  return encodeRowId(spec, row)
}
