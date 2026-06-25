import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory MMKV covers both pull.ts's lamport storage and clock.ts.
const mmkvStore = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    set: (k: string, v: string) => void mmkvStore.set(k, v),
    getString: (k: string) => mmkvStore.get(k),
    delete: (k: string) => void mmkvStore.delete(k),
  },
}))

const apiGetMock = vi.fn()
vi.mock('../../api/client', () => ({
  api: { get: apiGetMock, post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

const { pullSince, getLastPullLamport, __resetForTest } = await import('../pull')

interface Page {
  meetings: Array<{ id: string }>
  serverLamport: string
  hasMore?: boolean
}
function queuePages(...pages: Page[]): void {
  apiGetMock.mockReset()
  for (const p of pages) apiGetMock.mockResolvedValueOnce(p)
}
function sincesCalled(): string[] {
  return apiGetMock.mock.calls.map((c) => {
    const m = /since=([^&]+)/.exec(c[0] as string)
    return m ? decodeURIComponent(m[1]!) : ''
  })
}

beforeEach(() => {
  mmkvStore.clear()
  __resetForTest()
})
afterEach(() => vi.restoreAllMocks())

describe('pullSince — drains all pages', () => {
  it('loops while hasMore, accumulating rows and advancing the cursor', async () => {
    queuePages(
      { meetings: [{ id: 'm1' }, { id: 'm2' }], serverLamport: '10', hasMore: true },
      { meetings: [{ id: 'm3' }], serverLamport: '20', hasMore: true },
      { meetings: [{ id: 'm4' }], serverLamport: '30', hasMore: false },
    )

    const res = await pullSince()

    expect(apiGetMock).toHaveBeenCalledTimes(3)
    expect(sincesCalled()).toEqual(['0', '10', '20']) // cursor advances each page
    expect(res.changedIds).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(res.meetings).toHaveLength(4)
    expect(res.serverLamport).toBe('30')
    expect(getLastPullLamport()).toBe('30') // persisted high-water-mark
  })

  it('single page (hasMore falsey) → one call (back-compat with old gateway)', async () => {
    queuePages({ meetings: [{ id: 'm1' }], serverLamport: '5' })
    const res = await pullSince()
    expect(apiGetMock).toHaveBeenCalledTimes(1)
    expect(res.meetings).toHaveLength(1)
    expect(getLastPullLamport()).toBe('5')
  })

  it('persists the cursor per page, so a mid-drain failure resumes from the last page', async () => {
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValueOnce({ meetings: [{ id: 'm1' }], serverLamport: '10', hasMore: true })
    apiGetMock.mockRejectedValueOnce(new Error('network'))

    await expect(pullSince()).rejects.toThrow('network')
    expect(getLastPullLamport()).toBe('10') // page 1's cursor survived
  })
})

describe('pullSince — guards', () => {
  it('stops (no infinite loop) when hasMore=true but the cursor does not advance', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // serverLamport never moves past since → degenerate ceiling
    apiGetMock.mockReset()
    apiGetMock.mockResolvedValue({ meetings: [{ id: 'm1' }], serverLamport: '0', hasMore: true })

    const res = await pullSince()

    expect(apiGetMock).toHaveBeenCalledTimes(1)
    expect(res.meetings).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not advance'))
  })

  it('stops at the page cap and logs, leaving the rest for the next pull', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // always hasMore, always advancing → would loop forever without the cap
    let n = 0
    apiGetMock.mockReset()
    apiGetMock.mockImplementation(async () => {
      n += 1
      return { meetings: [{ id: `m${n}` }], serverLamport: String(n * 10), hasMore: true }
    })

    const res = await pullSince()

    expect(apiGetMock).toHaveBeenCalledTimes(50) // MAX_PULL_PAGES
    expect(res.meetings).toHaveLength(50)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cap'))
  })

  it('threads the AbortSignal through every page', async () => {
    const signal = new AbortController().signal
    queuePages(
      { meetings: [{ id: 'm1' }], serverLamport: '10', hasMore: true },
      { meetings: [{ id: 'm2' }], serverLamport: '20', hasMore: false },
    )
    await pullSince({ signal })
    for (const call of apiGetMock.mock.calls) {
      expect(call[1]).toMatchObject({ signal })
    }
  })
})
