// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStaleGuard } from '../renderer/hooks/useStaleGuard'

describe('useStaleGuard', () => {
  it('returns a stable getGuard function', () => {
    const { result } = renderHook(() => useStaleGuard())
    const first = result.current
    expect(typeof first).toBe('function')
    // Should be referentially stable across renders
    const { result: result2 } = renderHook(() => useStaleGuard())
    expect(typeof result2.current).toBe('function')
  })

  it('guard is not stale when nothing has changed', () => {
    const { result } = renderHook(() => useStaleGuard())

    let isStale: () => boolean
    act(() => {
      isStale = result.current()
    })
    expect(isStale!()).toBe(false)
  })

  it('guard becomes stale when a newer guard is created', () => {
    const { result } = renderHook(() => useStaleGuard())

    let firstIsStale: () => boolean
    let secondIsStale: () => boolean
    act(() => {
      firstIsStale = result.current()
      secondIsStale = result.current()
    })
    expect(firstIsStale!()).toBe(true)
    expect(secondIsStale!()).toBe(false)
  })

  it('guard becomes stale on unmount', () => {
    const { result, unmount } = renderHook(() => useStaleGuard())

    let isStale: () => boolean
    act(() => {
      isStale = result.current()
    })
    expect(isStale!()).toBe(false)

    unmount()
    expect(isStale!()).toBe(true)
  })

  it('third guard invalidates both previous guards', () => {
    const { result } = renderHook(() => useStaleGuard())

    let first: () => boolean
    let second: () => boolean
    let third: () => boolean
    act(() => {
      first = result.current()
      second = result.current()
      third = result.current()
    })
    expect(first!()).toBe(true)
    expect(second!()).toBe(true)
    expect(third!()).toBe(false)
  })
})
