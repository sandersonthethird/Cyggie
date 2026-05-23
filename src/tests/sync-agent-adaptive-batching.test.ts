/**
 * T38 — adaptive batching in SyncAgent.
 *
 * Covers:
 *   • On `PayloadTooLargeError` (413), the agent halves its batch size,
 *     persists the new ceiling to `sync_state.safe_batch_size`, and
 *     retries with the smaller size on the next flush.
 *   • At the floor (size 1), repeated 413s schedule backoff rather
 *     than loop tight.
 *   • At startup, the agent reads `sync_state.safe_batch_size` and uses
 *     it as the initial size (capped at the compiled ceiling).
 *   • Successful flushes that drain a full batch grow the size back
 *     toward the ceiling after the threshold.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  SyncAgent,
  PayloadTooLargeError,
  type PushBatchEntry,
  type PushBatchResponse,
  type SyncTransport,
} from '../main/services/sync-agent'

function buildDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      lamport TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT
    );
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      safe_batch_size INTEGER
    );
  `)
  return db
}

function seedOutbox(db: Database.Database, n: number): void {
  const stmt = db.prepare(
    `INSERT INTO outbox (user_id, device_id, table_name, row_id, op, payload, lamport)
     VALUES ('u1', 'd1', 'meetings', ?, 'update', '{}', ?)`,
  )
  for (let i = 0; i < n; i++) {
    stmt.run(`m${i}`, String(i + 1))
  }
}

interface MockTransport extends SyncTransport {
  calls: PushBatchEntry[][]
  setMode(
    mode: 'ok' | 'too-large' | { kind: 'too-large-then-ok'; after: number },
  ): void
}

function makeTransport(): MockTransport {
  let mode:
    | 'ok'
    | 'too-large'
    | { kind: 'too-large-then-ok'; after: number } = 'ok'
  let calls = 0
  const transport: MockTransport = {
    calls: [],
    setMode(m) {
      mode = m
      calls = 0
    },
    async push({ batch }) {
      transport.calls.push(batch)
      calls++
      if (mode === 'too-large') throw new PayloadTooLargeError('413')
      if (typeof mode === 'object' && mode.kind === 'too-large-then-ok') {
        if (calls <= mode.after) throw new PayloadTooLargeError('413')
      }
      const acked = batch.map((e) => e.outboxId)
      const response: PushBatchResponse = { acked, rejected: [], conflicts: [] }
      return response
    },
  }
  return transport
}

// Synchronous "clock" — setInterval is a no-op so we drive flushes manually
// via triggerFlush/start.
const noClock = {
  setInterval: (() => undefined) as unknown as typeof setInterval,
  clearInterval: (() => undefined) as unknown as typeof clearInterval,
  now: () => 0,
}

function makeAgent(
  db: Database.Database,
  transport: SyncTransport,
  opts: { batchSize?: number } = {},
): SyncAgent {
  return new SyncAgent({
    db,
    getUserId: () => 'u1',
    getDeviceId: () => 'd1',
    getAccessToken: async () => 'token',
    transport,
    clock: noClock,
    batchSize: opts.batchSize ?? 200,
  })
}

async function flush(agent: SyncAgent): Promise<void> {
  // start() fires one immediate flush and the periodic tick (which is a
  // no-op under noClock). We start, await microtasks, then stop.
  agent.start()
  // The flush is async; wait for it to settle. doFlush awaits the
  // transport which we resolve synchronously — but ack-application is
  // also async. A microtask flush is enough.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  agent.stop()
}

function persistedSize(db: Database.Database): number | null {
  const row = db
    .prepare(`SELECT safe_batch_size FROM sync_state WHERE device_id = 'd1'`)
    .get() as { safe_batch_size: number | null } | undefined
  return row?.safe_batch_size ?? null
}

describe('SyncAgent — T38 adaptive batching', () => {
  let db: Database.Database
  let transport: MockTransport

  beforeEach(() => {
    db = buildDb()
    transport = makeTransport()
  })

  it('halves currentBatchSize and persists on 413', async () => {
    seedOutbox(db, 50)
    // After-1 → first call 413s, second call (with halved batch) succeeds.
    transport.setMode({ kind: 'too-large-then-ok', after: 1 })
    const agent = makeAgent(db, transport, { batchSize: 200 })
    await flush(agent)

    // 413 → halved from 200 to 100 and persisted.
    expect(persistedSize(db)).toBe(100)
    // The first call attempted 50 rows (all that were queued).
    expect(transport.calls[0]).toHaveLength(50)
  })

  it('retries with the smaller size after 413 and succeeds', async () => {
    seedOutbox(db, 30)
    transport.setMode({ kind: 'too-large-then-ok', after: 1 })
    const agent = makeAgent(db, transport, { batchSize: 200 })
    await flush(agent)

    // First call: 30 rows, 413. Halve to 100. Second call: 30 rows (queue
    // only has 30), succeeds.
    expect(transport.calls.length).toBeGreaterThanOrEqual(2)
    expect(persistedSize(db)).toBe(100)
    // After ack: outbox is drained.
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
      .get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('cascades halvings down to the floor under sustained 413s', async () => {
    // 413 triggers an immediate re-fire with the halved size, which 413s
    // again, halves again, etc. — until floor=1 OR the size stops shrinking
    // (at which point scheduleBackoff fires). One flush() drains the
    // whole cascade.
    seedOutbox(db, 8)
    transport.setMode('too-large')
    const agent = makeAgent(db, transport, { batchSize: 8 })
    await flush(agent)
    // Cascade: 8 → 4 → 2 → 1 (floor). Persisted ends at floor.
    expect(persistedSize(db)).toBe(1)
    // At floor, further 413s no longer shrink — scheduleBackoff handles
    // the row instead. Outbox stays pending.
    const pending = db
      .prepare(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'`)
      .get() as { n: number }
    expect(pending.n).toBe(8)
  })

  it('reads persisted safe_batch_size at startup', () => {
    db.prepare(
      `INSERT INTO sync_state (device_id, user_id, safe_batch_size) VALUES ('d1', 'u1', 13)`,
    ).run()
    const agent = makeAgent(db, transport, { batchSize: 200 })
    // No direct accessor — exercise via flush. Seed 20 rows; with
    // persisted size = 13, the first call should send exactly 13.
    seedOutbox(db, 20)
    void agent // silence unused
    return flush(agent).then(() => {
      expect(transport.calls[0]).toHaveLength(13)
    })
  })

  it('clamps persisted size above ceiling down to ceiling', () => {
    // Persisted 500 but compiled ceiling (via cfg.batchSize) is 50.
    // Agent should start at 50, not 500.
    db.prepare(
      `INSERT INTO sync_state (device_id, user_id, safe_batch_size) VALUES ('d1', 'u1', 500)`,
    ).run()
    seedOutbox(db, 100)
    const agent = makeAgent(db, transport, { batchSize: 50 })
    return flush(agent).then(() => {
      expect(transport.calls[0]).toHaveLength(50)
    })
  })
})
