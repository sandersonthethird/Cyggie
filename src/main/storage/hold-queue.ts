import { existsSync } from 'fs'
import { placeFinalizedFile, invalidateResolveCache, type StorageKind } from './routing'

// ─────────────────────────────────────────────────────────────────────────────
// Held-finalize queue (Issue 3A).
//
// When a PUBLIC file is finalized while the firm's shared root is unresolved
// (Drive unmounted / folder not yet synced), placeFinalizedFile HOLDs it in the
// local staging slot instead of silently mis-filing it locally, and the caller
// enqueues it here. The queue drains when the shared root (re)resolves — see
// refreshSharedRoot() — re-placing each held file into the now-available root.
//
// Private files never reach this queue: they route to the per-user local root,
// which is always available, so placeFinalizedFile never returns 'held' for them.
// ─────────────────────────────────────────────────────────────────────────────

export interface HeldFile {
  meetingId: string
  kind: StorageKind
  filename: string
  /** Absolute path in the local staging slot where the file currently waits. */
  stagingPath: string
}

const queue = new Map<string, HeldFile>()
let onChange: (() => void) | null = null

function keyOf(h: { meetingId: string; kind: StorageKind; filename: string }): string {
  return `${h.meetingId}|${h.kind}|${h.filename}`
}

/** Register a callback fired whenever the queue depth changes, so the renderer
 *  banner can refresh without polling. Pass null to clear. */
export function setHoldQueueChangeListener(fn: (() => void) | null): void {
  onChange = fn
}

export function getHoldQueueDepth(): number {
  return queue.size
}

/** Enqueue a public file held because the shared root was unresolved at finalize.
 *  Idempotent per (meeting, kind, filename) — a re-finalize replaces in place. */
export function enqueueHeldFile(held: HeldFile): void {
  const k = keyOf(held)
  const existed = queue.get(k)
  queue.set(k, held)
  if (!existed) onChange?.()
}

/**
 * Re-attempt placement of every held file into the (hopefully now-resolved)
 * shared root. On 'placed', dequeue + invalidate the resolve cache so the next
 * read finds the file in its routed root. Files that still can't place (shared
 * root still unresolved) stay queued; a staged file that vanished (e.g. manually
 * deleted) is dropped. Returns counts for logging/metrics.
 */
export function drainHoldQueue(): { placed: number; remaining: number } {
  if (queue.size === 0) return { placed: 0, remaining: 0 }
  let placed = 0
  let changed = false
  for (const [k, h] of [...queue]) {
    if (!existsSync(h.stagingPath)) {
      queue.delete(k)
      changed = true
      continue
    }
    // Held files are always public (private routes to the always-available local
    // root), so re-place as explicitly public.
    const res = placeFinalizedFile({ id: h.meetingId, isPrivate: false }, h.kind, h.filename, h.stagingPath)
    if (res.kind === 'placed') {
      queue.delete(k)
      invalidateResolveCache(h.meetingId)
      placed++
      changed = true
    }
  }
  if (changed) onChange?.()
  return { placed, remaining: queue.size }
}

/** Test-only full reset (queue + listener). */
export function __resetHoldQueueForTests(): void {
  queue.clear()
  onChange = null
}
