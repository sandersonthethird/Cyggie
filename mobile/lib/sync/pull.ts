// =============================================================================
// pull.ts — mobile delta-pull from Neon (Phase 1.5b).
//
// Calls GET /sync/pull?since=<lastPullLamport>; the gateway returns user-
// scoped meetings rows with lamport > since, ordered ASC. We persist the
// highest seen lamport so subsequent calls only return deltas.
//
// Trigger sites (in app code):
//   • App focus (useFocusEffect on Calendar tab)
//   • Pull-to-refresh on detail screen
//   • After a successful sign-in
//
// Result handling:
//   • returned meetings → caller invalidates per-meeting TanStack queries
//     so the cached MeetingDetail rebuilds from the new state.
//   • lamport merge → local clock catches up so the next outbox tick is
//     guaranteed to be above the server's high-water-mark, preventing
//     accidental 409s when the user types right after a cross-device pull.
// =============================================================================

import { api } from '../api/client'
import { appStateStorage } from '../cache/mmkv'
import { merge as mergeClock } from './clock'

const LAST_PULL_LAMPORT_KEY = 'sync.pull.lastLamport'

interface PullStorage {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

let storage: PullStorage = appStateStorage

export function __setPullStorageForTest(next: PullStorage): () => void {
  const prev = storage
  storage = next
  return () => {
    storage = prev
  }
}

// The gateway returns meetings rows in their drizzle camelCase form; for
// the V1 pull we keep the type loose (unknown[]) so a schema addition on
// the server side doesn't require a redeploy of mobile to display anything.
// TypedMeetingsFromPull below carries just the fields we touch.
export interface MeetingsFromPullRow {
  id: string
  userId: string
  lamport: string
  // ...everything else from the meetings table; intentionally not typed
  // because the pull endpoint returns the full row.
  [field: string]: unknown
}

export interface PullResult {
  meetings: MeetingsFromPullRow[]
  serverLamport: string
  /** Convenience: ids that changed in this pull, in insertion order. */
  changedIds: string[]
}

export function getLastPullLamport(): string {
  return storage.getString(LAST_PULL_LAMPORT_KEY) ?? '0'
}

function setLastPullLamport(v: string): void {
  storage.set(LAST_PULL_LAMPORT_KEY, v)
}

/**
 * Pull deltas since the last successful call. Returns the rows + the new
 * high-water-mark; persists the mark BEFORE returning so a partial
 * caller failure doesn't force a full re-pull next time.
 *
 * Errors propagate (caller decides whether to retry / surface).
 */
export async function pullSince(opts: {
  since?: string
  signal?: AbortSignal
} = {}): Promise<PullResult> {
  const since = opts.since ?? getLastPullLamport()
  const res = await api.get<{
    meetings: MeetingsFromPullRow[]
    serverLamport: string
  }>(`/sync/pull?since=${encodeURIComponent(since)}`, { signal: opts.signal })

  if (res.serverLamport && res.serverLamport !== since) {
    setLastPullLamport(res.serverLamport)
    mergeClock(res.serverLamport)
  }
  return {
    meetings: res.meetings,
    serverLamport: res.serverLamport,
    changedIds: res.meetings.map((m) => m.id),
  }
}

/** Test-only reset. */
export function __resetForTest(): void {
  storage.delete(LAST_PULL_LAMPORT_KEY)
}
