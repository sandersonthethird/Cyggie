/**
 * useTableFilters — shared hook for URL-driven column filter state.
 *
 * Extracts the three filter state memos, three handler callbacks, and URL helpers
 * that were previously duplicated in Companies.tsx and Contacts.tsx.
 *
 * Data flow:
 *   URL searchParams ──► columnFilters  (select: ?field=value)
 *                   ──► rangeFilters   (range:  ?field_min=X & ?field_max=X)
 *                   ──► textFilters    (text:   ?field_q=search)
 *
 *   handlers ──► setSearchParams ──► URL (React Router) ──► re-render
 *
 * Custom columns: built-in columns identify themselves via `col.field`; custom
 * columns set `col.field = null` and use `col.key` (e.g. 'custom:abc123') as
 * their identifier. This hook reads/writes URL params using `col.field ?? col.key`,
 * so a custom-field filter dropdown writes `?custom:abc123=B2B` and the read side
 * picks it up under the same key. Downstream filterCompanies/filterContacts split
 * filter dicts into built-in vs. custom (by 'custom:' prefix) and apply each set
 * against its respective value source.
 *
 * Stability contract: `columnDefs` and `fieldToParamMap` MUST be stable references
 * (module-level consts). Passing inline object literals will cause unnecessary re-renders.
 */
import { useCallback, useMemo } from 'react'
import type { SetURLSearchParams } from 'react-router-dom'
import type { ColumnDef, RangeValue } from '../components/crm/tableUtils'

export interface UseTableFiltersOptions {
  /** Column definitions — must be a stable reference (module-level const). */
  columnDefs: ColumnDef[]
  searchParams: URLSearchParams
  setSearchParams: SetURLSearchParams
  /**
   * Optional remapping of field names to URL param names.
   * e.g. { entityType: 'type', pipelineStage: 'stage' }
   * Must be a stable reference (module-level const).
   */
  fieldToParamMap?: Record<string, string>
}

export interface UseTableFiltersResult {
  /** Active select filter values per field, derived from URL. */
  columnFilters: Record<string, string[]>
  /** Active range filter bounds per field, derived from URL. */
  rangeFilters: Record<string, RangeValue>
  /** Active text filter query per field, derived from URL. */
  textFilters: Record<string, string>
  /** Total count of active filter values across all three filter types. */
  activeFilterCount: number
  /** Update select filter values for a field. Pass [] to clear. */
  handleColumnFilter: (field: string, values: string[]) => void
  /** Update range filter bounds for a field. Pass {} to clear. */
  handleRangeFilter: (field: string, range: RangeValue) => void
  /** Update text filter query for a field. Pass '' to clear. */
  handleTextFilter: (field: string, value: string) => void
  /** Remove all filter params for all columns in columnDefs. */
  clearAllFilters: () => void
  /** Maps a field name to its URL param name (applies fieldToParamMap). */
  paramForField: (field: string) => string
}

const rangeParamMin = (field: string) => `${field}_min`
const rangeParamMax = (field: string) => `${field}_max`
const textParam = (field: string) => `${field}_q`

export function useTableFilters({
  columnDefs,
  searchParams,
  setSearchParams,
  fieldToParamMap = {}
}: UseTableFiltersOptions): UseTableFiltersResult {
  const paramForField = useCallback(
    (field: string) => fieldToParamMap[field] ?? field,
    // fieldToParamMap must be a stable ref — module-level const in both callers
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fieldToParamMap]
  )

  const columnFilters = useMemo<Record<string, string[]>>(() => {
    const result: Record<string, string[]> = {}
    for (const col of columnDefs) {
      if (!col.options) continue
      const id = col.field ?? col.key
      if (!id) continue
      // Defensive: drop empty-string values so a degenerate URL like `?key=`
      // doesn't silently match rows whose cell value is also empty.
      const values = searchParams.getAll(paramForField(id)).filter((v) => v !== '')
      if (values.length > 0) result[id] = values
    }
    return result
  }, [columnDefs, searchParams, paramForField])

  const rangeFilters = useMemo<Record<string, RangeValue>>(() => {
    const result: Record<string, RangeValue> = {}
    for (const col of columnDefs) {
      if (col.type !== 'number' && col.type !== 'date') continue
      const id = col.field ?? col.key
      if (!id) continue
      const min = searchParams.get(rangeParamMin(id)) ?? undefined
      const max = searchParams.get(rangeParamMax(id)) ?? undefined
      if (min != null || max != null) result[id] = { min, max }
    }
    return result
  }, [columnDefs, searchParams])

  const textFilters = useMemo<Record<string, string>>(() => {
    const result: Record<string, string> = {}
    for (const col of columnDefs) {
      if (col.type !== 'text') continue
      const id = col.field ?? col.key
      if (!id) continue
      const v = searchParams.get(textParam(id))
      if (v) result[id] = v
    }
    return result
  }, [columnDefs, searchParams])

  const activeFilterCount =
    Object.values(columnFilters).reduce((sum, v) => sum + v.length, 0) +
    Object.keys(rangeFilters).length +
    Object.keys(textFilters).length

  const handleColumnFilter = useCallback(
    (field: string, values: string[]) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        const param = fieldToParamMap[field] ?? field
        next.delete(param)
        values.forEach((v) => next.append(param, v))
        return next
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSearchParams, fieldToParamMap]
  )

  const handleRangeFilter = useCallback(
    (field: string, range: RangeValue) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete(rangeParamMin(field))
        next.delete(rangeParamMax(field))
        if (range.min != null && range.min !== '') next.set(rangeParamMin(field), range.min)
        if (range.max != null && range.max !== '') next.set(rangeParamMax(field), range.max)
        return next
      })
    },
    [setSearchParams]
  )

  const handleTextFilter = useCallback(
    (field: string, value: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete(textParam(field))
        if (value.trim()) next.set(textParam(field), value)
        return next
      })
    },
    [setSearchParams]
  )

  const clearAllFilters = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const col of columnDefs) {
        const id = col.field ?? col.key
        if (!id) continue
        if (col.options) next.delete(fieldToParamMap[id] ?? id)
        if (col.type === 'number' || col.type === 'date') {
          next.delete(rangeParamMin(id))
          next.delete(rangeParamMax(id))
        }
        if (col.type === 'text') next.delete(textParam(id))
      }
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSearchParams, columnDefs, fieldToParamMap])

  return {
    columnFilters,
    rangeFilters,
    textFilters,
    activeFilterCount,
    handleColumnFilter,
    handleRangeFilter,
    handleTextFilter,
    clearAllFilters,
    paramForField
  }
}
