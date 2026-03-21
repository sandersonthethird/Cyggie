/**
 * Shared string utilities for company name normalization and splitting.
 *
 * Used in:
 *   - note-tagging.service.ts — normalizeToken for concatenation-aware fuzzy match
 *   - company.ipc.ts          — normalizeToken replaces local normalizeName()
 *   - org-company.repo.ts     — splitCamelCase in fixConcatenatedCompanyNames()
 *   - company-extractor.ts    — splitCamelCase in humanizeDomainName()
 */

/**
 * Lowercase + strip all non-alphanumeric characters.
 * Used to normalize names before substring or equality comparison.
 *
 * "Acme Corp" → "acmecorp"
 * "Red Swan Ventures" → "redswanventures"
 * ""  → ""
 */
export function normalizeToken(s: string): string {
  if (!s) return ''
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Split a CamelCase string into space-separated words.
 * Splits on lowercase→uppercase boundaries only.
 * Returns the input unchanged if it has no mixed case (preserves "IBM", "acmecorp").
 *
 * "AcmeCorp"  → "Acme Corp"
 * "OpenAI"    → "Open AI"
 * "IBM"       → "IBM"      (all-caps: no lowercase → skip)
 * "acmecorp"  → "acmecorp" (no uppercase → skip)
 * ""          → ""
 */
export function splitCamelCase(s: string): string {
  if (!s) return s
  // Only split if input has BOTH upper and lower case characters
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) return s
  return s.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
}
