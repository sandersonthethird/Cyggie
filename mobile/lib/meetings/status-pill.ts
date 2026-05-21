// =============================================================================
// status-pill.ts — pure mapping from a meeting's gateway-side status string
// to the small badge shown on the calendar list + meeting detail Hero.
//
// Extracted from the React component so the mapping is unit-testable
// without dragging in react-native (mirrors poll-action.ts / mount-action.ts).
//
// The set of statuses we surface as pills is deliberately small — only
// the ones whose presence/state is non-obvious from the surrounding UI:
//
//   recording    → "Transcribing…" (brief server-side window between
//                  upload-land and Deepgram-submit; user sees the same
//                  label as the longer transcribing state below — the
//                  distinction isn't meaningful at the calendar-card level)
//   transcribing → "Transcribing…" (informational; user is waiting)
//   empty        → "No speech"    (warning; recording was silent)
//   error        → "Failed"       (warning; needs user action)
//
// Statuses we DELIBERATELY don't pill:
//   transcribed  → the transcript IS the meeting; no need to badge it
//   idle / unknown → render nothing rather than a confusing "Unknown" pill
// =============================================================================

export type PillTone = 'info' | 'warning' | 'error'

export interface StatusPill {
  label: string
  tone: PillTone
}

export function decideStatusPill(status: string | undefined | null): StatusPill | null {
  switch (status) {
    case 'recording':
    case 'transcribing':
      return { label: 'Transcribing…', tone: 'info' }
    case 'empty':
      return { label: 'No speech', tone: 'warning' }
    case 'error':
      return { label: 'Failed', tone: 'error' }
    default:
      return null
  }
}
