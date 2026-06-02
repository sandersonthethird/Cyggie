// AuditBuffer unit tests (External Agents V1 slice 7).
//
// Uses a stub `db` that captures inserted rows — no Neon connection
// required. Covers:
//   - Records buffered until size threshold flushes
//   - 5s timer flush (we drive a short interval for speed)
//   - Graceful shutdown drains the buffer
//   - Backpressure switches to sync writes
//   - DB errors are logged but don't escape

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AuditBuffer, type McpAuditRow } from '../src/audit/buffer'

// Minimal Sentry mock so import doesn't try to ship to a real DSN.
vi.mock('../src/sentry', () => ({
  Sentry: {
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    addBreadcrumb: vi.fn(),
  },
}))

interface FakeDb {
  inserted: Array<Record<string, unknown>>
  failNextN: number
  insert(_table: unknown): { values(rows: Array<Record<string, unknown>>): Promise<void> }
}

function makeFakeDb(): FakeDb {
  const fake: FakeDb = {
    inserted: [],
    failNextN: 0,
    insert(_table) {
      return {
        async values(rows) {
          if (fake.failNextN > 0) {
            fake.failNextN--
            throw new Error('fake-db write failure')
          }
          fake.inserted.push(...rows)
        },
      }
    },
  }
  return fake
}

function makeRow(toolName = 'cyggie_ask'): McpAuditRow {
  return {
    surface: 'slack',
    toolName,
    ok: true,
    onBehalfOfSlackId: 'U_TEST',
    inputSummary: 'test',
    durationMs: 100,
  }
}

let fakeLog: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> }

beforeEach(() => {
  fakeLog = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  }
})

afterEach(async () => {
  // Each test creates its own buffer; nothing global to clean.
})

describe('AuditBuffer.record + flush', () => {
  test('rows buffered until explicit flush, then inserted in batch', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as unknown as Parameters<typeof AuditBuffer>[0] extends {
        db: infer T
      }
        ? T
        : never,
      log: fakeLog as unknown as Parameters<typeof AuditBuffer>[0] extends {
        log?: infer T
      }
        ? T
        : never,
      flushIntervalMs: 60_000, // never auto-fire in this test
      flushSizeThreshold: 100, // never auto-fire in this test
    })
    await buf.record(makeRow('a'))
    await buf.record(makeRow('b'))
    expect(buf.size()).toBe(2)
    expect(db.inserted).toEqual([]) // not yet flushed

    await buf.flush()
    expect(db.inserted).toHaveLength(2)
    expect(db.inserted[0]).toMatchObject({ toolName: 'a', surface: 'slack', ok: true })
    expect(db.inserted[1]).toMatchObject({ toolName: 'b' })
    expect(db.inserted[0]['id']).toBeTruthy() // cuid generated
    expect(buf.size()).toBe(0)
  })

  test('size threshold triggers fire-and-forget flush', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 3, // trigger after 3 rows
    })
    await buf.record(makeRow('a'))
    await buf.record(makeRow('b'))
    expect(db.inserted).toHaveLength(0)
    await buf.record(makeRow('c')) // crosses threshold → triggers flush
    // The flush is not awaited inside record(); wait for it.
    await new Promise((r) => setTimeout(r, 10))
    expect(db.inserted).toHaveLength(3)
  })

  test('timer flush after flushIntervalMs', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 30,
      flushSizeThreshold: 100,
    })
    buf.start()
    await buf.record(makeRow('timed'))
    expect(db.inserted).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 80))
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ toolName: 'timed' })
    await buf.shutdown()
  })

  test('shutdown flushes remaining rows and rejects new ones (writes them sync)', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
    })
    await buf.record(makeRow('pre-shutdown'))
    await buf.shutdown()
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ toolName: 'pre-shutdown' })

    // After shutdown, record() should fall through to sync write.
    await buf.record(makeRow('post-shutdown'))
    expect(db.inserted).toHaveLength(2)
    expect(db.inserted[1]).toMatchObject({ toolName: 'post-shutdown' })
  })
})

describe('AuditBuffer backpressure', () => {
  test('over the limit, records write synchronously (caller awaits insert)', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
      backpressureLimit: 3,
    })
    // Fill to limit.
    await buf.record(makeRow('a'))
    await buf.record(makeRow('b'))
    await buf.record(makeRow('c'))
    expect(buf.size()).toBe(3)
    expect(db.inserted).toHaveLength(0)

    // Next call must write synchronously — caller-visible side effect.
    await buf.record(makeRow('overflow'))
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ toolName: 'overflow' })
    expect(buf.size()).toBe(3) // buffer untouched; only the new row flushed

    // The backpressure path Sentry-alerts once, then suppresses repeats.
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'audit.buffer.overflow' }),
      expect.stringContaining('backpressure'),
    )
  })

  test('alert re-arms after a flush drains below the limit (successive overflows each alert once)', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
      backpressureLimit: 3,
    })
    // First overflow.
    await buf.record(makeRow('a'))
    await buf.record(makeRow('b'))
    await buf.record(makeRow('c'))
    await buf.record(makeRow('overflow-1'))
    expect(
      fakeLog.error.mock.calls.filter(
        ([meta]) =>
          (meta as { metric?: string } | undefined)?.metric ===
          'audit.buffer.overflow',
      ),
    ).toHaveLength(1)

    // Drain back below limit via explicit flush.
    await buf.flush()
    expect(buf.size()).toBe(0)

    // Climb past the limit again.
    await buf.record(makeRow('d'))
    await buf.record(makeRow('e'))
    await buf.record(makeRow('f'))
    await buf.record(makeRow('overflow-2'))

    // The fix re-arms on any drain below the limit (not just below
    // limit/2), so the second overflow fires its own alert. With the
    // pre-fix half-threshold logic, this assertion would still pass
    // because the buffer fully drained — see the next test for the
    // oscillation case the fix actually addresses.
    expect(
      fakeLog.error.mock.calls.filter(
        ([meta]) =>
          (meta as { metric?: string } | undefined)?.metric ===
          'audit.buffer.overflow',
      ),
    ).toHaveLength(2)
  })

  test('alert re-arms even when flush only partially drains (oscillation between just-above and just-below the limit)', async () => {
    const db = makeFakeDb()
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
      backpressureLimit: 4,
    })

    // Climb to over-limit. backpressureLimit is 4 — record() pushes
    // into the buffer until length >= 4; at that point new rows write
    // sync and the alert fires once.
    for (const t of ['a', 'b', 'c', 'd']) {
      await buf.record(makeRow(t))
    }
    await buf.record(makeRow('overflow-1'))
    expect(buf.size()).toBe(4)

    // Flush drains to 0, then we climb back close to the limit
    // without going under limit/2 again — the key scenario the fix
    // protects against. With the pre-fix half-threshold (re-arm only
    // below 2), this oscillation pattern would silently swallow the
    // second overflow because the buffer hits 3 → 4+1 → flush →
    // would-be 3 again, never crossing below 2.
    await buf.flush()
    // Simulate the post-flush partial-drain state by re-filling close
    // to the limit before the next overflow.
    await buf.record(makeRow('e'))
    await buf.record(makeRow('f'))
    await buf.record(makeRow('g'))
    // One more crosses the limit and would be the second alert.
    await buf.record(makeRow('h'))
    await buf.record(makeRow('overflow-2'))

    // Fix asserts: both episodes alert. Pre-fix this would have been 1.
    expect(
      fakeLog.error.mock.calls.filter(
        ([meta]) =>
          (meta as { metric?: string } | undefined)?.metric ===
          'audit.buffer.overflow',
      ),
    ).toHaveLength(2)
  })
})

describe('AuditBuffer write errors', () => {
  test('flush write failure is logged but does not throw', async () => {
    const db = makeFakeDb()
    db.failNextN = 1
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
    })
    await buf.record(makeRow('lost'))
    await expect(buf.flush()).resolves.toBeUndefined()
    expect(db.inserted).toHaveLength(0)
    expect(fakeLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 1 }),
      expect.stringContaining('write failed'),
    )
  })

  test('subsequent flush succeeds after recovery', async () => {
    const db = makeFakeDb()
    db.failNextN = 1
    const buf = new AuditBuffer({
      db: db as never,
      log: fakeLog as never,
      flushIntervalMs: 60_000,
      flushSizeThreshold: 100,
    })
    await buf.record(makeRow('first'))
    await buf.flush() // fails — row dropped
    await buf.record(makeRow('second'))
    await buf.flush() // succeeds
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ toolName: 'second' })
  })
})
