// =============================================================================
// stale-sweeper.ts — last-resort cleanup for "stuck recording" meetings.
//
// Most meetings end up at status='transcribed' (Deepgram webhook lands) or
// status='error' (Deepgram submit failed, or webhook with invalid payload).
// The remaining stragglers are:
//
//   • Phone uploaded successfully but crashed/lost connection before the
//     gateway could submit to Deepgram. The reconciler covers gateway-side
//     restarts; this sweeper covers the phone-side abandon case where the
//     meetings row exists but no deepgram_request_id was ever set.
//
//   • Deepgram accepted the submit but never POSTed the webhook AND the
//     reconciler's poll returns transient errors. After enough hours these
//     are effectively lost.
//
// Sweep policy: meetings stuck in status='recording' for >1 hour get flipped
// to status='error'. The 1hr threshold is generous — Deepgram batch normally
// returns within 1-2 minutes for short audio; 60 min covers even a worst-case
// 8hr recording's ~5min processing time with plenty of slack.
// =============================================================================

import { and, eq, lt } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'

const STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
const SWEEP_INTERVAL_MS = 15 * 60 * 1000 // every 15 min

let sweeperHandle: NodeJS.Timeout | null = null

export function startStaleRecordingSweeper(env: GatewayEnv): void {
  if (sweeperHandle) return
  const sweep = async () => {
    try {
      const db = getDb(env.GATEWAY_DATABASE_URL)
      const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)
      const result = await db
        .update(schema.meetings)
        .set({ status: 'error', updatedAt: new Date() })
        .where(
          and(
            eq(schema.meetings.status, 'recording'),
            lt(schema.meetings.createdAt, cutoff),
          ),
        )
        .returning({ id: schema.meetings.id })
      if (result.length > 0) {
        console.log(
          `[stale-sweeper] marked ${result.length} stuck recording(s) as error`,
          result.map((r) => r.id),
        )
      }
    } catch (err) {
      // Best-effort. Sweep is non-critical; next interval tries again.
      console.warn('[stale-sweeper] sweep failed:', err)
    }
  }
  // Stagger the first run by 30-60s so concurrent gateway boots (HA) don't
  // all hit Neon at the same second. Same pattern as auth/pending sweeper.
  setTimeout(sweep, 30_000 + Math.floor(Math.random() * 30_000))
  sweeperHandle = setInterval(sweep, SWEEP_INTERVAL_MS)
  sweeperHandle.unref()
}

export function stopStaleRecordingSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle)
    sweeperHandle = null
  }
}

/**
 * Single-pass sweep, callable from tests. Returns the ids of meetings that
 * got swept to status='error' on this pass.
 */
export async function sweepStaleRecordingsOnce(env: GatewayEnv): Promise<string[]> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)
  const result = await db
    .update(schema.meetings)
    .set({ status: 'error', updatedAt: new Date() })
    .where(
      and(
        eq(schema.meetings.status, 'recording'),
        lt(schema.meetings.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.meetings.id })
  return result.map((r) => r.id)
}
