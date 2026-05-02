/**
 * useLastView — persist and restore the last-active table view.
 *
 * Saves current URL params + visible columns to localStorage on every change.
 * Restores them on mount when the URL has no search params (bare sidebar nav).
 *
 * Race guard: never saves when params are empty, preventing the save effect
 * from overwriting the real saved view during the initial bare-URL mount.
 */
import { useEffect, useRef } from 'react'
import { normalizeParams } from '../components/crm/ViewsBar'

interface LastViewState {
  urlParams: string
  columns: string[]
}

export function useLastView(
  key: string,
  path: string,
  searchParams: URLSearchParams,
  visibleKeys: string[],
  navigate: (to: string, opts?: { replace?: boolean }) => void,
  setVisibleKeys: (keys: string[]) => void,
  saveColumnConfig: (keys: string[]) => void,
): void {
  const hasRestored = useRef(false)

  // ── Restore on mount when URL has no params ────────────────────────────────
  useEffect(() => {
    if (hasRestored.current) return
    hasRestored.current = true

    if (searchParams.toString() !== '') return

    try {
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved: LastViewState = JSON.parse(raw)
      if (!saved.urlParams) return

      navigate(`${path}?${saved.urlParams}`, { replace: true })

      if (Array.isArray(saved.columns) && saved.columns.length > 0) {
        setVisibleKeys(saved.columns)
        saveColumnConfig(saved.columns)
      }
    } catch { /* corrupt data — fall back to default view */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally mount-only

  // ── Save on every param/column change ──────────────────────────────────────
  useEffect(() => {
    const normalized = normalizeParams(searchParams)
    if (!normalized) return // guard: never overwrite with blank state

    try {
      localStorage.setItem(key, JSON.stringify({
        urlParams: normalized,
        columns: visibleKeys,
      } satisfies LastViewState))
    } catch { /* quota exceeded — silently skip */ }
  }, [key, searchParams, visibleKeys])
}
