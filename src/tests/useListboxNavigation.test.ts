// @vitest-environment jsdom
/**
 * Unit tests for useListboxNavigation — the shared keyboard hook used by every
 * autocomplete in the app.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { useListboxNavigation } from '../renderer/hooks/useListboxNavigation'

function makeKey(key: string): KeyboardEvent {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent
}

describe('useListboxNavigation', () => {
  it('starts at index 0 by default', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b', 'c'], { onSelect: vi.fn() })
    )
    expect(result.current.activeIndex).toBe(0)
  })

  it('honors initialIndex (e.g. -1 for "no preselection")', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b'], { onSelect: vi.fn(), initialIndex: -1 })
    )
    expect(result.current.activeIndex).toBe(-1)
  })

  it('ArrowDown advances and clamps at the last item by default', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b', 'c'], { onSelect: vi.fn() })
    )
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    expect(result.current.activeIndex).toBe(1)
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    expect(result.current.activeIndex).toBe(2)
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    expect(result.current.activeIndex).toBe(2) // clamped
  })

  it('ArrowUp retreats and clamps at 0 by default', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b', 'c'], { onSelect: vi.fn() })
    )
    act(() => { result.current.setActiveIndex(2) })
    act(() => { result.current.onKeyDown(makeKey('ArrowUp')) })
    expect(result.current.activeIndex).toBe(1)
    act(() => { result.current.onKeyDown(makeKey('ArrowUp')) })
    expect(result.current.activeIndex).toBe(0)
    act(() => { result.current.onKeyDown(makeKey('ArrowUp')) })
    expect(result.current.activeIndex).toBe(0) // clamped
  })

  it('wrap=true wraps around at both ends', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b', 'c'], { onSelect: vi.fn(), wrap: true })
    )
    act(() => { result.current.setActiveIndex(2) })
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    expect(result.current.activeIndex).toBe(0)
    act(() => { result.current.onKeyDown(makeKey('ArrowUp')) })
    expect(result.current.activeIndex).toBe(2)
  })

  it('ArrowDown from -1 jumps to 0', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b'], { onSelect: vi.fn(), initialIndex: -1 })
    )
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    expect(result.current.activeIndex).toBe(0)
  })

  it('Enter calls onSelect with the active item and returns true', () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b', 'c'], { onSelect })
    )
    act(() => { result.current.setActiveIndex(1) })
    let handled = false
    act(() => { handled = result.current.onKeyDown(makeKey('Enter')) })
    expect(handled).toBe(true)
    expect(onSelect).toHaveBeenCalledWith('b', 1)
  })

  it('Enter when activeIndex is out of range returns false (site can fall back)', () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListboxNavigation(['a'], { onSelect, initialIndex: -1 })
    )
    let handled = true
    act(() => { handled = result.current.onKeyDown(makeKey('Enter')) })
    expect(handled).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('Escape calls onEscape and returns true', () => {
    const onEscape = vi.fn()
    const { result } = renderHook(() =>
      useListboxNavigation(['a'], { onSelect: vi.fn(), onEscape })
    )
    let handled = false
    act(() => { handled = result.current.onKeyDown(makeKey('Escape')) })
    expect(handled).toBe(true)
    expect(onEscape).toHaveBeenCalled()
  })

  it('Escape returns false when no onEscape provided', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a'], { onSelect: vi.fn() })
    )
    let handled = true
    act(() => { handled = result.current.onKeyDown(makeKey('Escape')) })
    expect(handled).toBe(false)
  })

  it('enabled=false short-circuits everything', () => {
    const onSelect = vi.fn()
    const onEscape = vi.fn()
    const { result } = renderHook(() =>
      useListboxNavigation(['a', 'b'], { onSelect, onEscape, enabled: false })
    )
    act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
    act(() => { result.current.onKeyDown(makeKey('Enter')) })
    act(() => { result.current.onKeyDown(makeKey('Escape')) })
    expect(result.current.activeIndex).toBe(0)
    expect(onSelect).not.toHaveBeenCalled()
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('empty items list does not crash on arrow keys or Enter', () => {
    const onSelect = vi.fn()
    const { result } = renderHook(() =>
      useListboxNavigation([] as string[], { onSelect })
    )
    expect(() => {
      act(() => { result.current.onKeyDown(makeKey('ArrowDown')) })
      act(() => { result.current.onKeyDown(makeKey('ArrowUp')) })
      act(() => { result.current.onKeyDown(makeKey('Enter')) })
    }).not.toThrow()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('items shrinking below activeIndex clamps to last index', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useListboxNavigation(items, { onSelect: vi.fn() }),
      { initialProps: { items: ['a', 'b', 'c', 'd'] as string[] } }
    )
    act(() => { result.current.setActiveIndex(3) })
    expect(result.current.activeIndex).toBe(3)
    rerender({ items: ['a', 'b'] })
    expect(result.current.activeIndex).toBe(1)
  })

  it('items emptying clamps activeIndex back to initialIndex', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useListboxNavigation(items, { onSelect: vi.fn(), initialIndex: -1 }),
      { initialProps: { items: ['a', 'b'] as string[] } }
    )
    act(() => { result.current.setActiveIndex(1) })
    expect(result.current.activeIndex).toBe(1)
    rerender({ items: [] })
    expect(result.current.activeIndex).toBe(-1)
  })

  it('items growing leaves activeIndex unchanged (caller resets explicitly)', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useListboxNavigation(items, { onSelect: vi.fn() }),
      { initialProps: { items: ['a', 'b'] as string[] } }
    )
    act(() => { result.current.setActiveIndex(1) })
    rerender({ items: ['a', 'b', 'c', 'd'] })
    expect(result.current.activeIndex).toBe(1)
  })

  it('non-handled keys (e.g. "a") return false without preventing default', () => {
    const { result } = renderHook(() =>
      useListboxNavigation(['a'], { onSelect: vi.fn() })
    )
    const evt = makeKey('a')
    let handled = true
    act(() => { handled = result.current.onKeyDown(evt) })
    expect(handled).toBe(false)
    expect(evt.preventDefault).not.toHaveBeenCalled()
  })
})
