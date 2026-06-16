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
// Sweep policy:
//   (1) meetings stuck in status='recording' WITH a recording_path for >1 hour
//       → status='error'. The recording_path guard is essential now that
//       impromptu meetings are pre-created at record start (no audio yet): a
//       live/just-created recording has recording_path=NULL and must never be
//       errored mid-recording. Only rows where audio WAS uploaded but Deepgram
//       never returned qualify.
//   (2) meetings stuck in status='recording' WITHOUT a recording_path for >12h
//       → DELETE (no audio to recover). These are pre-created rows whose phone
//       force-quit/crashed before uploading; deleting (not erroring) keeps the
//       calendar's "My Recordings" clean. 12h > the 8h recording cap so an
//       in-progress long recording is safe.
// =============================================================================

import { and, eq, isNull, isNotNull, lt } from 'drizzle-orm'
import { schema } from '@cyggie/db'
import { getDb } from '../db'
import type { GatewayEnv } from '../env'

const STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour
const SWEEP_INTERVAL_MS = 15 * 60 * 1000 // every 15 min
// No-audio orphans: a pre-created impromptu row whose phone force-quit/crashed
// mid-recording sits at status='recording' with recording_path=NULL and no
// recoverable audio anywhere. 12h is safely above the 8h MAX_RECORDING_MS cap
// (mobile/lib/recording/session.ts) + backgrounding slack, so a genuinely
// in-progress long recording is NEVER deleted out from under the user.
const NO_AUDIO_THRESHOLD_MS = 12 * 60 * 60 * 1000 // 12 hours

let sweeperHandle: NodeJS.Timeout | null = null

export function startStaleRecordingSweeper(env: GatewayEnv): void {
  if (sweeperHandle) return
  const sweep = async () => {
    try {
      const errored = await sweepStaleRecordingsOnce(env)
      if (errored.length > 0) {
        console.log(
          `[stale-sweeper] marked ${errored.length} stuck recording(s) as error`,
          errored,
        )
      }
      const deleted = await sweepNoAudioRecordingsOnce(env)
      if (deleted.length > 0) {
        console.log(
          `[stale-sweeper] deleted ${deleted.length} no-audio recording(s)`,
          deleted,
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
 * Single-pass sweep, callable from tests. Flips rows stuck in status='recording'
 * for >1h that HAVE a recording_path (audio uploaded, Deepgram never returned)
 * to status='error'. Rows with recording_path=NULL (live/just-created
 * recordings with no audio yet) are deliberately untouched — see (2) below.
 * Returns the ids swept to error on this pass.
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
        isNotNull(schema.meetings.recordingPath),
        lt(schema.meetings.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.meetings.id })
  return result.map((r) => r.id)
}

/**
 * Single-pass no-audio sweep, callable from tests. DELETES rows stuck in
 * status='recording' with recording_path=NULL for >12h — pre-created impromptu
 * rows whose phone force-quit/crashed before uploading (no recoverable audio).
 * The 12h cutoff is safely above the 8h MAX_RECORDING_MS cap so a genuinely
 * in-progress long recording is never deleted. Returns the deleted ids.
 *
 * Metric: 'stale-sweeper.no_audio_deleted'.
 */
export async function sweepNoAudioRecordingsOnce(env: GatewayEnv): Promise<string[]> {
  const db = getDb(env.GATEWAY_DATABASE_URL)
  const cutoff = new Date(Date.now() - NO_AUDIO_THRESHOLD_MS)
  const result = await db
    .delete(schema.meetings)
    .where(
      and(
        eq(schema.meetings.status, 'recording'),
        isNull(schema.meetings.recordingPath),
        lt(schema.meetings.createdAt, cutoff),
      ),
    )
    .returning({ id: schema.meetings.id })
  return result.map((r) => r.id)
}
