import { describe, it, expect } from 'vitest'
import { correctProperNouns } from '../main/utils/proper-noun-corrector'

describe('correctProperNouns', () => {
  it('returns text unchanged when name list is empty', () => {
    const text = 'We spoke with Sansen about the deal.'
    expect(correctProperNouns(text, [])).toBe(text)
  })

  it('returns text unchanged when text is empty', () => {
    expect(correctProperNouns('', ['Sandy Chen'])).toBe('')
  })

  it('corrects a single-word misspelling above threshold', () => {
    // "Tobius" is a close misspelling of "Tobias"
    const text = 'Tobius confirmed the term sheet.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe('Tobias confirmed the term sheet.')
  })

  it('does not replace a word that is too different', () => {
    const text = 'The meeting went well.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe(text)
  })

  it('does not replace tokens shorter than 4 characters', () => {
    // "Ian" is 3 chars — should not trigger single-word matching
    const text = 'Ian from the team joined.'
    const result = correctProperNouns(text, ['Ian'])
    expect(result).toBe(text)
  })

  it('corrects a two-word name using sliding window', () => {
    // "Redd Swan" is a close misspelling of "Red Swan"
    const text = 'We met with Redd Swan Ventures today.'
    const result = correctProperNouns(text, ['Red Swan Ventures'])
    expect(result).toBe('We met with Red Swan Ventures today.')
  })

  it('processes longest names first to prevent partial clobber', () => {
    // "Sandy Chan" should match "Sandy Chen" (2-word) before "Sandy" (1-word)
    // so the full name gets corrected, not just "Sandy"
    const text = 'Sandy Chan discussed the deal.'
    const result = correctProperNouns(text, ['Sandy', 'Sandy Chen'])
    expect(result).toBe('Sandy Chen discussed the deal.')
  })

  it('returns text unchanged when no names match', () => {
    const text = 'The quarterly results look strong.'
    const result = correctProperNouns(text, ['Anthropic', 'OpenAI', 'Google'])
    expect(result).toBe(text)
  })

  it('handles multiple corrections in the same text', () => {
    const text = 'Tobius and Martyn discussed the Incisive deal.'
    const result = correctProperNouns(text, ['Tobias', 'Martin', 'Incisive Ventures'])
    expect(result).toContain('Tobias')
    expect(result).toContain('Martin')
  })

  it('does not corrupt text on error — returns original', () => {
    // Should never throw; graceful fallback is the contract
    const text = 'Normal transcript text.'
    expect(() => correctProperNouns(text, ['ValidName'])).not.toThrow()
  })

  it('does not replace email local parts that fuzzy-match a CRM name', () => {
    // "sandy" in "sandy@redswanventures.com" should not become "Andy"
    // even though jaroWinkler("sandy", "andy") ≈ 0.933 > 0.92 threshold
    const text = '**sandy@redswanventures.com** [0:00]\nCoding and investing.'
    const result = correctProperNouns(text, ['Andy'])
    expect(result).toContain('sandy@redswanventures.com')
  })

  it('does not replace email domain parts that fuzzy-match a CRM name', () => {
    const text = 'Contact info@Promptcapital.com for details.'
    const result = correctProperNouns(text, ['PromptCapital'])
    expect(result).toContain('info@Promptcapital.com')
  })

  it('still corrects non-email words that fuzzy-match a CRM name', () => {
    // "Tobius" in normal text should still be corrected to "Tobias"
    // (regression: email guard must not block non-email tokens)
    const text = 'Tobius discussed the deal with the team.'
    const result = correctProperNouns(text, ['Tobias'])
    expect(result).toBe('Tobias discussed the deal with the team.')
  })

  // ── Sandy/Andy regression suite (2026-05-28) ─────────────────────────────
  // Reported bug: user "Sandy Cass" had every transcript rewrite "Sandy" to
  // "Andy" because a colleague named "Andy" is in the CRM and JW("sandy",
  // "andy") ≈ 0.933 > 0.92 threshold. Fix: canonical-token guard — a token
  // that is itself a known canonical name (lowercased, ≥ MIN_TOKEN_LENGTH)
  // is never fuzzy-replaced into a different canonical.

  it('does not rewrite a name that is itself a canonical token (Sandy/Andy)', () => {
    // "Sandy" appears in canonical names via "Sandy Cass" → token set
    // includes "sandy". The "Andy" canonical fuzzy-matches "Sandy" at
    // 0.933 but the guard short-circuits before the JW check.
    const text = 'Sandy joined the call.'
    const result = correctProperNouns(text, ['Andy', 'Sandy Cass'])
    expect(result).toContain('Sandy')
    expect(result).not.toContain('Andy')
  })

  it('symmetric protection — Andy unchanged when both are canonical tokens', () => {
    const text = 'Andy spoke first.'
    const result = correctProperNouns(text, ['Sandy Cass', 'Andy'])
    expect(result).toContain('Andy')
    expect(result).not.toContain('Sandy')
  })

  it('guard does not over-block — Mikee still corrects to Mike', () => {
    // "mikee" is NOT in the canonical-token set ("mike" is), so fuzzy
    // fallback runs and corrects to the canonical form.
    const text = 'Mikee called.'
    const result = correctProperNouns(text, ['Mike'])
    expect(result).toBe('Mike called.')
  })

  it('reverse direction — Andy never gets fuzzy-promoted to Sandy', () => {
    // Both "Sandy" and "Andy" are canonical; "andy" is in the token set;
    // the "Sandy" canonical's fuzzy pass cannot claim "Andy".
    const text = 'Andy joined.'
    const result = correctProperNouns(text, ['Sandy', 'Andy'])
    expect(result).toContain('Andy')
    expect(result).not.toContain('Sandy')
  })
})
