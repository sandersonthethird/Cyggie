import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock MMKV at module load — react-native-mmkv pulls in RN-Flow syntax that
// the node test runner can't parse. clock.ts imports appStateStorage at the
// top level; this mock has to register BEFORE that import.
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

const {
  __resetForTest,
  __setClockStorageForTest,
  current,
  merge,
  tick,
} = await import('../clock')

// In-memory storage adapter so the test doesn't touch the real MMKV instance.
function createMemoryStorage() {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => {
      map.set(k, v)
    },
    delete: (k: string) => {
      map.delete(k)
    },
    __raw: map,
  }
}

describe('sync/clock', () => {
  let restore: () => void

  beforeEach(() => {
    const mem = createMemoryStorage()
    restore = __setClockStorageForTest(mem)
    __resetForTest()
  })
  afterEach(() => {
    restore()
    vi.useRealTimers()
  })

  it('starts at 0', () => {
    expect(current()).toBe('0')
  })

  it('tick returns max(stored, Date.now()) + 1', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    expect(tick()).toBe('1700000000001')
    // Same ms: stored (1700000000001) > now (1700000000000), so +1 from stored.
    expect(tick()).toBe('1700000000002')
    // Wall clock advances past stored: jumps to now+1.
    vi.setSystemTime(new Date(1_700_000_005_000))
    expect(tick()).toBe('1700000005001')
    expect(current()).toBe('1700000005001')
  })

  it('merge advances local to max(local, server) + 1', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    tick() // 1700000000001
    tick() // 1700000000002
    merge('1700000000010')
    expect(current()).toBe('1700000000011')
    // Local already ahead: server stays behind, local + 1.
    merge('1700000000005')
    expect(current()).toBe('1700000000012')
  })

  it('handles BigInt-range values', () => {
    merge('99999999999999999999')
    // Next tick must still be strictly greater.
    const next = BigInt(tick())
    expect(next > 99999999999999999999n).toBe(true)
  })

  it('treats malformed persisted value as 0 (does not throw)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    const mem = createMemoryStorage()
    mem.set('sync.clock.lamport', 'not-a-number')
    restore()
    restore = __setClockStorageForTest(mem)
    expect(current()).toBe('0')
    expect(tick()).toBe('1700000000001')
  })

  it('ignores malformed merge input rather than throwing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_700_000_000_000))
    tick() // 1700000000001
    merge('garbage')
    expect(current()).toBe('1700000000001')
  })
})
