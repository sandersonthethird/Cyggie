// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
import React from 'react'
import type { AttachedContextEntity } from '../shared/types/chat'

vi.mock('../renderer/components/chat-panel/ContextChipRow.module.css', () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}))

// Control the resolve-availability IPC.
const apiInvoke = vi.fn()
vi.mock('../renderer/api', () => ({
  api: { invoke: (...a: unknown[]) => apiInvoke(...a) },
}))

// Stub the picker: a button that selects a fixed entity.
vi.mock('../renderer/components/crm/PolymorphicEntitySearch', () => ({
  PolymorphicEntitySearch: ({ onSelect }: { onSelect: (e: { id: string; name: string; type: 'company' | 'contact' }) => void }) => (
    <button type="button" data-testid="pick" onClick={() => onSelect({ id: 'c2', name: 'Beta Co', type: 'company' })}>
      pick
    </button>
  ),
}))

const { ContextChipRow } = await import('../renderer/components/chat-panel/ContextChipRow')

const COMPANY: AttachedContextEntity = { type: 'company', id: 'c1', label: 'Acme' }
const CONTACT: AttachedContextEntity = { type: 'contact', id: 'p1', label: 'Jane Doe' }

beforeEach(() => {
  apiInvoke.mockReset()
  // Default: everything resolves as available.
  apiInvoke.mockImplementation((_ch: string, entities: AttachedContextEntity[]) =>
    Promise.resolve(entities.map((e) => ({ ...e, available: true }))),
  )
})
afterEach(() => cleanup())

describe('ContextChipRow', () => {
  it('renders a chip per attached entity', async () => {
    const { getByText } = render(
      <ContextChipRow attachedEntities={[COMPANY, CONTACT]} canAttach onAddEntity={vi.fn()} onRemoveEntity={vi.fn()} />,
    )
    expect(getByText('Acme')).toBeTruthy()
    expect(getByText('Jane Doe')).toBeTruthy()
  })

  it('calls onRemoveEntity when a chip × is clicked', () => {
    const onRemove = vi.fn()
    const { getByLabelText } = render(
      <ContextChipRow attachedEntities={[COMPANY]} canAttach onAddEntity={vi.fn()} onRemoveEntity={onRemove} />,
    )
    fireEvent.click(getByLabelText('Remove Acme'))
    expect(onRemove).toHaveBeenCalledWith(COMPANY)
  })

  it('opens the picker and calls onAddEntity with the picked entity', () => {
    const onAdd = vi.fn()
    const { getByText, getByTestId } = render(
      <ContextChipRow attachedEntities={[]} canAttach onAddEntity={onAdd} onRemoveEntity={vi.fn()} />,
    )
    fireEvent.click(getByText('+ Add context'))
    fireEvent.click(getByTestId('pick'))
    expect(onAdd).toHaveBeenCalledWith({ type: 'company', id: 'c2', label: 'Beta Co' })
  })

  it('greys out an unavailable (deleted) entity', async () => {
    apiInvoke.mockResolvedValue([{ ...COMPANY, available: false }])
    const { getByText } = render(
      <ContextChipRow attachedEntities={[COMPANY]} canAttach onAddEntity={vi.fn()} onRemoveEntity={vi.fn()} />,
    )
    await waitFor(() => {
      // The chip wrapper carries the "unavailable" class (CSS proxy echoes keys).
      const chip = getByText('Acme').closest('.chip')
      expect(chip?.className).toContain('unavailable')
    })
  })

  it('renders nothing when no entities and attach is disabled', () => {
    const { container } = render(
      <ContextChipRow attachedEntities={[]} canAttach={false} onAddEntity={vi.fn()} onRemoveEntity={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
