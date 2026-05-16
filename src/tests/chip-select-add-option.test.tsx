// @vitest-environment jsdom
/**
 * Tests for ChipSelect's add-option flow.
 *
 * Coverage:
 *   - inline variant: happy path → onAddOption then onSave fired in order
 *   - inline variant: onAddOption throws → onError fired, onSave NOT fired
 *   - inline variant: onSave throws → onError fired
 *   - cell variant: happy path → same callbacks fire
 *   - cell variant: onAddOption throws → onError fired
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const { ChipSelect } = await import('../renderer/components/crm/ChipSelect')

afterEach(() => cleanup())

const OPTIONS = [
  { value: 'investor', label: 'Investor' },
  { value: 'founder', label: 'Founder' },
]

// Trigger the "+ Add option…" path then type and press Enter.
async function triggerAddOption(container: HTMLElement, typed: string) {
  const select = container.querySelector('select')!
  fireEvent.change(select, { target: { value: '__add_option__' } })
  // Now an <input> should render (AddOptionInlineInput)
  const input = container.querySelector('input')!
  fireEvent.change(input, { target: { value: typed } })
  fireEvent.keyDown(input, { key: 'Enter' })
  // Allow async onConfirm to settle
  await new Promise((r) => setTimeout(r, 0))
}

describe('ChipSelect add-option flow — inline variant', () => {
  it('happy path: onAddOption then onSave called with the new value', async () => {
    const onAddOption = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn()
    const onError = vi.fn()
    const { container } = render(
      <ChipSelect
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
        onError={onError}
      />,
    )

    await triggerAddOption(container, 'candidate')

    expect(onAddOption).toHaveBeenCalledWith('candidate')
    expect(onSave).toHaveBeenCalledWith('candidate')
    // Order: onAddOption first, onSave second
    expect(onAddOption.mock.invocationCallOrder[0])
      .toBeLessThan(onSave.mock.invocationCallOrder[0])
    expect(onError).not.toHaveBeenCalled()
  })

  it('onAddOption throws: onError fired, onSave NOT called', async () => {
    const onAddOption = vi.fn().mockRejectedValue(new Error('option add failed'))
    const onSave = vi.fn()
    const onError = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <ChipSelect
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
        onError={onError}
      />,
    )

    await triggerAddOption(container, 'candidate')

    expect(onAddOption).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('option add failed')
    warn.mockRestore()
  })

  it('onSave throws: onError fired', async () => {
    const onAddOption = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn().mockImplementation(() => { throw new Error('save failed') })
    const onError = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <ChipSelect
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
        onError={onError}
      />,
    )

    await triggerAddOption(container, 'candidate')

    expect(onAddOption).toHaveBeenCalled()
    expect(onSave).toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('save failed')
    warn.mockRestore()
  })

  it('without onError, errors are still caught and not propagated', async () => {
    const onAddOption = vi.fn().mockRejectedValue(new Error('boom'))
    const onSave = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <ChipSelect
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
      />,
    )
    // Should not throw
    await expect(triggerAddOption(container, 'candidate')).resolves.toBeUndefined()
    expect(onSave).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('ChipSelect add-option flow — cell variant', () => {
  it('happy path: onAddOption then onSave called', async () => {
    const onAddOption = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn()
    const onError = vi.fn()
    const { container } = render(
      <ChipSelect
        variant="cell"
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
        onError={onError}
      />,
    )

    await triggerAddOption(container, 'newstage')

    expect(onAddOption).toHaveBeenCalledWith('newstage')
    expect(onSave).toHaveBeenCalledWith('newstage')
    expect(onError).not.toHaveBeenCalled()
  })

  it('onAddOption throws: onError fired, onSave NOT called', async () => {
    const onAddOption = vi.fn().mockRejectedValue(new Error('cell failure'))
    const onSave = vi.fn()
    const onError = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { container } = render(
      <ChipSelect
        variant="cell"
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={onSave}
        onAddOption={onAddOption}
        onError={onError}
      />,
    )

    await triggerAddOption(container, 'newstage')

    expect(onAddOption).toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('cell failure')
    warn.mockRestore()
  })

  it('renders the chip label, caret, and overlay select', () => {
    const { container } = render(
      <ChipSelect
        variant="cell"
        value="investor"
        options={OPTIONS}
        isEditing={true}
        onSave={() => {}}
        cellCaretClassName="caret"
        cellSelectClassName="overlay"
      />,
    )
    // Chip label visible
    expect(container.textContent).toContain('Investor')
    // Caret span present
    expect(container.querySelector('.caret')).toBeTruthy()
    // Overlay select present
    expect(container.querySelector('select.overlay')).toBeTruthy()
  })
})
