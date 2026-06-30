// =============================================================================
// schema-drift.ts — boot-time guard against Drizzle-schema ↔ deployed-Neon drift.
//
// WHY THIS EXISTS
// ---------------
// 2026-06-29: every meetings write from the desktop SyncAgent silently failed
// for ~a day with `column "enriched_at" of relation "meetings" does not exist`.
// SQLite migration 138 added `enriched_at`; the Drizzle schema declared it
// (so the sync-push validator happily forwarded it); but the matching Postgres
// migration (0051) had never been APPLIED to Neon. The rows piled up in the
// desktop outbox as status='failed' — invisible to the user, surfacing only as
// an empty mobile app.
//
// No in-CI unit test catches this: the test database runs ALL migrations, so it
// always has the column. The drift is purely "migration written but not applied
// to the deployed DB" — which only a check against the REAL database sees.
//
// WHAT THIS DOES
// --------------
// On boot, for every owned (synced) table that exists in both the Drizzle schema
// and Neon, compare the Drizzle column set against information_schema.columns.
// A column the schema expects but the live table lacks = drift → loud log +
// Sentry. This would have fired the instant the gateway booted against a Neon
// missing `enriched_at`, turning a silent per-write failure into a startup alarm.
//
//   Drizzle schema (expected)        Neon information_schema (actual)
//        meetings.enriched_at  ──┐
//        meetings.title          ├──►  title, status, ...           = OK
//        meetings.status         │     (enriched_at ABSENT)         = DRIFT
//                              ──┘
//
// Non-fatal by design: a false positive must not take prod down. The signal is
// the Sentry alert + error log, not a crash.
// =============================================================================

import { getTableColumns, getTableName, type Table } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { OWNED_TABLES } from '@cyggie/db/sync/owned-tables'
import type pg from 'pg'

export interface TableDrift {
  table: string
  /** Columns the Drizzle schema declares that the live Neon table lacks. */
  missingColumns: string[]
}

/**
 * Map SQL table name → Drizzle table object, derived from the `schema`
 * namespace. Non-table exports (relations, enums, helpers) are skipped.
 */
function buildDrizzleTableMap(): Map<string, Table> {
  const map = new Map<string, Table>()
  for (const value of Object.values(schema as Record<string, unknown>)) {
    let name: string | undefined
    try {
      name = getTableName(value as Table)
    } catch {
      continue // not a Drizzle table
    }
    if (name) map.set(name, value as Table)
  }
  return map
}

/**
 * Compare each owned table's Drizzle columns to the live DB columns.
 *
 * Only tables that (a) exist in the Drizzle schema AND (b) already exist in
 * Neon (≥1 column in information_schema) are checked. A table absent from Neon
 * entirely is NOT reported — owned-table specs can lead a not-yet-deployed
 * domain, and we only want to flag the "existing table missing a column" class
 * that silently breaks sync. `actualColumnsByTable` is injected so the pure
 * comparison is unit-testable without a database.
 */
export function diffOwnedTableSchema(
  actualColumnsByTable: ReadonlyMap<string, ReadonlySet<string>>,
): TableDrift[] {
  const drizzleTables = buildDrizzleTableMap()
  const drifts: TableDrift[] = []
  for (const spec of OWNED_TABLES) {
    const table = drizzleTables.get(spec.table)
    if (!table) continue // owned table not yet ported to the Drizzle schema — skip
    const actual = actualColumnsByTable.get(spec.table)
    if (!actual || actual.size === 0) continue // table not deployed to Neon — out of scope
    const expected = Object.values(getTableColumns(table)).map((c) => c.name)
    const missing = expected.filter((col) => !actual.has(col))
    if (missing.length > 0) drifts.push({ table: spec.table, missingColumns: missing })
  }
  return drifts
}

/** Pull actual columns for the owned tables from information_schema in one query. */
export async function fetchActualColumns(
  pool: pg.Pool,
): Promise<Map<string, Set<string>>> {
  const tableNames = OWNED_TABLES.map((t) => t.table)
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tableNames],
  )
  const byTable = new Map<string, Set<string>>()
  for (const r of rows) {
    let set = byTable.get(r.table_name)
    if (!set) {
      set = new Set<string>()
      byTable.set(r.table_name, set)
    }
    set.add(r.column_name)
  }
  return byTable
}

/** Boot-time check: returns drift list (empty = healthy). Never throws on data. */
export async function checkOwnedTableSchemaDrift(pool: pg.Pool): Promise<TableDrift[]> {
  const actual = await fetchActualColumns(pool)
  return diffOwnedTableSchema(actual)
}
