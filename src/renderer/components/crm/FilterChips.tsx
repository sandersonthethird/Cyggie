/**
 * Shared filter-chip row for CRM tables (Companies + Contacts).
 *
 * Renders one chip per active filter (column-select, range, text) with an X
 * to clear it, plus a "Clear all" button. Returns null when no filters are
 * active, so callers don't need to gate it on `activeFilterCount`.
 *
 *   columnFilters ──► select chips
 *   rangeFilters  ──► range chips (formatted via prefix/suffix or date)
 *   textFilters   ──► text chips
 */

import styles from './FilterChips.module.css'

interface FilterColumnDef {
  field?: string | null
  label: string
  type?: string
  prefix?: string
  suffix?: string
  options?: { value: string; label: string }[]
}

interface FilterChipsProps {
  columnFilters: Record<string, string[]>
  rangeFilters: Record<string, { min?: string; max?: string }>
  textFilters: Record<string, string>
  columnDefs: readonly FilterColumnDef[]
  onColumnFilter: (field: string, values: string[]) => void
  onRangeFilter: (field: string, range: { min?: string; max?: string }) => void
  onTextFilter: (field: string, value: string) => void
  clearAllFilters: () => void
}

function findColumn(defs: readonly FilterColumnDef[], field: string): FilterColumnDef | undefined {
  return defs.find((c) => c.field === field)
}

function formatRangeValue(col: FilterColumnDef | undefined, v: string): string {
  if (col?.type === 'date') {
    return new Date(`${v}T00:00:00`).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
  }
  return `${col?.prefix ?? ''}${v}${col?.suffix ?? ''}`
}

function formatRangeLabel(col: FilterColumnDef | undefined, range: { min?: string; max?: string }): string {
  const { min, max } = range
  if (min && max && min === max) return `= ${formatRangeValue(col, min)}`
  if (min && max) return `${formatRangeValue(col, min)} – ${formatRangeValue(col, max)}`
  if (min) return `≥ ${formatRangeValue(col, min)}`
  return `≤ ${formatRangeValue(col, max!)}`
}

export function FilterChips({
  columnFilters,
  rangeFilters,
  textFilters,
  columnDefs,
  onColumnFilter,
  onRangeFilter,
  onTextFilter,
  clearAllFilters,
}: FilterChipsProps) {
  const hasAny =
    Object.values(columnFilters).some((v) => v.length > 0) ||
    Object.keys(rangeFilters).length > 0 ||
    Object.keys(textFilters).length > 0

  if (!hasAny) return null

  return (
    <div className={styles.filterRow}>
      {/* Select filter chips */}
      {Object.entries(columnFilters).flatMap(([field, values]) => {
        const col = findColumn(columnDefs, field)
        return values.map((v) => {
          const label = col?.options?.find((o) => o.value === v)?.label ?? v
          return (
            <span key={`${field}:${v}`} className={styles.filterChip}>
              {col?.label ?? field}: {label}
              <button
                className={styles.filterChipX}
                onClick={() =>
                  onColumnFilter(field, (columnFilters[field] ?? []).filter((p) => p !== v))
                }
              >
                ×
              </button>
            </span>
          )
        })
      })}

      {/* Range filter chips */}
      {Object.entries(rangeFilters).map(([field, range]) => {
        const col = findColumn(columnDefs, field)
        return (
          <span key={`range:${field}`} className={styles.filterChip}>
            {col?.label ?? field}: {formatRangeLabel(col, range)}
            <button className={styles.filterChipX} onClick={() => onRangeFilter(field, {})}>
              ×
            </button>
          </span>
        )
      })}

      {/* Text filter chips */}
      {Object.entries(textFilters).map(([field, value]) => {
        const col = findColumn(columnDefs, field)
        return (
          <span key={`text:${field}`} className={styles.filterChip}>
            {col?.label ?? field}: &ldquo;{value}&rdquo;
            <button className={styles.filterChipX} onClick={() => onTextFilter(field, '')}>
              ×
            </button>
          </span>
        )
      })}

      <button className={styles.filterClearAll} onClick={clearAllFilters}>
        Clear all
      </button>
    </div>
  )
}
