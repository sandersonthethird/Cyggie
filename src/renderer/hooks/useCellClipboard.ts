/**
 * useCellClipboard — clipboard, delete, type-to-edit, and undo for table cells.
 *
 * Clipboard state machine:
 *   IDLE ──Cmd+C──▶ COPIED (dashed outline on source)
 *     │                │
 *     │             Cmd+V → paste value(s), set undoAction, clear COPIED
 *     │             Escape → clear COPIED
 *     │
 *     └──Cmd+X──▶ CUT (dashed outline + isCut flag)
 *                   │
 *                Cmd+V → paste value(s), clear source, set undoAction, clear CUT
 *
 * Undo flow:
 *   PASTE ──▶ undoAction set (7s timer)
 *             ├─▶ click Undo → revert originals
 *             ├─▶ 7s elapsed → auto-dismiss
 *             ├─▶ dismiss click → clear
 *             └─▶ new paste → old undo cleared
 *
 * Keyboard handlers (all guarded: activeElement must NOT be input/select/textarea):
 *   Cmd+C         → copy single cell or column range
 *   Cmd+X         → copy + set isCut
 *   Cmd+V         → paste to cellRange > selectedIds > single focusedCell
 *   Delete/Bksp   → clear cell(s)
 *   Escape        → clear copied state
 *   Printable key → type-to-edit (enter edit mode with the pressed char)
 */
import { useState, useCallback, useRef } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'
import { executeBulkEdit } from '../components/crm/tableUtils'
import type { EditCell, CellRange } from './useEditCellNav'

interface UndoAction {
  col: ColumnDef
  originals: { id: string; value: string | null }[]
  count: number
}

export interface CellClipboardOpts<T extends { id: string }> {
  rows: T[]
  visibleCols: ColumnDef[]
  focusedCell: EditCell | null
  editCell: EditCell | null
  cellRange: CellRange | null
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
  isCut: boolean
  clipboardToast: string | null
  undoAction: UndoAction | null
  handleClipboardKeyDown: (e: React.KeyboardEvent) => void
  handleUndo: () => Promise<void>
  dismissUndo: () => void
}

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
}

function isPrintableKey(e: React.KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  // Single character keys (letters, numbers, symbols)
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

export function useCellClipboard<T extends { id: string }>(
  opts: CellClipboardOpts<T>
): CellClipboardReturn {
  const {
    rows,
    visibleCols,
    focusedCell,
    editCell,
    cellRange,
    selectedIds,
    getCellValue,
    saveCellValue,
    onStartEdit,
    onClearTableUndo,
  } = opts

  const [copiedCell, setCopiedCell] = useState<EditCell | null>(null)
  const [copiedRange, setCopiedRange] = useState<CellRange | null>(null)
  const [isCut, setIsCut] = useState(false)
  const [clipboardToast, setClipboardToast] = useState<string | null>(null)
  const [undoAction, setUndoAction] = useState<UndoAction | null>(null)

  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Keep refs for async operations
  const rowsRef = useRef(rows)
  rowsRef.current = rows

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

  // ── Copy ─────────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async (cut: boolean) => {
    const col = cellRange
      ? visibleCols[cellRange.colIdx]
      : focusedCell
        ? visibleCols[focusedCell.colIdx]
        : null
    if (!col) return

    let text: string
    if (cellRange) {
      // Copy all values in the column range, newline-separated
      const values: string[] = []
      for (let r = cellRange.startRow; r <= cellRange.endRow; r++) {
        const row = rows[r]
        if (row) values.push(getCellValue(row, col) ?? '')
      }
      text = values.join('\n')
      setCopiedRange(cellRange)
      setCopiedCell(null)
    } else if (focusedCell) {
      const row = rows[focusedCell.rowIdx]
      text = row ? (getCellValue(row, col) ?? '') : ''
      setCopiedCell(focusedCell)
      setCopiedRange(null)
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
  }, [cellRange, focusedCell, rows, visibleCols, getCellValue, showToast])

  // ── Paste ────────────────────────────────────────────────────────────────────

  const handlePaste = useCallback(async () => {
    const col = cellRange
      ? visibleCols[cellRange.colIdx]
      : focusedCell
        ? visibleCols[focusedCell.colIdx]
        : null
    if (!col) return

    let text: string
    try {
      text = await navigator.clipboard.readText()
    } catch {
      showToast('Paste failed — clipboard access denied')
      return
    }

    // Validate
    const error = validatePaste(col, text)
    if (error) {
      showToast(error)
      return
    }

    const pasteValue = text.trim() === '' ? null : text.trim()

    // Clear any existing table undo
    onClearTableUndo?.()
    dismissUndo()

    // Determine target rows
    let targetRowIndices: number[]
    if (cellRange) {
      targetRowIndices = []
      for (let r = cellRange.startRow; r <= cellRange.endRow; r++) {
        targetRowIndices.push(r)
      }
    } else if (focusedCell && selectedIds.size > 1 && selectedIds.has(rows[focusedCell.rowIdx]?.id)) {
      // Paste to all selected rows
      targetRowIndices = rows
        .map((_, i) => i)
        .filter((i) => selectedIds.has(rows[i].id))
    } else if (focusedCell) {
      targetRowIndices = [focusedCell.rowIdx]
    } else {
      return
    }

    // Capture originals for undo
    const originals = targetRowIndices.map((i) => {
      const row = rows[i]
      return { id: row.id, value: getCellValue(row, col) }
    })

    if (targetRowIndices.length === 1) {
      // Single cell paste
      const row = rows[targetRowIndices[0]]
      try {
        await saveCellValue(row, col, pasteValue)
        setUndoWithTimer({ col, originals, count: 1 })
        showToast('Pasted')
      } catch {
        showToast('Paste failed')
      }
    } else {
      // Bulk paste
      const ids = targetRowIndices.map((i) => rows[i].id)
      const originalsMap = new Map(originals.map((o) => [o.id, o.value]))

      // Optimistic patch — saveCellValue handles individual patches
      for (const i of targetRowIndices) {
        const row = rows[i]
        // Fire-and-forget optimistic patch happens inside saveCellValue
      }

      const { failedIds } = await executeBulkEdit({
        ids,
        getOriginalValue: (id) => originalsMap.get(id) ?? null,
        updateFn: async (id) => {
          const row = rowsRef.current.find((r) => r.id === id)
          if (row) await saveCellValue(row, col, pasteValue)
        },
        onPatch: () => {
          // saveCellValue already handles patching internally
        },
      })

      const succeeded = ids.length - failedIds.length
      if (failedIds.length > 0) {
        showToast(`${failedIds.length} of ${ids.length} updates failed`)
      } else {
        showToast(`Pasted to ${succeeded} cells`)
      }
      setUndoWithTimer({
        col,
        originals: originals.filter((o) => !failedIds.includes(o.id)),
        count: succeeded,
      })
    }

    // If cut, clear source cell(s)
    if (isCut) {
      if (copiedRange) {
        for (let r = copiedRange.startRow; r <= copiedRange.endRow; r++) {
          const row = rowsRef.current[r]
          if (row) {
            try { await saveCellValue(row, col, null) } catch { /* best effort */ }
          }
        }
      } else if (copiedCell) {
        const sourceRow = rowsRef.current[copiedCell.rowIdx]
        const sourceCol = visibleCols[copiedCell.colIdx]
        if (sourceRow && sourceCol) {
          try { await saveCellValue(sourceRow, sourceCol, null) } catch { /* best effort */ }
        }
      }
    }

    // Clear copied state
    setCopiedCell(null)
    setCopiedRange(null)
    setIsCut(false)
  }, [
    cellRange, focusedCell, selectedIds, rows, visibleCols,
    getCellValue, saveCellValue, showToast, dismissUndo, onClearTableUndo,
    setUndoWithTimer, isCut, copiedCell, copiedRange,
  ])

  // ── Delete ───────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    const col = cellRange
      ? visibleCols[cellRange.colIdx]
      : focusedCell
        ? visibleCols[focusedCell.colIdx]
        : null
    if (!col || !col.editable || col.type === 'computed') return

    if (cellRange) {
      for (let r = cellRange.startRow; r <= cellRange.endRow; r++) {
        const row = rows[r]
        if (row) {
          try { await saveCellValue(row, col, null) } catch { /* best effort */ }
        }
      }
      showToast(`Cleared ${cellRange.endRow - cellRange.startRow + 1} cells`)
    } else if (focusedCell) {
      const row = rows[focusedCell.rowIdx]
      if (row) {
        try {
          await saveCellValue(row, col, null)
          showToast('Cleared')
        } catch {
          showToast('Clear failed')
        }
      }
    }
  }, [cellRange, focusedCell, rows, visibleCols, saveCellValue, showToast])

  // ── Undo ─────────────────────────────────────────────────────────────────────

  const handleUndo = useCallback(async () => {
    if (!undoAction) return
    const { col, originals } = undoAction
    dismissUndo()

    for (const { id, value } of originals) {
      const row = rowsRef.current.find((r) => r.id === id)
      if (row) {
        try { await saveCellValue(row, col, value) } catch { /* best effort */ }
      }
    }
    showToast('Undone')
  }, [undoAction, saveCellValue, showToast, dismissUndo])

  // ── Keyboard handler ─────────────────────────────────────────────────────────

  const handleClipboardKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Don't intercept when an input is focused (edit mode) — let browser handle
    if (isInputFocused()) return
    // Don't intercept when in edit mode
    if (editCell) return

    const isMod = e.metaKey || e.ctrlKey

    // Cmd+C / Cmd+X
    if (isMod && (e.key === 'c' || e.key === 'x') && (focusedCell || cellRange)) {
      e.preventDefault()
      void handleCopy(e.key === 'x')
      return
    }

    // Cmd+V
    if (isMod && e.key === 'v' && (focusedCell || cellRange)) {
      e.preventDefault()
      void handlePaste()
      return
    }

    // Cmd+Z — undo
    if (isMod && e.key === 'z' && undoAction) {
      e.preventDefault()
      void handleUndo()
      return
    }

    // Delete / Backspace
    if ((e.key === 'Delete' || e.key === 'Backspace') && (focusedCell || cellRange)) {
      e.preventDefault()
      void handleDelete()
      return
    }

    // Escape — clear copied state
    if (e.key === 'Escape' && (copiedCell || copiedRange)) {
      e.preventDefault()
      setCopiedCell(null)
      setCopiedRange(null)
      setIsCut(false)
      return
    }

    // Arrow keys for navigation (handled by useEditCellNav, but we need to pass through)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      return // Let the table's composed handler deal with this
    }

    // Type-to-edit: printable char in focused mode → enter edit with that char
    if (focusedCell && !cellRange && isPrintableKey(e)) {
      const col = visibleCols[focusedCell.colIdx]
      if (col?.editable && col.type !== 'computed') {
        e.preventDefault()
        onStartEdit(focusedCell.rowIdx, focusedCell.colIdx, e.key)
      }
    }
  }, [
    editCell, focusedCell, cellRange, visibleCols,
    handleCopy, handlePaste, handleDelete, handleUndo,
    onStartEdit, undoAction, copiedCell, copiedRange,
  ])

  return {
    copiedCell,
    copiedRange,
    isCut,
    clipboardToast,
    undoAction,
    handleClipboardKeyDown,
    handleUndo,
    dismissUndo,
  }
}
