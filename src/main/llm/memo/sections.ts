import {
  MEMO_SECTION_HEADINGS,
  type MemoSectionHeading as SharedHeading,
} from '../../../shared/constants/memo-sections'

/**
 * Single source of truth for memo section structure.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Producer agent, stress-test agent, IPC handler, repo skeleton,  │
 *   │  assembly, prompt templates and tests all read MEMO_SECTIONS     │
 *   │  here. Adding/removing a section, renaming a heading, or         │
 *   │  changing a gate is a one-line edit.                              │
 *   │                                                                   │
 *   │  Section kinds:                                                   │
 *   │    narrative  — written from internal data (notes, transcripts,  │
 *   │                 contacts, files)                                  │
 *   │    research   — written primarily from web tools (web_search,    │
 *   │                 web_fetch)                                        │
 *   │    synthesis  — written from the union of the above with         │
 *   │                 extended thinking (CoT)                          │
 *   │                                                                   │
 *   │  Gates: a section is only emitted when its gate predicate fires.  │
 *   │    series_a_plus           — company.stage matches Series A+      │
 *   │    has_reference_calls     — at least one meeting is tagged a    │
 *   │                              reference call                       │
 *   │    has_substantive_thesis  — agent judgment; if no compelling     │
 *   │                              thesis can be articulated, the      │
 *   │                              section is omitted entirely         │
 *   └──────────────────────────────────────────────────────────────────┘
 */

export type MemoSectionKind = 'narrative' | 'research' | 'synthesis'
export type MemoSectionGate = 'series_a_plus' | 'has_reference_calls' | 'has_substantive_thesis'

export interface MemoSection {
  readonly heading: string
  readonly kind: MemoSectionKind
  /** Position in the assembled memo output (1-indexed). */
  readonly ordinal: number
  /** When true, the producer agent MUST submit this section for the run to succeed. */
  readonly required: boolean
  /** When set, the section is only emitted when the gate predicate fires at run-start. */
  readonly gate: MemoSectionGate | null
}

/**
 * Canonical roster. Order here defines assembly order in the final memo.
 *
 * The agent submits sections in any order; assembly sorts by `ordinal`.
 * The agent is INSTRUCTED via system prompt to iterate in roster order so that
 * synthesis sections see the prior narrative/research sections' submit_section
 * calls in its message history (improves synthesis quality).
 */
export const MEMO_SECTIONS: readonly MemoSection[] = [
  { heading: 'Executive Summary',     kind: 'synthesis', ordinal: 1,  required: true,  gate: null },
  { heading: 'Investment Thesis',     kind: 'synthesis', ordinal: 2,  required: false, gate: 'has_substantive_thesis' },
  { heading: 'Business Description',  kind: 'narrative', ordinal: 3,  required: true,  gate: null },
  { heading: 'Market / Industry',     kind: 'research',  ordinal: 4,  required: true,  gate: null },
  { heading: 'Competition',           kind: 'research',  ordinal: 5,  required: true,  gate: null },
  { heading: 'Team',                  kind: 'narrative', ordinal: 6,  required: true,  gate: null },
  { heading: 'Traction / Financials', kind: 'narrative', ordinal: 7,  required: true,  gate: null },
  { heading: 'Go-To-Market',          kind: 'narrative', ordinal: 8,  required: true,  gate: null },
  { heading: 'Valuation',             kind: 'research',  ordinal: 9,  required: false, gate: 'series_a_plus' },
  { heading: 'Risks',                 kind: 'synthesis', ordinal: 10, required: true,  gate: null },
  { heading: 'References',            kind: 'narrative', ordinal: 11, required: false, gate: 'has_reference_calls' },
] as const

export type MemoSectionHeading = SharedHeading

// Build-time invariant: the shared heading list must match the heading
// field of the richer roster. Drift between the two breaks the section-
// streaming UI and the section-refresh nav.
{
  const richerHeadings = MEMO_SECTIONS.map((s) => s.heading)
  for (let i = 0; i < MEMO_SECTION_HEADINGS.length; i++) {
    if (MEMO_SECTION_HEADINGS[i] !== richerHeadings[i]) {
      throw new Error(
        `MEMO_SECTION_HEADINGS / MEMO_SECTIONS drift at index ${i}: ` +
          `shared has "${MEMO_SECTION_HEADINGS[i]}" but main has "${richerHeadings[i]}"`,
      )
    }
  }
  if (MEMO_SECTION_HEADINGS.length !== richerHeadings.length) {
    throw new Error('MEMO_SECTION_HEADINGS length mismatch with MEMO_SECTIONS')
  }
}

const HEADING_SET = new Set(MEMO_SECTIONS.map((s) => s.heading))
const BY_HEADING = new Map(MEMO_SECTIONS.map((s) => [s.heading, s]))

export function isMemoSectionHeading(heading: string): heading is MemoSectionHeading {
  return HEADING_SET.has(heading)
}

export function getSection(heading: string): MemoSection | undefined {
  return BY_HEADING.get(heading)
}

/**
 * The stress-test agent rewrites "conclusory" sections and leaves "descriptive"
 * sections byte-identical. We treat synthesis + Competition + Traction +
 * Valuation as the rewrite targets — these match the legacy hard-coded list
 * (with Investment Highlights renamed to Investment Thesis).
 */
export function stressTestTargets(): readonly string[] {
  return MEMO_SECTIONS.filter(
    (s) =>
      s.kind === 'synthesis' ||
      s.heading === 'Competition' ||
      s.heading === 'Traction / Financials' ||
      s.heading === 'Valuation',
  ).map((s) => s.heading)
}

export function stressTestPassthrough(): readonly string[] {
  const targets = new Set(stressTestTargets())
  return MEMO_SECTIONS.filter((s) => !targets.has(s.heading)).map((s) => s.heading)
}

// ─── Stage gating ─────────────────────────────────────────────────────────

/**
 * Returns true when the company stage qualifies for the Valuation section.
 *
 *   matches  : "Series A", "Series B" … "Series Z", "Growth", "Late Stage",
 *              "Late-stage", "Pre-IPO", "Pre IPO"
 *   excludes : null, empty, "Pre-Seed", "Seed", "Seed+", "Angel",
 *              "Series A bridge" (acknowledged limitation — no "bridge"
 *              variant; document)
 */
const SERIES_A_PLUS_RE = /^\s*series\s*[a-z]\b(?!.*\bbridge\b)|^\s*growth\b|^\s*late.?stage\b|^\s*pre.?ipo\b/i

export function isSeriesAOrLater(stage: string | null | undefined): boolean {
  if (!stage) return false
  return SERIES_A_PLUS_RE.test(stage)
}

// ─── Legacy heading normalization (transparent backwards-compat) ─────────

/**
 * Rewrites pre-rename heading "## Investment Highlights" to "## Investment
 * Thesis" so the stress-test agent can transparently operate on memo versions
 * persisted before the rename landed.
 *
 * Idempotent: running twice yields the same output. Only normalizes when the
 * line is a top-level `##` heading at column 0 — does not rewrite the phrase
 * appearing in body text.
 */
const LEGACY_HEADING_RE = /^##\s+Investment Highlights\s*$/gm

export function normalizeLegacyHeadings(md: string): string {
  return md.replace(LEGACY_HEADING_RE, '## Investment Thesis')
}

// ─── Section replacement (used by per-section Refresh) ───────────────────

/**
 * Replaces a single section's body in a memo's markdown. Other sections are
 * byte-identical. Heading line is preserved.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Input:                                                            │
 *   │    "...prelude...                                                  │
 *   │     ## Heading                                                     │
 *   │     old body                                                       │
 *   │     ## Next Heading                                                │
 *   │     ..."                                                           │
 *   │                                                                    │
 *   │  Output (with new body):                                           │
 *   │    "...prelude...                                                  │
 *   │     ## Heading                                                     │
 *   │     new body                                                       │
 *   │     ## Next Heading                                                │
 *   │     ..."                                                           │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Throws if heading is not found in the markdown. Caller should verify
 * presence before calling (or catch and surface to user).
 */
export function replaceSectionInMarkdown(md: string, heading: string, newBody: string): string {
  // Find the heading line at column 0.
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headingRe = new RegExp(`^##\\s+${escapedHeading}\\s*$`, 'm')
  const match = headingRe.exec(md)
  if (!match) {
    throw new Error(`replaceSectionInMarkdown: heading "${heading}" not found`)
  }
  const headingStart = match.index
  const headingEnd = headingStart + match[0].length
  // Find the next `## ` heading at column 0 (or end-of-string).
  const nextHeadingRe = /^##\s/m
  // Start search after the heading line's trailing newline.
  const remainder = md.slice(headingEnd)
  const nextMatch = nextHeadingRe.exec(remainder)
  const sectionEnd = nextMatch ? headingEnd + nextMatch.index : md.length
  // Trim trailing whitespace on newBody to avoid runaway blank lines.
  const trimmedBody = newBody.replace(/\s+$/, '')
  const before = md.slice(0, headingEnd)
  const after = md.slice(sectionEnd)
  return `${before}\n${trimmedBody}\n\n${after}`
}

// ─── URL canonicalization for the web_fetch allowlist ────────────────────

// Re-exported from shared/lib so the citation preprocessor (renderer) and
// the producer agent's web_fetch allowlist (main) share byte-identical
// canonicalization. Implementation lives in src/shared/lib/url-canonical.ts.
export { canonicalizeUrl } from '../../../shared/lib/url-canonical'
