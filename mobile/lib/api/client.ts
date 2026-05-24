import { useAuthStore } from '../auth/store'
import { getRefreshToken } from '../auth/storage'
import { getOrCreateDeviceId } from '../auth/device'
import { refreshTokens } from '../auth/oauth'

// Typed fetch wrapper that:
//   • injects Authorization: Bearer <jwt> from the auth store
//   • on 401 with reauth_required=true → throws a typed ApiError with
//     reauthRequired=true. Does NOT signOut; the gateway uses this flag
//     for Google-side reauth too (calendar/Gmail), and conflating the two
//     produced an infinite sign-in loop.
//   • on 401 without that flag → attempts one silent /auth/refresh, retries
//   • parses the gateway error envelope into a typed ApiError
//
// Single in-flight refresh — concurrent 401s coalesce onto the same promise
// so we don't fire multiple /auth/refresh calls with the same refresh token
// (only the first would succeed; rotation would invalidate the others).

// Read directly from process.env so Metro inlines at JS-bundle time —
// see the matching note in oauth.ts for rationale.
export const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://cyggie-gateway.fly.dev'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  readonly reauthRequired: boolean

  constructor(opts: {
    status: number
    code: string
    message: string
    details?: unknown
    reauthRequired?: boolean
  }) {
    super(opts.message)
    this.status = opts.status
    this.code = opts.code
    this.details = opts.details
    this.reauthRequired = opts.reauthRequired ?? false
  }
}

interface GatewayErrorBody {
  error?: { code?: string; message?: string; details?: unknown }
  reauth_required?: boolean
}

interface FetchOpts<TBody> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: TBody
  // Set to true to skip auth injection (e.g., for /auth/google/start).
  unauthenticated?: boolean
  // AbortSignal forwarded to fetch.
  signal?: AbortSignal
}

let refreshInFlight: Promise<string | null> | null = null

/**
 * Force a /auth/refresh round-trip and update the auth store with the
 * rotated tokens. Returns the new access token, or null when refresh
 * fails (e.g. revoked refresh token — the store is signed out in that
 * case).
 *
 * Exported so the multipart upload path
 * ([recordings.ts](./recordings.ts)) can mirror the canonical 401 →
 * refresh → retry pattern without going through `apiFetch` (which
 * doesn't support the native createUploadTask transport). All callers
 * share the single in-flight promise so concurrent 401s coalesce.
 */
export async function ensureFreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const refreshToken = await getRefreshToken()
      if (!refreshToken) return null
      const deviceId = await getOrCreateDeviceId()
      const result = await refreshTokens({ refreshToken, deviceId })
      if ('error' in result) {
        await useAuthStore.getState().signOut()
        return null
      }
      await useAuthStore
        .getState()
        .updateTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken })
      return result.accessToken
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

export async function apiFetch<TResponse = unknown, TBody = unknown>(
  path: string,
  opts: FetchOpts<TBody> = {},
): Promise<TResponse> {
  const url = `${GATEWAY_URL}${path}`
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const attemptFetch = async (token: string | null): Promise<Response> => {
    if (token && !opts.unauthenticated) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      delete headers['Authorization']
    }
    return fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  }

  // First attempt with the current access token.
  let token = opts.unauthenticated ? null : useAuthStore.getState().accessToken
  let res = await attemptFetch(token)

  // 401 → maybe refresh and retry.
  if (res.status === 401 && !opts.unauthenticated) {
    const body = (await res.clone().json().catch(() => ({}))) as GatewayErrorBody
    console.log('[auth] api: 401 on ' + path + ' reauth_required=' + (body.reauth_required === true))
    if (body.reauth_required) {
      // Gateway is explicit: refresh won't help. Surface a typed error and
      // let per-screen handlers decide what to do. Critically, do NOT
      // signOut() here: the gateway emits `reauth_required` for Google-side
      // problems too (e.g. /calendar/events when the user's Google OAuth
      // token is revoked or missing the required scope), and wiping the
      // Cyggie session in that case produced an infinite sign-in loop —
      // the Cyggie JWT was fine; only the Google credentials were broken.
      throw new ApiError({
        status: 401,
        code: body.error?.code ?? 'REAUTH_REQUIRED',
        message: body.error?.message ?? 'Reauth required',
        details: body.error?.details,
        reauthRequired: true,
      })
    }
    // Try a silent refresh, then retry once.
    const fresh = await ensureFreshAccessToken()
    if (!fresh) {
      console.log('[auth] api: refresh failed on ' + path + ' — store should now be signed_out')
      // Set reauthRequired so per-screen reauth handlers (meeting detail,
      // calendar, notes, etc.) all route to sign-in. Without this flag the
      // user is stranded on whatever screen they're on with a generic 401
      // even though the store is already signed out.
      throw new ApiError({
        status: 401,
        code: body.error?.code ?? 'UNAUTHENTICATED',
        message: body.error?.message ?? 'Not signed in',
        reauthRequired: true,
      })
    }
    console.log('[auth] api: refresh succeeded, retrying ' + path)
    token = fresh
    res = await attemptFetch(token)
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as GatewayErrorBody
    throw new ApiError({
      status: res.status,
      code: body.error?.code ?? `HTTP_${res.status}`,
      message: body.error?.message ?? `Request failed (${res.status})`,
      details: body.error?.details,
      reauthRequired: body.reauth_required === true,
    })
  }

  // Empty responses (e.g., 204) — caller's responsibility to type as void.
  const text = await res.text()
  if (text.length === 0) return undefined as TResponse
  return JSON.parse(text) as TResponse
}

/**
 * Raw fetch — returns the parsed body and status code without throwing on
 * non-2xx. Used by the sync agent which needs the 409 response body to
 * surface conflict resolution UI.
 *
 * Shares the 401 → refresh → retry flow with apiFetch.
 */
export async function apiFetchRaw<TBody = unknown>(
  path: string,
  opts: FetchOpts<TBody> = {},
): Promise<{ status: number; body: unknown }> {
  const url = `${GATEWAY_URL}${path}`
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const attemptFetch = async (token: string | null): Promise<Response> => {
    if (token && !opts.unauthenticated) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      delete headers['Authorization']
    }
    return fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    })
  }

  let token = opts.unauthenticated ? null : useAuthStore.getState().accessToken
  let res = await attemptFetch(token)

  if (res.status === 401 && !opts.unauthenticated) {
    const body = (await res.clone().json().catch(() => ({}))) as GatewayErrorBody
    if (!body.reauth_required) {
      const fresh = await ensureFreshAccessToken()
      if (fresh) {
        token = fresh
        res = await attemptFetch(token)
      }
    }
  }

  const status = res.status
  const text = await res.text()
  if (text.length === 0) return { status, body: null }
  try {
    return { status, body: JSON.parse(text) }
  } catch {
    return { status, body: text }
  }
}

// Convenience wrappers.
export const api = {
  get: <T = unknown>(path: string, opts?: Omit<FetchOpts<never>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...opts, method: 'GET' }),
  post: <T = unknown, B = unknown>(path: string, body?: B, opts?: Omit<FetchOpts<B>, 'method' | 'body'>) =>
    apiFetch<T, B>(path, { ...opts, method: 'POST', body }),
  patch: <T = unknown, B = unknown>(
    path: string,
    body?: B,
    opts?: Omit<FetchOpts<B>, 'method' | 'body'>,
  ) => apiFetch<T, B>(path, { ...opts, method: 'PATCH', body }),
  delete: <T = unknown>(path: string, opts?: Omit<FetchOpts<never>, 'method' | 'body'>) =>
    apiFetch<T>(path, { ...opts, method: 'DELETE' }),
}
