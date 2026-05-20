/**
 * Desktop pending-finalizations registry.
 *
 * The actual map + functions live in @cyggie/services/recording/pending-finalizations
 * so the gateway can share the same registry pattern for its background
 * Deepgram transcribe jobs. This file is a thin desktop-facing re-export that
 * narrows the prefix type to the two callers the desktop has today ('video'
 * from video.ipc.ts, 'recording' from recording.ipc.ts) — a stronger type for
 * desktop code without locking the shared module to a desktop-only union.
 *
 * `app.on('before-quit')` in src/main/index.ts awaits `getPendingForQuit()`
 * before allowing exit, so user data isn't lost mid-transcription.
 */

import {
  addPending as _addPending,
  removePending as _removePending,
  hasPending as _hasPending,
  getPending as _getPending,
  getPendingForQuit as _getPendingForQuit,
  _resetForTests as _underlyingResetForTests,
  _peekMap as _underlyingPeekMap,
} from '@cyggie/services/recording/pending-finalizations'

type DesktopPrefix = 'video' | 'recording'

export function addPending(prefix: DesktopPrefix, id: string, promise: Promise<void>): void {
  _addPending(prefix, id, promise)
}

export function removePending(prefix: DesktopPrefix, id: string): void {
  _removePending(prefix, id)
}

export function hasPending(prefix: DesktopPrefix, id: string): boolean {
  return _hasPending(prefix, id)
}

export function getPending(prefix: DesktopPrefix, id: string): Promise<void> | undefined {
  return _getPending(prefix, id)
}

export function getPendingForQuit(): Promise<void>[] {
  return _getPendingForQuit()
}

/** Test-only: clear the registry between cases. */
export function _resetForTests(): void {
  _underlyingResetForTests()
}

/** Test-only: inspect the underlying map for assertions. */
export function _peekMap(): ReadonlyMap<string, Promise<void>> {
  return _underlyingPeekMap()
}
