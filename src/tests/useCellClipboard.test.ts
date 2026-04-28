// @vitest-environment jsdom
/**
 * Tests for useCellClipboard hook — copy, paste, cut, delete, type-to-edit, undo.
 *
 * Navigator.clipboard is mocked since jsdom doesn't provide it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCellClipboard } from '../renderer/hooks/useCellClipboard'
import type { CellClipboardOpts } from '../renderer/hooks/useCellClipboard'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'
import type { EditCell, CellRange } from '../renderer/hooks/useEditCellNav'

// ── Mocks ────────────────────────────────────────────────────────────────────

let clipboardText = ''
const mockClipboard = {
  writeText: vi.fn(async (text: string) => { clipboardText = text }),
  readText: vi.fn(async () => clipboardText),
}
Object.defineProperty(navigator, 'clipboard', { value: mockClipboard, writable: true })

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TestRow { id: string; col1: string | null; col2: string | null }

const textCol: ColumnDef = {
  key: 'col1', label: 'Col 1', field: 'col1', defaultVisible: true,
  width: 100, minWidth: 60, sortable: true, editable: true, type: 'text',
}

const selectCol: ColumnDef = {
  key: 'col2', label: 'Col 2', field: 'col2', defaultVisible: true,
  width: 100, minWidth: 60, sortable: true, editable: true, type: 'select',
  options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
}

const numberCol: ColumnDef = {
  key: 'col3', label: 'Col 3', field: 'col3', defaultVisible: true,
  width: 100, minWidth: 60, sortable: true, editable: true, type: 'number',
}

const computedCol: ColumnDef = {
  key: 'col4', label: 'Col 4', field: null, defaultVisible: true,
  width: 100, minWidth: 60, sortable: false, editable: false, type: 'computed',
}

const rows: TestRow[] = [
  { id: '1', col1: 'hello', col2: 'a' },
  { id: '2', col1: 'world', col2: 'b' },
  { id: '3', col1: 'foo', col2: null },
]

const visibleCols = [textCol, selectCol, numberCol, computedCol]

function makeOpts(overrides: Partial<CellClipboardOpts<TestRow>> = {}): CellClipboardOpts<TestRow> {
  return {
    rows,
    visibleCols,
    focusedCell: null,
    editCell: null,
    cellRange: null,
    selectedIds: new Set(),
    getCellValue: (item, col) => {
      if (col.field) return (item as Record<string, unknown>)[col.field] as string | null
      return null
    },
    saveCellValue: vi.fn(async () => {}),
    onStartEdit: vi.fn(),
    ...overrides,
  }
}

function makeKeyEvent(key: string, opts: Partial<React.KeyboardEvent> = {}): React.KeyboardEvent {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...opts,
  } as unknown as React.KeyboardEvent
}

describe('useCellClipboard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clipboardText = ''
    mockClipboard.writeText.mockClear()
    mockClipboard.readText.mockClear()
    // Ensure document.activeElement is body (not an input)
    if (document.activeElement !== document.body) {
      (document.activeElement as HTMLElement)?.blur()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Copy ─────────────────────────────────────────────────────────────────

  describe('copy', () => {
    it('C1: Cmd+C copies focused cell value to clipboard', async () => {
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(mockClipboard.writeText).toHaveBeenCalledWith('hello')
      expect(result.current.copiedCell).toEqual({ rowIdx: 0, colIdx: 0 })
      expect(result.current.clipboardToast).toBe('Copied')
    })

    it('copies empty string when cell value is null', async () => {
      const opts = makeOpts({ focusedCell: { rowIdx: 2, colIdx: 1 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(mockClipboard.writeText).toHaveBeenCalledWith('')
    })

    it('C2: Cmd+C with cellRange copies all values newline-separated', async () => {
      const range: CellRange = { colIdx: 0, startRow: 0, endRow: 2 }
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 }, cellRange: range })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(mockClipboard.writeText).toHaveBeenCalledWith('hello\nworld\nfoo')
      expect(result.current.copiedRange).toEqual(range)
    })

    it('does nothing when no cell is focused', async () => {
      const opts = makeOpts({ focusedCell: null })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(mockClipboard.writeText).not.toHaveBeenCalled()
    })

    it('C8: does not intercept when editCell is set', async () => {
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        editCell: { rowIdx: 0, colIdx: 0 },
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(mockClipboard.writeText).not.toHaveBeenCalled()
    })
  })

  // ── Cut ──────────────────────────────────────────────────────────────────

  describe('cut', () => {
    it('C3: Cmd+X sets isCut flag', async () => {
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('x', { metaKey: true }))
      })

      expect(mockClipboard.writeText).toHaveBeenCalledWith('hello')
      expect(result.current.isCut).toBe(true)
      expect(result.current.clipboardToast).toBe('Cut')
    })
  })

  // ── Paste ────────────────────────────────────────────────────────────────

  describe('paste', () => {
    it('C4: Cmd+V pastes to single cell', async () => {
      clipboardText = 'pasted'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 1, colIdx: 0 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).toHaveBeenCalledWith(rows[1], textCol, 'pasted')
      expect(result.current.clipboardToast).toBe('Pasted')
    })

    it('V4: paste empty string saves null', async () => {
      clipboardText = '   '
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).toHaveBeenCalledWith(rows[0], textCol, null)
    })
  })

  // ── Validation ───────────────────────────────────────────────────────────

  describe('validation', () => {
    it('V1: rejects paste into non-editable column', async () => {
      clipboardText = 'test'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 3 }, // computedCol
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).not.toHaveBeenCalled()
      expect(result.current.clipboardToast).toBe('Cannot paste into this column')
    })

    it('V2: rejects paste into select with invalid option', async () => {
      clipboardText = 'invalid_option'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 1 }, // selectCol
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).not.toHaveBeenCalled()
      expect(result.current.clipboardToast).toBe('Invalid option for Col 2')
    })

    it('V3: rejects non-numeric paste into number column', async () => {
      clipboardText = 'not-a-number'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 2 }, // numberCol
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).not.toHaveBeenCalled()
      expect(result.current.clipboardToast).toBe('Invalid number')
    })

    it('valid select option pastes successfully', async () => {
      clipboardText = 'a'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 1 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(saveCellValue).toHaveBeenCalledWith(rows[0], selectCol, 'a')
    })
  })

  // ── Delete ───────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('D1: Delete clears focused cell', async () => {
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('Delete'))
      })

      expect(saveCellValue).toHaveBeenCalledWith(rows[0], textCol, null)
    })

    it('D2: Delete clears all cells in range', async () => {
      const saveCellValue = vi.fn(async () => {})
      const range: CellRange = { colIdx: 0, startRow: 0, endRow: 2 }
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        cellRange: range,
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('Delete'))
      })

      expect(saveCellValue).toHaveBeenCalledTimes(3)
      expect(saveCellValue).toHaveBeenCalledWith(rows[0], textCol, null)
      expect(saveCellValue).toHaveBeenCalledWith(rows[1], textCol, null)
      expect(saveCellValue).toHaveBeenCalledWith(rows[2], textCol, null)
    })

    it('does not delete non-editable column', async () => {
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 3 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('Delete'))
      })

      expect(saveCellValue).not.toHaveBeenCalled()
    })
  })

  // ── Type-to-edit ─────────────────────────────────────────────────────────

  describe('type-to-edit', () => {
    it('T1: printable char triggers onStartEdit with initialChar', () => {
      const onStartEdit = vi.fn()
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        onStartEdit,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      act(() => {
        result.current.handleClipboardKeyDown(makeKeyEvent('a'))
      })

      expect(onStartEdit).toHaveBeenCalledWith(0, 0, 'a')
    })

    it('does not trigger for non-editable columns', () => {
      const onStartEdit = vi.fn()
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 3 },
        onStartEdit,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      act(() => {
        result.current.handleClipboardKeyDown(makeKeyEvent('a'))
      })

      expect(onStartEdit).not.toHaveBeenCalled()
    })

    it('does not trigger when cellRange is active', () => {
      const onStartEdit = vi.fn()
      const range: CellRange = { colIdx: 0, startRow: 0, endRow: 2 }
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        cellRange: range,
        onStartEdit,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      act(() => {
        result.current.handleClipboardKeyDown(makeKeyEvent('a'))
      })

      expect(onStartEdit).not.toHaveBeenCalled()
    })
  })

  // ── Undo ─────────────────────────────────────────────────────────────────

  describe('undo', () => {
    it('U1: undo reverts pasted values', async () => {
      clipboardText = 'pasted'
      const saveCellValue = vi.fn(async () => {})
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
        saveCellValue,
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      // Paste
      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(result.current.undoAction).not.toBeNull()
      saveCellValue.mockClear()

      // Undo
      await act(async () => {
        await result.current.handleUndo()
      })

      // Should have called saveCellValue with the original value
      expect(saveCellValue).toHaveBeenCalledWith(rows[0], textCol, 'hello')
      expect(result.current.undoAction).toBeNull()
    })

    it('U2: undo auto-dismisses after 7s', async () => {
      clipboardText = 'pasted'
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(result.current.undoAction).not.toBeNull()

      act(() => { vi.advanceTimersByTime(7000) })

      expect(result.current.undoAction).toBeNull()
    })

    it('U3: dismiss clears undo', async () => {
      clipboardText = 'pasted'
      const opts = makeOpts({
        focusedCell: { rowIdx: 0, colIdx: 0 },
      })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      act(() => result.current.dismissUndo())
      expect(result.current.undoAction).toBeNull()
    })
  })

  // ── Escape ───────────────────────────────────────────────────────────────

  describe('escape', () => {
    it('Escape clears copiedCell', async () => {
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      // Copy first
      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })
      expect(result.current.copiedCell).not.toBeNull()

      // Escape
      act(() => {
        result.current.handleClipboardKeyDown(makeKeyEvent('Escape'))
      })
      expect(result.current.copiedCell).toBeNull()
    })
  })

  // ── Toast ────────────────────────────────────────────────────────────────

  describe('toast', () => {
    it('toast auto-clears after 2s', async () => {
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })
      expect(result.current.clipboardToast).toBe('Copied')

      act(() => { vi.advanceTimersByTime(2000) })
      expect(result.current.clipboardToast).toBeNull()
    })
  })

  // ── Error handling ───────────────────────────────────────────────────────

  describe('errors', () => {
    it('E1: clipboard.writeText failure shows toast', async () => {
      mockClipboard.writeText.mockRejectedValueOnce(new Error('denied'))
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('c', { metaKey: true }))
      })

      expect(result.current.clipboardToast).toBe('Copy failed')
    })

    it('E2: clipboard.readText failure shows toast', async () => {
      mockClipboard.readText.mockRejectedValueOnce(new Error('denied'))
      const opts = makeOpts({ focusedCell: { rowIdx: 0, colIdx: 0 } })
      const { result } = renderHook(() => useCellClipboard(opts))

      await act(async () => {
        result.current.handleClipboardKeyDown(makeKeyEvent('v', { metaKey: true }))
      })

      expect(result.current.clipboardToast).toBe('Paste failed — clipboard access denied')
    })
  })
})
