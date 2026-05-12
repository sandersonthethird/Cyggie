/**
 * Memo citation preprocessor.
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  Producer agent writes inline `[source: <url>]` after each       │
 *   │  factual claim from a web source. This preprocessor:              │
 *   │                                                                   │
 *   │    1. Scans the memo markdown for `[source: <url>]` patterns      │
 *   │    2. Canonicalizes each URL (fragment-stripped — fragments don't │
 *   │       affect resource identity for citation matching)             │
 *   │    3. Assigns a per-memo citation number on first sight           │
 *   │       (same URL anywhere in the memo → same number)               │
 *   │    4. Replaces the source bracket with `[¹](url)` markdown link, │
 *   │       using Unicode superscript digits for visual subtlety        │
 *   │    5. Returns a Map<canonicalUrl, EvidenceRow[]> so the hover     │
 *   │       layer can resolve a hovered anchor's URL to its evidence    │
 *   │                                                                   │
 *   │  The hover layer (CitationHoverLayer) uses bySource.has() to      │
 *   │  decide whether to show a popover. Plain markdown links in        │
 *   │  section bodies have no matching evidence row and so silently     │
 *   │  receive no popover — see eng-review decision 1.1.                │
 *   │                                                                   │
 *   │  Idempotent: the regex requires a literal `source:` prefix, which │
 *   │  the rewritten output never has. Running twice yields identical   │
 *   │  output.                                                          │
 *   └──────────────────────────────────────────────────────────────────┘
 */

import { canonicalizeUrl } from '../../shared/lib/url-canonical'
import type { StoredMemoEvidence } from '../../shared/types/memo-evidence'

export interface PreprocessResult {
  /** Markdown with [source: url] patterns rewritten to numbered superscript links. */
  processedMarkdown: string
  /** canonicalUrl (fragment-stripped) → evidence rows that cite this URL */
  bySource: Map<string, StoredMemoEvidence[]>
  /** canonicalUrl → citation number (per-memo; first appearance wins) */
  citationNumber: Map<string, number>
}

/**
 * Citation-match canonical form. Strips the URL fragment before delegating
 * to `canonicalizeUrl`, because producer-emitted `[source: ...#section]` and
 * evidence rows with `sourceUrl=...` (no fragment) should match.
 *
 * Returns null for malformed URLs or non-http(s) protocols.
 */
export function canonicalizeForCitation(url: string): string | null {
  // Cheap fragment strip BEFORE canonicalizeUrl so the canonical form excludes
  // any anchor reference.
  let withoutFragment = url
  const hashIdx = url.indexOf('#')
  if (hashIdx >= 0) withoutFragment = url.slice(0, hashIdx)
  return canonicalizeUrl(withoutFragment)
}

const SUPERSCRIPT_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']

/**
 * Convert a positive integer to Unicode superscript digits.
 * `toSuperscript(1)` → '¹', `toSuperscript(42)` → '⁴²'.
 */
export function toSuperscript(n: number): string {
  if (n < 0 || !Number.isInteger(n)) return String(n)
  if (n === 0) return SUPERSCRIPT_DIGITS[0]
  let out = ''
  let m = n
  while (m > 0) {
    out = SUPERSCRIPT_DIGITS[m % 10] + out
    m = Math.floor(m / 10)
  }
  return out
}

// Matches `[source: <url>]` where url is http(s)://… stopping at whitespace
// or `]`. Captures the raw URL (group 1).
//   - `\s*` after `source:` allows missing space
//   - `[^\s\]]+` excludes whitespace AND `]` so the bracket terminates cleanly
const CITATION_RE = /\[source:\s*(https?:\/\/[^\s\]]+)\]/g

/**
 * Preprocess a memo's markdown to convert inline `[source: <url>]` patterns
 * into numbered superscript links. Idempotent.
 *
 * Performance: O(markdown.length) regex scan; one `canonicalizeForCitation`
 * call per match. Typical memo ~10-50KB; <5ms.
 */
export function preprocessMemoCitations(
  markdown: string,
  evidence: readonly StoredMemoEvidence[],
): PreprocessResult {
  // Build URL → evidence-rows lookup. Multiple rows can share a URL; keep
  // them in insertion order (which matches the order they were written by
  // the producer agent, roughly oldest first).
  const bySource = new Map<string, StoredMemoEvidence[]>()
  for (const row of evidence) {
    if (!row.sourceUrl) continue
    const key = canonicalizeForCitation(row.sourceUrl)
    if (!key) continue
    const list = bySource.get(key) ?? []
    list.push(row)
    bySource.set(key, list)
  }

  const citationNumber = new Map<string, number>()
  let nextNumber = 1

  const processedMarkdown = markdown.replace(CITATION_RE, (_match, rawUrl: string) => {
    const canonical = canonicalizeForCitation(rawUrl)
    if (!canonical) {
      // Malformed URL inside [source: …] — leave the original text alone so
      // the user can see it's broken instead of a silent dropped citation.
      return _match
    }
    let n = citationNumber.get(canonical)
    if (n === undefined) {
      n = nextNumber++
      citationNumber.set(canonical, n)
    }
    return `[${toSuperscript(n)}](${rawUrl})`
  })

  return { processedMarkdown, bySource, citationNumber }
}
