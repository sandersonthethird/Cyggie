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
  __resetForTest: resetAgent,
  configureSyncAgent,
  drainNow,
} = await import('../agent')
type PatchExecutor = Parameters<typeof configureSyncAgent>[0]['patch']
type PatchResult = Awaited<ReturnType<PatchExecutor>>
const {
  __resetForTest: resetOutbox,
  __setOutboxStorageForTest,
  enqueue,
  loadAll,
  loadDLQ,
} = await import('../outbox')
const {
  __resetForTest: resetClock,
  __setClockStorageForTest,
  current: clockNow,
} = await import('../clock')

function memStorage() {
  const map = new Map<string, string>()
  return {
    getString: (k: string) => map.get(k),
    set: (k: string, v: string) => map.set(k, v),
    delete: (k: string) => {
      map.delete(k)
    },
  }
}

interface QueuedResponse {
  status: number
  body?: unknown
  shouldThrow?: string
}

function makeExecutor(responses: QueuedResponse[]): {
  exec: PatchExecutor
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  const exec: PatchExecutor = async (url, body) => {
    calls.push({ url, body })
    const next = responses.shift()
    if (!next) return { status: 200, body: { lamport: '1' } }
    if (next.shouldThrow) throw new Error(next.shouldThrow)
    return next as PatchResult
  }
  return { exec, calls }
}

describe('sync/agent', () => {
  let restoreOutbox: () => void
  let restoreClock: () => void

  beforeEach(() => {
    restoreOutbox = __setOutboxStorageForTest(memStorage())
    restoreClock = __setClockStorageForTest(memStorage())
    resetOutbox()
    resetClock()
    resetAgent()
  })
  afterEach(() => {
    restoreOutbox()
    restoreClock()
  })

  it('returns no-op summary when no executor configured', async () => {
    const summary = await drainNow()
    expect(summary).toEqual({
      attempted: 0,
      applied: 0,
      conflicts: 0,
      retries: 0,
      deadLetters: 0,
    })
  })

  it('applies 2xx + removes from outbox + merges lamport', async () => {
    const { exec, calls } = makeExecutor([
      { status: 200, body: { id: 'm1', lamport: '42' } },
    ])
    configureSyncAgent({ patch: exec })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'hi', lamport: '5' },
    })

    const summary = await drainNow()
    expect(summary.applied).toBe(1)
    expect(summary.attempted).toBe(1)
    expect(loadAll()).toEqual([])
    expect(calls[0]?.url).toBe('/meetings/m1')
    // Clock merged → 42 + 1 = 43
    expect(clockNow()).toBe('43')
  })

  it('dispatches onConflict + drops entry on 409', async () => {
    const onConflict = vi.fn()
    const { exec } = makeExecutor([
      { status: 409, body: { id: 'm1', lamport: '99', notes: 'server wins' } },
    ])
    configureSyncAgent({ patch: exec, onConflict })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'mine', lamport: '5' },
    })

    const summary = await drainNow()
    expect(summary.conflicts).toBe(1)
    expect(loadAll()).toEqual([])
    expect(onConflict).toHaveBeenCalledTimes(1)
    expect(onConflict.mock.calls[0][0]).toMatchObject({
      meetingId: 'm1',
      server: { id: 'm1', notes: 'server wins' },
    })
  })

  it('bumps retry on 5xx (no DLQ until MAX_RETRIES)', async () => {
    const { exec } = makeExecutor([{ status: 503 }])
    configureSyncAgent({ patch: exec })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'x', lamport: '1' },
    })

    const summary = await drainNow()
    expect(summary.retries).toBe(1)
    const all = loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]!.retries).toBe(1)
    expect(all[0]!.lastError).toBe('http_503')
  })

  it('moves to DLQ on permanent 404', async () => {
    const onDLQ = vi.fn()
    const { exec } = makeExecutor([{ status: 404 }])
    configureSyncAgent({ patch: exec, onDLQ })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'x', lamport: '1' },
    })

    const summary = await drainNow()
    expect(summary.deadLetters).toBe(1)
    expect(loadAll()).toEqual([])
    expect(loadDLQ()).toHaveLength(1)
    expect(onDLQ).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'm1' }), 'http_404')
  })

  it('moves to DLQ after MAX_RETRIES transient failures', async () => {
    // 10 consecutive 503s; the 10th attempt should DLQ.
    const responses: QueuedResponse[] = Array.from({ length: 10 }, () => ({ status: 503 }))
    const { exec } = makeExecutor(responses)
    configureSyncAgent({ patch: exec })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'x', lamport: '1' },
    })

    for (let i = 0; i < 9; i++) {
      await drainNow()
    }
    // After 9 retries, still in outbox.
    expect(loadAll()).toHaveLength(1)
    expect(loadAll()[0]!.retries).toBe(9)
    // 10th attempt triggers DLQ.
    await drainNow()
    expect(loadAll()).toEqual([])
    expect(loadDLQ()).toHaveLength(1)
  })

  it('treats network exception same as transient (bumps retry)', async () => {
    const { exec } = makeExecutor([{ shouldThrow: 'TypeError: network', status: 0 }])
    configureSyncAgent({ patch: exec })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'x', lamport: '1' },
    })

    const summary = await drainNow()
    expect(summary.retries).toBe(1)
    expect(loadAll()[0]!.retries).toBe(1)
  })

  it('single-flight: concurrent drainNow calls collapse to one drain', async () => {
    let releasePending: ((r: PatchResult) => void) | null = null
    const exec: PatchExecutor = () =>
      new Promise<PatchResult>((resolve) => {
        releasePending = resolve
      })
    configureSyncAgent({ patch: exec })
    enqueue({
      op: 'meeting.notes.update',
      resourceId: 'm1',
      payload: { notes: 'x', lamport: '1' },
    })

    const first = drainNow()
    // Trigger a second drain while the first is still in flight.
    const second = drainNow()
    const secondSummary = await second
    expect(secondSummary.skippedConcurrent).toBe(true)
    // Release the executor → first drain completes.
    releasePending!({ status: 200, body: { lamport: '2' } })
    const firstSummary = await first
    expect(firstSummary.attempted).toBe(1)
    expect(firstSummary.applied).toBe(1)
  })

  it('drains entries in FIFO order', async () => {
    const { exec, calls } = makeExecutor([
      { status: 200, body: { lamport: '2' } },
      { status: 200, body: { lamport: '3' } },
    ])
    configureSyncAgent({ patch: exec })
    const a = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'a',
      payload: { notes: '', lamport: '1' },
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = enqueue({
      op: 'meeting.notes.update',
      resourceId: 'b',
      payload: { notes: '', lamport: '1' },
    })
    void a
    void b
    await drainNow()
    expect(calls.map((c) => c.url)).toEqual(['/meetings/a', '/meetings/b'])
  })
})
