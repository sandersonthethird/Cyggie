// =============================================================================
// summary-display.ts — pure decision function for the Summary tab.
//
// Mirrors the pattern used by `mount-action.ts` and `poll-action.ts`:
// extract the branching logic out of the React component so it can be
// unit-tested in isolation (no RN renderer / no Markdown library).
//
// The Summary tab has three terminal display states; this function maps
// (meeting status, summary string) onto one of them.
// =============================================================================

export type SummaryDisplay =
  | { kind: 'transcribing-wait' }
  | { kind: 'empty' }
  | { kind: 'render'; markdown: string }

/**
 * Decide which UI state the Summary tab should render.
 *
 *   status='transcribing' or 'recording'  → 'transcribing-wait'
 *     ("Summary will be ready once transcription completes.")
 *
 *   status terminal AND (summary null or whitespace-only)  → 'empty'
 *     ("No summary yet — open on desktop to generate one.")
 *
 *   summary present  → 'render' (markdown body in `markdown`)
 */
export function decideSummaryDisplay(opts: {
  summary: string | null
  status: string
}): SummaryDisplay {
  if (opts.status === 'transcribing' || opts.status === 'recording') {
    return { kind: 'transcribing-wait' }
  }
  if (!opts.summary?.trim()) {
    return { kind: 'empty' }
  }
  return { kind: 'render', markdown: opts.summary }
}
