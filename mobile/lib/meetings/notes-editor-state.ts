// =============================================================================
// notes-editor-state.ts — pure helpers for the NotesEditor component.
//
// Decisions extracted into a pure module so unit tests don't need to drag
// React Native into the runner. The component itself is a thin shell over
// these primitives — `formatRelative`, `decideSaveLabel`, and
// `coalesceDecision`.
// =============================================================================

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'error'

export interface SaveLabelInput {
  status: SaveStatus
  pendingCount: number
  lastSavedAtMs: number | null
  nowMs: number
  /** Number of attempts the most recent in-flight entry has had. */
  retries?: number
}

export interface SaveLabel {
  text: string
  /** Set true when the label conveys a problem the user should notice. */
  isWarning: boolean
}

/** Maximum age of `lastSavedAtMs` before we stop showing the freshness label. */
const RECENTLY_SAVED_WINDOW_MS = 60_000

/**
 * Map (status, pendingCount, lastSavedAt) → user-facing save label.
 *
 *   idle + recent save     → "Saved just now" / "Saved 12s ago" / ...
 *   idle + no recent save  → "Saved" or "" (caller's choice — we return "")
 *   pending                → "Saving (N)…" when N > 1, else "Saving…"
 *   saving (in-flight)     → same as pending; the editor doesn't distinguish
 *   error + retries        → "Retrying… (attempt N)"
 *   error + no retries     → "Save failed"
 */
export function decideSaveLabel(input: SaveLabelInput): SaveLabel {
  const { status, pendingCount, lastSavedAtMs, nowMs, retries = 0 } = input

  if (status === 'error') {
    if (retries > 0) {
      return { text: `Retrying… (attempt ${retries})`, isWarning: false }
    }
    return { text: 'Save failed', isWarning: true }
  }

  if (status === 'pending' || status === 'saving' || pendingCount > 0) {
    if (pendingCount > 1) {
      return { text: `Saving (${pendingCount})…`, isWarning: false }
    }
    return { text: 'Saving…', isWarning: false }
  }

  if (lastSavedAtMs !== null && nowMs - lastSavedAtMs < RECENTLY_SAVED_WINDOW_MS) {
    return { text: 'Saved', isWarning: false }
  }
  return { text: '', isWarning: false }
}

/**
 * Format an absolute moment as a relative timestamp ("12 minutes ago",
 * "just now", "yesterday"). Mirrors the desktop renderer's compact style
 * — long enough to be informative but short enough for the footer.
 */
export function formatRelative(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diffSec = Math.round((nowMs - t) / 1000)
  if (diffSec < 0) return 'just now' // clock skew — treat future as now
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec} seconds ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay} days ago`
  // Past a week: emit a date string so the user sees a concrete value.
  return new Date(t).toLocaleDateString()
}

/**
 * Decide whether the editor should enqueue a save right now, given the
 * latest text and the value last enqueued. Returns true ONLY when the
 * value has materially changed AND isn't identical to the persisted
 * server value (caller passes the original meeting.notes).
 *
 * The debouncer is the caller's responsibility — this function is the
 * "should we even debounce at all" decision.
 */
export function shouldEnqueueSave(input: {
  latest: string | null
  lastEnqueued: string | null
  serverValue: string | null
}): boolean {
  // Treat null and '' as the same — user clearing all text shouldn't
  // re-enqueue if the server is already null.
  const norm = (v: string | null): string => (v ?? '').trim()
  const latest = norm(input.latest)
  const enq = norm(input.lastEnqueued)
  const srv = norm(input.serverValue)
  if (latest === enq) return false // nothing changed since last enqueue
  if (latest === srv) return false // round-trip back to server state — no-op
  return true
}
