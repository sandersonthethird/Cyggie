// Meeting-row statuses that mean transcription is still in flight. The detail
// screen polls /meetings/:id while the row is in one of these (so the status
// pill flips to "transcribed" live), and stops once it reaches a terminal
// status. Mirrors the in-progress set used by the recording flow's
// use-transcribing-poll.ts.
export const MEETING_IN_PROGRESS_STATUSES = new Set(['recording', 'transcribing'])

/** True while the meeting is still recording / transcribing (non-terminal). */
export function isMeetingInProgress(status: string | null | undefined): boolean {
  return MEETING_IN_PROGRESS_STATUSES.has(status ?? '')
}

// Detail-screen poll cadence. 10s matches use-transcribing-poll.ts — steady
// without flooding the gateway; the user sees the result within one tick of
// the server flipping to a terminal status.
export const MEETING_DETAIL_POLL_MS = 10_000

/**
 * react-query `refetchInterval` decision for the meeting detail query: poll
 * every 10s while in-progress, stop (false) once terminal. Extracted as a
 * pure function so it can be unit-tested without a react-query harness.
 */
export function meetingDetailRefetchInterval(
  status: string | null | undefined,
): number | false {
  return isMeetingInProgress(status) ? MEETING_DETAIL_POLL_MS : false
}
