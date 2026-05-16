import { useRef, useState, useCallback, useEffect } from 'react'

export interface TimedError {
  error: string | null
  show: (msg: string) => void
  clear: () => void
}

/**
 * Local inline-error state with optional auto-clear.
 *
 *   show(msg) ─┬─▶ setError(msg)
 *              └─▶ if (autoClearMs) start timer → clear() on fire
 *   clear()  ───▶ clearTimeout + setError(null)
 *   unmount  ───▶ clearTimeout (no setState — component is gone)
 *
 * Pass autoClearMs for transient errors (e.g. inline next to a chip).
 * Omit it for sticky errors that persist until manually cleared.
 */
export function useTimedError(autoClearMs?: number): TimedError {
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const show = useCallback((msg: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setError(msg)
    if (autoClearMs) {
      timerRef.current = setTimeout(() => setError(null), autoClearMs)
    }
  }, [autoClearMs])

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setError(null)
  }, [])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return { error, show, clear }
}
