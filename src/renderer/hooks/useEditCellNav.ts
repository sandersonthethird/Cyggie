/**
 * useEditCellNav — shared hook for cell focus, inline edit, keyboard navigation,
 * and spreadsheet-style multi-cell selection.
 *
 * SELECTION MODEL (Phase 1 of "Sheets parity"):
 *   The source of truth is a single `selection` (hybrid Rect[] + added/removed):
 *
 *     interface CellSelection {
 *       rects:   Rect[]          // committed rectangles (shift drags; a click = 1×1)
 *       added:   Set<"row:col">  // Cmd+click toggled-ON singletons
 *       removed: Set<"row:col">  // Cmd+click toggled-OFF cells (subtracted from rects)
 *       anchor:  Cell            // origin for the current shift-rectangle
 *       active:  Cell            // keyboard cursor (the "one" cell for type-to-edit)
 *     }
 *     effective(cell) = (inAnyRect ∨ added) ∧ ¬removed
 *
 *   Gestures:
 *     click            → single cell
 *     shift+click/arrow→ rectangle anchor→active (multi-column)
 *     cmd+click        → toggle a cell (non-contiguous, any column)
 *     cmd+shift+click  → add another rectangle to the selection
 *
 *   Back-compat: `focusedCell` (= active) and `cellRange` (= a single-column
 *   contiguous rect) are DERIVED from `selection`, so existing consumers and
 *   tests keep working unchanged. The clipboard reads `selection` for the new
 *   grid operations (TSV copy, delete-all, paste-all).
 *
 *   State machine:
 *     IDLE ─click─▶ SINGLE ─dbl-click/Enter/type─▶ EDIT ─save─▶ SINGLE
 *       ▲             │  ▲    shift              cmd          │
 *       │             ▼  │  RECT ◀──────────── MULTI          │
 *       └── Esc ──────┴──┴────────────────────────◀── Esc ────┘
 */
import { useState, useCallback, useEffect, useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'

export interface EditCell {
  rowIdx: number
  colIdx: number
  initialChar?: string
}

/** Position of a cell within a contiguous range. null = not in range. */
export type RangePosition = 'only' | 'top' | 'mid' | 'bot' | null

/** Compute a cell's position within a range (for the copied-cell dashed outline). */
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

// ── Multi-cell selection model ──────────────────────────────────────────────

export interface Cell {
  row: number
  col: number
}

/** Normalized rectangle (r1≤r2, c1≤c2). */
export interface Rect {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface CellSelection {
  rects: Rect[]
  added: Set<string>
  removed: Set<string>
  anchor: Cell
  active: Cell
}

/** Which outer edges of a selected cell to draw a border on (for unified outlines). */
export interface CellEdges {
  active: boolean
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
}

const cellKey = (row: number, col: number): string => `${row}:${col}`

function normRect(a: Cell, b: Cell): Rect {
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  }
}

function rectHas(rect: Rect, row: number, col: number): boolean {
  return row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2
}

/** True if (row,col) is part of the effective selection. */
export function isCellSelected(sel: CellSelection | null, row: number, col: number): boolean {
  if (!sel) return false
  const k = cellKey(row, col)
  if (sel.removed.has(k)) return false
  if (sel.added.has(k)) return true
  return sel.rects.some((rt) => rectHas(rt, row, col))
}

/** Outer-edge descriptor for a selected cell, or null when the cell isn't selected. */
export function getCellEdges(sel: CellSelection | null, row: number, col: number): CellEdges | null {
  if (!isCellSelected(sel, row, col)) return null
  return {
    active: !!sel && sel.active.row === row && sel.active.col === col,
    top: !isCellSelected(sel, row - 1, col),
    bottom: !isCellSelected(sel, row + 1, col),
    left: !isCellSelected(sel, row, col - 1),
    right: !isCellSelected(sel, row, col + 1),
  }
}

/**
 * Build the inset box-shadow that draws a 2px selection border on only the outer
 * edges of a cell, so any selection shape renders as one clean outline. Returns
 * undefined for an unselected cell (no shadow).
 */
export function cellEdgeBoxShadow(edges: CellEdges | null): string | undefined {
  if (!edges) return undefined
  const parts = [
    edges.top && 'inset 0 2px 0 0 var(--color-primary)',
    edges.right && 'inset -2px 0 0 0 var(--color-primary)',
    edges.bottom && 'inset 0 -2px 0 0 var(--color-primary)',
    edges.left && 'inset 2px 0 0 0 var(--color-primary)',
  ].filter(Boolean)
  return parts.length ? parts.join(', ') : undefined
}

/** Materialize the effective selection as a deduped, row-then-column-sorted list. */
export function effectiveCells(sel: CellSelection | null): Cell[] {
  if (!sel) return []
  const keys = new Set<string>()
  for (const rt of sel.rects) {
    for (let r = rt.r1; r <= rt.r2; r++) {
      for (let c = rt.c1; c <= rt.c2; c++) keys.add(cellKey(r, c))
    }
  }
  for (const k of sel.added) keys.add(k)
  for (const k of sel.removed) keys.delete(k)
  const cells = [...keys].map((k) => {
    const [row, col] = k.split(':').map(Number)
    return { row, col }
  })
  cells.sort((a, b) => (a.row - b.row) || (a.col - b.col))
  return cells
}

function singleCellSel(row: number, col: number): CellSelection {
  const cell = { row, col }
  return { rects: [{ r1: row, c1: col, r2: row, c2: col }], added: new Set(), removed: new Set(), anchor: cell, active: cell }
}

/**
 * Derive the legacy single-column contiguous `cellRange` from a selection, for
 * back-compat with consumers that still branch on it. Only a single, single-
 * column, multi-row rectangle (no toggles) qualifies; everything else → null
 * (single cells are covered by `focusedCell`; multi-column shapes have no
 * single-column range representation).
 */
function deriveCellRange(sel: CellSelection | null): CellRange | null {
  if (!sel || sel.rects.length !== 1 || sel.added.size > 0 || sel.removed.size > 0) return null
  const rt = sel.rects[0]
  if (rt.c1 === rt.c2 && rt.r1 !== rt.r2) {
    return { colIdx: rt.c1, startRow: rt.r1, endRow: rt.r2 }
  }
  return null
}

export function useEditCellNav(
  rowCount: number,
  visibleCols: ColumnDef[],
  scrollToRow?: (idx: number) => void,
  /**
   * Bring the column at `colIdx` into horizontal view. Used during left/right
   * arrow navigation so the focused cell stays visible. Optional — tables
   * that don't horizontally scroll can omit it.
   */
  scrollToCol?: (colIdx: number) => void,
) {
  const [selection, setSelection] = useState<CellSelection | null>(null)
  const [editCell, setEditCell] = useState<EditCell | null>(null)

  // Derived back-compat views (stable identity while `selection` is unchanged).
  const focusedCell = useMemo<EditCell | null>(
    () => (selection ? { rowIdx: selection.active.row, colIdx: selection.active.col } : null),
    [selection],
  )
  const cellRange = useMemo<CellRange | null>(() => deriveCellRange(selection), [selection])

  const handleFocusCell = useCallback((rowIdx: number, colIdx: number, shiftKey = false, metaKey = false) => {
    setEditCell(null)
    setSelection((prev) => {
      const cell: Cell = { row: rowIdx, col: colIdx }
      const k = cellKey(rowIdx, colIdx)

      // Cmd+Shift+click → add another rectangle (anchor = current active cell).
      if (metaKey && shiftKey && prev) {
        return {
          rects: [...prev.rects, normRect(prev.active, cell)],
          added: new Set(prev.added),
          removed: new Set(prev.removed),
          anchor: prev.active,
          active: cell,
        }
      }

      // Cmd+click → toggle a single cell (non-contiguous).
      if (metaKey) {
        if (!prev) return singleCellSel(rowIdx, colIdx)
        const rects = [...prev.rects]
        const added = new Set(prev.added)
        const removed = new Set(prev.removed)
        if (isCellSelected(prev, rowIdx, colIdx)) {
          // Deselect: drop from `added`, and mark `removed` if it came from a rect.
          added.delete(k)
          if (prev.rects.some((rt) => rectHas(rt, rowIdx, colIdx))) removed.add(k)
          const next: CellSelection = { rects, added, removed, anchor: cell, active: cell }
          const remaining = effectiveCells(next)
          if (remaining.length === 0) return null
          // Keep an active cell that is still selected (avoid a stray cursor highlight).
          const last = remaining[remaining.length - 1]
          next.active = { row: last.row, col: last.col }
          next.anchor = next.active
          return next
        }
        // Select.
        removed.delete(k)
        added.add(k)
        return { rects, added, removed, anchor: cell, active: cell }
      }

      // Shift+click → rectangle from the existing anchor to the clicked cell.
      if (shiftKey && prev) {
        return { rects: [normRect(prev.anchor, cell)], added: new Set(), removed: new Set(), anchor: prev.anchor, active: cell }
      }

      // Plain click → single cell.
      return singleCellSel(rowIdx, colIdx)
    })
  }, [])

  const handleStartEdit = useCallback((rowIdx: number, colIdx: number, initialChar?: string) => {
    const cell: EditCell = { rowIdx, colIdx }
    if (initialChar) cell.initialChar = initialChar
    setEditCell(cell)
    // Editing a cell that's part of a multi-cell selection PRESERVES the
    // selection (just moves the active cell), so committing the value can
    // fan out to every selected cell (bulk-fill). Otherwise collapse to one.
    setSelection((prev) => {
      if (prev && isCellSelected(prev, rowIdx, colIdx) && effectiveCells(prev).length > 1) {
        return { ...prev, active: { row: rowIdx, col: colIdx } }
      }
      return singleCellSel(rowIdx, colIdx)
    })
  }, [])

  /**
   * Three-click dropdown dispatch: if the clicked cell is already active and the
   * user isn't shift/cmd-clicking (range / multi-select), enter edit mode.
   * Otherwise focus the cell (delegating modifier handling to handleFocusCell).
   */
  const handleSelectCellClick = useCallback(
    (rowIdx: number, colIdx: number, shiftKey = false, metaKey = false) => {
      if (shiftKey || metaKey) {
        handleFocusCell(rowIdx, colIdx, shiftKey, metaKey)
        return
      }
      const isActive = focusedCell?.rowIdx === rowIdx && focusedCell?.colIdx === colIdx
      if (isActive) {
        handleStartEdit(rowIdx, colIdx)
      } else {
        handleFocusCell(rowIdx, colIdx)
      }
    },
    [focusedCell, handleStartEdit, handleFocusCell]
  )

  const handleEndEdit = useCallback((rowIdx: number, colIdx: number, advanceDir: 'down' | 'right' | null) => {
    setEditCell(null)
    if (!advanceDir) {
      // Esc from edit → keep the current selection/active cell.
      return
    }

    const editableCols = visibleCols
      .map((c, i) => ({ col: c, i }))
      .filter(({ col }) => col.editable)

    if (advanceDir === 'down') {
      const nextRow = rowIdx + 1
      if (nextRow < rowCount) {
        setSelection(singleCellSel(nextRow, colIdx))
        setEditCell({ rowIdx: nextRow, colIdx })
        scrollToRow?.(nextRow)
      }
    } else if (advanceDir === 'right') {
      const currentEditIdx = editableCols.findIndex(({ i }) => i === colIdx)
      const nextEditable = editableCols[currentEditIdx + 1]
      if (nextEditable) {
        setSelection(singleCellSel(rowIdx, nextEditable.i))
        setEditCell({ rowIdx, colIdx: nextEditable.i })
      }
    }
  }, [rowCount, visibleCols, scrollToRow])

  const clearFocus = useCallback(() => {
    setSelection(null)
    setEditCell(null)
  }, [])

  const handleArrowNav = useCallback((direction: 'up' | 'down' | 'left' | 'right', shiftKey = false) => {
    setEditCell(null)
    setSelection((prev) => {
      if (!prev) return prev
      const { active } = prev

      if (direction === 'up' || direction === 'down') {
        const delta = direction === 'down' ? 1 : -1
        const nextRow = active.row + delta
        if (nextRow < 0 || nextRow >= rowCount) return prev
        scrollToRow?.(nextRow)
        const newActive: Cell = { row: nextRow, col: active.col }
        if (shiftKey) {
          return { rects: [normRect(prev.anchor, newActive)], added: new Set(), removed: new Set(), anchor: prev.anchor, active: newActive }
        }
        return singleCellSel(nextRow, active.col)
      }

      // Left/Right — move among editable columns (same row).
      const editableCols = visibleCols
        .map((c, i) => ({ col: c, i }))
        .filter(({ col }) => col.editable)
      const currentIdx = editableCols.findIndex(({ i }) => i === active.col)
      const nextIdx = direction === 'right' ? currentIdx + 1 : currentIdx - 1
      const nextCol = editableCols[nextIdx]
      if (!nextCol) return prev
      scrollToCol?.(nextCol.i)
      const newActive: Cell = { row: active.row, col: nextCol.i }
      if (shiftKey) {
        return { rects: [normRect(prev.anchor, newActive)], added: new Set(), removed: new Set(), anchor: prev.anchor, active: newActive }
      }
      return singleCellSel(active.row, nextCol.i)
    })
  }, [rowCount, visibleCols, scrollToRow, scrollToCol])

  /**
   * Dispatches a React keyboard event to the appropriate cell-nav action.
   * Returns true if handled. Arrow keys are owned by the document-level listener
   * below (so navigation works regardless of which element holds focus).
   */
  const handleKeyboardEvent = useCallback(
    (e: ReactKeyboardEvent, opts?: { suppressEscape?: boolean }): boolean => {
      if (!focusedCell || editCell) return false

      // Ignore keystrokes that originate in a form field (e.g. the column-picker
      // search box, an inline filter input). Without this, typing into such an
      // input bubbles up here and starts type-to-edit on the focused cell instead
      // of going into the input. Mirrors the document-level arrow-nav guard below.
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return false
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
    [focusedCell, editCell, visibleCols, handleStartEdit, clearFocus],
  )

  /**
   * Document-level arrow-key navigation: when a cell is focused (and not in
   * edit mode), Arrow keys navigate regardless of which DOM element holds focus.
   * Skipped while editing or when a form field is the event target.
   */
  useEffect(() => {
    if (!focusedCell || editCell) return
    function onDocKeyDown(e: KeyboardEvent) {
      if (
        e.key !== 'ArrowUp' && e.key !== 'ArrowDown' &&
        e.key !== 'ArrowLeft' && e.key !== 'ArrowRight'
      ) return
      const target = e.target as HTMLElement | null
      if (target) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
        if (target.isContentEditable) return
      }
      e.preventDefault()
      const dir = e.key.replace('Arrow', '').toLowerCase() as 'up' | 'down' | 'left' | 'right'
      handleArrowNav(dir, e.shiftKey)
    }
    document.addEventListener('keydown', onDocKeyDown)
    return () => document.removeEventListener('keydown', onDocKeyDown)
  }, [focusedCell, editCell, handleArrowNav])

  return {
    selection,
    focusedCell,
    editCell,
    setEditCell,
    cellRange,
    handleFocusCell,
    handleStartEdit,
    handleSelectCellClick,
    handleEndEdit,
    handleArrowNav,
    handleKeyboardEvent,
    clearFocus,
  }
}
