import { inArray, type AnyColumn } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'

// Shared test-row cleanup for the api-gateway DB suite (Issue 7B). Replaces the
// per-file hand-coded `createdXIds[]` arrays + ordered `afterAll` delete blocks.
//
// FK-safe ordering, for free
// ──────────────────────────
// Tests can only INSERT a child row after its parent exists (the FK is enforced
// at insert time). So the order rows are tracked is always a valid topological
// order parent→child. Therefore deleting in DESCENDING first-tracked order
// (child→parent) is *always* FK-safe — without this helper needing any
// hardcoded table dependency graph.
//
//   track order:   user → company → contact → meeting → note
//   cleanup order: note → meeting → contact → company → user   (reverse)
//
// Each table is deleted once (ids batched), ordered by when that table was
// first seen, descending.
//
// Usage:
//   const cleanup = makeDbCleanup(db)
//   const userId = cleanup.track(schema.users, schema.users.id, mkUser())
//   afterAll(() => cleanup.cleanup())
//
// Non-`id` keys are fine — pass the column rows should be matched on, e.g.
// `cleanup.track(schema.sessions, schema.sessions.userId, userId)` to delete a
// user's sessions by user_id.

export interface DbCleanup {
  /** Record a row to delete later. Returns `id` for convenient inline use. */
  track<T extends string>(table: PgTable, column: AnyColumn, id: T): T
  /** Delete every tracked row, children before parents. Safe to call once. */
  cleanup(): Promise<void>
}

type Drizzle = { delete: (table: PgTable) => { where: (cond: unknown) => Promise<unknown> } }

interface Entry {
  table: PgTable
  column: AnyColumn
  ids: string[]
  firstIdx: number
}

export function makeDbCleanup(db: Drizzle): DbCleanup {
  // Keyed by (table, column) identity so e.g. sessions-by-id and
  // sessions-by-userId never get mixed into one delete.
  const groups = new Map<string, Entry>()
  let seq = 0

  function keyFor(table: PgTable, column: AnyColumn): string {
    // Column objects are stable singletons on the schema; identity via a
    // WeakMap-free key built from the registered names is enough here.
    return `${tableName(table)}::${String((column as { name?: string }).name)}`
  }

  return {
    track(table, column, id) {
      const key = keyFor(table, column)
      let g = groups.get(key)
      if (!g) {
        g = { table, column, ids: [], firstIdx: seq++ }
        groups.set(key, g)
      }
      g.ids.push(id)
      return id
    },

    async cleanup() {
      const ordered = [...groups.values()].sort((a, b) => b.firstIdx - a.firstIdx)
      for (const g of ordered) {
        const ids = [...new Set(g.ids)]
        if (ids.length === 0) continue
        await db.delete(g.table).where(inArray(g.column, ids))
      }
      groups.clear()
    },
  }
}

function tableName(table: PgTable): string {
  // drizzle stores the SQL name under a well-known symbol; fall back to a
  // best-effort string so the cleanup key stays stable per table.
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.description === 'drizzle:Name',
  )
  return sym ? String((table as Record<symbol, unknown>)[sym]) : String(table)
}
