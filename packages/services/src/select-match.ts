import { jaroWinkler } from '@main/utils/jaroWinkler'
import { normalizeWhitespace } from '@main/utils/summary-text-utils'

/**
 * Shared fuzzy matcher for snapping an LLM-emitted value to a select/multiselect
 * field's option list. Used by both company and contact summary-sync.
 *
 *   raw ──normalize──▶ for each opt: jaroWinkler(opt, raw)
 *                          │
 *               best score ≥ FUZZY_THRESHOLD ? ──▶ that option
 *                          else               ──▶ null
 *
 * Replaces the old company-side naive substring fallback
 * (`opt.includes(raw) || raw.includes(opt)`), which let unrelated values bleed
 * into the wrong field — e.g. a sector like "LegalTech" snapping into a custom
 * "Pipeline Stage" option. Jaro-Winkler with a high threshold tolerates
 * case/punctuation/typo variance while rejecting cross-field junk. Exact matches
 * score 1.0 and always win.
 */
export const SELECT_FUZZY_THRESHOLD = 0.88

export function matchSelectOption(raw: string, options: string[]): string | null {
  const norm = normalizeWhitespace(raw).toLowerCase()
  if (!norm) return null
  let best: string | null = null
  let bestScore = 0
  for (const opt of options) {
    const score = jaroWinkler(normalizeWhitespace(opt).toLowerCase(), norm)
    if (score >= SELECT_FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score
      best = opt
    }
  }
  return best
}
