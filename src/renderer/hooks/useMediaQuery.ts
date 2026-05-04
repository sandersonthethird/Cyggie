import { useEffect, useState } from 'react'

/**
 * Reactive `window.matchMedia` wrapper. Returns a boolean that updates whenever
 * the query's match state flips.
 *
 *   const isNarrow = useMediaQuery('(max-width: 1024px)')
 *
 * SSR-safe: if `window` isn't available at first render, treats the query as
 * not-matching until mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])

  return matches
}
