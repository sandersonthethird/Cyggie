/**
 * Tests for fuzzy-match utilities (Levenshtein + fuzzyMatchExisting).
 *
 *   levenshteinDistance:  pairwise distance with early-bail at maxDistance
 *   fuzzyMatchExisting:   "did you mean…" detection with length-ratio guard
 */
import { describe, it, expect } from 'vitest'
import { levenshteinDistance, fuzzyMatchExisting } from '../shared/utils/fuzzy-match'

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0)
  })

  it('returns string length when one is empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3)
    expect(levenshteinDistance('abc', '')).toBe(3)
  })

  it('counts a single substitution', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1)
  })

  it('counts a single insertion', () => {
    expect(levenshteinDistance('cat', 'cats')).toBe(1)
  })

  it('counts a single deletion', () => {
    expect(levenshteinDistance('cats', 'cat')).toBe(1)
  })

  it('handles a typical typo: sequia vs sequoia (1 deletion)', () => {
    expect(levenshteinDistance('sequia', 'sequoia')).toBe(1)
  })

  it('handles typo: sequoa vs sequoia (1 insertion)', () => {
    expect(levenshteinDistance('sequoa', 'sequoia')).toBe(1)
  })

  it('early bails when length difference exceeds maxDistance', () => {
    // a is 1 char, b is 10 chars → diff 9 > maxDistance 2
    expect(levenshteinDistance('a', 'aaaaaaaaaa', 2)).toBeGreaterThan(2)
  })

  it('returns the actual distance when within maxDistance', () => {
    expect(levenshteinDistance('cat', 'bat', 5)).toBe(1)
  })
})

describe('fuzzyMatchExisting', () => {
  const candidates = [
    { id: 'c1', name: 'Sequoia Capital' },
    { id: 'c2', name: 'Accel Partners' },
    { id: 'c3', name: 'Index Ventures' },
    { id: 'c4', name: 'Founder Collective' },
  ]

  it('returns null on exact normalized match', () => {
    expect(fuzzyMatchExisting('Sequoia Capital', candidates)).toBeNull()
    expect(fuzzyMatchExisting('sequoia capital', candidates)).toBeNull()
    expect(fuzzyMatchExisting('  Sequoia   Capital ', candidates)).toBeNull()
  })

  it('returns null when typed is shorter than 3 chars', () => {
    expect(fuzzyMatchExisting('Se', candidates)).toBeNull()
  })

  it('returns null when there is no close match', () => {
    expect(fuzzyMatchExisting('Microsoft', candidates)).toBeNull()
  })

  it('returns null for very-different lengths even within distance threshold', () => {
    // typed length 1, candidate length 15 — length ratio < 0.7 → skip
    expect(fuzzyMatchExisting('S', candidates)).toBeNull()
  })

  it('returns the closest match within Levenshtein 2', () => {
    // "Sequia Capital" vs "Sequoia Capital" — 1 deletion
    const match = fuzzyMatchExisting('Sequia Capital', candidates)
    expect(match?.id).toBe('c1')
  })

  it('skips when length ratio is too low', () => {
    // "S Capital" vs "Sequoia Capital" — same length-ish but different content
    // length ratio: 9/15 = 0.6 → below 0.7 → skip
    expect(fuzzyMatchExisting('S Capital', candidates)).toBeNull()
  })

  it('picks the closest of multiple near-matches', () => {
    const cands = [
      { id: 'c1', name: 'Accel' },
      { id: 'c2', name: 'Excel' },
    ]
    // "Accel" exact → null (no confirm needed)
    expect(fuzzyMatchExisting('Accel', cands)).toBeNull()
    // "Acce" (length 4) vs "Accel" (5) and "Excel" (5) — ratio 4/5 = 0.8 ✓
    // distance to Accel = 1, distance to Excel = 2; pick Accel
    const m = fuzzyMatchExisting('Acce', cands)
    expect(m?.id).toBe('c1')
  })

  it('respects custom maxDistance', () => {
    // distance 3 — exceeds default 2, but allowed at 3
    expect(fuzzyMatchExisting('Sequoia Cap', candidates, 2)).toBeNull()
    const match = fuzzyMatchExisting('Sequoia Cap', candidates, 4)
    expect(match?.id).toBe('c1')
  })
})
