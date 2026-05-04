// @vitest-environment jsdom
/**
 * Verifies the right-anchored edge-resize math: dragging RIGHT shrinks the
 * panel; dragging LEFT grows it. Plus min/max clamping and double-click reset.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useEdgeResize } from '../renderer/hooks/useEdgeResize'

function fireMouseEvent(name: 'mousemove' | 'mouseup', clientX: number) {
  const e = new MouseEvent(name, { clientX, bubbles: true, cancelable: true })
  document.dispatchEvent(e)
}

describe('useEdgeResize (right-anchored)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('starts at defaultWidth', () => {
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored' })
    )
    expect(result.current.width).toBe(400)
  })

  it('shrinks the panel as the user drags RIGHT (right-anchored sign flip)', () => {
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored' })
    )

    // Start drag at clientX=500
    act(() => {
      result.current.dividerProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    // Drag right by 30px → width = 400 + (-30) = 370
    act(() => {
      fireMouseEvent('mousemove', 530)
    })
    expect(result.current.width).toBe(370)
  })

  it('grows the panel as the user drags LEFT', () => {
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored' })
    )
    act(() => {
      result.current.dividerProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    // Drag left by 50px → width = 400 + 50 = 450
    act(() => {
      fireMouseEvent('mousemove', 450)
    })
    expect(result.current.width).toBe(450)
  })

  it('clamps at minWidth', () => {
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored' })
    )
    act(() => {
      result.current.dividerProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    // Try to shrink way past min: drag right by 200px
    act(() => {
      fireMouseEvent('mousemove', 700)
    })
    expect(result.current.width).toBe(320)
  })

  it('clamps at maxWidth', () => {
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored' })
    )
    act(() => {
      result.current.dividerProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    // Drag left way past max: drag left by 500px
    act(() => {
      fireMouseEvent('mousemove', 0)
    })
    expect(result.current.width).toBe(600)
  })

  it('double-click resets to defaultWidth and fires onCommit', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored', onCommit })
    )
    // Manually grow
    act(() => {
      result.current.setWidth(550)
    })
    expect(result.current.width).toBe(550)

    act(() => {
      result.current.dividerProps.onDoubleClick()
    })
    expect(result.current.width).toBe(400)
    expect(onCommit).toHaveBeenCalledWith(400)
  })

  it('commits final width on mouse up via onCommit', () => {
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useEdgeResize({ defaultWidth: 400, minWidth: 320, maxWidth: 600, side: 'right-anchored', onCommit })
    )
    act(() => {
      result.current.dividerProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    act(() => {
      fireMouseEvent('mousemove', 470)
    })
    act(() => {
      fireMouseEvent('mouseup', 470)
    })
    expect(onCommit).toHaveBeenCalledWith(430)
  })
})
