/**
 * useLastView — persist and restore the last-active table view.
 *
 * Saves current URL params + visible columns to localStorage on every change.
 * Restores them on mount when the URL has no search params (bare sidebar nav).
 *
 * Race guard: never saves when params are empty, preventing the save effect
 * from overwriting the real saved view during the initial bare-URL mount.
 *
 * Transient params (modal toggles, etc.) are stripped before save and
 * restore — otherwise opening the "+ New" modal once would cause every
 * subsequent sidebar nav to re-open it.
 */
import { useEffect, useRef } from 'react'
import { normalizeParams } from '../components/crm/ViewsBar'

interface LastViewState {
  urlParams: string
  columns: string[]
}

/** Query params that represent transient UI (modals, dialogs) — not view state. */
const TRANSIENT_PARAMS = new Set(['new'])

function stripTransient(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of TRANSIENT_PARAMS) next.delete(key)
  return next
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

      // Defensive strip — old saves may contain transient params from before
      // we filtered them at save time.
      const cleaned = normalizeParams(stripTransient(new URLSearchParams(saved.urlParams)))
      if (!cleaned) return

      navigate(`${path}?${cleaned}`, { replace: true })

      if (Array.isArray(saved.columns) && saved.columns.length > 0) {
        setVisibleKeys(saved.columns)
        saveColumnConfig(saved.columns)
      }
    } catch { /* corrupt data — fall back to default view */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps — intentionally mount-only

  // ── Save on every param/column change ──────────────────────────────────────
  useEffect(() => {
    const normalized = normalizeParams(stripTransient(searchParams))
    if (!normalized) return // guard: never overwrite with blank state

    try {
      localStorage.setItem(key, JSON.stringify({
        urlParams: normalized,
        columns: visibleKeys,
      } satisfies LastViewState))
    } catch { /* quota exceeded — silently skip */ }
  }, [key, searchParams, visibleKeys])
}
