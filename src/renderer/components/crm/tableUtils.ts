/**
 * tableUtils — shared pure utilities for Company and Contact table components.
 *
 * All functions here are entity-agnostic and fully unit-testable
 * (no React, no IPC, no DOM dependencies).
 */

import type { CustomFieldDefinition } from '../../../shared/types/custom-fields'

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
  /** Display prefix for values (e.g. '$' for currency columns). Used by RangeFilter. */
  prefix?: string
  /** Display suffix for values (e.g. 'M' for $M columns). Used by RangeFilter. */
  suffix?: string
}

// ─── Range & text filter types ────────────────────────────────────────────────

/** Inclusive range bounds for number and date columns. Both ends are optional. */
export type RangeValue = { min?: string; max?: string }

/**
 * Generic range filter (Pass 2) — shared by filterCompanies and filterContacts.
 *
 * IMPORTANT: Date fields from SQLite arrive as 'YYYY-MM-DD HH:MM:SS'.
 * Slice to 10 chars before comparing against <input type="date"> values ('YYYY-MM-DD'),
 * otherwise boundary records (e.g. createdAt='2024-01-15 10:30:00' with max='2024-01-15')
 * would be incorrectly excluded because '2024-01-15 10:30:00' > '2024-01-15' lexicographically.
 *
 * Empty-string guard: URL params can arrive as '' when cleared; Number('') === 0, which would
 * silently filter by 0 for numeric columns. The `min !== ''` / `max !== ''` guards prevent this.
 */
export function applyRangeFilter<T extends Record<string, unknown>>(
  rows: T[],
  rangeFilters: Record<string, RangeValue>
): T[] {
  const active = Object.entries(rangeFilters).filter(
    ([, r]) => (r.min != null && r.min !== '') || (r.max != null && r.max !== '')
  )
  if (active.length === 0) return rows
  return rows.filter((row) =>
    active.every(([field, { min, max }]) => {
      const raw = row[field]
      if (raw == null) return false
      if (typeof raw === 'number') {
        if (min != null && min !== '' && raw < Number(min)) return false
        if (max != null && max !== '' && raw > Number(max)) return false
      } else {
        // Normalize SQLite 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DD' for string comparison
        const dateVal = String(raw).slice(0, 10)
        if (min != null && min !== '' && dateVal < min) return false
        if (max != null && max !== '' && dateVal > max) return false
      }
      return true
    })
  )
}

/**
 * Generic select filter (Pass 1) — exact string match against option values.
 * Shared by filterCompanies and filterContacts.
 *
 * Each entry in selectFilters is an OR list for that field; fields are ANDed together.
 */
export function applySelectFilter<T extends Record<string, unknown>>(
  rows: T[],
  selectFilters: Record<string, string[]>
): T[] {
  const active = Object.entries(selectFilters).filter(([, v]) => v.length > 0)
  if (active.length === 0) return rows
  return rows.filter((row) =>
    active.every(([field, values]) => {
      const cellVal = row[field]
      if (cellVal == null) return false
      return values.includes(String(cellVal))
    })
  )
}

/**
 * Generic text filter (Pass 3) — case-insensitive contains match.
 * Shared by filterCompanies and filterContacts.
 */
export function applyTextFilter<T extends Record<string, unknown>>(
  rows: T[],
  textFilters: Record<string, string>
): T[] {
  const active = Object.entries(textFilters).filter(([, v]) => v.trim().length > 0)
  if (active.length === 0) return rows
  return rows.filter((row) =>
    active.every(([field, query]) => {
      const raw = row[field]
      if (raw == null) return false
      return String(raw).toLowerCase().includes(query.toLowerCase())
    })
  )
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

/**
 * Returns a { load, save } helper pair for persisting column widths.
 *
 * Usage:
 *   const { load: loadColumnWidths, save: saveColumnWidths } =
 *     createColumnWidthsHelper('cyggie:company-table-widths')
 */
export function createColumnWidthsHelper(storageKey: string): {
  load: () => Record<string, number>
  save: (widths: Record<string, number>) => void
} {
  return {
    load(): Record<string, number> {
      try {
        const raw = localStorage.getItem(storageKey)
        if (!raw) return {}
        return JSON.parse(raw) as Record<string, number>
      } catch {
        console.warn(`[tableUtils] Column widths parse failed (${storageKey}), using defaults`)
        return {}
      }
    },
    save(widths: Record<string, number>): void {
      try {
        localStorage.setItem(storageKey, JSON.stringify(widths))
      } catch {
        console.warn(`[tableUtils] Failed to save column widths (${storageKey})`)
      }
    }
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

// ─── Custom field columns ─────────────────────────────────────────────────────

/**
 * Converts custom field definitions from the store into ColumnDef objects
 * that can be merged with built-in COLUMN_DEFS and passed to the table.
 *
 * Keys are prefixed with 'custom:' to distinguish from built-in columns.
 * field is null so that pass-1 filters (applySelectFilter etc.) skip these
 * columns; a second pass against customFieldValues handles their filtering.
 */
export function buildCustomFieldColumnDefs(defs: CustomFieldDefinition[]): ColumnDef[] {
  return defs.map((def) => ({
    key: `custom:${def.id}`,
    label: def.label,
    field: null,
    defaultVisible: false,
    width: 140,
    minWidth: 80,
    sortable: false,
    editable: true,
    type:
      def.fieldType === 'number' || def.fieldType === 'currency'
        ? 'number'
        : def.fieldType === 'date'
          ? 'date'
          : def.fieldType === 'select' || def.fieldType === 'multiselect'
            ? 'select'
            : 'text',
    options:
      def.fieldType === 'select' || def.fieldType === 'multiselect'
        ? parseCustomOptions(def.optionsJson)
        : undefined,
  }))
}

function parseCustomOptions(json: string | null): { value: string; label: string }[] | undefined {
  if (!json) return undefined
  try {
    const arr = JSON.parse(json) as string[]
    return arr.map((v) => ({ value: v, label: v }))
  } catch {
    return undefined
  }
}
