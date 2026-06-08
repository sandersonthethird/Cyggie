// Eng-review Issue 4B/4C — mobile abort plumbing for enhanceMeeting().
//
// The route handler at the gateway has its own 30s server-side timeout;
// mobile pads to 45s in the screen component. This test verifies the
// API helper correctly forwards the AbortSignal to fetch so the screen's
// AbortController actually cancels the in-flight request.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// useAuthStore — minimal stub so the api client can read the token.
vi.mock('../../auth/store', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: 'fake-token' }),
  },
}))

// Token refresh path — never invoked in these tests, but the import
// resolves so api/client.ts loads.
vi.mock('../../auth/oauth', () => ({
  refreshTokens: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../auth/storage', () => ({
  getRefreshToken: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../auth/device', () => ({
  getOrCreateDeviceId: vi.fn().mockResolvedValue('test-device'),
}))

// meetings.ts now imports the lamport clock, which transitively pulls in
// react-native-mmkv (a native module the node runner can't parse). Stub the
// cache layer so the import chain resolves.
const mmkvStore = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    set: (key: string, value: string) => {
      mmkvStore.set(key, value)
    },
    getString: (key: string) => mmkvStore.get(key),
    delete: (key: string) => {
      mmkvStore.delete(key)
    },
  },
}))

import { enhanceMeeting } from '../meetings'

const fetchSpy = vi.spyOn(global, 'fetch')

beforeEach(() => {
  fetchSpy.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('enhanceMeeting AbortSignal forwarding', () => {
  it('forwards the signal to fetch so the screen-level AbortController can cancel', async () => {
    fetchSpy.mockImplementation(async (_url, init): Promise<Response> => {
      // Sanity: the signal we passed must show up on the fetch init.
      expect(init?.signal).toBeDefined()
      return new Response(
        JSON.stringify({ summary: 'ok', lamport: '1', status: 'summarized' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    const controller = new AbortController()
    const result = await enhanceMeeting(
      'meeting-id-1',
      { templateId: 'general' },
      { signal: controller.signal },
    )
    expect(result.summary).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const passedSignal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal
    expect(passedSignal).toBe(controller.signal)
  })

  it('rejects with AbortError when the caller aborts before the fetch resolves', async () => {
    fetchSpy.mockImplementation((_url, init) => {
      // Simulate a hung server: respect the abort signal and reject when
      // it fires. Real fetch behaves this way per WHATWG spec.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        if (!signal) {
          reject(new Error('expected signal'))
          return
        }
        const onAbort = () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    })

    const controller = new AbortController()
    const pending = enhanceMeeting(
      'meeting-id-2',
      { templateId: 'general' },
      { signal: controller.signal },
    )

    // Caller aborts mid-flight (simulates screen unmount or 45s timeout).
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
