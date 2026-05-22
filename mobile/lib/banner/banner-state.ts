// =============================================================================
// banner-state.ts — pure error-to-message mapper for ErrorBanner.
//
// Extracted out of the component so unit tests don't need an RN runtime.
// Returns null for errors the caller handles via another path (e.g.,
// reauth_required → sign-out flow).
// =============================================================================

import { ApiError } from '../api/client'

const FIVE_HUNDRED_MSG = "Cyggie's servers are having trouble. Try again in a moment."
const GENERIC_MSG = 'Something went wrong. Tap again to retry.'

/**
 * Map a caught error to a user-facing banner message.
 *
 *   ApiError + reauthRequired       → null (sign-out path; no banner)
 *   ApiError 5xx                    → FIVE_HUNDRED_MSG
 *   ApiError 4xx                    → err.message (gateway envelope text)
 *   Error (other)                   → GENERIC_MSG
 *   unknown shape (not Error)       → GENERIC_MSG + console.warn
 *                                     (signals an error shape we don't
 *                                     recognize; helps dev catch surface
 *                                     bugs before they ship silently)
 */
export function formatErrorMessage(err: unknown): string | null {
  if (err instanceof ApiError) {
    if (err.reauthRequired) return null
    if (err.status >= 500) return FIVE_HUNDRED_MSG
    if (err.status >= 400) return err.message
    return GENERIC_MSG
  }
  if (err instanceof Error) return GENERIC_MSG
  // Not an Error at all — log so we notice during dev.
  // eslint-disable-next-line no-console
  console.warn('[banner] unrecognized error shape', err)
  return GENERIC_MSG
}
