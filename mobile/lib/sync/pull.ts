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

// The gateway caps each /sync/pull page (SYNC_PULL_PAGE_SIZE) and sets hasMore.
// A first launch on a heavy account spans several pages; drain them all in one
// call. Cap the loop so a server bug (hasMore stuck true) can't spin forever —
// whatever's left resumes on the next pull.
const MAX_PULL_PAGES = 50

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
 * Pull deltas since the last successful call, DRAINING every gateway page
 * (loops while the response says `hasMore`). Returns the accumulated rows + the
 * new high-water-mark; persists the cursor after EACH page so a mid-drain
 * failure resumes from the last drained page rather than re-pulling.
 *
 * Guards: the caller's AbortSignal is threaded through every page (navigate-away
 * aborts mid-drain); a page cap stops a runaway loop (logs + resumes next pull);
 * a cursor-advance check stops a degenerate `hasMore`-but-no-progress server.
 *
 * Errors propagate (caller decides whether to retry / surface).
 */
export async function pullSince(opts: {
  since?: string
  signal?: AbortSignal
} = {}): Promise<PullResult> {
  let since = opts.since ?? getLastPullLamport()
  const allMeetings: MeetingsFromPullRow[] = []
  let lastServerLamport = since
  let pages = 0
  let cappedWithMore = false

  for (;;) {
    const res = await api.get<{
      meetings: MeetingsFromPullRow[]
      serverLamport: string
      hasMore?: boolean
      // T40 — opt into lazy transcripts. The gateway suppresses
      // transcript_segments from the pull payload; the meeting detail screen
      // already fetches the transcript on-demand via GET /meetings/:id, so
      // mobile never relied on the pulled transcript for display.
    }>(`/sync/pull?since=${encodeURIComponent(since)}&lazyTranscripts=1`, { signal: opts.signal })

    allMeetings.push(...res.meetings)
    pages += 1

    // Persist + advance the clock per page so a later-page failure resumes here.
    if (res.serverLamport && res.serverLamport !== since) {
      setLastPullLamport(res.serverLamport)
      mergeClock(res.serverLamport)
      lastServerLamport = res.serverLamport
    }

    if (!res.hasMore) break

    // Degenerate ceiling: server says there's more but the cursor didn't move
    // past `since`. Draining again would loop forever — stop and let the next
    // pull retry rather than hang.
    if (!res.serverLamport || BigInt(res.serverLamport) <= BigInt(since)) {
      console.warn(
        `[sync.pull] hasMore=true but cursor did not advance past ${since}; stopping drain`,
      )
      break
    }
    since = res.serverLamport

    if (pages >= MAX_PULL_PAGES) {
      cappedWithMore = true
      break
    }
  }

  if (cappedWithMore) {
    console.warn(
      `[sync.pull] drained ${pages} pages (${allMeetings.length} rows) and hit the ` +
        `${MAX_PULL_PAGES}-page cap; more remain — resuming on the next pull`,
    )
  } else if (pages > 1) {
    console.log(`[sync.pull] drained ${pages} pages, ${allMeetings.length} rows`)
  }

  return {
    meetings: allMeetings,
    serverLamport: lastServerLamport,
    changedIds: allMeetings.map((m) => m.id),
  }
}

/** Test-only reset. */
export function __resetForTest(): void {
  storage.delete(LAST_PULL_LAMPORT_KEY)
}
