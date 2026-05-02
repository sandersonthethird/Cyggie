/**
 * Fuzzy string matching utilities. Used for "did you mean…" prompts
 * when a user types an investor name that closely resembles an existing one.
 *
 * Implementation notes:
 *   - levenshteinDistance: classic O(m·n) DP; bails early once distance exceeds maxDistance.
 *   - fuzzyMatchExisting: case-insensitive, whitespace-collapsed comparison;
 *     skips matches when length difference dominates (e.g. "S" vs "Sequoia Capital").
 *   - Both are pure functions with no side effects; safe to call on every Enter press.
 */

export function levenshteinDistance(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  // Early bail: difference in length alone exceeds maxDistance
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1

  // Use rolling rows to keep memory O(min(a, b))
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  let prev = new Array(shorter.length + 1)
  let curr = new Array(shorter.length + 1)
  for (let j = 0; j <= shorter.length; j++) prev[j] = j

  for (let i = 1; i <= longer.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= shorter.length; j++) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost  // substitution
      )
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > maxDistance) return maxDistance + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[shorter.length]
}

function normalizeForCompare(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Returns the closest existing match for `typed`, or null if no entry is close enough.
 *
 * "Close enough" means:
 *   - exact normalized match (same name, modulo case/whitespace) → returns null
 *     (no confirm needed; they typed the existing one)
 *   - Levenshtein distance ≤ maxDistance AND length difference < 30%
 *
 * @param typed       What the user typed
 * @param candidates  Existing entries to compare against (typically search suggestions)
 * @param maxDistance Levenshtein threshold (default 2)
 */
export function fuzzyMatchExisting<T extends { name: string }>(
  typed: string,
  candidates: T[],
  maxDistance = 2,
): T | null {
  const typedNorm = normalizeForCompare(typed)
  if (typedNorm.length < 3) return null

  let best: { entry: T; distance: number } | null = null

  for (const candidate of candidates) {
    const candNorm = normalizeForCompare(candidate.name)
    if (candNorm === typedNorm) return null // exact match — no confirm needed

    // Skip wildly-different lengths (avoid "S" matching "Sequoia Capital")
    const lenRatio = Math.min(typedNorm.length, candNorm.length) / Math.max(typedNorm.length, candNorm.length)
    if (lenRatio < 0.7) continue

    const distance = levenshteinDistance(typedNorm, candNorm, maxDistance)
    if (distance <= maxDistance && (best == null || distance < best.distance)) {
      best = { entry: candidate, distance }
    }
  }

  return best?.entry ?? null
}
