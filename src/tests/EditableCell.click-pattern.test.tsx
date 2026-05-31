// @vitest-environment jsdom
/**
 * EditableCell click-pattern + popover integration.
 *
 * Validates the three-click dropdown flow:
 *   1st click  → onFocus (cell highlights, no popover)
 *   2nd click  → onStartEdit (popover opens for select cells only)
 *   3rd click  → popover onPick → onSave with the picked value
 *
 * Plus the regression test for Issue 6 (stale closure):
 *   Picking an option must call onSave with the picked value, NOT the prior draft.
 *
 * Plus negative cases:
 *   - 2nd click on focused TEXT cell does NOT start edit (only select does)
 *   - double-click on unfocused select cell still starts edit (fallback)
 *   - Enter on focused select cell starts edit
 *   - Typing on focused select cell starts edit and seeds initialChar
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { ColumnDef } from '../renderer/components/crm/tableUtils'

vi.mock('../renderer/components/company/EditableCell.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))
vi.mock('../renderer/components/crm/OptionListPopover.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { EditableCell } from '../renderer/components/company/EditableCell'

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
    { value: 'owner',    label: 'Owner' },
  ],
}

const TEXT_COL: ColumnDef = {
  key: 'company',
  label: 'Company',
  field: 'company',
  defaultVisible: true,
  width: 200,
  minWidth: 80,
  sortable: true,
  editable: true,
  type: 'text',
}

function renderCell(overrides: Partial<Parameters<typeof EditableCell>[0]> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onFocus = vi.fn()
  const onStartEdit = vi.fn()
  const onEndEdit = vi.fn()
  const utils = render(
    <EditableCell
      value={overrides.value ?? null}
      col={overrides.col ?? SELECT_COL}
      onSave={overrides.onSave ?? onSave}
      onAddOption={overrides.onAddOption}
      rangePosition={overrides.rangePosition ?? null}
      isEditing={overrides.isEditing ?? false}
      initialChar={overrides.initialChar}
      scrollContainer={overrides.scrollContainer}
      onFocus={overrides.onFocus ?? onFocus}
      onStartEdit={overrides.onStartEdit ?? onStartEdit}
      onEndEdit={overrides.onEndEdit ?? onEndEdit}
    />
  )
  return { ...utils, onSave, onFocus, onStartEdit, onEndEdit }
}

function cellRoot(container: HTMLElement): HTMLElement {
  return container.querySelector('[role="button"]') as HTMLElement
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('EditableCell — three-click pattern (select cells)', () => {
  it('1st click on UNFOCUSED select cell calls only onFocus; no popover', () => {
    const { container, onFocus, onStartEdit } = renderCell({
      rangePosition: null,  // unfocused
    })
    fireEvent.click(cellRoot(container))
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onStartEdit).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('2nd click on FOCUSED select cell calls onStartEdit (popover opens after rerender)', () => {
    const { container, onStartEdit } = renderCell({
      rangePosition: 'only',  // already focused
    })
    fireEvent.click(cellRoot(container))
    expect(onStartEdit).toHaveBeenCalledTimes(1)
  })

  it('with isEditing=true on a select cell, popover renders', () => {
    renderCell({
      rangePosition: 'only',
      isEditing: true,
      value: 'investor',
    })
    const listbox = screen.getByRole('listbox')
    expect(listbox).toBeTruthy()
    // Popover option labels are inside the listbox; the cell chip also renders
    // "Investor" outside, so scope the queries to the listbox.
    expect(listbox.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Investor')
    const labels = Array.from(listbox.querySelectorAll('[role="option"]')).map(o => o.textContent)
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('Investor'),
      expect.stringContaining('Founder'),
    ]))
  })

  it('REGRESSION (Issue 6): clicking an option calls onSave with the PICKED value, not the prior draft', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderCell({
      rangePosition: 'only',
      isEditing: true,
      value: 'investor',      // prior value seeded into draft
      onSave,
    })
    // Click "Founder" — the popover must send 'founder' to onSave, not 'investor'.
    const founderRow = screen.getByText('Founder').closest('[role="option"]') as HTMLElement
    fireEvent.click(founderRow)
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('founder')
    expect(onSave).not.toHaveBeenCalledWith('investor')
  })
})

describe('EditableCell — non-dropdown cells unchanged', () => {
  it('2nd click on FOCUSED text cell calls only onFocus (does NOT start edit)', () => {
    const { container, onFocus, onStartEdit } = renderCell({
      col: TEXT_COL,
      rangePosition: 'only',
      value: 'Acme',
    })
    fireEvent.click(cellRoot(container))
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(onStartEdit).not.toHaveBeenCalled()
  })

  it('double-click on text cell still starts edit (legacy path preserved)', () => {
    const { container, onStartEdit } = renderCell({
      col: TEXT_COL,
      rangePosition: 'only',
      value: 'Acme',
    })
    fireEvent.doubleClick(cellRoot(container))
    expect(onStartEdit).toHaveBeenCalledTimes(1)
  })
})

describe('EditableCell — double-click fallback for select cells', () => {
  it('double-click on UNFOCUSED select cell still starts edit', () => {
    const { container, onStartEdit } = renderCell({
      rangePosition: null,  // unfocused
    })
    fireEvent.doubleClick(cellRoot(container))
    expect(onStartEdit).toHaveBeenCalledTimes(1)
  })
})

describe('EditableCell — keyboard entry on select cells', () => {
  it('Enter on focused select cell starts edit', () => {
    const { container, onStartEdit } = renderCell({
      rangePosition: 'only',
    })
    fireEvent.keyDown(cellRoot(container), { key: 'Enter' })
    expect(onStartEdit).toHaveBeenCalled()
  })

  it('initialChar="o" seeds popover active highlight (jump-to-letter)', async () => {
    // Render in edit mode with initialChar pre-set. Popover should pick the
    // first O-option ("Operator") as the active item; pressing Enter commits it.
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderCell({
      rangePosition: 'only',
      isEditing: true,
      initialChar: 'o',
      onSave,
    })
    const listbox = screen.getByRole('listbox')
    fireEvent.keyDown(listbox, { key: 'Enter' })
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('operator')
  })
})

describe('EditableCell — popover commit paths', () => {
  it('Tab inside popover calls onSave with the active value and signals advance', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onEndEdit = vi.fn()
    renderCell({
      rangePosition: 'only',
      isEditing: true,
      value: 'investor',  // active starts on Investor (index 0)
      onSave,
      onEndEdit,
    })
    const listbox = screen.getByRole('listbox')
    // Move to a DIFFERENT option so the commit isn't a no-op no-change.
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })  // → Founder
    fireEvent.keyDown(listbox, { key: 'Tab' })
    await act(async () => { await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith('founder')
    expect(onEndEdit).toHaveBeenCalledWith('right')
  })

  it('Escape closes popover without calling onSave', () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const onEndEdit = vi.fn()
    renderCell({
      rangePosition: 'only',
      isEditing: true,
      value: 'investor',
      onSave,
      onEndEdit,
    })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onSave).not.toHaveBeenCalled()
    expect(onEndEdit).toHaveBeenCalledWith(null)
  })
})

describe('EditableCell — non-editable cells', () => {
  it('non-editable select cell does NOT enter edit on click', () => {
    const { container, onStartEdit } = renderCell({
      col: { ...SELECT_COL, editable: false },
      rangePosition: 'only',
    })
    // Non-editable cells don't get role="button" — query the outer div directly.
    const cell = container.firstElementChild as HTMLElement
    fireEvent.click(cell)
    expect(onStartEdit).not.toHaveBeenCalled()
  })
})
