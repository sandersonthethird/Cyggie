// @vitest-environment jsdom
/**
 * Tests for useGroupedRows hook.
 *
 * Coverage diagram:
 *
 *   useGroupedRows
 *     ├── groupByKey=null    → passthrough DataRows, no group headers
 *     ├── groupByKey='type'  → emits GroupHeaderRow + DataRows per group
 *     │     ├── dataIndex correctness (group headers don't shift data indices)
 *     │     ├── groups ordered by GroupableField.order array
 *     │     └── null/"No value" group always last
 *     ├── collapsed group    → only GroupHeaderRow emitted, isCollapsed=true
 *     ├── unknown groupByKey → all items in "No value" group
 *     └── empty items[]     → empty rows array
 */

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useGroupedRows } from '../renderer/hooks/useGroupedRows'
import type { GroupableField } from '../renderer/components/company/companyColumns'

type Item = Record<string, unknown>

const FIELDS: GroupableField[] = [
  { key: 'type', label: 'Type', order: ['founder', 'investor', 'operator'] }
]

const ITEMS: Item[] = [
  { id: '1', type: 'investor', name: 'Alice' },
  { id: '2', type: 'founder', name: 'Bob' },
  { id: '3', type: 'investor', name: 'Carol' },
  { id: '4', type: 'operator', name: 'Dave' },
  { id: '5', type: null, name: 'Eve' }
]

function render(
  items: Item[],
  groupByKey: string | null,
  fields: GroupableField[],
  collapsed: Set<string>
) {
  return renderHook(() => useGroupedRows(items, groupByKey, fields, collapsed))
}

describe('useGroupedRows', () => {
  it('passthrough when groupByKey is null', () => {
    const { result } = render(ITEMS, null, FIELDS, new Set())
    expect(result.current).toHaveLength(ITEMS.length)
    expect(result.current.every(r => r.type === 'data')).toBe(true)
  })

  it('passthrough dataIndex equals array index when not grouped', () => {
    const { result } = render(ITEMS, null, FIELDS, new Set())
    result.current.forEach((row, i) => {
      expect(row.type).toBe('data')
      if (row.type === 'data') expect(row.dataIndex).toBe(i)
    })
  })

  it('emits group headers + data rows when groupByKey set', () => {
    const { result } = render(ITEMS, 'type', FIELDS, new Set())
    const headers = result.current.filter(r => r.type === 'group')
    // founder (1), investor (2), operator (1), null (1) → 4 groups
    expect(headers).toHaveLength(4)
  })

  it('orders groups by GroupableField.order, null last', () => {
    const { result } = render(ITEMS, 'type', FIELDS, new Set())
    const headers = result.current.filter(r => r.type === 'group')
    const labels = headers.map(h => (h.type === 'group' ? h.label : ''))
    expect(labels).toEqual(['founder', 'investor', 'operator', 'No value'])
  })

  it('dataIndex correctness: matches original array position despite group headers', () => {
    const items: Item[] = [
      { id: 'a', type: 'investor' },  // original index 0
      { id: 'b', type: 'founder' },   // original index 1
      { id: 'c', type: 'investor' }   // original index 2
    ]
    const { result } = render(items, 'type', FIELDS, new Set())
    const dataRows = result.current.filter(r => r.type === 'data')
    // founder group first: id 'b' (original index 1)
    // investor group second: id 'a' (0), id 'c' (2)
    const dataRowsSorted = dataRows.filter(r => r.type === 'data')
    const indices = dataRowsSorted.map(r => r.type === 'data' ? r.dataIndex : -1)
    // founder comes first in order: bob = index 1
    expect(indices[0]).toBe(1)
    // then investors: alice=0, carol=2
    expect(indices[1]).toBe(0)
    expect(indices[2]).toBe(2)
  })

  it('collapsed group emits only GroupHeaderRow, isCollapsed=true', () => {
    const { result } = render(ITEMS, 'type', FIELDS, new Set(['investor']))
    const investorHeader = result.current.find(
      r => r.type === 'group' && r.value === 'investor'
    )
    expect(investorHeader).toBeDefined()
    if (investorHeader?.type === 'group') {
      expect(investorHeader.isCollapsed).toBe(true)
    }
    // No data rows for investor group
    const investorDataRows = result.current.filter(
      r => r.type === 'data' && (r.item as Item).type === 'investor'
    )
    expect(investorDataRows).toHaveLength(0)
  })

  it('non-collapsed group has isCollapsed=false', () => {
    const { result } = render(ITEMS, 'type', FIELDS, new Set())
    const founderHeader = result.current.find(
      r => r.type === 'group' && r.value === 'founder'
    )
    if (founderHeader?.type === 'group') {
      expect(founderHeader.isCollapsed).toBe(false)
    }
  })

  it('unknown groupByKey puts all items in "No value" group', () => {
    const { result } = render(ITEMS, 'nonexistent', FIELDS, new Set())
    const headers = result.current.filter(r => r.type === 'group')
    expect(headers).toHaveLength(1)
    if (headers[0].type === 'group') {
      expect(headers[0].label).toBe('No value')
      expect(headers[0].count).toBe(ITEMS.length)
    }
  })

  it('empty items array returns empty rows', () => {
    const { result } = render([], 'type', FIELDS, new Set())
    expect(result.current).toHaveLength(0)
  })

  it('group count matches number of items in group', () => {
    const { result } = render(ITEMS, 'type', FIELDS, new Set())
    const investorHeader = result.current.find(r => r.type === 'group' && r.value === 'investor')
    if (investorHeader?.type === 'group') {
      expect(investorHeader.count).toBe(2) // Alice + Carol
    }
  })
})
