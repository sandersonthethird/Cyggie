/**
 * useEditCellNav — shared hook for cell focus, inline edit, and keyboard navigation.
 *
 * State machine:
 *   IDLE ──click──▶ FOCUSED ──dbl-click/Enter/type──▶ EDIT ──save──▶ FOCUSED
 *     ▲                │  ▲                              │
 *     └── click out ───┘  └──────── Esc ─────────────────┘
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
 *   handleKeyboardEvent(e, opts)      ──► dispatch a key event to nav/edit/escape/type-to-edit;
 *                                         returns true if handled, false to let caller continue.
 *                                         opts.suppressEscape skips the Esc clause when caller
 *                                         has competing state (e.g. clipboard "copied" mode).
 */
import { useState, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'

export interface EditCell {
  rowIdx: number
  colIdx: number
  initialChar?: string
}

/** Position of a cell within a contiguous range. null = not in range. */
export type RangePosition = 'only' | 'top' | 'mid' | 'bot' | null

/** Compute a cell's position within a range (for unified border rendering). */
export function getRangePosition(
  dataIndex: number,
  colIdx: number,
  range: CellRange | null,
  singleCell: EditCell | null
): RangePosition {
  // Check range first
  if (range && range.colIdx === colIdx && dataIndex >= range.startRow && dataIndex <= range.endRow) {
    if (range.startRow === range.endRow) return 'only'
    if (dataIndex === range.startRow) return 'top'
    if (dataIndex === range.endRow) return 'bot'
    return 'mid'
  }
  // Single cell
  if (singleCell && singleCell.rowIdx === dataIndex && singleCell.colIdx === colIdx) {
    return 'only'
  }
  return null
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

  /**
   * Dispatches a React keyboard event to the appropriate cell-nav action.
   * Returns true if the event was handled (caller should stop), false if not
   * (caller should continue to other handlers like clipboard / row-selection).
   *
   * Handles, in order:
   *   1. Arrow keys (when focused, not editing) → handleArrowNav
   *   2. Enter (when focused, not editing) → handleStartEdit
   *   3. Escape (when focused, not editing, !opts.suppressEscape) → clearFocus
   *   4. Printable single-char key (when focused, not editing, no modifiers,
   *      not autorepeat, focused col is editable) → handleStartEdit with initialChar
   */
  const handleKeyboardEvent = useCallback(
    (e: ReactKeyboardEvent, opts?: { suppressEscape?: boolean }): boolean => {
      if (!focusedCell || editCell) return false

      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault()
        const dir = e.key.replace('Arrow', '').toLowerCase() as 'up' | 'down' | 'left' | 'right'
        handleArrowNav(dir, e.shiftKey)
        return true
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        handleStartEdit(focusedCell.rowIdx, focusedCell.colIdx)
        return true
      }

      if (e.key === 'Escape' && !opts?.suppressEscape) {
        e.preventDefault()
        clearFocus()
        return true
      }

      // Type-to-edit: any printable single character without modifiers, on an editable col.
      // - e.repeat skipped so holding a key doesn't re-trigger after edit mode begins
      // - length === 1 excludes "Tab", "Backspace", "Enter", "ArrowDown", "Process" (IME), etc.
      if (
        !e.metaKey && !e.ctrlKey && !e.altKey &&
        !e.repeat &&
        e.key.length === 1
      ) {
        const focusedCol = visibleCols[focusedCell.colIdx]
        if (focusedCol?.editable) {
          e.preventDefault()
          handleStartEdit(focusedCell.rowIdx, focusedCell.colIdx, e.key)
          return true
        }
      }

      return false
    },
    [focusedCell, editCell, visibleCols, handleArrowNav, handleStartEdit, clearFocus],
  )

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
    handleKeyboardEvent,
    clearFocus,
  }
}
