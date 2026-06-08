/**
 * tableUtils — shared pure utilities for Company and Contact table components.
 *
 * All functions here are entity-agnostic and fully unit-testable
 * (no React, no IPC, no DOM dependencies).
 */

import type { CustomFieldDefinition, CustomFieldType } from '../../../shared/types/custom-fields'

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
  type: 'text' | 'select' | 'number' | 'date' | 'computed' | 'investor_chips'
  /** For investor_chips columns: caps the chip count. Used by Lead Investor (maxChips: 1). */
  maxChips?: number
  options?: { value: string; label: string }[]
  /** Display prefix for values (e.g. '$' for currency columns). Used by RangeFilter. */
  prefix?: string
  /** Display suffix for values (e.g. 'M' for $M columns). Used by RangeFilter. */
  suffix?: string
  /** Fixed decimal places for number display (e.g. 3 → 1.500). Used by renderDisplay. */
  decimals?: number
  /** Significant digits for number display (e.g. 2 → 0.85, 13, 5.0). Takes precedence over decimals. */
  sigDigits?: number
  /**
   * Custom value accessor for sorting. Used for computed columns whose `field` is null
   * (e.g. "location" = city + state). When provided, takes precedence over `field`.
   */
  sortAccessor?: (row: Record<string, unknown>) => string | number | null
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

// ─── Custom field filter passes ───────────────────────────────────────────────
//
// Custom field column filters use 'custom:<defId>' as their identifier in the
// URL and in the filter dicts produced by useTableFilters. The cell value for
// a custom field is NOT on the row scalar — it lives in customFieldValues
// (a Record<entityId, Record<defId, string>>). These passes mirror the built-in
// applySelectFilter/applyRangeFilter/applyTextFilter but read from the custom
// values map instead of row[field].

export type CustomFieldValuesMap = Record<string, Record<string, string>>
export type CustomFieldTypesMap = Record<string, CustomFieldType>

/**
 * Partition a filter dict into built-in vs. custom by 'custom:' prefix.
 * Custom keys are 'custom:<defId>'; built-ins use scalar field names.
 *
 *   in:  { type: ['investor'], 'custom:abc': ['B2B'] }
 *   out: { builtIn: { type: ['investor'] }, custom: { abc: ['B2B'] } }
 *
 * Custom keys are stripped of the 'custom:' prefix in the output so callers
 * can use the bare defId as a lookup key into customFieldValues / customFieldTypes.
 */
export function splitFiltersByCustom<V>(
  filters: Record<string, V>
): { builtIn: Record<string, V>; custom: Record<string, V> } {
  const builtIn: Record<string, V> = {}
  const custom: Record<string, V> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith('custom:')) custom[key.slice(7)] = value
    else builtIn[key] = value
  }
  return { builtIn, custom }
}

/**
 * Custom-field select filter. Cell values are strings:
 *   - single-select: bare value, e.g. 'B2B'
 *   - multiselect:   comma-joined, e.g. 'B2B,SaaS'
 *
 * We always split the cell on comma and check intersection with the active
 * filter values. Single-select reduces to a 1-element list (exact match);
 * multiselect matches if ANY filter value is in the cell's value list.
 *
 * Assumption: option names do not contain commas. Documented data-model
 * invariant; not validated here.
 */
export function applyCustomSelectFilter<T extends { id: string }>(
  rows: T[],
  customSelectFilters: Record<string, string[]>,
  customFieldValues: CustomFieldValuesMap
): T[] {
  const active = Object.entries(customSelectFilters).filter(([, v]) => v.length > 0)
  if (active.length === 0) return rows
  return rows.filter((row) => {
    const valuesForRow = customFieldValues[row.id] ?? {}
    return active.every(([defId, filterValues]) => {
      const raw = valuesForRow[defId]
      if (raw == null || raw === '') return false
      const cellValues = raw.split(',').map((s) => s.trim()).filter(Boolean)
      return filterValues.some((v) => cellValues.includes(v))
    })
  })
}

/**
 * Custom-field range filter — numeric or date inclusive bounds against
 * customFieldValues. Custom values arrive as strings; customFieldTypes
 * tells us whether to compare numerically or as date strings.
 *
 * Non-numeric strings in a number-typed field cause the row to be excluded
 * (Number(raw) is NaN, fails both bound checks). This is the desired
 * "row excluded — not silently mis-compared" semantics.
 *
 * Date format: SQLite values may arrive as 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS';
 * slice to 10 chars for lexicographic comparison against <input type="date">.
 */
export function applyCustomRangeFilter<T extends { id: string }>(
  rows: T[],
  customRangeFilters: Record<string, RangeValue>,
  customFieldValues: CustomFieldValuesMap,
  customFieldTypes: CustomFieldTypesMap
): T[] {
  const active = Object.entries(customRangeFilters).filter(
    ([, r]) => (r.min != null && r.min !== '') || (r.max != null && r.max !== '')
  )
  if (active.length === 0) return rows
  return rows.filter((row) => {
    const valuesForRow = customFieldValues[row.id] ?? {}
    return active.every(([defId, { min, max }]) => {
      const raw = valuesForRow[defId]
      if (raw == null || raw === '') return false
      const fieldType = customFieldTypes[defId]
      if (fieldType === 'date') {
        const dateVal = raw.slice(0, 10)
        if (min != null && min !== '' && dateVal < min) return false
        if (max != null && max !== '' && dateVal > max) return false
        return true
      }
      // number / currency — compare numerically. NaN fails both bounds → row excluded.
      const num = Number(raw)
      if (Number.isNaN(num)) return false
      if (min != null && min !== '' && num < Number(min)) return false
      if (max != null && max !== '' && num > Number(max)) return false
      return true
    })
  })
}

/**
 * Custom-field text filter — case-insensitive contains against customFieldValues.
 */
export function applyCustomTextFilter<T extends { id: string }>(
  rows: T[],
  customTextFilters: Record<string, string>,
  customFieldValues: CustomFieldValuesMap
): T[] {
  const active = Object.entries(customTextFilters).filter(([, v]) => v.trim().length > 0)
  if (active.length === 0) return rows
  return rows.filter((row) => {
    const valuesForRow = customFieldValues[row.id] ?? {}
    return active.every(([defId, query]) => {
      const raw = valuesForRow[defId]
      if (raw == null) return false
      return raw.toLowerCase().includes(query.toLowerCase())
    })
  })
}

export interface SortKey {
  key: string
  dir: 'asc' | 'desc'
}

/** Multi-column sort state — ordered from primary to tiebreaker. */
export type SortState = SortKey[]

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
 * Client-side multi-column sort for any row type.
 * Keys are evaluated in order (primary → tiebreaker). Nulls always sort last.
 * If sort array is empty, rows are returned unchanged.
 */
export function sortRows<T extends object>(
  rows: T[],
  sort: SortKey[],
  defs: ColumnDef[]
): T[] {
  if (sort.length === 0) return rows

  // Pre-resolve column defs for each sort key — skip keys with no matching def or accessor
  const resolved = sort.flatMap((sk) => {
    const col = defs.find((c) => c.key === sk.key)
    if (!col) return []
    const dir = sk.dir === 'asc' ? 1 : -1
    if (col.sortAccessor) {
      const accessor = col.sortAccessor
      return [{ get: (row: T) => accessor(row as unknown as Record<string, unknown>), dir }]
    }
    if (!col.field) return []
    const field = col.field as keyof T
    return [{ get: (row: T) => row[field] as string | number | null | undefined, dir }]
  })
  if (resolved.length === 0) return rows

  return [...rows].sort((a, b) => {
    for (const { get, dir } of resolved) {
      const av = get(a)
      const bv = get(b)

      const aEmpty = av == null || av === ''
      const bEmpty = bv == null || bv === ''
      if (aEmpty && bEmpty) continue
      if (aEmpty) return 1
      if (bEmpty) return -1

      let cmp: number
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av).localeCompare(String(bv))
      }
      if (cmp !== 0) return cmp * dir
    }
    return 0
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
 * field is null because the cell value is NOT on the row scalar — it lives
 * in customFieldValues (Record<entityId, Record<defId, string>>) and is
 * filtered by applyCustomSelectFilter / applyCustomRangeFilter /
 * applyCustomTextFilter against that map. useTableFilters reads/writes URL
 * params under col.key (e.g. ?custom:abc123=B2B) so custom filters round-trip.
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

// ─── Cell value callbacks factory ────────────────────────────────────────────

/**
 * createCellCallbacks — builds getCellValue and saveCellValue callbacks
 * that route between regular fields, custom fields, and computed fields.
 *
 * Used by CompanyTable and ContactTable to provide clipboard and inline-edit
 * save logic without duplicating the routing.
 *
 *   getCellValue(entity, col) → raw string value (or null)
 *   saveCellValue(entity, col, value) → async save via IPC
 */
export function createCellCallbacks<T extends { id: string }>(opts: {
  /** Read a custom field value for an entity. colKey is the full 'custom:xyz' key. */
  getCustomFieldValue: (entityId: string, customFieldId: string) => string | null
  /** Save a custom field value. */
  saveCustomField: (entityId: string, col: ColumnDef, value: string | null) => Promise<void>
  /** Save a regular (built-in) field. */
  saveRegularField: (entity: T, field: string, value: string | null) => Promise<void>
  /** Read a computed field value (e.g. 'location' = city + state). Optional. */
  getComputedValue?: (entity: T, col: ColumnDef) => string | null
}): {
  getCellValue: (entity: T, col: ColumnDef) => string | null
  saveCellValue: (entity: T, col: ColumnDef, value: string | null) => Promise<void>
} {
  const { getCustomFieldValue, saveCustomField, saveRegularField, getComputedValue } = opts

  function getCellValue(entity: T, col: ColumnDef): string | null {
    const customFieldId = col.key.startsWith('custom:') ? col.key.slice(7) : null
    if (customFieldId) return getCustomFieldValue(entity.id, customFieldId)
    if (getComputedValue && !col.field) return getComputedValue(entity, col)
    if (col.field) {
      const val = (entity as Record<string, unknown>)[col.field]
      return val == null || val === '' ? null : String(val)
    }
    return null
  }

  async function saveCellValue(entity: T, col: ColumnDef, value: string | null): Promise<void> {
    const customFieldId = col.key.startsWith('custom:') ? col.key.slice(7) : null
    if (customFieldId) {
      await saveCustomField(entity.id, col, value)
      return
    }
    if (!col.field) return
    await saveRegularField(entity, col.field, value)
  }

  return { getCellValue, saveCellValue }
}
