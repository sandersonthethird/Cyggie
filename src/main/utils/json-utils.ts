/**
 * Shared JSON parsing utilities used by LLM-based extraction services.
 * Extracted from contact-summary-sync.service.ts for reuse in company enrichment.
 */

/**
 * Parses a JSON object from LLM output, tolerating markdown fences.
 * Returns null for arrays, non-objects, or unparseable text.
 */
export function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Extracts a non-empty trimmed string from an unknown value. Returns null otherwise. */
export function extractString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

/** Extracts a finite number from an unknown value. Returns null otherwise. */
export function extractNumber(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return isFinite(n) ? n : null
}
