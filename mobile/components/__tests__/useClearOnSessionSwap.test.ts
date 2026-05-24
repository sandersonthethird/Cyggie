// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useClearOnSessionSwap } from '../useClearOnSessionSwap'

// =============================================================================
// Swap semantics (mirrors the doc comment in the hook):
//
//   prev=null, curr='abc'  → SKIP  (initial load — preserve any state typed
//                                   during the find-or-create round-trip)
//   prev='abc', curr='def' → CLEAR (New Chat archived + created fresh)
//   prev='abc', curr=undefined → SKIP (sessionQuery never goes back to null
//                                   in practice; defensive: don't nuke state
//                                   on a transient cache eviction)
//
// The hook owns no state visible to callers other than the side-effect.
// Tests assert: clear was called the right number of times AND the prev
// pointer updates on every render (verified indirectly by sequencing).
// =============================================================================

describe('useClearOnSessionSwap', () => {
  test('1. initial load (null → "abc") does NOT clear', () => {
    const clear = vi.fn()
    renderHook(({ sessionId }) => useClearOnSessionSwap(sessionId, clear), {
      initialProps: { sessionId: undefined as string | undefined },
    })
    // Re-render with a real sessionId — simulates find-or-create resolving.
    const { rerender } = renderHook(
      ({ sessionId }) => useClearOnSessionSwap(sessionId, clear),
      { initialProps: { sessionId: undefined as string | undefined } },
    )
    rerender({ sessionId: 'sess_abc' })

    expect(clear).not.toHaveBeenCalled()
  })

  test('2. swap ("abc" → "def") clears exactly once', () => {
    const clear = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId }) => useClearOnSessionSwap(sessionId, clear),
      { initialProps: { sessionId: 'sess_abc' as string | undefined } },
    )
    // First render establishes prev='sess_abc' without firing clear (the
    // prev pointer was null on the very first effect, by design).
    expect(clear).not.toHaveBeenCalled()

    rerender({ sessionId: 'sess_def' })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  test('3. same id across rerenders does NOT clear', () => {
    const clear = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId }) => useClearOnSessionSwap(sessionId, clear),
      { initialProps: { sessionId: 'sess_abc' as string | undefined } },
    )
    rerender({ sessionId: 'sess_abc' })
    rerender({ sessionId: 'sess_abc' })

    expect(clear).not.toHaveBeenCalled()
  })

  test('4. transient undefined ("abc" → undefined) does NOT clear', () => {
    const clear = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId }) => useClearOnSessionSwap(sessionId, clear),
      { initialProps: { sessionId: 'sess_abc' as string | undefined } },
    )
    rerender({ sessionId: undefined })

    // Defensive: if sessionQuery briefly returns undefined (e.g., cache
    // invalidation in flight), we don't want to flush pending state.
    expect(clear).not.toHaveBeenCalled()
  })

  test('5. swap A → B → C clears twice (one per real transition)', () => {
    const clear = vi.fn()
    const { rerender } = renderHook(
      ({ sessionId }) => useClearOnSessionSwap(sessionId, clear),
      { initialProps: { sessionId: 'A' as string | undefined } },
    )
    rerender({ sessionId: 'B' })
    rerender({ sessionId: 'C' })

    expect(clear).toHaveBeenCalledTimes(2)
  })
})
