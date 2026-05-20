// @vitest-environment jsdom
/**
 * Regression test for the `useStaleGuard` shared-counter footgun.
 *
 * The Notes route folder sidebar stayed empty on initial mount because
 * `fetchFolderData` and `fetchFolderCounts` shared one `useStaleGuard()`
 * instance. Their `getGuard()` calls bumped the same counter; once the
 * second fetcher ran, the first fetcher's `isStale()` reported true and
 * its `setState` was skipped.
 *
 * Fix: each parallel fetcher gets its OWN `useStaleGuard()` instance.
 * This test pins both halves of that contract — the shared-guard
 * antipattern is documented as broken; the separate-guard pattern is
 * verified working.
 *
 * If the future-dev temptation to DRY three calls back into one returns,
 * the "shared guard" case below will silently keep passing — which is
 * intentional: it captures the antipattern's behavior. The matching
 * inline comment at the Notes.tsx call site is what guards the
 * specific route from regressing.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState } from 'react'
import { useStaleGuard } from '../renderer/hooks/useStaleGuard'

describe('useStaleGuard — parallel-fetch contract', () => {
  it('shared guard + Promise.all: the FIRST fetcher always stale-bails', async () => {
    // Documents the broken pattern. Two fetchers share one guard;
    // running them in parallel guarantees the first one's setState is
    // skipped because the second's getGuard() bumps the counter past it.
    const { result } = renderHook(() => {
      const getGuard = useStaleGuard()
      const [a, setA] = useState<string | null>(null)
      const [b, setB] = useState<string | null>(null)

      const run = async () => {
        const fetchA = async () => {
          const isStale = getGuard()
          await Promise.resolve()
          if (isStale()) return
          setA('a-set')
        }
        const fetchB = async () => {
          const isStale = getGuard()
          await Promise.resolve()
          if (isStale()) return
          setB('b-set')
        }
        await Promise.all([fetchA(), fetchB()])
      }

      return { a, b, run }
    })

    await act(async () => {
      await result.current.run()
    })

    expect(result.current.a).toBeNull()       // ← first fetcher skipped
    expect(result.current.b).toBe('b-set')    // ← second fetcher wins
  })

  it('separate guards + Promise.all: BOTH fetchers land their setState', async () => {
    // The fix: each fetcher owns its own counter. Concurrent calls
    // never bump each other's guard.
    const { result } = renderHook(() => {
      const getGuardA = useStaleGuard()
      const getGuardB = useStaleGuard()
      const [a, setA] = useState<string | null>(null)
      const [b, setB] = useState<string | null>(null)

      const run = async () => {
        const fetchA = async () => {
          const isStale = getGuardA()
          await Promise.resolve()
          if (isStale()) return
          setA('a-set')
        }
        const fetchB = async () => {
          const isStale = getGuardB()
          await Promise.resolve()
          if (isStale()) return
          setB('b-set')
        }
        await Promise.all([fetchA(), fetchB()])
      }

      return { a, b, run }
    })

    await act(async () => {
      await result.current.run()
    })

    expect(result.current.a).toBe('a-set')
    expect(result.current.b).toBe('b-set')
  })

  it('single guard + sequential calls: latest call wins (intended behavior)', async () => {
    // Sanity check that the hook's primary use case still works.
    const { result } = renderHook(() => {
      const getGuard = useStaleGuard()
      const [value, setValue] = useState<string | null>(null)

      // Two staggered calls — the second supersedes the first.
      const fetchSlow = async () => {
        const isStale = getGuard()
        await new Promise((r) => setTimeout(r, 5))
        if (isStale()) return
        setValue('slow')
      }
      const fetchFast = async () => {
        const isStale = getGuard()
        if (isStale()) return
        setValue('fast')
      }

      const run = async () => {
        const slow = fetchSlow()
        await fetchFast()
        await slow
      }

      return { value, run }
    })

    await act(async () => {
      await result.current.run()
    })

    // fetchFast ran second, bumping the counter past fetchSlow's id.
    // When fetchSlow's promise resolves, isStale() returns true → bails.
    // The fast value wins.
    expect(result.current.value).toBe('fast')
  })
})
