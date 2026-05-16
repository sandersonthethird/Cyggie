// @vitest-environment jsdom
/**
 * Tests for useTimedError hook.
 *
 * Coverage:
 *   - show(msg) sets the error
 *   - clear() resets to null and cancels pending timer
 *   - autoClearMs triggers automatic clear after the delay
 *   - omitting autoClearMs leaves the error sticky
 *   - calling show twice resets the timer
 *   - unmount clears pending timer (no stale setState)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { useTimedError } = await import('../renderer/hooks/useTimedError')

describe('useTimedError', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with error = null', () => {
    const { result } = renderHook(() => useTimedError())
    expect(result.current.error).toBeNull()
  })

  it('show(msg) sets the error to the given message', () => {
    const { result } = renderHook(() => useTimedError())
    act(() => result.current.show('boom'))
    expect(result.current.error).toBe('boom')
  })

  it('clear() resets the error to null', () => {
    const { result } = renderHook(() => useTimedError())
    act(() => result.current.show('boom'))
    act(() => result.current.clear())
    expect(result.current.error).toBeNull()
  })

  it('with autoClearMs, auto-clears after the delay', () => {
    const { result } = renderHook(() => useTimedError(100))
    act(() => result.current.show('boom'))
    expect(result.current.error).toBe('boom')
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.error).toBeNull()
  })

  it('without autoClearMs, the error is sticky', () => {
    const { result } = renderHook(() => useTimedError())
    act(() => result.current.show('boom'))
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(result.current.error).toBe('boom')
  })

  it('calling show twice resets the timer', () => {
    const { result } = renderHook(() => useTimedError(100))
    act(() => result.current.show('first'))
    act(() => { vi.advanceTimersByTime(60) })
    expect(result.current.error).toBe('first')
    act(() => result.current.show('second'))
    // Original 100ms would now fire (40ms left) — but timer was reset
    act(() => { vi.advanceTimersByTime(60) })
    expect(result.current.error).toBe('second')
    // After another 40ms (total 100ms since second show), it clears
    act(() => { vi.advanceTimersByTime(40) })
    expect(result.current.error).toBeNull()
  })

  it('clear() cancels a pending auto-clear timer', () => {
    const { result } = renderHook(() => useTimedError(100))
    act(() => result.current.show('boom'))
    act(() => result.current.clear())
    expect(result.current.error).toBeNull()
    // Advancing time should not re-trigger anything
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current.error).toBeNull()
  })

  it('unmount clears the pending timer (no stale setState warning)', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useTimedError(100))
    act(() => result.current.show('boom'))
    unmount()
    act(() => { vi.advanceTimersByTime(200) })
    // If the timer wasn't cleared, React would log a "setState on unmounted" warning
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/unmounted/))
    warn.mockRestore()
  })
})
