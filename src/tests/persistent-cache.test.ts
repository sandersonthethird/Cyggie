/**
 * Unit tests for persistent-cache: disk-backed JSON cache used by the
 * main process for cross-restart caching (e.g. Google Calendar events).
 *
 * Mock boundary:
 *   - electron.app.getPath('userData') → tmpdir(), so files land in a
 *     test-scoped directory and don't pollute the dev app cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let testCacheRoot: string

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => testCacheRoot },
}))

const { persistentCache } = await import('../main/cache/persistent-cache')

beforeEach(() => {
  testCacheRoot = mkdtempSync(join(tmpdir(), 'cyggie-cache-test-'))
})

afterEach(() => {
  rmSync(testCacheRoot, { recursive: true, force: true })
})

describe('persistent-cache', () => {
  it('writes and reads back a value within TTL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ items: ['a', 'b'] })
    const v1 = await persistentCache.get('events', 60_000, fetcher)
    const v2 = await persistentCache.get('events', 60_000, fetcher)
    expect(v1).toEqual({ items: ['a', 'b'] })
    expect(v2).toEqual({ items: ['a', 'b'] })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches once the entry has expired', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second')
    const v1 = await persistentCache.get('expiry', 1, fetcher) // 1ms TTL
    // Wait 5ms to clear the TTL window.
    await new Promise((r) => setTimeout(r, 5))
    const v2 = await persistentCache.get('expiry', 1, fetcher)
    expect(v1).toBe('first')
    expect(v2).toBe('second')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('treats a corrupt cache file as a miss and overwrites it', async () => {
    const fetcher = vi.fn().mockResolvedValue('fresh')
    // Seed a corrupt file.
    const corruptDir = join(testCacheRoot, 'cache')
    // First call creates the directory (via mkdirSync inside the module) — do
    // a real get first then overwrite the file with garbage.
    await persistentCache.get('corrupt', 60_000, vi.fn().mockResolvedValue('seed'))
    const filePath = join(corruptDir, 'corrupt.json')
    require('fs').writeFileSync(filePath, '{{not valid json', 'utf-8')

    const v = await persistentCache.get('corrupt', 60_000, fetcher)
    expect(v).toBe('fresh')
    expect(fetcher).toHaveBeenCalledTimes(1)
    // File was overwritten — read it and check it's valid JSON now.
    const raw = readFileSync(filePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('sanitizes keys with disallowed characters', async () => {
    const fetcher = vi.fn().mockResolvedValue('v')
    await persistentCache.get('cal:events/sandy@example.com', 60_000, fetcher)
    // Sanitized key uses underscores for colon/slash/@; file should exist
    // with that name.
    const sanitized = 'cal_events_sandy_example.com'
    expect(existsSync(join(testCacheRoot, 'cache', `${sanitized}.json`))).toBe(true)
  })

  it('invalidate(key) drops the entry so next get refetches', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce('a')
      .mockResolvedValueOnce('b')
    await persistentCache.get('inv', 60_000, fetcher)
    persistentCache.invalidate('inv')
    const v = await persistentCache.get('inv', 60_000, fetcher)
    expect(v).toBe('b')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does NOT cache fetcher failures — next call retries', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce('ok')
    await expect(persistentCache.get('fail', 60_000, fetcher)).rejects.toThrow('network down')
    const v = await persistentCache.get('fail', 60_000, fetcher)
    expect(v).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
