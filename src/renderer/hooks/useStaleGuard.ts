import { useRef, useEffect, useCallback } from 'react'

/**
 * Prevents stale async results from calling setState after a component
 * unmounts or a newer invocation supersedes a previous one.
 *
 * Usage:
 *   const getGuard = useStaleGuard()
 *
 *   const fetchData = useCallback(async () => {
 *     const isStale = getGuard()
 *     const result = await api.invoke(...)
 *     if (isStale()) return
 *     setData(result)
 *   }, [getGuard])
 *
 * Footgun — parallel fetchers must use SEPARATE guard instances:
 *
 *   // ✗ Broken — both fetchers share one counter; the first call's
 *   //   getGuard() bumps it 0→1, the second bumps 1→2, and when the
 *   //   first call's IPC resolves its isStale() sees 2 !== 1 and bails.
 *   //   setData is never called on the first call.
 *   const getGuard = useStaleGuard()
 *   void Promise.all([fetchA(getGuard), fetchB(getGuard)])
 *
 *   // ✓ Correct — each fetcher owns its own counter.
 *   const guardA = useStaleGuard()
 *   const guardB = useStaleGuard()
 *   void Promise.all([fetchA(guardA), fetchB(guardB)])
 *
 * Each `useStaleGuard()` call creates an independent counterRef. Every
 * closure returned from a given instance's `getGuard()` reads the same
 * counter, so use one instance per "latest-call-wins" sequence. Don't
 * DRY them across unrelated parallel fetchers — the result is a silent
 * setState skip (Notes-route folder sidebar empty-on-mount, May 2026).
 */
export function useStaleGuard() {
  const counterRef = useRef(0)

  // Invalidate any in-flight guards on unmount
  useEffect(() => {
    return () => { counterRef.current++ }
  }, [])

  const getGuard = useCallback(() => {
    const id = ++counterRef.current
    return () => counterRef.current !== id
  }, [])

  return getGuard
}
