import { describe, expect, test } from 'vitest'
import { getTableColumns, getTableName, type Table } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { OWNED_TABLES } from '@cyggie/db/sync/owned-tables'
import { diffOwnedTableSchema } from '../src/sync/schema-drift'

// =============================================================================
// Boot-time schema-drift guard (2026-06-29 regression).
//
// Reproduces the exact failure that silently broke all meetings sync: the
// Drizzle schema declared meetings.enriched_at but the deployed Neon table
// lacked it (migration 0051 never applied). diffOwnedTableSchema() must flag
// that column as drift.
// =============================================================================

/** Build the real "actual columns" map from the Drizzle schema — i.e. a DB
 *  that is perfectly in sync. We then remove columns to simulate drift. */
function columnsFromDrizzle(): Map<string, Set<string>> {
  const byName = new Map<string, Table>()
  for (const value of Object.values(schema as Record<string, unknown>)) {
    let name: string | undefined
    try {
      name = getTableName(value as Table)
    } catch {
      continue
    }
    if (name) byName.set(name, value as Table)
  }
  const actual = new Map<string, Set<string>>()
  for (const spec of OWNED_TABLES) {
    const table = byName.get(spec.table)
    if (!table) continue
    actual.set(
      spec.table,
      new Set(Object.values(getTableColumns(table)).map((c) => c.name)),
    )
  }
  return actual
}

describe('diffOwnedTableSchema', () => {
  test('reports no drift when the live DB matches the Drizzle schema', () => {
    expect(diffOwnedTableSchema(columnsFromDrizzle())).toEqual([])
  })

  test('flags the meetings.enriched_at regression (column present in schema, absent in DB)', () => {
    const actual = columnsFromDrizzle()
    const meetings = actual.get('meetings')
    expect(meetings?.has('enriched_at')).toBe(true) // guard: column is in the schema
    meetings!.delete('enriched_at')

    const drift = diffOwnedTableSchema(actual)
    expect(drift).toContainEqual({
      table: 'meetings',
      missingColumns: ['enriched_at'],
    })
  })

  test('ignores tables absent from Neon entirely (not-yet-deployed owned tables)', () => {
    const actual = columnsFromDrizzle()
    actual.delete('meetings') // simulate "table not deployed" — must NOT be flagged
    const drift = diffOwnedTableSchema(actual)
    expect(drift.find((d) => d.table === 'meetings')).toBeUndefined()
  })

  test('reports every missing column, not just the first', () => {
    const actual = columnsFromDrizzle()
    const meetings = actual.get('meetings')!
    meetings.delete('enriched_at')
    meetings.delete('enrich_attempts')
    const drift = diffOwnedTableSchema(actual).find((d) => d.table === 'meetings')
    expect(drift?.missingColumns).toEqual(
      expect.arrayContaining(['enriched_at', 'enrich_attempts']),
    )
  })
})
