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
