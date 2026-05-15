/**
 * Unit tests for ipcCache — the renderer-side IPC response cache.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ipcCache } from '../renderer/api/ipcCache'

beforeEach(() => {
  ipcCache._resetForTests()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-15T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ipcCache', () => {
  it('returns the fetcher value on first call and caches it on subsequent calls', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ id: 'a' }])
    const a = await ipcCache.get('CHAN', { x: 1 }, fetcher)
    const b = await ipcCache.get('CHAN', { x: 1 }, fetcher)
    expect(a).toEqual([{ id: 'a' }])
    expect(b).toEqual([{ id: 'a' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('treats different args as different keys', async () => {
    const fetcher = vi.fn().mockImplementation((args: { x: number }) => Promise.resolve(args.x))
    await ipcCache.get('CHAN', { x: 1 }, () => fetcher({ x: 1 }))
    await ipcCache.get('CHAN', { x: 2 }, () => fetcher({ x: 2 }))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('treats args with same shape but different key order as the same key', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    await ipcCache.get('CHAN', { a: 1, b: 2 }, fetcher)
    await ipcCache.get('CHAN', { b: 2, a: 1 }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent in-flight requests', async () => {
    let resolveIt: (v: string) => void = () => {}
    const fetcher = vi.fn().mockImplementation(() => new Promise<string>((res) => { resolveIt = res }))
    const p1 = ipcCache.get('CHAN', { x: 1 }, fetcher)
    const p2 = ipcCache.get('CHAN', { x: 1 }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolveIt('value')
    const [v1, v2] = await Promise.all([p1, p2])
    expect(v1).toBe('value')
    expect(v2).toBe('value')
  })

  it('refetches after TTL expires', async () => {
    const fetcher = vi.fn().mockResolvedValue('a')
    await ipcCache.get('CHAN', null, fetcher, { ttlMs: 1000 })
    vi.setSystemTime(new Date('2026-05-15T12:00:00.500Z'))
    await ipcCache.get('CHAN', null, fetcher, { ttlMs: 1000 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-05-15T12:00:01.500Z'))
    await ipcCache.get('CHAN', null, fetcher, { ttlMs: 1000 })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache failures — next call retries', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok')
    await expect(ipcCache.get('CHAN', null, fetcher)).rejects.toThrow('boom')
    const v = await ipcCache.get('CHAN', null, fetcher)
    expect(v).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('invalidate(channel) drops all entries for the channel', async () => {
    const fetcher = vi.fn().mockResolvedValue('x')
    await ipcCache.get('CHAN', { a: 1 }, fetcher)
    await ipcCache.get('CHAN', { a: 2 }, fetcher)
    await ipcCache.get('OTHER', { a: 1 }, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(3)
    ipcCache.invalidate('CHAN')
    await ipcCache.get('CHAN', { a: 1 }, fetcher)
    await ipcCache.get('CHAN', { a: 2 }, fetcher)
    await ipcCache.get('OTHER', { a: 1 }, fetcher) // still cached
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('invalidate(channel, matcher) drops only matching entries', async () => {
    const fetcher = vi.fn().mockResolvedValue('x')
    await ipcCache.get('CHAN', { a: 1 }, fetcher)
    await ipcCache.get('CHAN', { a: 2 }, fetcher)
    ipcCache.invalidate('CHAN', (args) => (args as { a: number }).a === 1)
    await ipcCache.get('CHAN', { a: 1 }, fetcher) // refetched
    await ipcCache.get('CHAN', { a: 2 }, fetcher) // still cached
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
