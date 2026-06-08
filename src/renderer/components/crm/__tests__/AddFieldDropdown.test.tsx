// @vitest-environment jsdom

import { describe, expect, test, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AddFieldDropdown, type AddFieldDropdownProps, type FieldEditor } from '../AddFieldDropdown'
import type { HardcodedFieldDef } from '../../../constants/contactFields'

afterEach(() => {
  cleanup()
})

const baseHardcoded: HardcodedFieldDef[] = [
  { key: 'phone', label: 'Phone', defaultSection: 'contact_info' },
]

const baseSections = [
  { key: 'contact_info', label: 'Contact Info' },
  { key: 'professional', label: 'Professional' },
]

function noop() {}

/** A simple inline editor that records its value on every change (controlled). */
function makeEditor(key: string, commit: (v: unknown) => Promise<void>, initialValue: unknown = ''): FieldEditor {
  return {
    initialValue,
    renderEditor: (value, onChange) => (
      <input
        data-testid={`editor-${key}`}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    ),
    commit,
  }
}

function renderModal(overrides: Partial<AddFieldDropdownProps> = {}) {
  const props: AddFieldDropdownProps = {
    entityType: 'contact',
    hardcodedDefs: baseHardcoded,
    customFields: [],
    addedFields: [],
    hiddenFields: [],
    entityData: {},
    fieldPlacements: {},
    sections: baseSections,
    onToggleField: noop,
    onSetSection: noop,
    onCreateCustomField: noop,
    onClose: noop,
    getFieldEditor: () => null,
    ...overrides,
  }
  return { props, ...render(<AddFieldDropdown {...props} />) }
}

describe('AddFieldDropdown — footer buttons', () => {
  test('renders Cancel and Save (no Done)', () => {
    renderModal()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
  })

  test('Cancel closes and applies nothing', () => {
    const onClose = vi.fn()
    const onToggleField = vi.fn()
    renderModal({ onClose, onToggleField })
    // Check a field, then Cancel — the toggle must NOT be applied.
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onToggleField).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('AddFieldDropdown — buffering & commit', () => {
  test('checking a field reveals its inline editor; null editor shows none', () => {
    const { rerender, props } = renderModal({
      getFieldEditor: (key) => (key === 'phone' ? makeEditor('phone', vi.fn()) : null),
    })
    expect(screen.queryByTestId('editor-phone')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByTestId('editor-phone')).toBeInTheDocument()
    void rerender; void props
  })

  test('excluded field (getFieldEditor → null) shows no editor when checked', () => {
    renderModal({ getFieldEditor: () => null })
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.queryByTestId('editor-phone')).not.toBeInTheDocument()
  })

  test('Save applies the field add + commits the typed value', async () => {
    const onToggleField = vi.fn()
    const onClose = vi.fn()
    const commit = vi.fn().mockResolvedValue(undefined)
    renderModal({
      onToggleField,
      onClose,
      getFieldEditor: (key) => (key === 'phone' ? makeEditor('phone', commit) : null),
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByTestId('editor-phone'), { target: { value: '555-1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onToggleField).toHaveBeenCalledWith('phone', true)
    expect(commit).toHaveBeenCalledWith('555-1234')
  })

  test('checking without typing commits nothing (only the add)', async () => {
    const onToggleField = vi.fn()
    const onClose = vi.fn()
    const commit = vi.fn().mockResolvedValue(undefined)
    renderModal({
      onToggleField,
      onClose,
      getFieldEditor: (key) => (key === 'phone' ? makeEditor('phone', commit) : null),
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onToggleField).toHaveBeenCalledWith('phone', true)
    expect(commit).not.toHaveBeenCalled()
  })

  test('Cancel after typing commits nothing and applies no toggle', () => {
    const onToggleField = vi.fn()
    const commit = vi.fn()
    const onClose = vi.fn()
    renderModal({
      onToggleField,
      onClose,
      getFieldEditor: (key) => (key === 'phone' ? makeEditor('phone', commit) : null),
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByTestId('editor-phone'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(commit).not.toHaveBeenCalled()
    expect(onToggleField).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('Save flushes a value recorded on blur (no manual blur needed)', async () => {
    const commit = vi.fn().mockResolvedValue(undefined)
    const onClose = vi.fn()
    // Editor that only reports its value on blur — exercises handleSave's forced blur.
    const blurEditor: FieldEditor = {
      initialValue: '',
      renderEditor: (_value, onChange) => {
        let local = ''
        return (
          <input
            data-testid="editor-phone"
            onChange={(e) => { local = e.target.value }}
            onBlur={() => onChange(local)}
          />
        )
      },
      commit,
    }
    renderModal({ onClose, getFieldEditor: (key) => (key === 'phone' ? blurEditor : null) })
    fireEvent.click(screen.getByRole('checkbox'))
    const input = screen.getByTestId('editor-phone') as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: '999' } })
    // Click Save WITHOUT manually blurring the input.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(commit).toHaveBeenCalledWith('999')
  })
})

describe('AddFieldDropdown — dismiss guard', () => {
  test('click-outside closes when there are no changes', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.mouseDown(document.body)
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('click-outside is ignored once a change has been made (no data loss)', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByRole('checkbox')) // now dirty
    fireEvent.mouseDown(document.body)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('click inside a role=listbox portal never cancels', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    const portal = document.createElement('div')
    portal.setAttribute('role', 'listbox')
    document.body.appendChild(portal)
    fireEvent.mouseDown(portal)
    expect(onClose).not.toHaveBeenCalled()
    portal.remove()
  })
})
