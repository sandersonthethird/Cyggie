// @vitest-environment jsdom
/**
 * Tests for shared MergePicker atom.
 *
 *   contact noun  → "Search contacts…" + "No contacts found"
 *   company noun  → "Search companies…" + "No companies found"
 *   click result  → onSelect(target)
 *   click overlay → onClose
 *   Escape key    → onClose
 *   open=false    → renders nothing
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const { MergePicker } = await import('../renderer/components/crm/MergePicker')

afterEach(() => cleanup())

const RESULTS = [
  { id: 'r1', name: 'Acme Holdings' },
  { id: 'r2', name: 'Acme Industries' },
]

describe('MergePicker', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <MergePicker
        open={false}
        onClose={vi.fn()}
        entityNoun="contact"
        currentEntityName="X"
        query=""
        onQueryChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    expect(container.querySelector('input')).toBeNull()
  })

  it('contact noun uses contact placeholder + empty text', () => {
    const { container } = render(
      <MergePicker
        open={true}
        onClose={vi.fn()}
        entityNoun="contact"
        currentEntityName="Jane Doe"
        query=""
        onQueryChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    const input = container.querySelector('input')!
    expect(input.getAttribute('placeholder')).toBe('Search contacts…')
    // empty state (no query) shows the "start typing" message
    expect(container.textContent).toContain('Start typing to search…')
    // header shows entity name
    expect(container.textContent).toContain('Jane Doe')
  })

  it('company noun uses company placeholder', () => {
    const { container } = render(
      <MergePicker
        open={true}
        onClose={vi.fn()}
        entityNoun="company"
        currentEntityName="Acme Corp"
        query="acme"
        onQueryChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    expect(container.querySelector('input')!.getAttribute('placeholder')).toBe('Search companies…')
    expect(container.textContent).toContain('No companies found')
  })

  it('clicking a result calls onSelect with the target', () => {
    const onSelect = vi.fn()
    const { getByText } = render(
      <MergePicker
        open={true}
        onClose={vi.fn()}
        entityNoun="company"
        currentEntityName="X"
        query="acme"
        onQueryChange={vi.fn()}
        results={RESULTS}
        onSelect={onSelect}
      />,
    )
    fireEvent.click(getByText('Acme Industries'))
    expect(onSelect).toHaveBeenCalledWith({ id: 'r2', name: 'Acme Industries' })
  })

  it('clicking the overlay calls onClose; clicking inside the picker does not', () => {
    const onClose = vi.fn()
    const { container } = render(
      <MergePicker
        open={true}
        onClose={onClose}
        entityNoun="contact"
        currentEntityName="X"
        query=""
        onQueryChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    // click the inner picker — should NOT close
    fireEvent.click(container.querySelector('input')!)
    expect(onClose).not.toHaveBeenCalled()
    // click the overlay (outermost div with the dim background)
    const overlay = container.firstChild as HTMLElement
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape key in input calls onClose', () => {
    const onClose = vi.fn()
    const { container } = render(
      <MergePicker
        open={true}
        onClose={onClose}
        entityNoun="contact"
        currentEntityName="X"
        query=""
        onQueryChange={vi.fn()}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.keyDown(container.querySelector('input')!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('typing fires onQueryChange', () => {
    const onQueryChange = vi.fn()
    const { container } = render(
      <MergePicker
        open={true}
        onClose={vi.fn()}
        entityNoun="contact"
        currentEntityName="X"
        query=""
        onQueryChange={onQueryChange}
        results={[]}
        onSelect={vi.fn()}
      />,
    )
    fireEvent.change(container.querySelector('input')!, { target: { value: 'a' } })
    expect(onQueryChange).toHaveBeenCalledWith('a')
  })
})
