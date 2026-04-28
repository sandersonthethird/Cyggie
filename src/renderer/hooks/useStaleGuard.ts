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
