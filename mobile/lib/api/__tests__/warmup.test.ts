import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the client so we only pull in GATEWAY_URL (the real client transitively
// imports expo/RN auth modules we don't want under node).
vi.mock('../client', () => ({ GATEWAY_URL: 'https://gw.test' }))

const { warmGateway } = await import('../warmup')

describe('warmGateway', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pings GET /health/ready on the gateway', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    warmGateway()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gw.test/health/ready')
    expect(init.method).toBe('GET')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('never throws when the gateway is unreachable (fire-and-forget)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)

    expect(() => warmGateway()).not.toThrow()
    // let the rejected promise + .catch settle
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
