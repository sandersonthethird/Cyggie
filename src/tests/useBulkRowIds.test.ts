// @vitest-environment jsdom
/**
 * Tests for useBulkRowIds — the union of row-checkbox selection and the rows
 * covered by the spreadsheet cell selection, feeding the bulk-action bar.
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBulkRowIds } from '../renderer/hooks/useBulkRowIds'
import type { CellSelection } from '../renderer/hooks/useEditCellNav'

const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

/** Selection covering a single rectangle (rows r1..r2, cols c1..c2). */
function rectSelection(r1: number, c1: number, r2: number, c2: number): CellSelection {
  return {
    rects: [{ r1, c1, r2, c2 }],
    added: new Set(),
    removed: new Set(),
    anchor: { row: r1, col: c1 },
    active: { row: r2, col: c2 },
  }
}

describe('useBulkRowIds', () => {
  it('unions checkbox-selected ids with the cell-selection rows', () => {
    const selectedIds = new Set(['a'])
    const selection = rectSelection(1, 0, 2, 0) // rows 1,2 → ids b,c
    const { result } = renderHook(() => useBulkRowIds(selectedIds, selection, rows))
    expect([...result.current].sort()).toEqual(['a', 'b', 'c'])
  })

  it('skips stale cell-selection row indices that are out of range', () => {
    const selectedIds = new Set<string>()
    const selection = rectSelection(1, 0, 9, 0) // rows 1..9, but only 3 rows exist
    const { result } = renderHook(() => useBulkRowIds(selectedIds, selection, rows))
    expect([...result.current].sort()).toEqual(['b', 'c']) // rows 3..9 skipped, no undefined
  })

  it('returns just the checkbox selection when there is no cell selection', () => {
    const selectedIds = new Set(['a', 'c'])
    const { result } = renderHook(() => useBulkRowIds(selectedIds, null, rows))
    expect([...result.current].sort()).toEqual(['a', 'c'])
  })

  it('is empty when neither source has a selection', () => {
    const { result } = renderHook(() => useBulkRowIds(new Set<string>(), null, rows))
    expect(result.current.size).toBe(0)
  })
})
