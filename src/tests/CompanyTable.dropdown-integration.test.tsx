// @vitest-environment jsdom
/**
 * CompanyTable chip-cell three-click integration smoke test.
 *
 * Mirrors ContactTable.dropdown-integration.test.tsx — CompanyTable's
 * chip-cell branch ([CompanyTable.tsx:702-715]) uses the exact same wiring
 * pattern as Contacts. This test exists so a CompanyTable-specific
 * regression (e.g. someone swaps handleSelectCellClick back to
 * handleFocusCell on the Companies side only) is caught independently.
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

import { useEditCellNav, getCellEdges } from '../renderer/hooks/useEditCellNav'
import { EditableCell } from '../renderer/components/company/EditableCell'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'

const STAGE_COL: ColumnDef = {
  key: 'pipelineStage',
  label: 'Stage',
  field: 'pipelineStage',
  defaultVisible: true,
  width: 120,
  minWidth: 80,
  sortable: false,
  editable: true,
  type: 'select',
  options: [
    { value: 'sourced',  label: 'Sourced' },
    { value: 'meeting',  label: 'Meeting' },
    { value: 'diligence', label: 'Diligence' },
    { value: 'passed',   label: 'Passed' },
  ],
}

function TableHarness({ value, onSave }: { value: string | null; onSave: (v: string | null) => Promise<void> }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const cols = [STAGE_COL]
  const {
    selection, editCell,
    handleSelectCellClick, handleFocusCell, handleStartEdit, handleEndEdit,
  } = useEditCellNav(1, cols)
  const [cellValue, setCellValue] = useState<string | null>(value)

  const dataIndex = 0, colIdx = 0
  const edges = getCellEdges(selection, dataIndex, colIdx)
  const isCellEditing = editCell?.rowIdx === dataIndex && editCell?.colIdx === colIdx

  if (!isCellEditing) {
    return (
      <div ref={scrollRef}>
        <div
          data-testid="chip-cell"
          onClick={(e) => handleSelectCellClick(dataIndex, colIdx, e.shiftKey)}
          onDoubleClick={() => handleStartEdit(dataIndex, colIdx)}
        >
          {cellValue ?? '—'}
        </div>
      </div>
    )
  }

  return (
    <div ref={scrollRef}>
      <EditableCell
        value={cellValue}
        col={STAGE_COL}
        edges={edges}
        isEditing={true}
        initialChar={editCell?.initialChar}
        scrollContainer={scrollRef.current}
        onFocus={(shiftKey) => handleFocusCell(dataIndex, colIdx, shiftKey)}
        onStartEdit={() => handleStartEdit(dataIndex, colIdx)}
        onEndEdit={(dir) => handleEndEdit(dataIndex, colIdx, dir ?? null)}
        onSave={async (v) => { setCellValue(v); await onSave(v) }}
      />
    </div>
  )
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('CompanyTable — chip-cell three-click integration (pipelineStage)', () => {
  it('1st click focuses; 2nd click opens popover; 3rd click commits the chosen stage', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TableHarness value="sourced" onSave={onSave} />)

    fireEvent.click(screen.getByTestId('chip-cell'))
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(screen.getByTestId('chip-cell'))
    const listbox = await screen.findByRole('listbox')
    expect(listbox).toBeTruthy()

    fireEvent.click(screen.getByText('Diligence').closest('[role="option"]') as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('diligence')
  })

  it('Tab inside popover commits + signals right-advance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TableHarness value="sourced" onSave={onSave} />)
    fireEvent.click(screen.getByTestId('chip-cell'))
    fireEvent.click(screen.getByTestId('chip-cell'))
    const listbox = await screen.findByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })  // → Meeting
    fireEvent.keyDown(listbox, { key: 'Tab' })
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('meeting')
  })

  it('outside click closes popover without committing', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<TableHarness value="sourced" onSave={onSave} />)
    fireEvent.click(screen.getByTestId('chip-cell'))
    fireEvent.click(screen.getByTestId('chip-cell'))
    await screen.findByRole('listbox')
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    fireEvent.mouseDown(outside)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })
})
