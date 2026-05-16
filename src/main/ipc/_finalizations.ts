/**
 * Shared pending-finalizations registry.
 *
 * Several IPC handlers return optimistically after kicking off slow
 * background work (ffmpeg flush, Deepgram finalize + transcript write,
 * etc.). This module holds the in-flight Promises so the app's
 * `before-quit` handler can await them and avoid losing user data on
 * quit.
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │  pendingFinalizations: Map<string, Promise<void>>        │
 *      │  keys look like:                                          │
 *      │     "video:<meetingId>"      ← video.ipc.ts adds these   │
 *      │     "recording:<meetingId>"  ← recording.ipc.ts adds them │
 *      └─────────────────────┬────────────────────────────────────┘
 *                            ▼
 *      app.on('before-quit') → await Promise.allSettled(values)
 *
 * Two subsystems write here today. Keys are prefixed so a single
 * meetingId can have both a video AND a recording finalize pending
 * without collision.
 */

const pendingFinalizations = new Map<string, Promise<void>>()

function compositeKey(prefix: 'video' | 'recording', id: string): string {
  return `${prefix}:${id}`
}

/**
 * Register a background-finalization promise. The caller is responsible
 * for calling `removePending(prefix, id)` from the promise's .finally
 * block (or equivalent) once it settles.
 */
export function addPending(prefix: 'video' | 'recording', id: string, promise: Promise<void>): void {
  pendingFinalizations.set(compositeKey(prefix, id), promise)
}

export function removePending(prefix: 'video' | 'recording', id: string): void {
  pendingFinalizations.delete(compositeKey(prefix, id))
}

export function hasPending(prefix: 'video' | 'recording', id: string): boolean {
  return pendingFinalizations.has(compositeKey(prefix, id))
}

export function getPending(prefix: 'video' | 'recording', id: string): Promise<void> | undefined {
  return pendingFinalizations.get(compositeKey(prefix, id))
}

/**
 * Snapshot of every pending finalize across subsystems. Used only by
 * the before-quit handler. Returns an array (not a live reference) so
 * the caller can `Promise.allSettled` it without worrying about the
 * map being mutated mid-await.
 */
export function getPendingForQuit(): Promise<void>[] {
  return Array.from(pendingFinalizations.values())
}

/** Test-only: clear the registry between cases. */
export function _resetForTests(): void {
  pendingFinalizations.clear()
}

/** Test-only: inspect the underlying map for assertions. */
export function _peekMap(): ReadonlyMap<string, Promise<void>> {
  return pendingFinalizations
}
