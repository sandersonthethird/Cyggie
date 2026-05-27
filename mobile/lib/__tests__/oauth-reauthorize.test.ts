import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// Tests for the reauthorizeGoogle helper extracted in oauth.ts. The helper
// wraps startSignIn + the iOS dismiss-after-success recovery polling, and
// is shared between sign-in.tsx (initial auth) and calendar.tsx (Reconnect
// Google after REAUTH_REQUIRED).

vi.mock('../auth/device', () => ({
  getOrCreateDeviceId: vi.fn(async () => 'test-device-id'),
}))

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  dismissAuthSession: vi.fn(async () => undefined),
}))

import * as WebBrowser from 'expo-web-browser'
import { reauthorizeGoogle } from '../auth/oauth'

const openAuthSessionAsyncMock = WebBrowser.openAuthSessionAsync as unknown as ReturnType<
  typeof vi.fn
>

const SUCCESS_CALLBACK =
  'cyggie://auth-callback' +
  '?session=test-access' +
  '&refresh=test-refresh' +
  '&user_id=u_1' +
  '&action=returning'

const originalFetch = globalThis.fetch

beforeEach(() => {
  openAuthSessionAsyncMock.mockReset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('reauthorizeGoogle', () => {
  test('t8: forwards Authorization: Bearer ${authToken} on /auth/google/start', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/auth/google/start')) {
        return new Response(
          JSON.stringify({
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            state: 's1',
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    openAuthSessionAsyncMock.mockResolvedValueOnce({ type: 'success', url: SUCCESS_CALLBACK })

    const result = await reauthorizeGoogle({ authToken: 'token-abc' })

    expect(result.kind).toBe('success')
    const startCall = fetchMock.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : (input as URL).toString()).endsWith('/auth/google/start'),
    )
    expect(startCall).toBeDefined()
    const headers = (startCall![1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer token-abc')
  })

  test('t8b: no authToken → no Authorization header (sign-in.tsx case)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/auth/google/start')) {
        return new Response(
          JSON.stringify({
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            state: 's1',
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    openAuthSessionAsyncMock.mockResolvedValueOnce({ type: 'success', url: SUCCESS_CALLBACK })

    await reauthorizeGoogle()

    const startCall = fetchMock.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : (input as URL).toString()).endsWith('/auth/google/start'),
    )
    const headers = (startCall![1] as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  test('t9: on cancel, fires onRecovering callback and polls /claim-by-device', async () => {
    const onRecovering = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/auth/google/start')) {
        return new Response(
          JSON.stringify({
            authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
            state: 's2',
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/auth/session/claim-by-device')) {
        // First attempt returns a recovered session so we don't wait the full
        // 15 s polling timeout — the helper short-circuits on the first 200.
        return new Response(
          JSON.stringify({
            session: 'rec-access',
            refresh: 'rec-refresh',
            user_id: 'u_rec',
            action: 'returning',
            email: 'rec@example.com',
          }),
          { status: 200 },
        )
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    openAuthSessionAsyncMock.mockResolvedValueOnce({ type: 'cancel' })

    const result = await reauthorizeGoogle({ onRecovering })

    expect(onRecovering).toHaveBeenCalledTimes(1)
    const claimCall = fetchMock.mock.calls.find(([input]) =>
      (typeof input === 'string' ? input : (input as URL).toString()).endsWith(
        '/auth/session/claim-by-device',
      ),
    )
    expect(claimCall).toBeDefined()
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.userId).toBe('u_rec')
    }
  })
})
