// =============================================================================
// confirmed-meetings.ts — "is this meeting row confirmed on the gateway yet?"
//
// Notes for an impromptu meeting can't be PATCHed until the gateway row exists
// — and the sync outbox dead-letters a 404 (losing the note). So NotesEditor
// buffers keystrokes in its existing MMKV draft but does NOT enqueue to the
// outbox until the row is CONFIRMED. Confirmation happens when either:
//   • POST /meetings/impromptu returns 200/201 (online pre-create), or
//   • POST /recordings/upload upserts the row at Stop (offline path).
// Both call markMeetingConfirmed(id).
//
//   typing ──▶ MMKV draft (always)
//                 │
//                 ▼ unconfirmed? hold.  confirmed? flush once ──▶ outbox ──▶ PATCH
//
// The confirmed set is persisted to MMKV so a force-quit between confirm and
// flush still flushes on next boot (see flushConfirmedDrafts).
//
// Scheduled meetings are confirmed by definition (the row predates recording),
// so callers treat any non-impromptu meeting as confirmed without registering.
// =============================================================================

import { appStateStorage } from '../cache/mmkv'

const KEY = 'cyggie.confirmed-meetings.v1'

// In-memory subscribers so a mounted NotesEditor flips from buffering to
// enqueueing the instant its meeting is confirmed (no polling).
type Listener = (meetingId: string) => void
const listeners = new Set<Listener>()

function readSet(): Set<string> {
  const raw = appStateStorage.getString(KEY)
  if (!raw) return new Set()
  try {
    const arr = JSON.parse(raw) as unknown
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    appStateStorage.delete(KEY)
    return new Set()
  }
}

function writeSet(set: Set<string>): void {
  appStateStorage.set(KEY, JSON.stringify([...set]))
}

export function isMeetingConfirmed(meetingId: string): boolean {
  return readSet().has(meetingId)
}

/** Mark a meeting row as existing on the gateway. Idempotent; notifies any
 *  mounted NotesEditor for this id so it flushes its buffered draft. */
export function markMeetingConfirmed(meetingId: string): void {
  const set = readSet()
  if (set.has(meetingId)) return
  set.add(meetingId)
  writeSet(set)
  for (const l of listeners) l(meetingId)
}

/** Forget a confirmation (e.g. the meeting was cancelled/deleted) so a stale
 *  id doesn't linger in the set forever. */
export function clearMeetingConfirmed(meetingId: string): void {
  const set = readSet()
  if (!set.delete(meetingId)) return
  writeSet(set)
}

/** Subscribe to confirmations. Returns an unsubscribe fn. */
export function onMeetingConfirmed(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
