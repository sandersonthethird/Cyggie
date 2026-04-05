/**
 * useGroupedRows — generic hook that transforms a flat item array into a
 * mixed VirtualRow<T>[] array for use with TanStack Virtual when row grouping
 * is active.
 *
 * Data flow:
 *   items[]  +  groupByKey  +  fields[]  +  collapsedGroups
 *     ↓
 *   VirtualRow<T>[]
 *     ├── GroupHeaderRow  { type: 'group', value, label, count, isCollapsed }
 *     └── DataRow<T>      { type: 'data',  item, dataIndex }
 *
 * dataIndex is the position of item in the original items array (0-based).
 * It equals vrow.index when not grouped, but diverges when group headers are
 * interleaved. Always use row.dataIndex (not vrow.index) for data-index-dependent
 * calls: toggleSelect, handleStartEdit, handleEndEdit.
 *
 * When groupByKey is null the hook is a passthrough — all items become DataRows
 * with dataIndex === their array index. No group headers are emitted.
 */
import { useMemo } from 'react'
import type { GroupableField } from '../components/company/companyColumns'

// ─── Types ────────────────────────────────────────────────────────────────────

export type GroupHeaderRow = {
  type: 'group'
  value: string | null
  label: string
  count: number
  /** Collapse state is encoded here so the table does not need a collapsedGroups Set prop. */
  isCollapsed: boolean
}

export type DataRow<T> = {
  type: 'data'
  item: T
  /** Position of item in the original items[] array. Use this instead of vrow.index. */
  dataIndex: number
}

export type VirtualRow<T> = GroupHeaderRow | DataRow<T>

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useGroupedRows<T extends Record<string, unknown>>(
  items: T[],
  groupByKey: string | null,
  fields: GroupableField[],
  collapsedGroups: Set<string>
): VirtualRow<T>[] {
  return useMemo(() => {
    // Passthrough when grouping is off
    if (!groupByKey) {
      return items.map((item, i): DataRow<T> => ({ type: 'data', item, dataIndex: i }))
    }

    const field = fields.find((f) => f.key === groupByKey)
    const order = field?.order ?? []

    // Partition items into groups, tracking original indices
    const groups = new Map<string, Array<{ item: T; dataIndex: number }>>()

    items.forEach((item, i) => {
      const raw = item[groupByKey]
      const key = raw != null && raw !== '' ? String(raw) : '__null__'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push({ item, dataIndex: i })
    })

    // Order groups by predefined order array; unknown values before null/"No value"
    const orderedKeys: string[] = []
    for (const v of order) {
      if (groups.has(v)) orderedKeys.push(v)
    }
    // Add any values not in the predefined order (but not null)
    for (const k of groups.keys()) {
      if (k !== '__null__' && !orderedKeys.includes(k)) orderedKeys.push(k)
    }
    // Null/"No value" always last
    if (groups.has('__null__')) orderedKeys.push('__null__')

    const rows: VirtualRow<T>[] = []

    for (const groupKey of orderedKeys) {
      const entries = groups.get(groupKey)
      if (!entries || entries.length === 0) continue

      // Find the display label
      const rawValue = groupKey === '__null__' ? null : groupKey
      const label = groupKey === '__null__'
        ? 'No value'
        : (field
            ? (fields.find((f) => f.key === groupByKey) ? groupKey : groupKey)
            : groupKey)

      const isCollapsed = collapsedGroups.has(groupKey)

      rows.push({
        type: 'group',
        value: rawValue,
        label,
        count: entries.length,
        isCollapsed
      })

      if (!isCollapsed) {
        for (const { item, dataIndex } of entries) {
          rows.push({ type: 'data', item, dataIndex })
        }
      }
    }

    return rows
  }, [items, groupByKey, fields, collapsedGroups])
}
