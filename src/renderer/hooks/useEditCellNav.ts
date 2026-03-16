/**
 * useEditCellNav — shared hook for inline edit keyboard navigation.
 *
 * Manages editCell state and Tab (right) / Enter (down) advance logic.
 * Optional scrollToRow callback is called when advancing to a new row (down).
 *
 * Data flow:
 *   handleStartEdit(rowIdx, colIdx) ──► editCell = { rowIdx, colIdx }
 *   handleEndEdit(dir='right')      ──► advance to next editable col in same row
 *   handleEndEdit(dir='down')       ──► advance to same col in next row + scrollToRow
 *   handleEndEdit(dir=null)         ──► clear editCell
 */
import { useState, useCallback } from 'react'
import type { ColumnDef } from '../components/crm/tableUtils'

export interface EditCell {
  rowIdx: number
  colIdx: number
}

export function useEditCellNav(
  rowCount: number,
  visibleCols: ColumnDef[],
  scrollToRow?: (idx: number) => void
): {
  editCell: EditCell | null
  setEditCell: React.Dispatch<React.SetStateAction<EditCell | null>>
  handleStartEdit: (rowIdx: number, colIdx: number) => void
  handleEndEdit: (rowIdx: number, colIdx: number, advanceDir: 'down' | 'right' | null) => void
} {
  const [editCell, setEditCell] = useState<EditCell | null>(null)

  const handleStartEdit = useCallback((rowIdx: number, colIdx: number) => {
    setEditCell({ rowIdx, colIdx })
  }, [])

  const handleEndEdit = useCallback((rowIdx: number, colIdx: number, advanceDir: 'down' | 'right' | null) => {
    setEditCell(null)
    if (!advanceDir) return

    const editableCols = visibleCols
      .map((c, i) => ({ col: c, i }))
      .filter(({ col }) => col.editable)

    if (advanceDir === 'down') {
      const nextRow = rowIdx + 1
      if (nextRow < rowCount) {
        setEditCell({ rowIdx: nextRow, colIdx })
        scrollToRow?.(nextRow)
      }
    } else if (advanceDir === 'right') {
      const currentEditIdx = editableCols.findIndex(({ i }) => i === colIdx)
      const nextEditable = editableCols[currentEditIdx + 1]
      if (nextEditable) {
        setEditCell({ rowIdx, colIdx: nextEditable.i })
      }
    }
  }, [rowCount, visibleCols, scrollToRow])

  return { editCell, setEditCell, handleStartEdit, handleEndEdit }
}
