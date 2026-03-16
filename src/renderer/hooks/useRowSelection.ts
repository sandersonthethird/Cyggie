/**
 * useRowSelection — shared hook for row checkbox + keyboard selection.
 *
 * Handles:
 *   - toggleSelect: click (± shift-range) → selectedIds
 *   - handleTableKeyDown: Cmd+A (select all) + Shift+Arrow (expand selection)
 *
 * `getEditCell` is a stable callback (from useEditCellNav) — handleTableKeyDown
 * bails early when a cell is in edit mode, preventing selection changes during typing.
 * Using a callback instead of a direct state ref avoids stale closure issues.
 */
import { useState, useRef, useCallback } from 'react'

export function useRowSelection<T extends { id: string }>(
  rows: T[],
  scrollToRow: (idx: number) => void,
  getEditCell: () => { rowIdx: number; colIdx: number } | null
): {
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  toggleSelect: (id: string, rowIdx: number, shiftKey: boolean) => void
  handleTableKeyDown: (e: React.KeyboardEvent) => void
  lastSelectedIdxRef: React.MutableRefObject<number | null>
} {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastSelectedIdxRef = useRef<number | null>(null)
  const cursorRowIdxRef = useRef<number | null>(null)

  const toggleSelect = useCallback((id: string, rowIdx: number, shiftKey: boolean) => {
    if (shiftKey && lastSelectedIdxRef.current !== null) {
      const lo = Math.min(lastSelectedIdxRef.current, rowIdx)
      const hi = Math.max(lastSelectedIdxRef.current, rowIdx)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) {
          const item = rows[i]
          if (item) next.add(item.id)
        }
        return next
      })
    } else {
      lastSelectedIdxRef.current = rowIdx
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }
  }, [rows])

  const handleTableKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (getEditCell() !== null) return

    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      setSelectedIds(new Set(rows.map((r) => r.id)))
      return
    }

    if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      const direction = e.key === 'ArrowDown' ? 1 : -1
      const currentCursor = cursorRowIdxRef.current ?? lastSelectedIdxRef.current ?? -1
      const nextIdx = currentCursor + direction
      if (nextIdx >= 0 && nextIdx < rows.length) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          next.add(rows[nextIdx].id)
          return next
        })
        cursorRowIdxRef.current = nextIdx
        lastSelectedIdxRef.current = nextIdx
        scrollToRow(nextIdx)
      }
    }
  }, [rows, scrollToRow, getEditCell])

  return { selectedIds, setSelectedIds, toggleSelect, handleTableKeyDown, lastSelectedIdxRef }
}
