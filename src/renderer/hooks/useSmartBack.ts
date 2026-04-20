import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * Smart back/forward navigation for Electron.
 *
 * Back: prefers history.back() but falls back to a route when
 * there's no history (deep link, refresh, app switch).
 *
 * Forward: available when the user has navigated back and there
 * are entries ahead in the history stack.
 *
 *   ┌─ idx > 0 ──→ history.back()
 *   └─ idx = 0 ──→ navigate(fallbackRoute)
 *
 *   ┌─ idx < maxIdx ──→ history.forward()
 *   └─ otherwise ──→ button hidden
 *
 * maxIdx tracks the highest history index seen this session.
 * Resets naturally on page refresh (JS state clears).
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

  const label = (location.state as { backLabel?: string } | null)?.backLabel ?? defaultLabel

  // React Router stores its own index in history.state.idx
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > maxIdx) maxIdx = idx
  const canGoForward = idx < maxIdx

  const goBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (idx != null && idx > 0) {
      navigate(-1)
    } else {
      navigate(fallbackRoute, { replace: true })
    }
  }, [navigate, fallbackRoute])

  const goForward = useCallback(() => {
    navigate(1)
  }, [navigate])

  return { label, goBack, canGoForward, goForward }
}
