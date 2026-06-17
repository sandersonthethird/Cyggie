import { useMemo } from 'react'
import { selectionRowIndices, type CellSelection } from './useEditCellNav'

/**
 * Union of the two row-selection sources that feed the bulk-action bar:
 *   - explicit row-checkbox selection (`selectedIds`), and
 *   - the rows covered by the spreadsheet cell selection (`selection`).
 *
 *   checkbox rows ─┐
 *                  ├─▶ Set<rowId>  ──▶ bulk-action bar gate / count / handlers
 *   cell-sel rows ─┘
 *
 * `if (row)` guards stale indices: the cell selection stores row *indices*, which
 * can fall out of range after the row list shrinks (filter/delete) before the
 * selection is cleared — skip those rather than emit `undefined` ids.
 */
export function useBulkRowIds<T extends { id: string }>(
  selectedIds: Set<string>,
  selection: CellSelection | null,
  rows: T[],
): Set<string> {
  return useMemo(() => {
    const ids = new Set(selectedIds)
    for (const r of selectionRowIndices(selection)) {
      const row = rows[r]
      if (row) ids.add(row.id)
    }
    return ids
  }, [selectedIds, selection, rows])
}
