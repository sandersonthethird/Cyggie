// Regression tests for the OAuth-loop fix:
// when the gateway returns 401 with reauth_required=true, apiFetch must
// throw a typed ApiError but must NOT call signOut(). Previously it
// signed the user out, which produced an infinite sign-in loop whenever
// /calendar/events returned reauth_required=true because the user's
// server-side Google OAuth tokens were broken (NOT their Cyggie JWT).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock factories are hoisted to the top of the file, so top-level
// `const` references inside them are TDZ traps. Use vi.hoisted to surface
// the spies before the factory runs.
const { signOutSpy, updateTokensSpy, refreshTokensSpy } = vi.hoisted(() => ({
  signOutSpy: vi.fn(),
  updateTokensSpy: vi.fn(),
  refreshTokensSpy: vi.fn(),
}))

vi.mock('../../auth/store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'cyggie-jwt',
      signOut: signOutSpy,
      updateTokens: updateTokensSpy,
    }),
  },
}))

vi.mock('../../auth/oauth', () => ({
  refreshTokens: refreshTokensSpy,
}))
vi.mock('../../auth/storage', () => ({
  getRefreshToken: vi.fn().mockResolvedValue('refresh-token'),
}))
vi.mock('../../auth/device', () => ({
  getOrCreateDeviceId: vi.fn().mockResolvedValue('test-device'),
}))

import { apiFetch, ApiError } from '../client'

const fetchSpy = vi.spyOn(global, 'fetch')

beforeEach(() => {
  fetchSpy.mockReset()
  signOutSpy.mockReset()
  updateTokensSpy.mockReset()
  refreshTokensSpy.mockReset()
})
// No afterEach restoreAllMocks — that would un-spy global.fetch and the
// next test's mockResolvedValueOnce would silently miss.

function makeReauthRequired401(): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'REAUTH_REQUIRED', message: 'Google access has expired or been revoked' },
      reauth_required: true,
    }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )
}

describe('apiFetch 401 with reauth_required=true (Google-side reauth)', () => {
  it('throws ApiError preserving the gateway error code', async () => {
    fetchSpy.mockResolvedValueOnce(makeReauthRequired401())

    await expect(apiFetch('/calendar/events')).rejects.toMatchObject({
      status: 401,
      code: 'REAUTH_REQUIRED',
    } satisfies Partial<ApiError>)
  })

  it('throws with reauthRequired=false so screen-level handlers do NOT redirect to sign-in', async () => {
    // Every reauth_required=true response that reaches apiFetch's 401
    // branch is a Google-side issue (the Cyggie JWT is fine; the user's
    // server-side Google OAuth tokens are broken). The 8 screens with
    // a `useEffect(() => signOut+redirect, [query.error])` pattern keyed
    // on reauthRequired would wipe the Cyggie session otherwise, producing
    // the OAuth-loop bug (sign in → calendar 401 → signOut → bounce).
    fetchSpy.mockResolvedValueOnce(makeReauthRequired401())

    let caught: ApiError | undefined
    try {
      await apiFetch('/calendar/events')
    } catch (err) {
      caught = err as ApiError
    }
    expect(caught).toBeInstanceOf(ApiError)
    expect(caught?.reauthRequired).toBe(false)
  })

  it('does NOT call useAuthStore.signOut() — the Cyggie JWT may still be valid', async () => {
    fetchSpy.mockResolvedValueOnce(makeReauthRequired401())

    await expect(apiFetch('/calendar/events')).rejects.toBeInstanceOf(ApiError)
    expect(signOutSpy).not.toHaveBeenCalled()
  })

  it('does NOT attempt a token refresh — the gateway said refresh won’t help', async () => {
    fetchSpy.mockResolvedValueOnce(makeReauthRequired401())

    await expect(apiFetch('/calendar/events')).rejects.toBeInstanceOf(ApiError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(refreshTokensSpy).not.toHaveBeenCalled()
  })
})

describe('apiFetch 401 without reauth_required (refresh path)', () => {
  it('attempts a silent refresh and retries once', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: 'EXPIRED', message: 'access token expired' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

    refreshTokensSpy.mockResolvedValueOnce({
      accessToken: 'fresh-jwt',
      refreshToken: 'fresh-refresh',
    })

    const result = await apiFetch<{ ok: boolean }>('/meetings/abc')
    expect(result.ok).toBe(true)
    expect(refreshTokensSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(signOutSpy).not.toHaveBeenCalled()
  })
})
