/**
 * useCellClipboard — clipboard, delete, type-to-edit, bulk-fill, and undo for
 * table cells, over a spreadsheet-style multi-cell `selection`.
 *
 * All write operations funnel through one helper, `applyValueToCells`, which
 * validates per cell, writes concurrently, captures originals for undo, and
 * reports partial failures. Copy/paste/delete and bulk-fill-on-commit all use it.
 *
 * Input normalization (preferring the unified selection, with back-compat):
 *   selection (>1 effective cell) → those cells (the grid path)
 *   cellRange                     → the column range
 *   focusedCell + selectedIds>1   → that column across the checkbox-selected rows
 *   focusedCell                   → the single cell
 *
 * Clipboard state machine:
 *   IDLE ──Cmd+C──▶ COPIED (dashed outline) ──Cmd+V──▶ paste + undo, clear COPIED
 *     └──Cmd+X──▶ CUT ──Cmd+V──▶ paste, clear source, undo, clear CUT
 *
 * Undo (7s window): a single action restores every (row, col) it touched.
 */
import { useState, useCallback, useRef } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'
import type { EditCell, CellRange, CellSelection, Cell } from './useEditCellNav'
import { effectiveCells } from './useEditCellNav'

interface CellOriginal {
  rowId: string
  colIdx: number
  value: string | null
}

interface UndoAction {
  originals: CellOriginal[]
  count: number
  /** Verb shown in the undo toast, e.g. "Pasted", "Cleared", "Filled". */
  label: string
}

export interface CellClipboardOpts<T extends { id: string }> {
  rows: T[]
  visibleCols: ColumnDef[]
  focusedCell: EditCell | null
  editCell: EditCell | null
  cellRange: CellRange | null
  /** Unified multi-cell selection (preferred input when present). */
  selection?: CellSelection | null
  selectedIds: Set<string>
  getCellValue: (item: T, col: ColumnDef) => string | null
  saveCellValue: (item: T, col: ColumnDef, value: string | null) => Promise<void>
  onStartEdit: (rowIdx: number, colIdx: number, initialChar?: string) => void
  /** Called when clipboard paste sets its own undo, so the table can clear its existing undo. */
  onClearTableUndo?: () => void
}

export interface CellClipboardReturn {
  copiedCell: EditCell | null
  copiedRange: CellRange | null
  /** Snapshot of a copied multi-cell selection (for the dashed outline). */
  copiedCells: Cell[] | null
  isCut: boolean
  clipboardToast: string | null
  undoAction: UndoAction | null
  handleClipboardKeyDown: (e: React.KeyboardEvent) => void
  handleUndo: () => Promise<void>
  dismissUndo: () => void
  /** Bulk-fill: write `value` to every selected cell in column `colIdx`. */
  fillSelection: (colIdx: number, value: string | null) => Promise<void>
}

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

function isPrintableKey(e: React.KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return e.key.length === 1
}

function validatePaste(col: ColumnDef, text: string): string | null {
  if (!col.editable || col.type === 'computed') {
    return 'Cannot paste into this column'
  }
  if (col.type === 'select' && text !== '') {
    const valid = col.options?.some((o) => o.value === text)
    if (!valid) return `Invalid option for ${col.label}`
  }
  if (col.type === 'number' && text !== '') {
    if (isNaN(parseFloat(text))) return 'Invalid number'
  }
  return null
}

/** Build a Sheets-compatible TSV grid over the bounding box of `cells` (gaps = ""). */
function buildTsv<T extends { id: string }>(
  cells: Cell[],
  rows: T[],
  visibleCols: ColumnDef[],
  getCellValue: (item: T, col: ColumnDef) => string | null,
): string {
  const minR = Math.min(...cells.map((c) => c.row))
  const maxR = Math.max(...cells.map((c) => c.row))
  const minC = Math.min(...cells.map((c) => c.col))
  const maxC = Math.max(...cells.map((c) => c.col))
  const selected = new Set(cells.map((c) => `${c.row}:${c.col}`))
  const lines: string[] = []
  for (let r = minR; r <= maxR; r++) {
    const cols: string[] = []
    for (let c = minC; c <= maxC; c++) {
      if (selected.has(`${r}:${c}`)) {
        const row = rows[r]
        const col = visibleCols[c]
        cols.push(row && col ? (getCellValue(row, col) ?? '') : '')
      } else {
        cols.push('')
      }
    }
    lines.push(cols.join('\t'))
  }
  return lines.join('\n')
}

export function useCellClipboard<T extends { id: string }>(
  opts: CellClipboardOpts<T>
): CellClipboardReturn {
  const {
    rows,
    visibleCols,
    focusedCell,
    editCell,
    cellRange,
    selection,
    selectedIds,
    getCellValue,
    saveCellValue,
    onStartEdit,
    onClearTableUndo,
  } = opts

  const [copiedCell, setCopiedCell] = useState<EditCell | null>(null)
  const [copiedRange, setCopiedRange] = useState<CellRange | null>(null)
  const [copiedCells, setCopiedCells] = useState<Cell[] | null>(null)
  const [isCut, setIsCut] = useState(false)
  const [clipboardToast, setClipboardToast] = useState<string | null>(null)
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null)

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const colsRef = useRef(visibleCols)
  colsRef.current = visibleCols

  const showToast = useCallback((msg: string) => {
    clearTimeout(toastTimerRef.current)
    setClipboardToast(msg)
    toastTimerRef.current = setTimeout(() => setClipboardToast(null), 2000)
  }, [])

  const setUndoWithTimer = useCallback((action: UndoAction) => {
    clearTimeout(undoTimerRef.current)
    setUndoAction(action)
    undoTimerRef.current = setTimeout(() => setUndoAction(null), 7000)
  }, [])

  const dismissUndo = useCallback(() => {
    clearTimeout(undoTimerRef.current)
    setUndoAction(null)
  }, [])

  // ── Shared write helper ────────────────────────────────────────────────────
  // Applies `value` (null = clear) to every cell: validates per column, writes
  // concurrently, captures originals for undo, reports skips/failures, and shows
  // a single contextual toast. Used by paste, delete-all, and bulk-fill.
  const writeAndRegister = useCallback(
    async (cells: Cell[], value: string | null, verb: string): Promise<void> => {
      const curRows = rowsRef.current
      const curCols = colsRef.current
      let skipped = 0
      let firstError: string | null = null
      const writable: Array<{ row: T; col: ColumnDef; colIdx: number }> = []
      for (const cell of cells) {
        const row = curRows[cell.row]
        const col = curCols[cell.col]
        if (!row || !col) continue
        const err = value === null
          ? (!col.editable || col.type === 'computed' ? 'Cannot paste into this column' : null)
          : validatePaste(col, value)
        if (err) { skipped++; if (!firstError) firstError = err; continue }
        writable.push({ row, col, colIdx: cell.col })
      }

      // Single-cell precise UX: surface the exact validation error, no toast clutter.
      if (cells.length === 1 && writable.length === 0) {
        if (firstError) showToast(firstError)
        return
      }
      if (writable.length === 0) {
        showToast(`Nothing to ${verb.toLowerCase()} — ${skipped} read-only cell${skipped !== 1 ? 's' : ''} skipped`)
        return
      }

      const originals: CellOriginal[] = writable.map((w) => ({
        rowId: w.row.id, colIdx: w.colIdx, value: getCellValue(w.row, w.col),
      }))
      const results = await Promise.allSettled(writable.map((w) => saveCellValue(w.row, w.col, value)))
      const okOriginals = originals.filter((_, i) => results[i].status === 'fulfilled')
      const failed = results.length - okOriginals.length

      if (okOriginals.length > 0) {
        onClearTableUndo?.()
        dismissUndo()
        setUndoWithTimer({ originals: okOriginals, count: okOriginals.length, label: verb })
      }

      const parts: string[] = []
      if (cells.length === 1 && okOriginals.length === 1 && failed === 0 && skipped === 0) {
        showToast(verb) // "Pasted" / "Cleared" — keep the crisp single-cell toast
        return
      }
      parts.push(`${verb} ${okOriginals.length} cell${okOriginals.length !== 1 ? 's' : ''}`)
      if (skipped > 0) parts.push(`${skipped} skipped`)
      if (failed > 0) parts.push(`${failed} failed`)
      showToast(parts.join(' · '))
    },
    [getCellValue, saveCellValue, showToast, dismissUndo, setUndoWithTimer, onClearTableUndo],
  )

  // ── Input normalization ────────────────────────────────────────────────────
  // Resolve the cells an operation targets. Prefers the unified `selection`.
  const resolveCells = useCallback((): Cell[] => {
    const selCells = effectiveCells(selection ?? null)
    if (selCells.length > 1) return selCells
    if (cellRange) {
      const cells: Cell[] = []
      for (let r = cellRange.startRow; r <= cellRange.endRow; r++) cells.push({ row: r, col: cellRange.colIdx })
      return cells
    }
    if (focusedCell && selectedIds.size > 1 && selectedIds.has(rows[focusedCell.rowIdx]?.id)) {
      return rows
        .map((_, i) => i)
        .filter((i) => selectedIds.has(rows[i].id))
        .map((i) => ({ row: i, col: focusedCell.colIdx }))
    }
    if (focusedCell) return [{ row: focusedCell.rowIdx, col: focusedCell.colIdx }]
    return []
  }, [selection, cellRange, focusedCell, selectedIds, rows])

  // ── Copy ───────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async (cut: boolean) => {
    const selCells = effectiveCells(selection ?? null)

    let text: string
    if (selCells.length > 1) {
      // Multi-cell → Sheets-compatible TSV grid (bounding box, gaps = "").
      text = buildTsv(selCells, rows, visibleCols, getCellValue)
      setCopiedCells(selCells)
      setCopiedCell(null)
      setCopiedRange(null)
    } else if (cellRange) {
      const col = visibleCols[cellRange.colIdx]
      const values: string[] = []
      for (let r = cellRange.startRow; r <= cellRange.endRow; r++) {
        const row = rows[r]
        if (row) values.push(getCellValue(row, col) ?? '')
      }
      text = values.join('\n')
      setCopiedRange(cellRange)
      setCopiedCell(null)
      setCopiedCells(null)
    } else if (focusedCell) {
      const col = visibleCols[focusedCell.colIdx]
      const row = rows[focusedCell.rowIdx]
      text = row ? (getCellValue(row, col) ?? '') : ''
      setCopiedCell(focusedCell)
      setCopiedRange(null)
      setCopiedCells(null)
    } else {
      return
    }

    setIsCut(cut)
    try {
      await navigator.clipboard.writeText(text)
      showToast(cut ? 'Cut' : 'Copied')
    } catch {
      showToast('Copy failed')
    }
  }, [selection, cellRange, focusedCell, rows, visibleCols, getCellValue, showToast])

  // ── Paste ──────────────────────────────────────────────────────────────────

  const handlePaste = useCallback(async () => {
    const cells = resolveCells()
    if (cells.length === 0) return

    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      showToast('Paste failed — clipboard access denied')
      return
    }

    const pasteValue = text.trim() === '' ? null : text.trim()
    await writeAndRegister(cells, pasteValue, 'Pasted')

    // If cut, clear the source cell(s).
    if (isCut) {
      const srcCells = copiedCells
        ? copiedCells
        : copiedRange
          ? Array.from({ length: copiedRange.endRow - copiedRange.startRow + 1 }, (_, i) => ({ row: copiedRange.startRow + i, col: copiedRange.colIdx }))
          : copiedCell
            ? [{ row: copiedCell.rowIdx, col: copiedCell.colIdx }]
            : []
      for (const sc of srcCells) {
        const row = rowsRef.current[sc.row]
        const col = colsRef.current[sc.col]
        if (row && col) { try { await saveCellValue(row, col, null) } catch { /* best effort */ } }
      }
    }

    setCopiedCell(null)
    setCopiedRange(null)
    setCopiedCells(null)
    setIsCut(false)
  }, [resolveCells, writeAndRegister, showToast, isCut, copiedCell, copiedRange, copiedCells, saveCellValue])

  // ── Delete ─────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    const cells = resolveCells()
    if (cells.length === 0) return
    await writeAndRegister(cells, null, 'Cleared')
  }, [resolveCells, writeAndRegister])

  // ── Bulk-fill (pick once → fill all selected cells in a column) ─────────────

  const fillSelection = useCallback(async (colIdx: number, value: string | null) => {
    const cells = effectiveCells(selection ?? null).filter((c) => c.col === colIdx)
    if (cells.length <= 1) return // nothing to fan out to
    await writeAndRegister(cells, value, 'Filled')
  }, [selection, writeAndRegister])

  // ── Undo ───────────────────────────────────────────────────────────────────

  const handleUndo = useCallback(async () => {
    if (!undoAction) return
    const { originals } = undoAction
    dismissUndo()
    for (const { rowId, colIdx, value } of originals) {
      const row = rowsRef.current.find((r) => r.id === rowId)
      const col = colsRef.current[colIdx]
      if (row && col) {
        try { await saveCellValue(row, col, value) } catch { /* best effort */ }
      }
    }
    showToast('Undone')
  }, [undoAction, saveCellValue, showToast, dismissUndo])

  // ── Keyboard handler ────────────────────────────────────────────────────────

  const handleClipboardKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isInputFocused()) return
    if (editCell) return

    const isMod = e.metaKey || e.ctrlKey
    const hasSelection = !!focusedCell || !!cellRange || effectiveCells(selection ?? null).length > 0

    if (isMod && (e.key === 'c' || e.key === 'x') && hasSelection) {
      e.preventDefault()
      void handleCopy(e.key === 'x')
      return
    }

    if (isMod && e.key === 'v' && hasSelection) {
      e.preventDefault()
      void handlePaste()
      return
    }

    if (isMod && e.key === 'z' && undoAction) {
      e.preventDefault()
      void handleUndo()
      return
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
      e.preventDefault()
      void handleDelete()
      return
    }

    if (e.key === 'Escape' && (copiedCell || copiedRange || copiedCells)) {
      e.preventDefault()
      setCopiedCell(null)
      setCopiedRange(null)
      setCopiedCells(null)
      setIsCut(false)
      return
    }

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      return // Let the table's composed handler deal with this
    }

    // Type-to-edit: printable char on a single focused cell (not a multi-selection).
    const isMulti = !!cellRange || effectiveCells(selection ?? null).length > 1
    if (focusedCell && !isMulti && isPrintableKey(e)) {
      const col = visibleCols[focusedCell.colIdx]
      if (col?.editable && col.type !== 'computed') {
        e.preventDefault()
        onStartEdit(focusedCell.rowIdx, focusedCell.colIdx, e.key)
      }
    }
  }, [
    editCell, focusedCell, cellRange, selection, visibleCols,
    handleCopy, handlePaste, handleDelete, handleUndo,
    onStartEdit, undoAction, copiedCell, copiedRange, copiedCells,
  ])

  return {
    copiedCell,
    copiedRange,
    copiedCells,
    isCut,
    clipboardToast,
    undoAction,
    handleClipboardKeyDown,
    handleUndo,
    dismissUndo,
    fillSelection,
  }
}
