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
 *
 * ── restorePending (anti-flash gate) ────────────────────────────────────────
 * The restore runs in a mount effect (after first paint) and `navigate`s the
 * saved filters into the URL. Until that lands, the URL is bare, so the page's
 * filter (scope, column filters) reads as "All" — rendering the table now would
 * flash the full, unfiltered list. `restorePending` lets the page gate its table
 * (show loading) during that window:
 *
 *   restoreExpected = (mount) bareURL && readRestoreTarget(key) != null
 *        │
 *        ├─ false ─► restorePending = false forever      (URL had params / "All" / no save)
 *        └─ true  ─► restorePending = true WHILE bare ──► released latches once the
 *                       restored params land (URL non-bare); a later clearAllFilters()
 *                       back to bare does NOT re-gate ("All" is intentional then).
 *
 * Cannot hang: the app uses HashRouter, where `navigate` is an urgent update, so
 * the restored params make the URL non-bare in the very next commit and the
 * settle effect releases the gate. (No timer belt needed; if the app ever moves
 * to a data router with deferred navigation it still releases, just a frame later.)
 */
import { useEffect, useRef, useState } from 'react'
import { normalizeParams } from '../components/crm/ViewsBar'

interface LastViewState {
  urlParams: string
  columns: string[]
}

interface RestoreTarget {
  params: string
  columns: string[]
}

export interface UseLastViewResult {
  /** True while a saved-view restore is pending (URL still bare). Gate the list. */
  restorePending: boolean
}

/** Query params that represent transient UI (modals, dialogs) — not view state. */
const TRANSIENT_PARAMS = new Set(['new'])

function stripTransient(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of TRANSIENT_PARAMS) next.delete(key)
  return next
}

/**
 * Read + normalize the saved view for `key`. Returns `null` when there is nothing
 * to restore (no save, "All" was the last view, or only transient params remain).
 * Single source of truth shared by the mount decision and the restore effect, so
 * the "is a restore coming?" gate and the actual navigate can never disagree.
 */
function readRestoreTarget(key: string): RestoreTarget | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const saved: LastViewState = JSON.parse(raw)
    if (!saved.urlParams) return null
    const cleaned = normalizeParams(stripTransient(new URLSearchParams(saved.urlParams)))
    if (!cleaned) return null
    return { params: cleaned, columns: Array.isArray(saved.columns) ? saved.columns : [] }
  } catch {
    return null // corrupt data — fall back to default view
  }
}

export function useLastView(
  key: string,
  path: string,
  searchParams: URLSearchParams,
  visibleKeys: string[],
  navigate: (to: string, opts?: { replace?: boolean }) => void,
  setVisibleKeys: (keys: string[]) => void,
  saveColumnConfig: (keys: string[]) => void,
): UseLastViewResult {
  const hasRestored = useRef(false)

  // Decide ONCE, on first render, whether a bare-URL restore will run. Seed a ref
  // so the decision (and thus restorePending's initial value) is stable.
  const restoreTargetRef = useRef<RestoreTarget | null | undefined>(undefined)
  if (restoreTargetRef.current === undefined) {
    restoreTargetRef.current =
      searchParams.toString() === '' ? readRestoreTarget(key) : null
  }
  const restoreExpected = restoreTargetRef.current != null

  // `released` latches true once the URL has been non-bare at least once, so a
  // later clearAllFilters() (intentional "All") does not re-gate the list.
  const [released, setReleased] = useState(!restoreExpected)
  const restorePending = !released && searchParams.toString() === ''

  // ── Restore on mount when URL has no params ────────────────────────────────
  useEffect(() => {
    if (hasRestored.current) return
    hasRestored.current = true

    const target = restoreTargetRef.current
    if (!target) return

    navigate(`${path}?${target.params}`, { replace: true })

    if (target.columns.length > 0) {
      setVisibleKeys(target.columns)
      saveColumnConfig(target.columns)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- intentionally mount-only

  // ── Release the gate once the restored params land (URL no longer bare) ─────
  useEffect(() => {
    if (released) return
    if (searchParams.toString() !== '') setReleased(true)
  }, [searchParams, released])

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

  return { restorePending }
}
