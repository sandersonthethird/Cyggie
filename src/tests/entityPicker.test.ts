// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { createElement } from 'react'
import { EntityPicker } from '../renderer/components/common/EntityPicker'
import type { PickerState } from '../renderer/hooks/usePicker'

// Minimal CSS module stub (jsdom doesn't process CSS modules)
vi.mock('../renderer/components/common/EntityPicker.module.css', () => ({
  default: new Proxy({}, { get: (_t, key) => String(key) })
}))

type Item = { id: string; name: string }

function makePicker(results: Item[] = [], searching = false): PickerState<Item> {
  return { results, searching, search: vi.fn() }
}

function makeProps(overrides: Partial<Parameters<typeof EntityPicker>[0]> = {}) {
  return {
    picker: makePicker([{ id: '1', name: 'Acme' }, { id: '2', name: 'Beta' }]),
    renderItem: (item: Item) => item.name,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

// jsdom doesn't implement scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn()

afterEach(() => cleanup())

describe('EntityPicker — onCreate prop', () => {
  it('does not show Create row when onCreate is not provided', () => {
    render(createElement(EntityPicker<Item>, makeProps()))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Co' } })
    expect(screen.queryByText(/^Create "/)).toBeNull()
  })

  it('does not show Create row when query is empty (even if onCreate provided)', () => {
    render(createElement(EntityPicker<Item>, makeProps({ onCreate: vi.fn() })))
    // Input starts empty — Create row should not appear
    expect(screen.queryByText(/^Create "/)).toBeNull()
  })

  it('shows Create row when onCreate provided and query is non-empty', () => {
    render(createElement(EntityPicker<Item>, makeProps({ onCreate: vi.fn() })))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Co' } })
    expect(screen.getByText('Create "New Co"')).toBeTruthy()
  })

  it('calls onCreate with trimmed query on mouse click', () => {
    const onCreate = vi.fn()
    render(createElement(EntityPicker<Item>, makeProps({ onCreate })))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  New Co  ' } })
    fireEvent.mouseDown(screen.getByText(/^Create "/))
    expect(onCreate).toHaveBeenCalledWith('New Co')
  })

  it('navigates to Create row with ArrowDown past last result', () => {
    const onCreate = vi.fn()
    render(createElement(EntityPicker<Item>, makeProps({ onCreate })))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'test' } })

    // Two results: ArrowDown x2 lands on result index 1, ArrowDown x1 more lands on Create row
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // index 0
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // index 1
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // index 2 = Create row
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('test')
  })

  it('calls onCreate on Enter when Create row is active (navigated to)', () => {
    const onCreate = vi.fn()
    const onSelect = vi.fn()
    render(createElement(EntityPicker<Item>, makeProps({ onCreate, onSelect, picker: makePicker([{ id: '1', name: 'Acme' }]) })))
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'query' } })
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // result 0
    fireEvent.keyDown(input, { key: 'ArrowDown' }) // Create row
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).toHaveBeenCalledWith('query')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('does not interfere with existing onSelect when onCreate not provided', () => {
    const onSelect = vi.fn()
    render(createElement(EntityPicker<Item>, makeProps({ onSelect })))
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith({ id: '1', name: 'Acme' })
  })
})
