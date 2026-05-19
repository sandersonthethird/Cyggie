import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  nextLamport,
  persistLastPushedLamport,
  _resetLamportMemoForTesting,
} from '@cyggie/db/sync/sync-clock'

// Pure-function tests for the lamport clock. Two invariants:
//   1. Strict monotonic across calls (next > prev) — even within one ms.
//   2. Restart-safe — re-reading from sync_state never regresses.

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE sync_state (
      device_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      last_pushed_lamport TEXT NOT NULL DEFAULT '0',
      last_pulled_lamport TEXT NOT NULL DEFAULT '0',
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  return db
}

describe('sync-clock', () => {
  beforeEach(() => {
    _resetLamportMemoForTesting()
  })

  test('monotonic across consecutive calls in the same process', () => {
    const db = freshDb()
    const a = BigInt(nextLamport(db, 'dev1'))
    const b = BigInt(nextLamport(db, 'dev1'))
    const c = BigInt(nextLamport(db, 'dev1'))
    expect(b).toBeGreaterThan(a)
    expect(c).toBeGreaterThan(b)
  })

  test('does not regress when persisted lamport is in the future', () => {
    const db = freshDb()
    // Simulate a previous process that wrote a very-future lamport.
    persistLastPushedLamport(db, 'dev2', 'u2', '999999999999999')
    _resetLamportMemoForTesting() // simulates process restart
    const first = BigInt(nextLamport(db, 'dev2'))
    expect(first).toBeGreaterThan(999999999999999n)
  })

  test('persistLastPushedLamport upserts on second call', () => {
    const db = freshDb()
    persistLastPushedLamport(db, 'dev3', 'u3', '100')
    persistLastPushedLamport(db, 'dev3', 'u3', '200')
    const row = db
      .prepare(`SELECT last_pushed_lamport FROM sync_state WHERE device_id = ?`)
      .get('dev3') as { last_pushed_lamport: string }
    expect(row.last_pushed_lamport).toBe('200')
  })

  test('seeds from sync_state on first call after restart', () => {
    const db = freshDb()
    db.prepare(
      `INSERT INTO sync_state (device_id, user_id, last_pushed_lamport) VALUES (?, ?, ?)`,
    ).run('dev4', 'u4', '50000')
    _resetLamportMemoForTesting()
    const first = BigInt(nextLamport(db, 'dev4'))
    expect(first).toBeGreaterThan(50000n)
  })
})
