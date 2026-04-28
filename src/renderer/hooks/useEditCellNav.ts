/**
 * useEditCellNav — shared hook for cell focus, inline edit, and keyboard navigation.
 *
 * State machine:
 *   IDLE ──click──▶ FOCUSED ──dbl-click/Enter──▶ EDIT ──save──▶ FOCUSED
 *     ▲                │  ▲                         │
 *     └── click out ───┘  └──────── Esc ────────────┘
 *     └── Esc ─────────┘
 *
 *   FOCUSED + Shift:
 *     Shift+click (same col) → set cellRange { colIdx, startRow, endRow }
 *     Shift+Arrow Up/Down    → extend/contract cellRange
 *
 *   cellRange:
 *     Holds { colIdx, startRow, endRow } — all cells in one column between rows
 *     Cleared on: click without Shift, Escape, entering edit mode
 *
 * Data flow:
 *   handleFocusCell(row, col, shift) ──► focusedCell = { rowIdx, colIdx }
 *   handleStartEdit(row, col, char?) ──► editCell = { rowIdx, colIdx, initialChar? }
 *   handleEndEdit(dir='right')        ──► advance to next editable col, stay FOCUSED
 *   handleEndEdit(dir='down')         ──► advance to next row, stay FOCUSED
 *   handleEndEdit(dir=null)           ──► clear editCell, keep focusedCell (Esc from edit)
 *   handleArrowNav(dir, shift)        ──► move focusedCell, optionally extend cellRange
 */
import { useState, useCallback } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'

export interface EditCell {
  rowIdx: number
  colIdx: number
  initialChar?: string
}

export interface CellRange {
  colIdx: number
  startRow: number
  endRow: number
}

export function useEditCellNav(
  rowCount: number,
  visibleCols: ColumnDef[],
  scrollToRow?: (idx: number) => void
) {
  const [focusedCell, setFocusedCell] = useState<EditCell | null>(null)
  const [editCell, setEditCell] = useState<EditCell | null>(null)
  const [cellRange, setCellRange] = useState<CellRange | null>(null)

  const handleFocusCell = useCallback((rowIdx: number, colIdx: number, shiftKey = false) => {
    if (shiftKey && focusedCell && focusedCell.colIdx === colIdx) {
      // Shift+click same column → create/extend range
      setCellRange({
        colIdx,
        startRow: Math.min(focusedCell.rowIdx, rowIdx),
        endRow: Math.max(focusedCell.rowIdx, rowIdx),
      })
    } else {
      setCellRange(null)
      setFocusedCell({ rowIdx, colIdx })
    }
    setEditCell(null)
  }, [focusedCell])

  const handleStartEdit = useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
    const cell: EditCell = { rowIdx, colIdx }
    if (initialChar) cell.initialChar = initialChar
    setEditCell(cell)
    setFocusedCell({ rowIdx, colIdx })
    setCellRange(null)
  }, [])

  const handleEndEdit = useCallback((rowIdx: number, colIdx: number, advanceDir: 'down' | 'right' | null) => {
    setEditCell(null)
    if (!advanceDir) {
      // Esc from edit → keep focusedCell at current position
      return
    }

    const editableCols = visibleCols
      .map((c, i) => ({ col: c, i }))
      .filter(({ col }) => col.editable)

    if (advanceDir === 'down') {
      const nextRow = rowIdx + 1
      if (nextRow < rowCount) {
        setFocusedCell({ rowIdx: nextRow, colIdx })
        setEditCell({ rowIdx: nextRow, colIdx })
        scrollToRow?.(nextRow)
      }
    } else if (advanceDir === 'right') {
      const currentEditIdx = editableCols.findIndex(({ i }) => i === colIdx)
      const nextEditable = editableCols[currentEditIdx + 1]
      if (nextEditable) {
        setFocusedCell({ rowIdx, colIdx: nextEditable.i })
        setEditCell({ rowIdx, colIdx: nextEditable.i })
      }
    }
  }, [rowCount, visibleCols, scrollToRow])

  const clearFocus = useCallback(() => {
    setFocusedCell(null)
    setEditCell(null)
    setCellRange(null)
  }, [])

  const handleArrowNav = useCallback((direction: 'up' | 'down' | 'left' | 'right', shiftKey = false) => {
    if (!focusedCell) return

    if (direction === 'up' || direction === 'down') {
      const delta = direction === 'down' ? 1 : -1
      const nextRow = focusedCell.rowIdx + delta
      if (nextRow < 0 || nextRow >= rowCount) return

      if (shiftKey) {
        // Extend/create column range
        setCellRange((prev) => {
          if (prev) {
            const newEnd = prev.endRow + delta
            if (newEnd < 0 || newEnd >= rowCount) return prev
            // If range collapses to single cell, clear it
            if (prev.startRow === newEnd) {
              return null
            }
            return { ...prev, endRow: newEnd }
          }
          // Create new range from focusedCell to next row
          return {
            colIdx: focusedCell.colIdx,
            startRow: Math.min(focusedCell.rowIdx, nextRow),
            endRow: Math.max(focusedCell.rowIdx, nextRow),
          }
        })
      } else {
        setFocusedCell({ rowIdx: nextRow, colIdx: focusedCell.colIdx })
        setCellRange(null)
      }
      scrollToRow?.(nextRow)
    } else {
      // Left/Right — move to prev/next editable column (same row), clear range
      const editableCols = visibleCols
        .map((c, i) => ({ col: c, i }))
        .filter(({ col }) => col.editable)

      const currentIdx = editableCols.findIndex(({ i }) => i === focusedCell.colIdx)
      const nextIdx = direction === 'right' ? currentIdx + 1 : currentIdx - 1
      const nextCol = editableCols[nextIdx]
      if (nextCol) {
        setFocusedCell({ rowIdx: focusedCell.rowIdx, colIdx: nextCol.i })
        setCellRange(null)
      }
    }
    setEditCell(null)
  }, [focusedCell, rowCount, visibleCols, scrollToRow])

  return {
    focusedCell,
    setFocusedCell,
    editCell,
    setEditCell,
    cellRange,
    setCellRange,
    handleFocusCell,
    handleStartEdit,
    handleEndEdit,
    handleArrowNav,
    clearFocus,
  }
}
