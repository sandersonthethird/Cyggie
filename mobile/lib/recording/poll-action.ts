// =============================================================================
// poll-action.ts — pure decision function for useTranscribingPoll.
//
// Extracted from the hook so it can be unit-tested without dragging
// react-native (and its Flow-syntax index) into the vitest module graph.
// The hook in use-transcribing-poll.ts imports + dispatches on the result;
// any change to the mapping should land in this file (with a test) first.
// =============================================================================

/**
 * Mobile's age window for treating status='error' as transient (retryable).
 * Past this, we assume the error is permanent (stale sweeper, webhook
 * permanently failed) and stop offering retry — the audio file's
 * gateway-side context is likely gone anyway.
 */
export const ERROR_RETRYABILITY_WINDOW_MS = 30 * 60 * 1000

export type PollAction =
  /** No terminal status yet — wait for the next tick. */
  | { kind: 'noop' }
  /** Transcription succeeded — clean up locally, navigate to meeting detail. */
  | { kind: 'terminal-transcribed' }
  /** Transcription completed but no speech detected — same cleanup, banner on detail. */
  | { kind: 'terminal-empty' }
  /** Recent error — show retry banner (keep MMKV intact). */
  | { kind: 'error-retryable'; message: string }
  /** Stale error — clean up locally + show terminal "too old" message. */
  | { kind: 'error-stale'; message: string }
  /** Server-side delete — clean up locally + navigate back to calendar. */
  | { kind: 'gone'; message: string }

export interface PollSnapshot {
  status: string
  updatedAt: string
}

/**
 * Map the latest poll snapshot into a PollAction.
 *
 * Inputs are deliberately minimal — passing `nowMs` rather than reading
 * `Date.now()` lets tests pin a specific moment for the age-window check.
 */
export function decidePollAction(input: {
  data: PollSnapshot | undefined
  error: unknown
  nowMs: number
}): PollAction {
  const { data, error, nowMs } = input
  // Duck-typed 404 check (instead of `instanceof ApiError`) so this file
  // stays free of api/client imports — keeps the React Native dep chain
  // out of the test runner's module graph.
  if (
    error !== null &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: unknown }).status === 404
  ) {
    return { kind: 'gone', message: 'Meeting no longer exists' }
  }
  if (!data) return { kind: 'noop' }
  if (data.status === 'transcribed') return { kind: 'terminal-transcribed' }
  if (data.status === 'empty') return { kind: 'terminal-empty' }
  if (data.status === 'error') {
    const updatedAtMs = Date.parse(data.updatedAt)
    const ageMs = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : 0
    if (ageMs < ERROR_RETRYABILITY_WINDOW_MS) {
      return { kind: 'error-retryable', message: 'Transcription failed on the server' }
    }
    return { kind: 'error-stale', message: 'Transcription failed too long ago to retry' }
  }
  return { kind: 'noop' }
}
