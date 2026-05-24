// =============================================================================
// clock.ts — mobile-side lamport clock (Phase 1.5b).
//
// Lamport is stored on each owned-row in Neon as a stringified BigInt (text
// column) because Postgres bigint can exceed JS safe-integer range. Mobile
// matches that convention: the persisted value is a decimal string, all
// arithmetic happens through BigInt.
//
// Semantics (mirrors desktop's packages/db/src/sync/sync-clock.ts):
//   tick()  → max(stored, Date.now()) + 1
//             — tracks wall clock so values interleave with server-minted
//             lamports under LWW. The gateway's validate-lamport.ts ceiling
//             check assumes this; a counter-only clock instantly falls
//             behind any server-stamped row (Date.now() ≈ 1.7e12) and
//             every subsequent write 409s.
//   merge(serverLamport) → local = max(local, server) + 1
//                          (call right after a successful GET /sync/pull
//                          OR any response that returns a server lamport)
//   current() → peek without mutating
//
// Persistence: MMKV (appStateStorage) under a single key. We don't
// per-table or per-row track lamport — one monotonic counter per device,
// consistent with the desktop SyncAgent's convention.
// =============================================================================

import { appStateStorage } from '../cache/mmkv'

const MMKV_KEY = 'sync.clock.lamport'

interface ClockStorage {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

let storage: ClockStorage = appStateStorage

/**
 * Swap the storage adapter — tests use an in-memory Map; production uses
 * the real MMKV instance. Returns a restore-fn so a test can leave global
 * state clean.
 */
export function __setClockStorageForTest(next: ClockStorage): () => void {
  const prev = storage
  storage = next
  return () => {
    storage = prev
  }
}

function read(): bigint {
  const raw = storage.getString(MMKV_KEY)
  if (!raw) return 0n
  try {
    return BigInt(raw)
  } catch {
    // Corruption — start over. Outbox entries already enqueued reference
    // older values; those keep working because the LWW compare is purely
    // numeric and the next tick guarantees a higher value.
    return 0n
  }
}

function write(v: bigint): void {
  storage.set(MMKV_KEY, v.toString())
}

export function tick(): string {
  const prev = read()
  const now = BigInt(Date.now())
  const next = (prev > now ? prev : now) + 1n
  write(next)
  return next.toString()
}

export function merge(serverLamport: string): void {
  let s: bigint
  try {
    s = BigInt(serverLamport)
  } catch {
    return
  }
  const local = read()
  const next = (local > s ? local : s) + 1n
  write(next)
}

export function current(): string {
  return read().toString()
}

/** Test-only reset. */
export function __resetForTest(): void {
  storage.delete(MMKV_KEY)
}
