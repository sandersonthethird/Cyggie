// =============================================================================
// outbox-failed-requeue.service.ts — one-time re-drive of outbox rows that the
// gateway rejected before the 2026-06-19 sync-push hardening shipped.
//
// Background: company/contact cascade rows were rejected by the gateway for two
// now-fixed reasons (the lossy camelToSnake on digit-suffix columns like
// `followon_check_2`, and missing int→boolean coercion for `is_private`). The
// SyncAgent marked them `status='failed'` — and crucially, the drain loop only
// flushes `status='pending'` and `retryDeadLetters()` only reset `'dead'`, so
// nothing ever re-attempts a `'failed'` row. With the gateway fixed, this pass
// resets those rows to `pending` once so they drain on the next flush (in id
// order — parents before FK children).
//
// Run-once guarded (settings flag) so it doesn't perpetually re-drive a row
// that keeps genuinely failing (those settle into 'dead' after MAX_ATTEMPTS and
// stay there for inspection). Deploy the gateway fix BEFORE this runs.
// =============================================================================

import { getDatabase } from '@cyggie/db/sqlite/connection'

const DONE_FLAG_KEY = 'outboxFailedRequeueV1Done'

export interface OutboxRequeueResult {
  requeued: number
  alreadyDone: boolean
}

export function requeueFailedOutbox(): OutboxRequeueResult {
  const db = getDatabase()

  const flag = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(DONE_FLAG_KEY) as { value: string } | undefined
  if (flag?.value === '1') {
    return { requeued: 0, alreadyDone: true }
  }

  const result = db
    .prepare(
      `UPDATE outbox
         SET status = 'pending', attempts = 0, last_error = NULL
       WHERE status IN ('failed', 'dead')`,
    )
    .run()

  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = '1'`,
  ).run(DONE_FLAG_KEY)

  console.log(`[outbox-failed-requeue] requeued ${result.changes} failed/dead rows`)
  return { requeued: result.changes, alreadyDone: false }
}

/**
 * Fire-and-forget launcher. Deferred 6s so it lands after the cascade backfill
 * (4s) and the SyncAgent has bootstrapped — the reset rows then flush on the
 * next tick. Run-once via the settings flag.
 */
export function requeueFailedOutboxOnLaunch(): void {
  setTimeout(() => {
    try {
      requeueFailedOutbox()
    } catch (err) {
      console.error('[outbox-failed-requeue] unexpected failure:', err)
    }
  }, 6000)
}
