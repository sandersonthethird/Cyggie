// =============================================================================
// outbox.ts — mobile-side write outbox (Phase 1.5b).
//
// Mobile-originated writes queue here, then drain to the gateway via PATCH
// (see agent.ts). Persistence is MMKV — the whole queue lives under one
// key as JSON, and we rewrite the slot on each mutation. Volume is tiny
// (single-firm beta; one entry per ~1s of typing while a user is editing
// notes) so the rewrite cost is negligible vs the complexity savings of
// not maintaining a per-entry key scheme.
//
// COALESCING (key correctness property)
//   Same `(op, resourceId)` replaces an existing entry rather than
//   queueing alongside it. Notes editing in particular emits one entry
//   per debounced save; without coalescing, a user typing for 30s would
//   stack 30 separate PATCHes — all but the last redundant. Each entry
//   carries the lamport from the moment of enqueue, so the latest
//   coalesced entry's lamport > stored, and the LWW compare on the
//   gateway accepts it.
//
// ENTRY STRUCTURE
//   id          — client-generated UUID (logging + dedup)
//   op          — 'meeting.notes.update' (only one op for V1)
//   resourceId  — meetingId
//   payload     — { notes, lamport }
//   createdAt   — ISO timestamp (for FIFO ordering)
//   retries     — increments on transient failure (5xx / network)
//   lastError   — last error message (DLQ context)
//
// CORRUPTION RECOVERY
//   If the persisted blob fails JSON.parse, we wipe the key and start
//   fresh. Loss is acceptable — these are notes-only writes, and the
//   next user keystroke re-enqueues. Throwing here would brick the app.
// =============================================================================

import { appStateStorage } from '../cache/mmkv'

const MMKV_KEY = 'sync.outbox.v1'

export type OutboxOp = 'meeting.notes.update'

export interface OutboxPayload {
  notes: string | null
  lamport: string
}

export interface OutboxEntry {
  id: string
  op: OutboxOp
  resourceId: string
  payload: OutboxPayload
  createdAt: string
  retries: number
  lastError?: string
}

interface OutboxStorage {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

let storage: OutboxStorage = appStateStorage

export function __setOutboxStorageForTest(next: OutboxStorage): () => void {
  const prev = storage
  storage = next
  return () => {
    storage = prev
  }
}

function readAll(): OutboxEntry[] {
  const raw = storage.getString(MMKV_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    // Lax filter — drop entries missing required fields rather than throwing.
    return parsed.filter(isEntry)
  } catch {
    // Corrupt blob — start over rather than brick.
    storage.delete(MMKV_KEY)
    return []
  }
}

function writeAll(entries: OutboxEntry[]): void {
  if (entries.length === 0) {
    storage.delete(MMKV_KEY)
    return
  }
  storage.set(MMKV_KEY, JSON.stringify(entries))
}

function isEntry(v: unknown): v is OutboxEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o['id'] === 'string' &&
    typeof o['op'] === 'string' &&
    typeof o['resourceId'] === 'string' &&
    typeof o['createdAt'] === 'string' &&
    typeof o['retries'] === 'number' &&
    typeof o['payload'] === 'object'
  )
}

let idCounter = 0
function genId(): string {
  // Lightweight client UUID — collisions would only matter for our own
  // logs and the chance is effectively zero at the volumes we see.
  idCounter = (idCounter + 1) & 0xffffff
  return `out-${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export interface EnqueueInput {
  op: OutboxOp
  resourceId: string
  payload: OutboxPayload
}

/**
 * Enqueue (or coalesce) a write. Coalescing replaces any existing entry
 * with the same `(op, resourceId)` — the latest write wins locally,
 * and its lamport is the one that gets PATCHed.
 *
 * Returns the entry that was persisted (caller might log the id).
 */
export function enqueue(input: EnqueueInput): OutboxEntry {
  const all = readAll()
  const existingIdx = all.findIndex(
    (e) => e.op === input.op && e.resourceId === input.resourceId,
  )
  const next: OutboxEntry = {
    id: existingIdx >= 0 ? all[existingIdx]!.id : genId(),
    op: input.op,
    resourceId: input.resourceId,
    payload: input.payload,
    // Preserve the original createdAt for FIFO fairness — coalescing
    // updates the payload but not the queue position.
    createdAt:
      existingIdx >= 0 ? all[existingIdx]!.createdAt : new Date().toISOString(),
    // Reset retries — a fresh edit deserves a fresh attempt schedule.
    retries: 0,
  }
  if (existingIdx >= 0) {
    all[existingIdx] = next
  } else {
    all.push(next)
  }
  writeAll(all)
  return next
}

/** Read all entries in FIFO order (oldest createdAt first). */
export function loadAll(): OutboxEntry[] {
  const all = readAll()
  return [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export function removeById(id: string): void {
  const all = readAll()
  const filtered = all.filter((e) => e.id !== id)
  if (filtered.length === all.length) return
  writeAll(filtered)
}

/**
 * Update retry counters in-place for an entry that just failed
 * transiently (5xx / network). Used by the agent's failure branch.
 */
export function bumpRetry(id: string, lastError: string): void {
  const all = readAll()
  const idx = all.findIndex((e) => e.id === id)
  if (idx < 0) return
  const e = all[idx]!
  all[idx] = { ...e, retries: e.retries + 1, lastError }
  writeAll(all)
}

// =============================================================================
// DEAD-LETTER QUEUE
//
// Stored in a separate MMKV slot — the agent's drain never visits it. Entries
// land here on a permanent error (400/404/unknown_op) or after MAX_RETRIES.
// readDLQ/writeDLQ mirror readAll/writeAll so corruption handling (corrupt blob
// → start over) is identical to the active queue.
// =============================================================================

const DLQ_KEY = 'sync.outbox.dlq.v1'

function readDLQ(): OutboxEntry[] {
  const raw = storage.getString(DLQ_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    storage.delete(DLQ_KEY)
    return []
  }
}

function writeDLQ(entries: OutboxEntry[]): void {
  if (entries.length === 0) {
    storage.delete(DLQ_KEY)
    return
  }
  storage.set(DLQ_KEY, JSON.stringify(entries))
}

/** Move an entry from the active queue to the dead-letter queue. */
export function moveToDLQ(id: string): OutboxEntry | null {
  const all = readAll()
  const idx = all.findIndex((e) => e.id === id)
  if (idx < 0) return null
  const entry = all[idx]!
  writeAll([...all.slice(0, idx), ...all.slice(idx + 1)])
  writeDLQ([...readDLQ(), entry])
  return entry
}

export function loadDLQ(): OutboxEntry[] {
  return readDLQ()
}

/**
 * Replay a dead-lettered entry back into the active queue for another drain.
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ LAMPORT IS PRESERVED — DO NOT RE-STAMP.                             │
 *   │                                                                      │
 *   │ A DLQ entry's lamport was captured when it first failed (possibly   │
 *   │ days old). Re-stamping a fresh lamport would make the replayed      │
 *   │ notes write WIN last-write-wins on the gateway and could clobber a  │
 *   │ newer server-side edit. Preserving the old lamport lets LWW resolve │
 *   │ correctly:                                                          │
 *   │   replayed (stale) lamport  <  server lamport  →  409  →  conflict  │
 *   │ The agent's existing 409 path surfaces NotesConflictModal — a clean,│
 *   │ visible outcome rather than silent data loss.                       │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Only the retry bookkeeping is reset (retries → 0, lastError cleared) so the
 * entry gets a fresh attempt schedule. If a live entry for the same
 * (op, resourceId) already exists it carries a newer lamport and would win
 * anyway, so the dead entry is dropped and the live one is returned.
 *
 * Returns the entry now sitting in the active queue, or `null` if `id` was
 * not in the DLQ.
 */
export function replayFromDLQ(id: string): OutboxEntry | null {
  const dlq = readDLQ()
  const idx = dlq.findIndex((e) => e.id === id)
  if (idx < 0) return null
  const dead = dlq[idx]!
  // Remove from the DLQ regardless of the active-queue outcome.
  writeDLQ([...dlq.slice(0, idx), ...dlq.slice(idx + 1)])

  const active = readAll()
  const clash = active.findIndex(
    (e) => e.op === dead.op && e.resourceId === dead.resourceId,
  )
  if (clash >= 0) {
    // Live entry wins (newer lamport); the stale dead entry is discarded.
    return active[clash]!
  }
  const revived: OutboxEntry = { ...dead, retries: 0, lastError: undefined }
  active.push(revived)
  writeAll(active)
  return revived
}

/** Remove a single entry from the DLQ (the "Dismiss" action). */
export function removeFromDLQ(id: string): void {
  const dlq = readDLQ()
  const filtered = dlq.filter((e) => e.id !== id)
  if (filtered.length === dlq.length) return
  writeDLQ(filtered)
}

/** Wipe the entire DLQ. */
export function clearDLQ(): void {
  storage.delete(DLQ_KEY)
}

/** Number of dead-lettered entries. Lets the settings row show "(N)" without
 *  parsing the blob inside a render. */
export function dlqCount(): number {
  return readDLQ().length
}

/** Number of entries pending in the active queue. Used by the editor for
 *  the "Saving (N)…" indicator. */
export function pendingCount(): number {
  return readAll().length
}

/** Test-only reset. */
export function __resetForTest(): void {
  storage.delete(MMKV_KEY)
  storage.delete(DLQ_KEY)
}
