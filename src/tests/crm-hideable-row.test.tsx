// @vitest-environment jsdom
/**
 * Tests for shared HideableRow atom.
 *
 *   showControls = isEditing || showAllFields
 *
 *   isEditing=false && showAllFields=false → no buttons
 *   either flag true && !isHidden          → Hide (×) button
 *   either flag true && isHidden           → Restore (↺) button
 *   onHide(fieldKey, isEmpty) on hide click
 *   onRestore(fieldKey) on restore click
 *   isHidden adds opacity class on container
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'

const { HideableRow } = await import('../renderer/components/crm/HideableRow')

afterEach(() => cleanup())

function defaults() {
  return {
    fieldKey: 'twitterHandle',
    isHidden: false,
    isEditing: false,
    showAllFields: false,
    onHide: vi.fn(),
    onRestore: vi.fn(),
  }
}

describe('HideableRow', () => {
  it('renders children and no controls when isEditing=false && showAllFields=false', () => {
    const { container, getByText } = render(
      <HideableRow {...defaults()}>
        <span>child content</span>
      </HideableRow>,
    )
    expect(getByText('child content')).toBeTruthy()
    expect(container.querySelector('button')).toBeNull()
  })

  it('shows Hide (×) button when isEditing && !isHidden', () => {
    const { container, getByText } = render(
      <HideableRow {...defaults()} isEditing={true}>
        <span>x</span>
      </HideableRow>,
    )
    const btn = container.querySelector('button')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toBe('×')
    expect(getByText('×')).toBeTruthy()
  })

  it('shows Hide button when showAllFields && !isHidden', () => {
    const { container } = render(
      <HideableRow {...defaults()} showAllFields={true}>
        <span>x</span>
      </HideableRow>,
    )
    expect(container.querySelector('button')!.textContent).toBe('×')
  })

  it('shows Restore (↺) button when isHidden + either control flag', () => {
    const { container } = render(
      <HideableRow {...defaults()} isEditing={true} isHidden={true}>
        <span>x</span>
      </HideableRow>,
    )
    expect(container.querySelector('button')!.textContent).toBe('↺')
  })

  it('clicking Hide calls onHide(fieldKey, isEmpty)', () => {
    const onHide = vi.fn()
    const { container } = render(
      <HideableRow {...defaults()} isEditing={true} isEmpty={true} onHide={onHide}>
        <span>x</span>
      </HideableRow>,
    )
    fireEvent.click(container.querySelector('button')!)
    expect(onHide).toHaveBeenCalledWith('twitterHandle', true)
  })

  it('clicking Restore calls onRestore(fieldKey)', () => {
    const onRestore = vi.fn()
    const { container } = render(
      <HideableRow {...defaults()} isEditing={true} isHidden={true} onRestore={onRestore}>
        <span>x</span>
      </HideableRow>,
    )
    fireEvent.click(container.querySelector('button')!)
    expect(onRestore).toHaveBeenCalledWith('twitterHandle')
  })

  it('isHidden applies the fieldHidden class (visual de-emphasis)', () => {
    const { container } = render(
      <HideableRow {...defaults()} isHidden={true}>
        <span>x</span>
      </HideableRow>,
    )
    // Outer container should have a class with "fieldHidden" in its name (CSS-module hashed)
    const outer = container.firstChild as HTMLElement
    expect(outer.className).toContain('fieldHidden')
  })
})
