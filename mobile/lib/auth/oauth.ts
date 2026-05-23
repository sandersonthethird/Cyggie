import * as WebBrowser from 'expo-web-browser'
import {
  parseCallbackUrl as sharedParseCallbackUrl,
  type SignInAction as SharedSignInAction,
  type SignInResult as SharedSignInResult,
  type SignInSuccess as SharedSignInSuccess,
  type SignInCancel as SharedSignInCancel,
  type SignInError as SharedSignInError,
} from '@cyggie/shared/auth-callback'
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

// Read directly from process.env so Metro inlines this at JS-bundle time —
// changing mobile/.env + a Metro reload picks up the new value. Reading from
// Constants.expoConfig.extra requires a native rebuild (the manifest is baked
// at expo prebuild / pnpm ios time), which is too slow for dev iteration.
const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

// Surfaces a typo'd or unset EXPO_PUBLIC_GATEWAY_URL — otherwise the silent
// prod fallback reproduces the exact 503 symptom the env var was meant to
// avoid, with no signal in the simulator UI. Compiled out of release bundles.
if (__DEV__) {
  // eslint-disable-next-line no-console
  console.log('[auth] gateway URL:', GATEWAY_URL)
}

// Re-exports of the shared types so existing call sites that imported them
// from './oauth' keep working. Canonical definitions live in
// @cyggie/shared/auth-callback (also consumed by the desktop main process).
export type SignInAction = SharedSignInAction
export type SignInSuccess = SharedSignInSuccess
export type SignInCancel = SharedSignInCancel
export type SignInError = SharedSignInError
export type SignInResult = SharedSignInResult

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
    console.log('[auth] startSignIn: opening WebBrowser')
    const result = await WebBrowser.openAuthSessionAsync(authUrl, CALLBACK_SCHEME, {
      showInRecents: false,
      preferEphemeralSession: false, // keep Google's "stay signed in" cookie
    })
    console.log('[auth] startSignIn: WebBrowser returned type=' + result.type)
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
    console.log('[auth] startSignIn: callback url scheme=' + new URL(redirectUrl).protocol)
  } catch (err) {
    console.log('[auth] startSignIn: WebBrowser threw: ' + (err instanceof Error ? err.message : String(err)))
    return {
      kind: 'error',
      code: 'AUTH_SESSION',
      message: err instanceof Error ? err.message : 'Auth session failed',
    }
  }

  // 3. Parse the cyggie:// deep link.
  const parsed = parseCallbackUrl(redirectUrl)
  console.log('[auth] startSignIn: parse kind=' + parsed.kind)
  return parsed
}

// Re-export the canonical parser so existing call sites keep working.
export const parseCallbackUrl = sharedParseCallbackUrl

/**
 * Recover a session whose cyggie:// deep link never reached the app.
 *
 * ASWebAuthenticationSession on iOS can return type='dismiss' or 'cancel'
 * AFTER the gateway has already minted a session and 302'd to
 * cyggie://auth-callback?session=… — the redirect just never makes it back.
 * The repro is documented above (lines 84-94) and survives the defensive
 * `dismissAuthSession()` we already call.
 *
 * On dismiss, the sign-in screen calls into this helper. We poll
 * POST /auth/session/claim-by-device for ~15 s. If the gateway finds a
 * session minted in the last 120 s for our device_id, it re-mints fresh
 * tokens, marks the session recovered (single-use), and returns them. If
 * the user really did cancel, the poll keeps getting 404s and times out
 * to `{ kind: 'cancel' }` — same UX as today.
 */
export async function pollForRecoveredSession(deviceId: string): Promise<SignInResult> {
  const startedAt = Date.now()
  const MAX_DURATION_MS = 15_000
  const NORMAL_INTERVAL_MS = 1_500
  const BACKOFF_INTERVAL_MS = 3_000

  console.log('[auth] recovery: polling /auth/session/claim-by-device')
  let attempt = 0
  while (Date.now() - startedAt < MAX_DURATION_MS) {
    attempt += 1
    let res: Response
    try {
      res = await fetch(`${GATEWAY_URL}/auth/session/claim-by-device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
      })
    } catch (err) {
      console.log('[auth] recovery: attempt ' + attempt + ' network err: ' + (err instanceof Error ? err.message : String(err)))
      await sleep(BACKOFF_INTERVAL_MS)
      continue
    }

    console.log('[auth] recovery: attempt ' + attempt + ' status=' + res.status)
    if (res.status === 200) {
      try {
        const body = (await res.json()) as {
          session: string
          refresh: string
          user_id: string
          action: SignInAction
          email: string | null
        }
        console.log('[auth] recovery: success action=' + body.action)
        return {
          kind: 'success',
          accessToken: body.session,
          refreshToken: body.refresh,
          userId: body.user_id,
          action: body.action,
          email: body.email ?? null,
        }
      } catch (err) {
        console.log('[auth] recovery: parse failed: ' + (err instanceof Error ? err.message : String(err)))
        return {
          kind: 'error',
          code: 'CALLBACK_INVALID_URL',
          message: err instanceof Error ? err.message : 'Bad claim response',
        }
      }
    }

    // 404 NO_RECENT_SESSION: keep polling at the normal cadence.
    // 429 RATE_LIMITED: back off.
    // 5xx: also back off — the gateway might be transiently down.
    const wait = res.status === 429 || res.status >= 500
      ? BACKOFF_INTERVAL_MS
      : NORMAL_INTERVAL_MS
    await sleep(wait)
  }

  console.log('[auth] recovery: timed out after ' + attempt + ' attempts')
  return { kind: 'cancel' }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
