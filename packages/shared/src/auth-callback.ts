// =============================================================================
// auth-callback.ts — canonical OAuth callback parser shared by mobile + desktop.
//
// Both clients receive a custom-scheme deep link after the gateway completes
// /auth/google/callback:
//
//   mobile:  cyggie://auth-callback?session=&refresh=&user_id=&action=
//   desktop: cyggie-desktop://auth-callback?session=&refresh=&user_id=&action=
//
// The query-string shape is identical; only the scheme/host differ. This
// parser handles both transparently (it doesn't care about the scheme — it
// just reads searchParams from a URL).
//
// Lives in @cyggie/shared so we have one canonical implementation. Bug
// fixes land in one place; both clients pick them up.
// =============================================================================

export type SignInAction = 'returning' | 'create_workspace' | 'join_firm'

export interface SignInSuccess {
  kind: 'success'
  accessToken: string
  refreshToken: string
  userId: string
  action: SignInAction
}

export interface SignInCancel {
  kind: 'cancel'
}

export interface SignInError {
  kind: 'error'
  code: string
  message: string
}

export type SignInResult = SignInSuccess | SignInCancel | SignInError

/**
 * Parse a cyggie:// or cyggie-desktop:// callback URL produced by the
 * gateway's /auth/google/callback handler.
 *
 *   • OAuth provider errors → kind: 'error' with code OAUTH_<UPPER>
 *   • Missing any required param → kind: 'error' / CALLBACK_INCOMPLETE
 *   • Unknown action value → kind: 'error' / CALLBACK_UNKNOWN_ACTION
 *   • Otherwise → kind: 'success' with the four params
 *
 * Does NOT throw. Returns a discriminated union the caller pattern-matches.
 * Pure — no platform deps (works in Node, browser, React Native, Electron).
 */
export function parseCallbackUrl(url: string): SignInResult {
  // WHATWG URL handles custom schemes fine across all runtimes we care about.
  let u: URL
  try {
    u = new URL(url)
  } catch (err) {
    return {
      kind: 'error',
      code: 'CALLBACK_INVALID_URL',
      message: err instanceof Error ? err.message : 'invalid callback URL',
    }
  }
  const error = u.searchParams.get('error')
  if (error) {
    return {
      kind: 'error',
      code: 'OAUTH_' + error.toUpperCase(),
      message: `OAuth provider error: ${error}`,
    }
  }
  const accessToken = u.searchParams.get('session')
  const refreshToken = u.searchParams.get('refresh')
  const userId = u.searchParams.get('user_id')
  const action = u.searchParams.get('action')
  if (!accessToken || !refreshToken || !userId || !action) {
    return {
      kind: 'error',
      code: 'CALLBACK_INCOMPLETE',
      message: 'OAuth callback missing required params',
    }
  }
  if (action !== 'returning' && action !== 'create_workspace' && action !== 'join_firm') {
    return {
      kind: 'error',
      code: 'CALLBACK_UNKNOWN_ACTION',
      message: `Unknown action hint: ${action}`,
    }
  }
  return {
    kind: 'success',
    accessToken,
    refreshToken,
    userId,
    action,
  }
}
