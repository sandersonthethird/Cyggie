/**
 * Shared pending-finalizations registry.
 *
 * Multiple async paths return optimistically after kicking off slow background
 * work (Deepgram batch transcription, ffmpeg flush, transcript-to-disk write,
 * etc.). This module is the in-memory registry of those in-flight Promises.
 *
 *      ┌──────────────────────────────────────────────────────────┐
 *      │  pendingFinalizations: Map<string, Promise<void>>        │
 *      │  keys are caller-namespaced strings, e.g.:                │
 *      │     "video:<meetingId>"        ← desktop video.ipc        │
 *      │     "recording:<meetingId>"    ← desktop recording.ipc    │
 *      │     "transcribe:<meetingId>"   ← gateway transcribe job   │
 *      └─────────────────────┬────────────────────────────────────┘
 *                            ▼
 *      caller awaits via Promise.allSettled(getPendingForQuit())
 *
 * Consumers:
 *   • Desktop main process: app.on('before-quit') awaits everything so user
 *     data isn't lost on quit.
 *   • Gateway: same registry used by the recording transcribe job. The
 *     on-boot reconciler doesn't read from here (the in-memory state was
 *     lost on restart); it polls the DB instead.
 *
 * Why the prefix is `string` (not a tight union):
 *   The desktop ships with two callers ('video', 'recording'); the gateway
 *   adds 'transcribe'. Keeping the type open avoids the import-graph thrash
 *   that comes with extending a union across packages.
 */

const pendingFinalizations = new Map<string, Promise<void>>()

function compositeKey(prefix: string, id: string): string {
  return `${prefix}:${id}`
}

/**
 * Register a background-finalization promise. The caller is responsible for
 * calling `removePending(prefix, id)` once the promise settles (typically
 * from its own `.finally`).
 */
export function addPending(prefix: string, id: string, promise: Promise<void>): void {
  pendingFinalizations.set(compositeKey(prefix, id), promise)
}

export function removePending(prefix: string, id: string): void {
  pendingFinalizations.delete(compositeKey(prefix, id))
}

export function hasPending(prefix: string, id: string): boolean {
  return pendingFinalizations.has(compositeKey(prefix, id))
}

export function getPending(prefix: string, id: string): Promise<void> | undefined {
  return pendingFinalizations.get(compositeKey(prefix, id))
}

/**
 * Snapshot of every pending finalize across all callers. Returns an array
 * (not a live reference) so the caller can `Promise.allSettled` it without
 * worrying about the map being mutated mid-await.
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
