// sync-repull-once.service.ts — one-time, race-proof pull-watermark reset so an
// existing install re-pulls every owned row from lamport 0 on its next pull.
//
// THE GAP THIS CLOSES
// Migration 123 added meetings.was_impromptu / scheduled_end_at and
// contacts.last_meeting_at / last_email_at. Before it, every /sync/pull
// `meetings` and `contacts` sub-batch threw "table … has no column named …" and
// rolled back, so NO gateway meeting or contact had ever applied to this device
// — yet the shared pull watermark (sync_state.last_pulled_lamport) advanced past
// them anyway, because OTHER tables (notes/companies/chat/prefs) bumped it.
//
// Adding the columns is necessary but not sufficient: those meeting/contact rows
// now sit BELOW the watermark, and the gateway pull is `WHERE lamport > since`,
// so an incremental pull never returns them again. A one-time reset to 0 forces
// the next pull to re-fetch and apply them (now that the columns exist).
//
//   last_pulled_lamport := '0'   ──►  next pull returns ALL rows  ──►  apply succeeds
//
// RACE-PROOF (vs PR 2b): called synchronously in bootstrapSync() BEFORE
// pullService.start(), when there are no pending outbox rows (push idle) and no
// pull in flight. PR 2b's predecessor reset ~4s after launch, by which point a
// normal pull had already read the high `since`; on completion it wrote the high
// watermark back (it only moves up via MAX), clobbering the reset. Running before
// start() removes the race entirely — start()'s first tick then pulls from 0.
// No triggerSyncPull() needed.
//
// Run-once guarded by a LOCAL-only `settings` flag (meetingRepullV2Done), so each
// device heals itself once and the flag never propagates via sync. Re-armed with
// a fresh flag (not PR 2b's spent divergedMeetingRehealV1Done) so installs where
// PR 2b ran ineffectively still get this reset. Idempotent: re-applying unchanged
// rows is a lamport-LWW no-op. No-op (without setting the flag) if the device id
// or sync_state row isn't provisioned yet — retried on a later launch.

import type Database from 'better-sqlite3'

// `syncDeviceId` is provisioned into `settings` once the device registers with
// the gateway; the pull watermark lives in sync_state keyed by that id.
const DEVICE_ID_KEY = 'syncDeviceId'

/**
 * Reset this device's pull watermark to 0 exactly once (guarded by `flagKey`),
 * so the next pull re-pulls every owned row from lamport 0. `last_pulled_lamport`
 * is shared across all owned tables, so this is a full re-pull regardless of the
 * reason — each one-time reason gets its OWN flag so it fires once even on
 * installs that already ran an earlier reset:
 *   - `meetingRepullV2Done`  — heal meetings/contacts after migration 123.
 *   - `notesBlankRepullV1Done` — surface corrupted blank notes for the pull
 *     reconcile to refuse + re-push (see reconcileBlankNote / note-blank-heal).
 * Returns whether a reset was performed (false = already done, or device not yet
 * provisioned). Must be called BEFORE the pull service starts so no in-flight
 * pull can clobber the reset.
 */
export function resetPullWatermarkForRepullOnce(
  db: Database.Database,
  flagKey: string,
): { reset: boolean } {
  const done = db.prepare('SELECT value FROM settings WHERE key = ?').get(flagKey) as
    | { value: string }
    | undefined
  if (done?.value === '1') return { reset: false }

  const deviceIdRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_ID_KEY) as
    | { value: string }
    | undefined
  const deviceId = deviceIdRow?.value
  if (!deviceId) {
    // Not done-flagged → retried on a later launch once the device registers.
    console.log(`[sync-repull] skipped (${flagKey}): device_id not yet provisioned`)
    return { reset: false }
  }

  const res = db
    .prepare("UPDATE sync_state SET last_pulled_lamport = '0' WHERE device_id = ?")
    .run(deviceId)

  // Mark done BEFORE the pull starts: the watermark is already '0', so even if the
  // app closes mid-pull the SyncPullService resumes the full re-pull on its next
  // tick. We must never reset the watermark a second time for this reason.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(flagKey)

  console.log(
    `[sync-repull] watermark reset to 0 (device=${deviceId}, rows=${res.changes}, reason=${flagKey}); ` +
      'next pull does a one-time full re-pull metric=sync.repull.triggered count=1',
  )
  return { reset: res.changes > 0 }
}
