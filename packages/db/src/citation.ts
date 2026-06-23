// =============================================================================
// Chat citations — shared type + the pure attribution matcher.
//
// A citation links an assistant chat answer back to a source record the gateway
// injected into the model's context (a meeting / company / contact / note). The
// gateway produces them by CONTEXT-ATTRIBUTION: it knows every entity it injected
// (collectContextEntities) and cites the ones the answer actually names. There is
// no agent self-report (no tool loop yet) — see the M5 plan.
//
//   injected candidates ─┐
//                        ├─▶ extractCitations(answer, candidates) ─▶ Citation[]
//   assistant answer ────┘        (conservative whole-word match)
//
// Lives in @cyggie/db so the gateway (producer) and the desktop renderer
// (consumer) share one definition; mobile mirrors it (separate Expo bundle).
// The matcher is PURE (no DB) so it unit-tests without a gateway/SQLite harness.
// =============================================================================

export type CitationType = 'meeting' | 'company' | 'contact' | 'note'

export interface Citation {
  type: CitationType
  id: string
  /** Display name at citation time (company canonicalName / meeting title / contact fullName). */
  label: string
  /** Epoch ms — set for meetings (date) so the chip can show recency. */
  timestamp?: number
}

/** Min label length to be eligible — skips noise like "AI", "Inc", "Co", "LP". */
const MIN_LABEL_LEN = 4
/** Hard cap so a context-heavy turn can't spray chips. */
const MAX_CITATIONS = 5

/** Lowercase, collapse internal whitespace, trim. Used on both the answer and labels. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Escape a string for safe insertion into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 2A conservative matcher: cite a candidate only when its normalized label
 * appears in the normalized answer on WORD BOUNDARIES (so "Acme" doesn't match
 * inside "Acmevale"). Labels shorter than MIN_LABEL_LEN are skipped (avoid
 * "AI"/"Inc" false positives). Deduped by `type:id`, capped at MAX_CITATIONS,
 * order preserved from the candidate list (stable chip order).
 *
 * Pure + total: nil/empty answer or candidates → []. Never throws on the inputs
 * we feed it (caller still wraps it defensively — a citation bug must not break
 * the chat turn).
 */
export function extractCitations(
  answerText: string | null | undefined,
  candidates: readonly Citation[] | null | undefined,
): Citation[] {
  if (!answerText || !candidates || candidates.length === 0) return []
  const answer = normalize(answerText)
  if (!answer) return []

  const out: Citation[] = []
  const seen = new Set<string>()
  for (const c of candidates) {
    if (out.length >= MAX_CITATIONS) break
    const label = normalize(c.label ?? '')
    if (label.length < MIN_LABEL_LEN) continue
    const key = `${c.type}:${c.id}`
    if (seen.has(key)) continue
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(label)}([^\\p{L}\\p{N}]|$)`, 'u')
    if (re.test(answer)) {
      seen.add(key)
      out.push(c)
    }
  }
  return out
}
