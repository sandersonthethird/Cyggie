// @vitest-environment jsdom

import { describe, expect, test, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { AddFieldDropdown } from '../AddFieldDropdown'
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

describe('AddFieldDropdown — Done button', () => {
  test('renders a visible Done button in the footer', () => {
    render(
      <AddFieldDropdown
        entityType="contact"
        hardcodedDefs={baseHardcoded}
        customFields={[]}
        addedFields={[]}
        hiddenFields={[]}
        entityData={{}}
        fieldPlacements={{}}
        sections={baseSections}
        onToggleField={noop}
        onSetSection={noop}
        onCreateCustomField={noop}
        onClose={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
  })

  test('clicking Done calls onClose exactly once', () => {
    const onClose = vi.fn()
    render(
      <AddFieldDropdown
        entityType="contact"
        hardcodedDefs={baseHardcoded}
        customFields={[]}
        addedFields={[]}
        hiddenFields={[]}
        entityData={{}}
        fieldPlacements={{}}
        sections={baseSections}
        onToggleField={noop}
        onSetSection={noop}
        onCreateCustomField={noop}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  test('Done click does not fire onCreateCustomField', () => {
    const onCreateCustomField = vi.fn()
    const onClose = vi.fn()
    render(
      <AddFieldDropdown
        entityType="contact"
        hardcodedDefs={baseHardcoded}
        customFields={[]}
        addedFields={[]}
        hiddenFields={[]}
        entityData={{}}
        fieldPlacements={{}}
        sections={baseSections}
        onToggleField={noop}
        onSetSection={noop}
        onCreateCustomField={onCreateCustomField}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onCreateCustomField).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
