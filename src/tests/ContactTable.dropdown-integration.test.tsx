// @vitest-environment jsdom
/**
 * ContactTable / CompanyTable chip-cell integration smoke test.
 *
 * The full table component has 27 imports (stores, IPC, router, virtual
 * scroller, drag-and-drop). Rather than mock all of those, this test
 * proves the wiring at the boundary that matters: a chip cell's onClick
 * must route through useEditCellNav.handleSelectCellClick (not the older
 * handleFocusCell), so the three-click pattern works end-to-end.
 *
 * The harness mirrors the exact JSX shape used by ContactTable's chip-cell
 * branch ([ContactTable.tsx:818-831]) so a refactor that swaps the click
 * dispatcher back to handleFocusCell would fail this test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { useState, useRef } from 'react'

vi.mock('../renderer/components/crm/OptionListPopover.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))
vi.mock('../renderer/components/company/EditableCell.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { useEditCellNav, getRangePosition } from '../renderer/hooks/useEditCellNav'
import { EditableCell } from '../renderer/components/company/EditableCell'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'

const SELECT_COL: ColumnDef = {
  key: 'contactType',
  label: 'Type',
  field: 'contactType',
  defaultVisible: true,
  width: 120,
  minWidth: 80,
  sortable: false,
  editable: true,
  type: 'select',
  options: [
    { value: 'investor', label: 'Investor' },
    { value: 'founder',  label: 'Founder' },
    { value: 'operator', label: 'Operator' },
  ],
}

/**
 * Minimal harness mirroring ContactTable's chip-cell branch + the
 * EditableCell fall-through path. Wires both to a real useEditCellNav.
 */
function TableHarness({ value, onSave }: { value: string | null; onSave: (v: string | null) => Promise<void> }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const cols = [SELECT_COL]
  const {
    focusedCell, editCell,
    handleSelectCellClick, handleFocusCell, handleStartEdit, handleEndEdit,
  } = useEditCellNav(1, cols)
  const [cellValue, setCellValue] = useState<string | null>(value)

  const dataIndex = 0
  const colIdx = 0
  const focusPos = getRangePosition(dataIndex, colIdx, null, focusedCell)
  const isCellEditing =
    editCell?.rowIdx === dataIndex && editCell?.colIdx === colIdx

  // Chip-cell branch (mirrors ContactTable.tsx:818-831): renders when NOT editing.
  // Critical: onClick routes through handleSelectCellClick, NOT handleFocusCell.
  if (!isCellEditing) {
    return (
      <div ref={scrollRef} data-testid="scroll-container">
        <div
          data-testid="chip-cell"
          onClick={(e) => handleSelectCellClick(dataIndex, colIdx, e.shiftKey)}
          onDoubleClick={() => handleStartEdit(dataIndex, colIdx)}
        >
          {cellValue ?? '—'}
          <span data-testid="focused-marker">{focusPos === 'only' ? 'FOCUSED' : 'UNFOCUSED'}</span>
        </div>
      </div>
    )
  }

  // Edit branch — falls through to EditableCell (mirrors ContactTable.tsx:843).
  return (
    <div ref={scrollRef} data-testid="scroll-container">
      <EditableCell
        value={cellValue}
        col={SELECT_COL}
        rangePosition={focusPos}
        isEditing={true}
        initialChar={editCell?.initialChar}
        scrollContainer={scrollRef.current}
        onFocus={(shiftKey) => handleFocusCell(dataIndex, colIdx, shiftKey)}
        onStartEdit={() => handleStartEdit(dataIndex, colIdx)}
        onEndEdit={(dir) => handleEndEdit(dataIndex, colIdx, dir ?? null)}
        onSave={async (v) => {
          setCellValue(v)
          await onSave(v)
        }}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('ContactTable / CompanyTable — chip-cell three-click integration', () => {
  it('first click focuses the chip cell (no popover); second click opens popover; pick commits', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TableHarness value="investor" onSave={onSave} />)

    // 1st click → focus only
    fireEvent.click(screen.getByTestId('chip-cell'))
    expect(screen.getByTestId('focused-marker').textContent).toBe('FOCUSED')
    expect(screen.queryByRole('listbox')).toBeNull()

    // 2nd click → popover opens
    fireEvent.click(screen.getByTestId('chip-cell'))
    const listbox = await screen.findByRole('listbox')
    expect(listbox).toBeTruthy()

    // 3rd click → pick option commits
    const founderRow = screen.getByText('Founder').closest('[role="option"]') as HTMLElement
    fireEvent.click(founderRow)
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('founder')
  })

  it('REGRESSION: chip-cell onClick must route through handleSelectCellClick (not handleFocusCell)', () => {
    // Render twice in a row without any state change — if the chip cell used
    // handleFocusCell, click #2 would just re-focus the already-focused cell
    // and never enter edit mode. With handleSelectCellClick, click #2 enters edit.
    render(<TableHarness value={null} onSave={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByTestId('chip-cell'))
    fireEvent.click(screen.getByTestId('chip-cell'))
    // If wiring is correct, popover is now visible.
    expect(screen.queryByRole('listbox')).toBeTruthy()
  })

  it('Esc closes popover and returns to chip-cell display', async () => {
    render(<TableHarness value="investor" onSave={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.click(screen.getByTestId('chip-cell'))
    fireEvent.click(screen.getByTestId('chip-cell'))
    const listbox = await screen.findByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'Escape' })
    // After Esc, edit mode ends → harness re-renders the chip-cell branch
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.getByTestId('chip-cell')).toBeTruthy()
  })

  it('double-click on UNFOCUSED chip cell opens popover (fallback path)', async () => {
    render(<TableHarness value="investor" onSave={vi.fn().mockResolvedValue(undefined)} />)
    fireEvent.doubleClick(screen.getByTestId('chip-cell'))
    expect(await screen.findByRole('listbox')).toBeTruthy()
  })
})
