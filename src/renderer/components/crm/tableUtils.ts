/**
 * tableUtils — shared pure utilities for Company and Contact table components.
 *
 * All functions here are entity-agnostic and fully unit-testable
 * (no React, no IPC, no DOM dependencies).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal column definition used by sort/config utilities. */
export interface ColumnDef {
  key: string
  label: string
  field: string | null
  defaultVisible: boolean
  width: number
  minWidth: number
  sortable: boolean
  editable: boolean
  type: 'text' | 'select' | 'number' | 'date' | 'computed'
  options?: { value: string; label: string }[]
}

export interface SortState {
  key: string
  dir: 'asc' | 'desc'
}

// ─── Column config ────────────────────────────────────────────────────────────

/**
 * Returns a loader function for the given storage key + column definitions.
 * The loader:
 *   1. Reads raw JSON from localStorage
 *   2. Drops keys not present in defs
 *   3. Appends any defaultVisible keys missing from the stored array
 *   4. Falls back to all defaultVisible keys on parse error or empty storage
 *
 * Usage:
 *   const loadColumnConfig = createColumnConfigLoader('cyggie:company-table-columns', COLUMN_DEFS)
 *   const keys = loadColumnConfig()
 */
export function createColumnConfigLoader(
  storageKey: string,
  defs: ColumnDef[]
): () => string[] {
  const defaultVisible = defs.filter((c) => c.defaultVisible).map((c) => c.key)
  const validKeys = new Set(defs.map((c) => c.key))

  return function loadColumnConfig(): string[] {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return [...defaultVisible]
      const stored: string[] = JSON.parse(raw)
      const filtered = stored.filter((k) => validKeys.has(k))
      const newDefaults = defs
        .filter((c) => c.defaultVisible && !filtered.includes(c.key))
        .map((c) => c.key)
      if (newDefaults.length) {
        console.warn(`[tableUtils] New default columns added (${storageKey}):`, newDefaults)
      }
      return [...filtered, ...newDefaults]
    } catch {
      console.warn(`[tableUtils] Column config parse failed (${storageKey}), using defaults`)
      return [...defaultVisible]
    }
  }
}

/** Persist visible column keys to localStorage. */
export function saveColumnConfig(storageKey: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(keys))
  } catch {
    console.warn(`[tableUtils] Failed to save column config (${storageKey})`)
  }
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Client-side sort for any row type. Nulls always sort last regardless of direction.
 * Uses the column def to determine the field key and value type.
 */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: SortState,
  defs: ColumnDef[]
): T[] {
  const col = defs.find((c) => c.key === sort.key)
  if (!col || !col.field) return rows

  const field = col.field as keyof T
  const dir = sort.dir === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const av = a[field]
    const bv = b[field]

    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1

    if (typeof av === 'number' && typeof bv === 'number') {
      return (av - bv) * dir
    }

    return String(av).localeCompare(String(bv)) * dir
  })
}

// ─── Array utilities ──────────────────────────────────────────────────────────

/** Split an array into chunks of `size`. Last chunk may be smaller. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  return Array.from(
    { length: Math.ceil(arr.length / size) },
    (_, i) => arr.slice(i * size, i * size + size)
  )
}

// ─── Bulk edit ────────────────────────────────────────────────────────────────

export interface BulkEditOpts {
  ids: string[]
  getOriginalValue: (id: string) => unknown
  /** Async function that persists one update (e.g. IPC call). Must throw on failure. */
  updateFn: (id: string) => Promise<void>
  /** Called to apply or revert an optimistic patch. */
  onPatch: (id: string, value: unknown) => void
  /** Max concurrent IPC calls per chunk. Defaults to 10. */
  chunkSize?: number
}

export interface BulkEditResult {
  failedIds: string[]
}

/**
 * Executes a bulk field edit with:
 *   - Chunked concurrency (default 10 per chunk) — scales to web/multi-user
 *   - Promise.allSettled — tracks individual failures, does not short-circuit
 *   - Reverts failed rows via onPatch(id, originalValue)
 *
 * Callers must apply the optimistic patch BEFORE calling this function.
 * Originals must be captured BEFORE the optimistic patch.
 */
export async function executeBulkEdit(opts: BulkEditOpts): Promise<BulkEditResult> {
  const { ids, getOriginalValue, updateFn, onPatch, chunkSize = 10 } = opts
  const failedIds: string[] = []

  for (const chunk of chunkArray(ids, chunkSize)) {
    const results = await Promise.allSettled(chunk.map((id) => updateFn(id)))
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        failedIds.push(chunk[i])
      }
    })
  }

  // Revert failed rows
  for (const id of failedIds) {
    onPatch(id, getOriginalValue(id))
  }

  return { failedIds }
}
