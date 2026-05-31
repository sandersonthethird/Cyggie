// @vitest-environment jsdom
/**
 * Tests for useEditCellNav hook — focus, edit, arrow nav, cell range.
 *
 * State machine under test:
 *   IDLE ──click──▶ FOCUSED ──dbl-click/Enter──▶ EDIT ──save──▶ FOCUSED
 *     ▲                │  ▲                         │
 *     └── click out ───┘  └──────── Esc ────────────┘
 *     └── Esc ─────────┘
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEditCellNav, getRangePosition } from '../renderer/hooks/useEditCellNav'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'

const makeCols = (count: number, editable = true): ColumnDef[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `col${i}`,
    label: `Col ${i}`,
    field: `col${i}`,
    defaultVisible: true,
    width: 100,
    minWidth: 60,
    sortable: true,
    editable: i > 0 ? editable : false, // col0 is name (not editable)
    type: 'text' as const,
  }))

// ── getRangePosition unit tests ──────────────────────────────────────────────

describe('getRangePosition', () => {
  it('returns null when not in any range or cell', () => {
    expect(getRangePosition(5, 1, null, null)).toBeNull()
  })

  it('returns "only" for a single focused cell', () => {
    expect(getRangePosition(2, 1, null, { rowIdx: 2, colIdx: 1 })).toBe('only')
  })

  it('returns null for wrong column on single cell', () => {
    expect(getRangePosition(2, 3, null, { rowIdx: 2, colIdx: 1 })).toBeNull()
  })

  it('returns "only" for a single-row range', () => {
    expect(getRangePosition(2, 1, { colIdx: 1, startRow: 2, endRow: 2 }, null)).toBe('only')
  })

  it('returns "top" for first row of multi-row range', () => {
    expect(getRangePosition(2, 1, { colIdx: 1, startRow: 2, endRow: 5 }, null)).toBe('top')
  })

  it('returns "mid" for middle row of multi-row range', () => {
    expect(getRangePosition(3, 1, { colIdx: 1, startRow: 2, endRow: 5 }, null)).toBe('mid')
  })

  it('returns "bot" for last row of multi-row range', () => {
    expect(getRangePosition(5, 1, { colIdx: 1, startRow: 2, endRow: 5 }, null)).toBe('bot')
  })

  it('returns null for wrong column in range', () => {
    expect(getRangePosition(3, 2, { colIdx: 1, startRow: 2, endRow: 5 }, null)).toBeNull()
  })

  it('range takes precedence over single cell', () => {
    expect(getRangePosition(2, 1, { colIdx: 1, startRow: 2, endRow: 4 }, { rowIdx: 2, colIdx: 1 })).toBe('top')
  })
})

// ── useEditCellNav hook tests ───────────────────────────────────────────────

describe('useEditCellNav', () => {
  const cols = makeCols(5)
  const scrollToRow = vi.fn()
  const scrollToCol = vi.fn()

  function setup(rowCount = 10) {
    return renderHook(() => useEditCellNav(rowCount, cols, scrollToRow, scrollToCol))
  }

  afterEach(() => { scrollToRow.mockClear(); scrollToCol.mockClear() })

  // ── Focus ─────────────────────────────────────────────────────────────────

  describe('focus', () => {
    it('F1: single click sets focusedCell without editCell', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      expect(result.current.editCell).toBeNull()
    })

    it('F2: handleStartEdit sets editCell', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(3, 2))
      expect(result.current.editCell).toEqual({ rowIdx: 3, colIdx: 2 })
      expect(result.current.focusedCell).toEqual({ rowIdx: 3, colIdx: 2 })
    })

    it('clicking a new cell clears editCell', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(1, 1))
      act(() => result.current.handleFocusCell(3, 2))
      expect(result.current.editCell).toBeNull()
      expect(result.current.focusedCell).toEqual({ rowIdx: 3, colIdx: 2 })
    })
  })

  // ── Arrow nav ─────────────────────────────────────────────────────────────

  describe('arrow navigation', () => {
    it('F3: Arrow Down moves focusedCell to next row', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('down'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 3, colIdx: 1 })
      expect(scrollToRow).toHaveBeenCalledWith(3)
    })

    it('F3: Arrow Up moves focusedCell to previous row', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('up'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 1, colIdx: 1 })
    })

    it('Arrow Up at row 0 does nothing', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(0, 1))
      act(() => result.current.handleArrowNav('up'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 0, colIdx: 1 })
    })

    it('Arrow Down at last row does nothing', () => {
      const { result } = setup(3)
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('down'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('F4: Arrow Right moves to next editable column', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('right'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 2 })
    })

    it('Arrow Right calls scrollToCol with the target column index', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('right'))
      expect(scrollToCol).toHaveBeenCalledWith(2)
    })

    it('F4: Arrow Left moves to previous editable column', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 3))
      act(() => result.current.handleArrowNav('left'))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 2 })
    })

    it('Arrow Left calls scrollToCol with the target column index', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 3))
      act(() => result.current.handleArrowNav('left'))
      expect(scrollToCol).toHaveBeenCalledWith(2)
    })

    it('Arrow Right at last editable col does NOT call scrollToCol (no movement)', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 4))  // col4 is last editable
      act(() => result.current.handleArrowNav('right'))
      expect(scrollToCol).not.toHaveBeenCalled()
    })

    it('Arrow Left at first editable column does nothing', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('left'))
      // col0 is not editable, so col1 is first editable → no movement
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('arrow clears editCell', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(1, 1))
      act(() => result.current.handleArrowNav('down'))
      expect(result.current.editCell).toBeNull()
    })
  })

  // ── Edit end ──────────────────────────────────────────────────────────────

  describe('handleEndEdit', () => {
    it('F7: Escape from edit (dir=null) keeps focusedCell', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(2, 1))
      act(() => result.current.handleEndEdit(2, 1, null))
      expect(result.current.editCell).toBeNull()
      // focusedCell should remain from handleStartEdit
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('Enter (dir=down) advances to next row in edit mode', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(2, 1))
      act(() => result.current.handleEndEdit(2, 1, 'down'))
      expect(result.current.editCell).toEqual({ rowIdx: 3, colIdx: 1 })
      expect(result.current.focusedCell).toEqual({ rowIdx: 3, colIdx: 1 })
    })

    it('Tab (dir=right) advances to next editable column', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(2, 1))
      act(() => result.current.handleEndEdit(2, 1, 'right'))
      expect(result.current.editCell).toEqual({ rowIdx: 2, colIdx: 2 })
    })
  })

  // ── initialChar ───────────────────────────────────────────────────────────

  describe('initialChar', () => {
    it('F8: handleStartEdit with initialChar stores it', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(1, 2, 'a'))
      expect(result.current.editCell).toEqual({ rowIdx: 1, colIdx: 2, initialChar: 'a' })
    })

    it('handleStartEdit without initialChar has no initialChar', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(1, 2))
      expect(result.current.editCell).toEqual({ rowIdx: 1, colIdx: 2 })
      expect(result.current.editCell?.initialChar).toBeUndefined()
    })
  })

  // ── Cell range ────────────────────────────────────────────────────────────

  describe('cellRange', () => {
    it('R1: Shift+click same column creates cellRange', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleFocusCell(5, 1, true))
      expect(result.current.cellRange).toEqual({ colIdx: 1, startRow: 2, endRow: 5 })
    })

    it('R2: Shift+click different column ignores shift', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleFocusCell(5, 3, true))
      expect(result.current.cellRange).toBeNull()
      expect(result.current.focusedCell).toEqual({ rowIdx: 5, colIdx: 3 })
    })

    it('R3: Shift+Arrow Down creates/extends cellRange', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('down', true))
      expect(result.current.cellRange).toEqual({ colIdx: 1, startRow: 2, endRow: 3 })
    })

    it('R3: Shift+Arrow extends existing cellRange', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleArrowNav('down', true))
      act(() => result.current.handleArrowNav('down', true))
      expect(result.current.cellRange).toEqual({ colIdx: 1, startRow: 2, endRow: 4 })
    })

    it('R4: Click without shift clears cellRange', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleFocusCell(5, 1, true))
      expect(result.current.cellRange).not.toBeNull()
      act(() => result.current.handleFocusCell(3, 2))
      expect(result.current.cellRange).toBeNull()
    })

    it('R6: Entering edit clears cellRange', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => result.current.handleFocusCell(5, 1, true))
      act(() => result.current.handleStartEdit(3, 1))
      expect(result.current.cellRange).toBeNull()
    })
  })

  // ── handleSelectCellClick (three-click dropdown dispatch) ─────────────────

  describe('handleSelectCellClick', () => {
    it('first click on an unfocused cell focuses (does NOT edit)', () => {
      const { result } = setup()
      act(() => result.current.handleSelectCellClick(2, 1))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      expect(result.current.editCell).toBeNull()
    })

    it('second click on the already-focused cell starts edit', () => {
      const { result } = setup()
      act(() => result.current.handleSelectCellClick(2, 1))
      act(() => result.current.handleSelectCellClick(2, 1))
      expect(result.current.editCell).toEqual({ rowIdx: 2, colIdx: 1 })
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('click on a different cell focuses it (does NOT edit) even if a cell was previously focused', () => {
      const { result } = setup()
      act(() => result.current.handleSelectCellClick(2, 1))
      act(() => result.current.handleSelectCellClick(2, 2))
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 2 })
      expect(result.current.editCell).toBeNull()
    })

    it('shift-click on the focused cell does NOT start edit (range select instead)', () => {
      const { result } = setup()
      act(() => result.current.handleSelectCellClick(2, 1))
      act(() => result.current.handleSelectCellClick(2, 1, true))
      // No edit; focusedCell stays
      expect(result.current.editCell).toBeNull()
    })
  })

  // ── Document-level arrow navigation (runs even when wrapper isn't focused) ──

  describe('document-level arrow nav fallback', () => {
    it('Arrow Down fires on document keydown when a cell is focused', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toEqual({ rowIdx: 3, colIdx: 1 })
    })

    it('Arrow Right navigates columns from document keydown', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 2 })
    })

    it('does NOT fire when no cell is focused', () => {
      const { result } = setup()
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toBeNull()
    })

    it('does NOT fire while a cell is being edited (editor owns the arrow keys)', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(2, 1))
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
      })
      // editCell + focusedCell stay at (2, 1) — no navigation
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      expect(result.current.editCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('does NOT fire when an INPUT element has focus (lets the user type)', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        input.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      input.remove()
    })

    it('does NOT fire when a TEXTAREA has focus', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        textarea.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      textarea.remove()
    })

    it('does NOT fire when target is contentEditable', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      const div = document.createElement('div')
      div.setAttribute('contenteditable', 'true')
      // jsdom doesn't always reflect isContentEditable from the attribute, so
      // stub the property explicitly to mirror the production browser behavior.
      Object.defineProperty(div, 'isContentEditable', { value: true })
      document.body.appendChild(div)
      div.focus()
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        div.dispatchEvent(e)
      })
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
      div.remove()
    })

    it('non-arrow keys pass through (no preventDefault / no nav)', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      let prevented = false
      const e = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
      const origPreventDefault = e.preventDefault.bind(e)
      e.preventDefault = () => { prevented = true; origPreventDefault() }
      act(() => { document.body.dispatchEvent(e) })
      expect(prevented).toBe(false)
      expect(result.current.focusedCell).toEqual({ rowIdx: 2, colIdx: 1 })
    })

    it('Shift+Arrow extends range from document keydown', () => {
      const { result } = setup()
      act(() => result.current.handleFocusCell(2, 1))
      act(() => {
        const e = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true, cancelable: true })
        document.body.dispatchEvent(e)
      })
      expect(result.current.cellRange).toEqual({ colIdx: 1, startRow: 2, endRow: 3 })
    })
  })

  // ── clearFocus ────────────────────────────────────────────────────────────

  describe('clearFocus', () => {
    it('clears all state', () => {
      const { result } = setup()
      act(() => result.current.handleStartEdit(2, 1))
      act(() => result.current.clearFocus())
      expect(result.current.focusedCell).toBeNull()
      expect(result.current.editCell).toBeNull()
      expect(result.current.cellRange).toBeNull()
    })
  })
})
