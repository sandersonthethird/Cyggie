// =============================================================================
// attachment-gc.service.ts — desktop garbage collection of ORPHANED note/memo
// attachment metadata rows.
//
// An attachment is orphaned when its `cyggie-attachment://{id}` reference no
// longer appears in ANY local content (every active note + EVERY memo version,
// not just the latest). The sweep soft-deletes such rows so the tombstone
// replicates cross-device; the R2 object byte-reclaim is a separate, PR3 step
// gated on the tombstone having propagated.
//
//   ┌──────────────────────────────────────────────────────────────────┐
//   │ referenced = collectReferencedAttachmentIds()  (all notes + all   │
//   │              memo versions — the false-orphan guard)              │
//   │ candidates = listOwnActiveAttachmentsForGc(me)  (OWN rows only —  │
//   │              never touch a teammate's row we can't fully see)     │
//   │ orphans    = candidates − referenced, created_at < now − 24h grace │
//   │ for each orphan: softDeleteAttachment(id)  (barrel → outbox)       │
//   └──────────────────────────────────────────────────────────────────┘
//
// Runs in the desktop MAIN process (startup + 24h interval) — no Fly SIGTERM
// concern. Idempotent: a re-run finds nothing once orphans are tombstoned.
// =============================================================================

import {
  softDeleteAttachment,
  listOwnActiveAttachmentsForGc,
  collectReferencedAttachmentIds,
} from '@cyggie/db/sqlite/repositories'
import { getCurrentUserId } from '../security/current-user'

// Grace window: an attachment must be older than this before it's eligible, so
// a transient unreferenced state (undo, cut-then-paste, mid-upload) doesn't
// reclaim a row that's about to be referenced again.
export const ATTACHMENT_GC_GRACE_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const STARTUP_DELAY_MS = 5_000

/** SQLite `datetime('now')` → 'YYYY-MM-DD HH:MM:SS' in UTC. Parse as UTC ms. */
function parseSqliteUtcMs(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z')
}

/**
 * PURE orphan-selection core (unit-tested). Returns the ids to soft-delete:
 * candidates not referenced anywhere AND older than the grace window.
 * `candidates` is assumed already scoped to the current user (own rows only).
 */
export function selectOrphanAttachmentIds(
  candidates: { id: string; createdAt: string }[],
  referenced: Set<string>,
  nowMs: number,
  graceMs: number,
): string[] {
  const cutoff = nowMs - graceMs
  return candidates
    .filter((c) => !referenced.has(c.id))
    .filter((c) => {
      const created = parseSqliteUtcMs(c.createdAt)
      // Unparseable timestamp → treat as NOT eligible (fail safe).
      return Number.isFinite(created) && created < cutoff
    })
    .map((c) => c.id)
}

/**
 * Run one sweep for `userId`. Returns the number of rows soft-deleted.
 * `nowMs`/`graceMs` are injectable for tests; default to real clock + 24h.
 */
export function runAttachmentGcSweep(
  userId: string,
  opts: { nowMs?: number; graceMs?: number } = {},
): number {
  const nowMs = opts.nowMs ?? Date.now()
  const graceMs = opts.graceMs ?? ATTACHMENT_GC_GRACE_MS

  const referenced = collectReferencedAttachmentIds()
  const candidates = listOwnActiveAttachmentsForGc(userId)
  const orphanIds = selectOrphanAttachmentIds(candidates, referenced, nowMs, graceMs)

  let swept = 0
  for (const id of orphanIds) {
    try {
      const row = softDeleteAttachment(id, userId)
      if (row) swept++
    } catch (err) {
      console.error(`[attachment-gc] failed to soft-delete ${id}:`, err)
    }
  }
  if (swept > 0) {
    console.log(
      `[attachment-gc] swept ${swept} orphaned attachment(s) metric=attachment.gc.swept count=${swept}`,
    )
  }
  return swept
}

let gcInterval: ReturnType<typeof setInterval> | null = null

/**
 * Schedule the GC: one deferred sweep shortly after launch (past sync
 * bootstrap) + a 24h interval. Resolves the current user lazily on each tick so
 * a sign-in after launch is picked up. Safe to call once at startup.
 */
export function startAttachmentGc(): void {
  const tick = (): void => {
    let userId: string
    try {
      userId = getCurrentUserId()
    } catch {
      return // not signed in yet — skip this tick
    }
    if (!userId) return
    try {
      runAttachmentGcSweep(userId)
    } catch (err) {
      console.error('[attachment-gc] sweep failed:', err)
    }
  }

  setTimeout(tick, STARTUP_DELAY_MS)
  if (gcInterval) clearInterval(gcInterval)
  gcInterval = setInterval(tick, SWEEP_INTERVAL_MS)
  // Don't keep the event loop alive for the GC alone.
  gcInterval.unref?.()
}

export function stopAttachmentGc(): void {
  if (gcInterval) {
    clearInterval(gcInterval)
    gcInterval = null
  }
}
