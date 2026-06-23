import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  __setOutboxStorageForTest,
  enqueue,
  loadAll,
  loadDLQ,
  moveToDLQ,
  replayFromDLQ,
  removeFromDLQ,
  clearDLQ,
  dlqCount,
  bumpRetry,
} = await import('../outbox')

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

/** Enqueue an entry then dead-letter it, returning the DLQ entry. */
function deadLetter(resourceId: string, notes: string, lamport: string) {
  const e = enqueue({
    op: 'meeting.notes.update',
    resourceId,
    payload: { notes, lamport },
  })
  // Simulate the failure path that the agent would have taken.
  bumpRetry(e.id, 'http_500')
  moveToDLQ(e.id)
  return loadDLQ().find((d) => d.id === e.id)!
}

describe('sync/outbox — dead-letter queue', () => {
  let restore: () => void

  beforeEach(() => {
    const mem = createMemoryStorage()
    restore = __setOutboxStorageForTest(mem)
    __resetForTest()
  })
  afterEach(() => restore())

  it('replayFromDLQ moves an entry DLQ→active with retries reset', () => {
    const dead = deadLetter('mtg-a', 'notes', '5')
    expect(dead.retries).toBe(1)
    expect(loadAll()).toEqual([])

    const revived = replayFromDLQ(dead.id)

    expect(revived).not.toBeNull()
    expect(loadDLQ()).toEqual([])
    const active = loadAll()
    expect(active).toHaveLength(1)
    expect(active[0]!.id).toBe(dead.id)
    expect(active[0]!.retries).toBe(0)
    expect(active[0]!.lastError).toBeUndefined()
  })

  it('replayFromDLQ PRESERVES the original lamport (does not re-stamp)', () => {
    const dead = deadLetter('mtg-a', 'notes', '42')
    const revived = replayFromDLQ(dead.id)
    // The whole point of decision 1A: a stale lamport must survive so LWW
    // resolves correctly and a newer server edit is not clobbered.
    expect(revived!.payload.lamport).toBe('42')
    expect(loadAll()[0]!.payload.lamport).toBe('42')
  })

  it('replayFromDLQ drops the dead entry when a live (op,resourceId) exists', () => {
    const dead = deadLetter('mtg-a', 'stale', '1')
    // A newer live edit for the same meeting arrives after the dead-letter.
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-a',
      payload: { notes: 'fresh', lamport: '9' },
    })

    const result = replayFromDLQ(dead.id)

    // Dead entry removed from DLQ; the live entry is untouched (newer payload
    // + lamport win — the stale dead entry would lose LWW anyway).
    expect(loadDLQ()).toEqual([])
    const active = loadAll()
    expect(active).toHaveLength(1)
    expect(active[0]!.payload.notes).toBe('fresh')
    expect(active[0]!.payload.lamport).toBe('9')
    expect(result!.payload.notes).toBe('fresh')
  })

  it('replayFromDLQ returns null for an unknown id', () => {
    deadLetter('mtg-a', 'x', '1')
    expect(replayFromDLQ('does-not-exist')).toBeNull()
    // Nothing moved.
    expect(loadDLQ()).toHaveLength(1)
    expect(loadAll()).toEqual([])
  })

  it('removeFromDLQ drops a single entry', () => {
    const a = deadLetter('mtg-a', 'a', '1')
    deadLetter('mtg-b', 'b', '1')
    expect(dlqCount()).toBe(2)

    removeFromDLQ(a.id)

    const dlq = loadDLQ()
    expect(dlq).toHaveLength(1)
    expect(dlq[0]!.resourceId).toBe('mtg-b')
  })

  it('removeFromDLQ is a no-op for an unknown id', () => {
    deadLetter('mtg-a', 'a', '1')
    removeFromDLQ('nope')
    expect(dlqCount()).toBe(1)
  })

  it('clearDLQ empties the whole queue', () => {
    deadLetter('mtg-a', 'a', '1')
    deadLetter('mtg-b', 'b', '1')
    expect(dlqCount()).toBe(2)

    clearDLQ()

    expect(loadDLQ()).toEqual([])
    expect(dlqCount()).toBe(0)
  })

  it('dlqCount reflects the queue size', () => {
    expect(dlqCount()).toBe(0)
    deadLetter('mtg-a', 'a', '1')
    expect(dlqCount()).toBe(1)
  })

  it('corrupt DLQ blob reads as empty (no throw)', () => {
    const mem = createMemoryStorage()
    mem.set('sync.outbox.dlq.v1', 'not-json')
    restore()
    restore = __setOutboxStorageForTest(mem)

    expect(loadDLQ()).toEqual([])
    expect(dlqCount()).toBe(0)
    // Corrupt blob was cleared, so a subsequent dead-letter works.
    deadLetter('mtg-a', 'a', '1')
    expect(dlqCount()).toBe(1)
  })
})
