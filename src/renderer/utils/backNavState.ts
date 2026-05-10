/**
 * backNavState — shared shape + builder for navigation state passed
 * via React Router's location.state when going from a list to a detail
 * page. The detail's back button (useSmartBack) and breadcrumb both
 * consume `from` to return to the originating filtered list URL even
 * when browser history is unavailable (refresh, deep-link).
 */
import type { Location } from 'react-router-dom'

export interface BackNavState {
  /** Label shown on the back button (e.g. "Companies"). */
  backLabel?: string
  /** Originating URL captured at navigation time, e.g. "/companies?priority=high". */
  from?: string
}

/**
 * Build the location.state payload for list → detail navigation.
 *
 * Captures the current path + search so the detail's back button can
 * restore the exact filtered view, even after a refresh on the detail
 * page (location.state is persisted in browser history state).
 */
export function buildBackState(location: Location, backLabel: string): BackNavState {
  return { backLabel, from: `${location.pathname}${location.search}` }
}
