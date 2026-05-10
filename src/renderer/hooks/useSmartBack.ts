import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { BackNavState } from '../utils/backNavState'

/**
 * Smart back/forward navigation for Electron.
 *
 * Back: prefers history.back(); falls back to a captured `state.from`
 * URL (set by list → detail navigations); falls back further to a
 * static fallback route when no history state is available
 * (deep link, refresh, app switch).
 *
 * Forward: available when the user has navigated back and there
 * are entries ahead in the history stack.
 *
 *   ┌─ idx > 0 ────────────────────────────▶ history.back()
 *   ├─ idx = 0 + state.from valid (/-prefix) ▶ navigate(state.from, replace)
 *   └─ idx = 0 + no/invalid state.from ─────▶ navigate(fallbackRoute, replace)
 *
 *   ┌─ idx < maxIdx ──▶ history.forward()
 *   └─ otherwise ────▶ button hidden
 *
 * maxIdx tracks the highest history index seen this session.
 * Resets naturally on page refresh (JS state clears).
 *
 * state.from is validated to start with '/' to prevent navigation to
 * external/scheme-injected URLs (defense in depth — all internal
 * callers go through buildBackState which produces a path string).
 */

// Highest React Router history index seen this session.
// When the user navigates forward to new pages, maxIdx grows.
// When they go back, idx drops below maxIdx → forward is available.
// When they push a new route from a back position, the browser
// truncates forward entries and maxIdx resets to the new idx.
let maxIdx = 0

export function useSmartBack(fallbackRoute: string, defaultLabel = 'Back'): {
  label: string
  goBack: () => void
  canGoForward: boolean
  goForward: () => void
} {
  const location = useLocation()
  const navigate = useNavigate()

  const state = location.state as BackNavState | null
  const label = state?.backLabel ?? defaultLabel
  const stateFrom = state?.from

  // React Router stores its own index in history.state.idx
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > maxIdx) maxIdx = idx
  const canGoForward = idx < maxIdx

  const goBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (idx != null && idx > 0) {
      navigate(-1)
      return
    }
    if (stateFrom) {
      if (stateFrom.startsWith('/')) {
        navigate(stateFrom, { replace: true })
        return
      }
      console.warn('[useSmartBack] Ignoring state.from that does not start with "/":', stateFrom)
    }
    navigate(fallbackRoute, { replace: true })
  }, [navigate, fallbackRoute, stateFrom])

  const goForward = useCallback(() => {
    navigate(1)
  }, [navigate])

  return { label, goBack, canGoForward, goForward }
}
