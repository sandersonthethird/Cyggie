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
  bumpRetry,
  enqueue,
  loadAll,
  loadDLQ,
  moveToDLQ,
  pendingCount,
  removeById,
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

describe('sync/outbox', () => {
  let restore: () => void

  beforeEach(() => {
    const mem = createMemoryStorage()
    restore = __setOutboxStorageForTest(mem)
    __resetForTest()
  })
  afterEach(() => restore())

  it('enqueues + loadAll returns FIFO ordered entries', async () => {
    const a = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-a',
      payload: { notes: 'a', lamport: '1' },
    })
    await new Promise((r) => setTimeout(r, 5)) // distinct createdAt
    const b = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-b',
      payload: { notes: 'b', lamport: '2' },
    })
    const all = loadAll()
    expect(all.map((e) => e.id)).toEqual([a.id, b.id])
  })

  it('coalesces same-(op, resourceId) — payload replaced, id preserved', () => {
    const first = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-x',
      payload: { notes: 'first', lamport: '1' },
    })
    const second = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-x',
      payload: { notes: 'second', lamport: '2' },
    })
    expect(second.id).toBe(first.id) // coalesced
    const all = loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.payload.notes).toBe('second')
    expect(all[0]!.payload.lamport).toBe('2')
  })

  it('coalescing preserves original createdAt for fair FIFO', async () => {
    const first = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-x',
      payload: { notes: 'a', lamport: '1' },
    })
    await new Promise((r) => setTimeout(r, 10))
    const second = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'mtg-x',
      payload: { notes: 'b', lamport: '2' },
    })
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('different resourceIds are independent', () => {
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: 'A', lamport: '1' },
    })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'b',
      payload: { notes: 'B', lamport: '1' },
    })
    expect(pendingCount()).toBe(2)
  })

  it('removeById drops the matching entry', () => {
    const a = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: '', lamport: '1' },
    })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'b',
      payload: { notes: '', lamport: '1' },
    })
    removeById(a.id)
    expect(loadAll().map((e) => e.resourceId)).toEqual(['b'])
  })

  it('bumpRetry increments retries + records lastError', () => {
    const e = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: '', lamport: '1' },
    })
    bumpRetry(e.id, 'http_500')
    bumpRetry(e.id, 'network')
    const all = loadAll()
    expect(all[0]!.retries).toBe(2)
    expect(all[0]!.lastError).toBe('network')
  })

  it('moveToDLQ removes from active queue + appends to DLQ', () => {
    const e = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: '', lamport: '1' },
    })
    moveToDLQ(e.id)
    expect(loadAll()).toEqual([])
    const dlq = loadDLQ()
    expect(dlq).toHaveLength(1)
    expect(dlq[0]!.id).toBe(e.id)
  })

  it('corrupt persisted blob is wiped on read (no throw)', () => {
    const mem = createMemoryStorage()
    mem.set('sync.outbox.v1', 'not-json')
    restore()
    restore = __setOutboxStorageForTest(mem)
    expect(loadAll()).toEqual([])
    // Corrupt blob was cleared so subsequent enqueue works.
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: '', lamport: '1' },
    })
    expect(pendingCount()).toBe(1)
  })

  it('drops entries missing required fields (lax filter)', () => {
    const mem = createMemoryStorage()
    mem.set(
      'sync.outbox.v1',
      JSON.stringify([
        // valid
        {
          id: 'a',
          op: 'meeting.notes.update',
          resourceId: 'r',
          payload: { notes: 'x', lamport: '1' },
          createdAt: '2026-05-21T10:00:00.000Z',
          retries: 0,
        },
        // missing payload
        { id: 'b', op: 'meeting.notes.update', resourceId: 'r2', createdAt: 't', retries: 0 },
        // wrong type
        'garbage',
      ]),
    )
    restore()
    restore = __setOutboxStorageForTest(mem)
    const all = loadAll()
    expect(all.map((e) => e.id)).toEqual(['a'])
  })
})
