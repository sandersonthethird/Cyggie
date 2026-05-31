// @vitest-environment jsdom
/**
 * EditableCell unmount cleanup.
 *
 * When a cell is unmounted while in edit mode (e.g. a TanStack Virtual row
 * scrolls out of the overscan window), the parent hook's editCell state
 * must be cleared so:
 *   - the popover doesn't dangle anchored to a dead DOM node
 *   - the cell doesn't auto-reopen the popover when it re-mounts later
 *
 * The component achieves this by calling onEndEdit(null) in a useEffect
 * cleanup that fires on unmount.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
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
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ],
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('EditableCell — unmount cleanup', () => {
  it('unmounting a cell that was in edit mode calls onEndEdit(null)', () => {
    const onEndEdit = vi.fn()
    const { unmount } = render(
      <EditableCell
        value="a"
        col={SELECT_COL}
        onSave={vi.fn().mockResolvedValue(undefined)}
        rangePosition="only"
        isEditing={true}
        onFocus={vi.fn()}
        onStartEdit={vi.fn()}
        onEndEdit={onEndEdit}
      />
    )
    unmount()
    expect(onEndEdit).toHaveBeenCalledWith(null)
  })

  it('unmounting a cell that was NOT in edit mode does NOT call onEndEdit', () => {
    const onEndEdit = vi.fn()
    const { unmount } = render(
      <EditableCell
        value="a"
        col={SELECT_COL}
        onSave={vi.fn().mockResolvedValue(undefined)}
        rangePosition="only"
        isEditing={false}
        onFocus={vi.fn()}
        onStartEdit={vi.fn()}
        onEndEdit={onEndEdit}
      />
    )
    unmount()
    expect(onEndEdit).not.toHaveBeenCalled()
  })
})
