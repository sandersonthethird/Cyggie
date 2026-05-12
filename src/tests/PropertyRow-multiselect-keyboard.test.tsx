// @vitest-environment jsdom
/**
 * Behavior-at-risk test for PropertyRow's multiselect keyboard after the
 * keyboard refactor.
 *
 * The multiselect uses Space (not Enter) to TOGGLE the focused option,
 * while Enter/Escape close the dropdown and save. This test pins both
 * behaviors so future hook changes don't accidentally route Space through
 * the hook's onSelect path or break the toggle semantics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'

vi.mock('../renderer/api', () => ({
  api: {
    invoke: vi.fn(),
    on: vi.fn(() => () => {}),
  },
}))

vi.mock('../renderer/components/crm/PropertyRow.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))
vi.mock('../renderer/components/crm/EntitySearch.module.css', () => ({
  default: new Proxy({}, { get: (_, p) => String(p) }),
}))

import { PropertyRow } from '../renderer/components/crm/PropertyRow'

const OPTIONS = [
  { value: 'red', label: 'Red' },
  { value: 'green', label: 'Green' },
  { value: 'blue', label: 'Blue' },
]

function openMultiselect() {
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(
    <PropertyRow
      label="Color"
      value=""
      type="multiselect"
      options={OPTIONS}
      onSave={onSave}
      editMode={true}
    />
  )
  const trigger = screen.getByRole('combobox')
  fireEvent.click(trigger)
  return { onSave, trigger }
}

describe('PropertyRow multiselect — keyboard behavior preservation', () => {
  beforeEach(() => {
    cleanup()
  })
  afterEach(() => cleanup())

  it('Space on focused option toggles selection (does NOT close dropdown)', async () => {
    openMultiselect()
    const dropdown = await screen.findByRole('listbox')

    fireEvent.keyDown(dropdown, { key: 'ArrowDown' }) // focus index 0 (Red)
    fireEvent.keyDown(dropdown, { key: ' ' }) // toggle Red → selected

    await waitFor(() => {
      const red = within(dropdown).getByText('Red').closest('[role="option"]')
      expect(red?.getAttribute('aria-selected')).toBe('true')
    })
    // Dropdown still open — Space did NOT close-and-save
    expect(screen.getByRole('listbox')).toBeTruthy()

    // Toggle off again
    fireEvent.keyDown(dropdown, { key: ' ' })
    await waitFor(() => {
      const red = within(dropdown).getByText('Red').closest('[role="option"]')
      expect(red?.getAttribute('aria-selected')).toBe('false')
    })
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('Enter closes the dropdown and saves the draft selection', async () => {
    const { onSave } = openMultiselect()
    const dropdown = await screen.findByRole('listbox')

    fireEvent.keyDown(dropdown, { key: 'ArrowDown' }) // Red
    fireEvent.keyDown(dropdown, { key: ' ' })          // select Red
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' }) // Green
    fireEvent.keyDown(dropdown, { key: ' ' })          // select Green
    fireEvent.keyDown(dropdown, { key: 'Enter' })      // close + save

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('red,green')
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape closes the dropdown and saves the draft selection', async () => {
    const { onSave } = openMultiselect()
    const dropdown = await screen.findByRole('listbox')

    fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
    fireEvent.keyDown(dropdown, { key: ' ' })
    fireEvent.keyDown(dropdown, { key: 'Escape' })

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith('red')
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('ArrowDown/ArrowUp move focus through options with wrap-around', async () => {
    openMultiselect()
    const dropdown = await screen.findByRole('listbox')

    // Default focusedIndex starts at -1, so 1st ArrowDown → 0 (Red).
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' })
    fireEvent.keyDown(dropdown, { key: ' ' }) // select Green

    await waitFor(() => {
      const green = within(dropdown).getByText('Green').closest('[role="option"]')
      expect(green?.getAttribute('aria-selected')).toBe('true')
    })

    // Wrap: from Blue (index 2) → ArrowDown → wraps to Red (index 0).
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' }) // → Blue
    fireEvent.keyDown(dropdown, { key: 'ArrowDown' }) // wrap → Red
    fireEvent.keyDown(dropdown, { key: ' ' })          // select Red

    await waitFor(() => {
      const red = within(dropdown).getByText('Red').closest('[role="option"]')
      expect(red?.getAttribute('aria-selected')).toBe('true')
    })
  })
})
