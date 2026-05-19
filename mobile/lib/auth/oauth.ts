import Constants from 'expo-constants'
import * as WebBrowser from 'expo-web-browser'
import { getOrCreateDeviceId } from './device'

// OAuth round-trip orchestration. The flow:
//
//   1. Client → POST /auth/google/start { device_id }
//      Gateway returns { authUrl, state }
//
//   2. Client opens authUrl via WebBrowser.openAuthSessionAsync.
//      iOS uses ASWebAuthenticationSession — a system-managed browser tab
//      that shares cookies with Safari (so Google "stay signed in" works)
//      and is scoped to a specific callback URL scheme (cyggie://).
//
//   3. User consents at Google → Google → /auth/google/callback → gateway
//      mints JWT, redirects to cyggie://auth-callback?session=...&action=...
//
//   4. ASWebAuthenticationSession catches the cyggie:// redirect, closes
//      itself, returns the URL synchronously. We parse the query string
//      and hand back the typed result.
//
// No raw refresh token ever lands in URL bars or browser history — it's
// only in the deep-link query string that's never rendered or logged.

const GATEWAY_URL = (Constants.expoConfig?.extra?.['gatewayUrl'] as string | undefined) ??
  'https://cyggie-gateway.fly.dev'

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

const CALLBACK_SCHEME = 'cyggie://auth-callback'

export async function startSignIn(): Promise<SignInResult> {
  const deviceId = await getOrCreateDeviceId()

  // 1. Ask the gateway for an auth URL.
  let authUrl: string
  try {
    const res = await fetch(`${GATEWAY_URL}/auth/google/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, device_label: defaultDeviceLabel() }),
    })
    if (!res.ok) {
      return {
        kind: 'error',
        code: `GATEWAY_${res.status}`,
        message: `Gateway returned ${res.status} starting OAuth`,
      }
    }
    const body = (await res.json()) as { authUrl: string }
    authUrl = body.authUrl
  } catch (err) {
    return {
      kind: 'error',
      code: 'NETWORK',
      message: err instanceof Error ? err.message : 'Network error starting OAuth',
    }
  }

  // 2. Open in a system auth session, wait for the cyggie:// redirect.
  // Defensively dismiss any stale session before opening a new one. On iOS
  // Simulator, after the first ASWebAuthenticationSession in an app run, the
  // native module's `currentAuthSession` can retain state that makes the
  // SECOND attempt close silently with type='cancel' after Google's "Allow"
  // — even though the gateway successfully sent the cyggie:// redirect.
  // The dismiss is a no-op if no session is active, so it's safe to always call.
  try {
    await WebBrowser.dismissAuthSession()
  } catch {
    // ignore — best-effort cleanup
  }

  let redirectUrl: string | null = null
  try {
    const result = await WebBrowser.openAuthSessionAsync(authUrl, CALLBACK_SCHEME, {
      showInRecents: false,
      preferEphemeralSession: false, // keep Google's "stay signed in" cookie
    })
    if (result.type === 'cancel' || result.type === 'dismiss') {
      return { kind: 'cancel' }
    }
    if (result.type !== 'success') {
      return {
        kind: 'error',
        code: 'AUTH_SESSION_' + result.type.toUpperCase(),
        message: 'Auth session ended unexpectedly',
      }
    }
    redirectUrl = result.url
  } catch (err) {
    return {
      kind: 'error',
      code: 'AUTH_SESSION',
      message: err instanceof Error ? err.message : 'Auth session failed',
    }
  }

  // 3. Parse the cyggie:// deep link.
  return parseCallbackUrl(redirectUrl)
}

export function parseCallbackUrl(url: string): SignInResult {
  // RN URL parser handles custom schemes fine.
  const u = new URL(url)
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

/** Rotates the refresh token; returns a new access + refresh pair. */
export async function refreshTokens(opts: {
  refreshToken: string
  deviceId: string
}): Promise<{ accessToken: string; refreshToken: string } | { error: string }> {
  try {
    const res = await fetch(`${GATEWAY_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: opts.refreshToken,
        device_id: opts.deviceId,
      }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string }
      }
      return { error: body.error?.code ?? `HTTP_${res.status}` }
    }
    const body = (await res.json()) as { access_token: string; refresh_token: string }
    return { accessToken: body.access_token, refreshToken: body.refresh_token }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'refresh failed' }
  }
}

/** Best-effort logout — clears server-side session, then caller clears storage. */
export async function callLogout(accessToken: string): Promise<void> {
  try {
    await fetch(`${GATEWAY_URL}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch {
    // Best effort — if the gateway is down, local storage clear is still useful.
  }
}

function defaultDeviceLabel(): string {
  // iOS-only V1; expand for other platforms later.
  return 'iPhone'
}
