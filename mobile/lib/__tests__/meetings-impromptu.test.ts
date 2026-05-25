import { afterEach, describe, expect, test, vi, type Mock } from 'vitest'

// vi.mock calls are hoisted above the imports below so meetings.ts sees the
// stubs at module load time. `client` is the module under test indirectly;
// `sync/clock` transitively pulls MMKV which can't load in Node.

vi.mock('../api/client', () => ({
  api: {
    get: vi.fn(),
  },
  apiFetchRaw: vi.fn(),
  ApiError: class ApiError extends Error {},
}))

vi.mock('../sync/clock', () => ({
  tick: () => '0',
}))

import { fetchImpromptuMeetings } from '../api/meetings'
import { api } from '../api/client'

const mockedGet = api.get as Mock

afterEach(() => {
  mockedGet.mockReset()
})

describe('fetchImpromptuMeetings', () => {
  test('calls GET /meetings/impromptu?days=7 by default and unwraps the meetings array', async () => {
    const fakeMeetings = [
      { id: 'm_1', title: 'Recording 1', date: '2026-05-25T10:00:00.000Z' },
      { id: 'm_2', title: 'Recording 2', date: '2026-05-24T15:00:00.000Z' },
    ]
    mockedGet.mockResolvedValueOnce({ meetings: fakeMeetings })

    const result = await fetchImpromptuMeetings()

    expect(mockedGet).toHaveBeenCalledTimes(1)
    const [url, opts] = mockedGet.mock.calls[0]!
    expect(url).toBe('/meetings/impromptu?days=7')
    expect(opts).toEqual({ signal: undefined })
    expect(result).toBe(fakeMeetings)
  })

  test('honors a custom days value', async () => {
    mockedGet.mockResolvedValueOnce({ meetings: [] })

    await fetchImpromptuMeetings({ days: 14 })

    expect(mockedGet).toHaveBeenCalledWith('/meetings/impromptu?days=14', {
      signal: undefined,
    })
  })

  test('forwards AbortSignal to api.get', async () => {
    mockedGet.mockResolvedValueOnce({ meetings: [] })
    const controller = new AbortController()

    await fetchImpromptuMeetings({ signal: controller.signal })

    expect(mockedGet).toHaveBeenCalledWith('/meetings/impromptu?days=7', {
      signal: controller.signal,
    })
  })

  test('propagates errors from api.get', async () => {
    mockedGet.mockRejectedValueOnce(new Error('boom'))

    await expect(fetchImpromptuMeetings()).rejects.toThrow('boom')
  })
})
