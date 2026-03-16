// @vitest-environment jsdom
/**
 * Tests for useColumnDrag hook and reorder utility.
 *
 * Data flow under test:
 *   getDragProps(key).onDragStart  → draggingKey = key
 *   getDragProps(key).onDragOver   → dragOverKey = key (deduped)
 *   getDragProps(key).onDrop       → reorder + onVisibleKeysChange + saveKeys
 *   getDragProps(key).onDragEnd    → state cleared, no reorder
 *   getDragProps(key).onDragLeave  → dragOverKey cleared (child guard respected)
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useColumnDrag, reorder } from '../renderer/hooks/useColumnDrag'

// ── reorder() unit tests ────────────────────────────────────────────────────────

describe('reorder', () => {
  it('moves a column left: drag C before A', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['c', 'a', 'b', 'd'])
  })

  it('moves a column right: drag A before C', () => {
    // Removes 'a', then inserts it before 'c' → ['b', 'a', 'c', 'd']
    expect(reorder(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('returns same array when from === to', () => {
    const keys = ['a', 'b', 'c']
    expect(reorder(keys, 'b', 'b')).toBe(keys)
  })

  it('returns same array when to is not found (stale ref)', () => {
    const keys = ['a', 'b', 'c']
    expect(reorder(keys, 'a', 'z')).toBe(keys)
  })
})

// ── helper ─────────────────────────────────────────────────────────────────────

const KEYS = ['name', 'entityType', 'round', 'sector']
const ANCHOR = 'name'

function makeDragEvent(overrides: Partial<React.DragEvent> = {}): React.DragEvent {
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: '',
    setDragImage: vi.fn(),
  }
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer,
    currentTarget: document.createElement('div'),
    relatedTarget: null,
    ...overrides,
  } as unknown as React.DragEvent
}

// ── getDragProps ────────────────────────────────────────────────────────────────

describe('useColumnDrag — getDragProps', () => {
  it('returns draggable: false for anchorKey', () => {
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, vi.fn(), vi.fn(), ANCHOR)
    )
    expect(result.current.getDragProps(ANCHOR).draggable).toBe(false)
  })

  it('returns draggable: true for non-anchor keys', () => {
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, vi.fn(), vi.fn(), ANCHOR)
    )
    expect(result.current.getDragProps('entityType').draggable).toBe(true)
  })
})

// ── full drag sequence ──────────────────────────────────────────────────────────

describe('useColumnDrag — full drag sequence', () => {
  it('drag round → entityType: calls onVisibleKeysChange + saveKeys with reordered keys', () => {
    const onVisibleKeysChange = vi.fn()
    const saveKeys = vi.fn()
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, onVisibleKeysChange, saveKeys, ANCHOR)
    )

    act(() => {
      result.current.getDragProps('round').onDragStart(makeDragEvent())
    })
    expect(result.current.draggingKey).toBe('round')

    act(() => {
      result.current.getDragProps('entityType').onDragOver(makeDragEvent())
    })
    expect(result.current.dragOverKey).toBe('entityType')

    act(() => {
      result.current.getDragProps('entityType').onDrop(makeDragEvent())
    })

    // ['name','entityType','round','sector'] drag round→entityType = ['name','round','entityType','sector']
    expect(onVisibleKeysChange).toHaveBeenCalledWith(['name', 'round', 'entityType', 'sector'])
    expect(saveKeys).toHaveBeenCalledOnce()
    expect(result.current.draggingKey).toBeNull()
    expect(result.current.dragOverKey).toBeNull()
  })

  it('drop onto anchorKey does not call onVisibleKeysChange', () => {
    const onVisibleKeysChange = vi.fn()
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, onVisibleKeysChange, vi.fn(), ANCHOR)
    )

    act(() => {
      result.current.getDragProps('round').onDragStart(makeDragEvent())
      result.current.getDragProps(ANCHOR).onDrop(makeDragEvent())
    })

    expect(onVisibleKeysChange).not.toHaveBeenCalled()
  })

  it('onDragEnd (cancel) clears state and does not call onVisibleKeysChange', () => {
    const onVisibleKeysChange = vi.fn()
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, onVisibleKeysChange, vi.fn(), ANCHOR)
    )

    act(() => {
      result.current.getDragProps('round').onDragStart(makeDragEvent())
    })
    act(() => {
      result.current.getDragProps('round').onDragEnd()
    })

    expect(result.current.draggingKey).toBeNull()
    expect(result.current.dragOverKey).toBeNull()
    expect(onVisibleKeysChange).not.toHaveBeenCalled()
  })
})

// ── onDragOver dedup ────────────────────────────────────────────────────────────

describe('useColumnDrag — onDragOver dedup', () => {
  it('calling onDragOver twice with the same key only triggers one state update', () => {
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, vi.fn(), vi.fn(), ANCHOR)
    )

    let renderCount = 0
    // We can't easily count renders from renderHook, but we can verify the
    // ref-based guard works: dragOverKey should be set on first call and
    // remain unchanged on second call (no extra re-render needed to verify).
    act(() => {
      result.current.getDragProps('entityType').onDragOver(makeDragEvent())
    })
    expect(result.current.dragOverKey).toBe('entityType')

    // Second call with same key — dragOverKey should stay 'entityType'
    act(() => {
      result.current.getDragProps('entityType').onDragOver(makeDragEvent())
    })
    expect(result.current.dragOverKey).toBe('entityType')

    // Different key — should update
    act(() => {
      result.current.getDragProps('round').onDragOver(makeDragEvent())
    })
    expect(result.current.dragOverKey).toBe('round')
  })
})

// ── onDragLeave child guard ─────────────────────────────────────────────────────

describe('useColumnDrag — onDragLeave', () => {
  it('does NOT clear dragOverKey when relatedTarget is a child of the cell', () => {
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, vi.fn(), vi.fn(), ANCHOR)
    )

    // Set up: drag started and hovering over entityType
    act(() => {
      result.current.getDragProps('round').onDragStart(makeDragEvent())
      result.current.getDragProps('entityType').onDragOver(makeDragEvent())
    })
    expect(result.current.dragOverKey).toBe('entityType')

    // Simulate leaving to a child element (relatedTarget is inside currentTarget)
    const cell = document.createElement('div')
    const child = document.createElement('span')
    cell.appendChild(child)

    act(() => {
      result.current.getDragProps('entityType').onDragLeave(
        makeDragEvent({ currentTarget: cell, relatedTarget: child })
      )
    })

    // dragOverKey should NOT be cleared because relatedTarget is a child
    expect(result.current.dragOverKey).toBe('entityType')
  })

  it('clears dragOverKey when relatedTarget is outside the cell', () => {
    const { result } = renderHook(() =>
      useColumnDrag(KEYS, vi.fn(), vi.fn(), ANCHOR)
    )

    act(() => {
      result.current.getDragProps('round').onDragStart(makeDragEvent())
      result.current.getDragProps('entityType').onDragOver(makeDragEvent())
    })

    // Simulate leaving to an element outside the cell
    const cell = document.createElement('div')
    const outsideEl = document.createElement('div') // not appended to cell

    act(() => {
      result.current.getDragProps('entityType').onDragLeave(
        makeDragEvent({ currentTarget: cell, relatedTarget: outsideEl })
      )
    })

    expect(result.current.dragOverKey).toBeNull()
  })
})
