// reheal-diverged-meetings.service.ts — one-time full re-pull to heal meetings
// that diverged BEFORE the id-divergence reconcile shipped.
//
// THE GAP THIS CLOSES
// PR 2's reconcile (sync-remote-apply.ts reconcileCalendarMeeting) converges a
// mobile-recorded meeting (gateway row B) onto the desktop stub (row A) — but it
// only runs for meeting rows RETURNED by /sync/pull, i.e. rows with
// lamport > sync_state.last_pulled_lamport. A meeting that diverged BEFORE PR 2
// had its canonical row B pulled once (pre-fix) and rejected (SQLite global
// UNIQUE(calendar_event_id) — A holds it), after which the pull watermark
// advanced past B's lamport. So B is never returned again and the reconcile
// never fires for it: the stub persists with "No transcript available yet".
//
// THE FIX
// Once per device, reset the pull watermark so the next /sync/pull re-pulls
// every owned row; PR 2's reconcile then heals each below-watermark diverged
// meeting as its canonical row comes back down.
//
//   last_pulled_lamport := '0'   ──►  next pull returns ALL rows  ──►  reconcile heals
//
// Safe + idempotent: only the PULL watermark is touched (push/outbox untouched);
// re-applying an unchanged row is a lamport-LWW no-op; the reconcile no-ops for
// non-diverged meetings. Run-once guarded by a LOCAL-only `settings` flag (not
// the synced user_preferences), so each device heals itself and the flag never
// propagates. Mirrors the other one-time launch backfills (notes-privacy, etc.),
// and uses raw SQL on the shared connection rather than importing a *.repo.ts
// (check-repo-imports forbids that in production code).

import { getDatabase } from '@cyggie/db/sqlite/connection'
import { triggerSyncPull } from './sync-bootstrap'

// `syncDeviceId` is provisioned into `settings` once the device registers with
// the gateway; the pull watermark lives in sync_state keyed by that id.
const DEVICE_ID_KEY = 'syncDeviceId'
const DONE_FLAG_KEY = 'divergedMeetingRehealV1Done'

/**
 * Reset this device's pull watermark once so a full re-pull heals any meeting
 * that diverged before the reconcile shipped. No-op if already run, or if the
 * device id / user isn't provisioned yet (retried next launch).
 */
export function rehealDivergedMeetings(userId: string | null): void {
  if (!userId) {
    console.log('[reheal-diverged-meetings] skipped: no user_id at launch')
    return
  }
  const db = getDatabase()

  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(DONE_FLAG_KEY) as
    | { value: string }
    | undefined
  if (done?.value === '1') return

  const deviceIdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_ID_KEY) as
    | { value: string }
    | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    // Not done-flagged → retried on a later launch once the device registers.
    console.log('[reheal-diverged-meetings] skipped: device_id not yet provisioned')
    return
  }

  const res = db
    .prepare("UPDATE sync_state SET last_pulled_lamport = '0' WHERE device_id = ?")
    .run(deviceId)

  // Mark done BEFORE triggering: the watermark is already '0', so even if the app
  // closes mid-pull the SyncPullService resumes the full re-pull on its next
  // tick. We must never reset the watermark a second time.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(DONE_FLAG_KEY)

  console.log(
    `[reheal-diverged-meetings] watermark reset (device=${deviceId}, rows=${res.changes}); ` +
      'triggering full re-pull metric=sync.meeting.reheal.triggered count=1',
  )
  triggerSyncPull()
}

/**
 * Fire-and-forget launcher. Deferred 4s — just after the custom-field /
 * notes-privacy backfills (3.5–3.6s) so it doesn't race the SyncAgent's first
 * tick or the initial pull.
 */
export function rehealDivergedMeetingsOnLaunch(userId: string | null): void {
  setTimeout(() => {
    try {
      rehealDivergedMeetings(userId)
    } catch (err) {
      console.error('[reheal-diverged-meetings] unexpected failure:', err)
    }
  }, 4000)
}
