import { beforeEach, describe, expect, it, vi } from 'vitest'

// MMKV isn't loadable in Node — back it with an in-memory Map for tests.
// Tests then exercise the persistence logic through this fake.
const memStore = new Map<string, string>()
vi.mock('../../cache/mmkv', () => ({
  appStateStorage: {
    getString: (k: string) => memStore.get(k),
    set: (k: string, v: string) => {
      memStore.set(k, v)
    },
    delete: (k: string) => {
      memStore.delete(k)
    },
  },
}))

// Each test re-imports the store fresh so loadInitial() sees the
// current memStore state. Without resetModules, the first import
// caches loadInitial()'s result for the entire suite.
async function freshStore() {
  vi.resetModules()
  return (await import('../store')).useCalendarStore
}

describe('calendar/store', () => {
  beforeEach(() => {
    memStore.clear()
  })

  it('starts with an empty set when MMKV has no entry', async () => {
    const useCalendarStore = await freshStore()
    expect(useCalendarStore.getState().dismissedIds.size).toBe(0)
    expect(useCalendarStore.getState().isDismissed('any-id')).toBe(false)
  })

  it('dismiss(id) adds to the set and persists to MMKV', async () => {
    const useCalendarStore = await freshStore()
    useCalendarStore.getState().dismiss('event-1')

    expect(useCalendarStore.getState().isDismissed('event-1')).toBe(true)
    expect(useCalendarStore.getState().dismissedIds.size).toBe(1)
    expect(memStore.get('calendar.dismissedIds')).toBe(JSON.stringify(['event-1']))
  })

  it('dismiss(id) is idempotent — calling twice does not change state', async () => {
    const useCalendarStore = await freshStore()
    useCalendarStore.getState().dismiss('event-1')
    const firstRef = useCalendarStore.getState().dismissedIds
    useCalendarStore.getState().dismiss('event-1')
    const secondRef = useCalendarStore.getState().dismissedIds

    expect(secondRef.size).toBe(1)
    expect(secondRef).toBe(firstRef) // no spurious state replacement
  })

  it('undismissAll() clears the set and removes the MMKV key', async () => {
    const useCalendarStore = await freshStore()
    useCalendarStore.getState().dismiss('a')
    useCalendarStore.getState().dismiss('b')
    expect(memStore.has('calendar.dismissedIds')).toBe(true)

    useCalendarStore.getState().undismissAll()
    expect(useCalendarStore.getState().dismissedIds.size).toBe(0)
    expect(memStore.has('calendar.dismissedIds')).toBe(false)
  })

  it('undismissAll() is a no-op when already empty (no spurious MMKV write)', async () => {
    const useCalendarStore = await freshStore()
    const before = useCalendarStore.getState().dismissedIds
    useCalendarStore.getState().undismissAll()
    expect(useCalendarStore.getState().dismissedIds).toBe(before)
  })

  it('cold-load: store hydrates dismissedIds from MMKV on first import', async () => {
    memStore.set('calendar.dismissedIds', JSON.stringify(['x', 'y', 'z']))
    const useCalendarStore = await freshStore()

    expect(useCalendarStore.getState().dismissedIds.size).toBe(3)
    expect(useCalendarStore.getState().isDismissed('x')).toBe(true)
    expect(useCalendarStore.getState().isDismissed('y')).toBe(true)
    expect(useCalendarStore.getState().isDismissed('z')).toBe(true)
    expect(useCalendarStore.getState().isDismissed('unknown')).toBe(false)
  })

  it('cold-load: corrupt MMKV blob is recovered to an empty set', async () => {
    memStore.set('calendar.dismissedIds', '{not valid json')
    const useCalendarStore = await freshStore()
    expect(useCalendarStore.getState().dismissedIds.size).toBe(0)
  })

  it('cold-load: non-string entries in the stored array are filtered out', async () => {
    memStore.set('calendar.dismissedIds', JSON.stringify(['valid', 42, null, 'also-valid']))
    const useCalendarStore = await freshStore()
    expect(useCalendarStore.getState().dismissedIds.size).toBe(2)
    expect(useCalendarStore.getState().isDismissed('valid')).toBe(true)
    expect(useCalendarStore.getState().isDismissed('also-valid')).toBe(true)
  })
})
