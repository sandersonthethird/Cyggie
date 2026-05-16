// @vitest-environment jsdom
/**
 * Tests for useOutsideClick hook.
 *
 *   click on ref-element              → onClickOutside NOT called
 *   click outside ref-element         → onClickOutside called
 *   enabled=false                     → no listener attached
 *   ref.current = null                → no false-positive triggers
 *   unmount                           → listener removed (no stale fire)
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { useRef } from 'react'
import React from 'react'

const { useOutsideClick } = await import('../renderer/hooks/useOutsideClick')

afterEach(() => cleanup())

function Harness({ onClickOutside, enabled = true }: { onClickOutside: () => void; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClick(ref, onClickOutside, enabled)
  return (
    <div>
      <div ref={ref} data-testid="inside">inside</div>
      <button data-testid="outside">outside</button>
    </div>
  )
}

describe('useOutsideClick', () => {
  it('does NOT fire when mousedown lands inside the ref element', () => {
    const onClickOutside = vi.fn()
    const { getByTestId } = render(<Harness onClickOutside={onClickOutside} />)
    fireEvent.mouseDown(getByTestId('inside'))
    expect(onClickOutside).not.toHaveBeenCalled()
  })

  it('fires when mousedown lands outside the ref element', () => {
    const onClickOutside = vi.fn()
    const { getByTestId } = render(<Harness onClickOutside={onClickOutside} />)
    fireEvent.mouseDown(getByTestId('outside'))
    expect(onClickOutside).toHaveBeenCalledTimes(1)
  })

  it('does NOT attach a listener when enabled=false', () => {
    const onClickOutside = vi.fn()
    const { getByTestId } = render(<Harness onClickOutside={onClickOutside} enabled={false} />)
    fireEvent.mouseDown(getByTestId('outside'))
    expect(onClickOutside).not.toHaveBeenCalled()
  })

  it('cleans up the listener on unmount', () => {
    const onClickOutside = vi.fn()
    const { getByTestId, unmount } = render(<Harness onClickOutside={onClickOutside} />)
    unmount()
    // The "outside" element is gone from the rendered tree, but document still exists.
    // Fire mousedown directly on document body — listener should have been removed.
    fireEvent.mouseDown(document.body)
    expect(onClickOutside).not.toHaveBeenCalled()
    // Make sure the test doesn't accidentally pass for the wrong reason:
    // re-render confirms listener attaches fresh on remount
    const { getByTestId: getByTestId2 } = render(<Harness onClickOutside={onClickOutside} />)
    fireEvent.mouseDown(getByTestId2('outside'))
    expect(onClickOutside).toHaveBeenCalledTimes(1)
    void getByTestId  // suppress unused
  })
})
