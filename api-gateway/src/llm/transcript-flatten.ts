// Shared transcript-segment helpers. Lifted from routes/chat.ts so the
// meetings/:id/enhance handler can reuse the same flatten + budget logic.

// Maximum transcript characters injected into a Claude prompt. Tuned to
// stay well below the model's context window after system+user prompt
// padding. Long transcripts are truncated with a visible marker so Claude
// knows the cut is intentional.
export const TRANSCRIPT_CONTEXT_BUDGET = 50_000

// transcript_segments is jsonb; the row shape is per the canonical
// TranscriptSegmentSchema in routes/meetings.ts. We only need text +
// speakerLabel for the flat representation.
export function flattenSegments(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  return raw
    .map((seg) => {
      if (typeof seg !== 'object' || seg === null) return ''
      const s = seg as { speakerLabel?: unknown; text?: unknown }
      const label =
        typeof s.speakerLabel === 'string' && s.speakerLabel.length > 0
          ? s.speakerLabel
          : 'Speaker'
      const text = typeof s.text === 'string' ? s.text : ''
      return `${label}: ${text}`
    })
    .filter((line) => line.length > 0)
    .join('\n')
}

// Truncate the flattened transcript to TRANSCRIPT_CONTEXT_BUDGET with an
// explicit marker. Returns '' for empty input (caller checks .length > 0
// before injecting into a prompt).
export function truncateTranscript(flat: string): string {
  if (flat.length <= TRANSCRIPT_CONTEXT_BUDGET) return flat
  return flat.slice(0, TRANSCRIPT_CONTEXT_BUDGET) + '\n[...transcript truncated...]'
}

// Issue 1A (eng review) — strict transcript-shape gate. A segment array
// can be null, empty, OR contain only zero-text segments (silent
// recording, transcription that returned nothing meaningful). All three
// should be rejected by callers that need real content to summarize.
//
// Returns true when there's AT LEAST ONE segment with non-empty .text.
export function hasTranscriptContent(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  return raw.some((seg) => {
    if (typeof seg !== 'object' || seg === null) return false
    const s = seg as { text?: unknown }
    return typeof s.text === 'string' && s.text.trim().length > 0
  })
}
